/** Accessible, bounded shape authoring compiled to authentic AGI picture commands. */
import { resourceCacheHint } from "./authoringState.ts";
import {
  colourGrid,
  formatPriorityDiagnostics,
  PICTURE_COMPARISON_LEGEND,
  pictureComparisonPng,
} from "./pictureFeedback.ts";
import type { AgentSessionState, AgentToolResult, ToolDefinition } from "./tools.ts";
import { computePictureMetrics, DEFAULT_HORIZON } from "../picture/metrics.ts";
import { renderPicture } from "../picture/renderer.ts";
import { compilePictureSource } from "../picture/source.ts";
import { sceneSource, validateSimplePolygon } from "../studio/shapes.ts";
import type { Point, SceneShape } from "../studio/shapes.ts";
import { createPictureSurface, SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";

const MAX_SHAPES = 128;
const MAX_VERTICES_PER_SHAPE = 64;
const MAX_TOTAL_VERTICES = 2048;
const MAX_PAYLOAD_BYTES = 60_000;

const POINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    x: { type: "integer", minimum: 0, maximum: 159 },
    y: { type: "integer", minimum: 0, maximum: 167 },
  },
  required: ["x", "y"],
} as const;

/** Strict-compatible schema for deterministic scene geometry. */
export const PICTURE_TOOLS: readonly ToolDefinition[] = [
  {
    name: "write_scene",
    description:
      "Compile a complete picture `room` from ordered `shapes` (rects, polygons and lines in logical coordinates) over a full `backgroundColor` fill. Rects use x1,y1,x2,y2; other shapes use points. Unused coordinates and visual-only priority are null. Later shapes paint over earlier ones. Returns the rendered comparison, spatial metrics and revision; invalid geometry stores nothing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: {
          type: "integer",
          minimum: 0,
          maximum: 255,
        },
        backgroundColor: {
          type: "integer",
          minimum: 0,
          maximum: 15,
        },
        shapes: {
          type: "array",
          maxItems: MAX_SHAPES,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: ["rect", "polygon", "line"] },
              color: { type: "integer", minimum: 0, maximum: 15 },
              priority: {
                type: ["integer", "null"],
                minimum: 0,
                maximum: 15,
              },
              filled: {
                type: "boolean",
              },
              x1: {
                type: ["integer", "null"],
                minimum: 0,
                maximum: 159,
              },
              y1: {
                type: ["integer", "null"],
                minimum: 0,
                maximum: 167,
              },
              x2: {
                type: ["integer", "null"],
                minimum: 0,
                maximum: 159,
              },
              y2: {
                type: ["integer", "null"],
                minimum: 0,
                maximum: 167,
              },
              points: {
                type: ["array", "null"],
                minItems: 2,
                maxItems: MAX_VERTICES_PER_SHAPE,
                items: POINT_SCHEMA,
              },
            },
            required: ["kind", "color", "priority", "filled", "x1", "y1", "x2", "y2", "points"],
          },
        },
      },
      required: ["room", "backgroundColor", "shapes"],
    },
  },
];

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}.`);
  }
  return value;
}

function nullablePriority(value: unknown, label: string): number | null {
  if (value === null) return null;
  return integer(value, label, 0, 15);
}

function point(value: unknown, label: string): Point {
  const item = record(value, label);
  return {
    x: integer(item["x"], `${label} x`, 0, SCREEN_WIDTH - 1),
    y: integer(item["y"], `${label} y`, 0, SCREEN_HEIGHT - 1),
  };
}

function parseShape(value: unknown, index: number): SceneShape {
  const label = `Shape ${index}`;
  const item = record(value, label);
  const kind = item["kind"];
  if (kind !== "rect" && kind !== "polygon" && kind !== "line") {
    throw new Error(`${label} kind must be rect, polygon, or line.`);
  }
  const color = integer(item["color"], `${label} color`, 0, 15);
  const priority = nullablePriority(item["priority"], `${label} priority`);
  if (typeof item["filled"] !== "boolean") throw new Error(`${label} filled must be boolean.`);
  const filled = item["filled"];
  if (kind === "rect") {
    if (item["points"] !== null) throw new Error(`${label} rect points must be null.`);
    const firstX = integer(item["x1"], `${label} x1`, 0, SCREEN_WIDTH - 1);
    const firstY = integer(item["y1"], `${label} y1`, 0, SCREEN_HEIGHT - 1);
    const secondX = integer(item["x2"], `${label} x2`, 0, SCREEN_WIDTH - 1);
    const secondY = integer(item["y2"], `${label} y2`, 0, SCREEN_HEIGHT - 1);
    return {
      kind,
      color,
      priority,
      filled,
      x1: Math.min(firstX, secondX),
      y1: Math.min(firstY, secondY),
      x2: Math.max(firstX, secondX),
      y2: Math.max(firstY, secondY),
    };
  }
  for (const field of ["x1", "y1", "x2", "y2"]) {
    if (item[field] !== null) throw new Error(`${label} ${field} must be null for ${kind}.`);
  }
  const rawPoints = item["points"];
  const minimum = kind === "polygon" ? 3 : 2;
  if (
    !Array.isArray(rawPoints) ||
    rawPoints.length < minimum ||
    rawPoints.length > MAX_VERTICES_PER_SHAPE
  ) {
    throw new Error(`${label} ${kind} needs ${minimum}..${MAX_VERTICES_PER_SHAPE} points.`);
  }
  if (kind === "line" && filled) throw new Error(`${label} line cannot be filled.`);
  const points = rawPoints.map((value, pointIndex) => point(value, `${label} point ${pointIndex}`));
  if (kind === "polygon") validateSimplePolygon(points, label);
  return { kind, color, priority, filled, points };
}

/** Execute write_scene, or return undefined when another registry owns the name. */
export function executePictureTool(
  state: AgentSessionState,
  name: string,
  args: Record<string, unknown>,
): AgentToolResult | undefined {
  if (name !== "write_scene") return undefined;
  try {
    const room = integer(args["room"], "Picture number", 0, 255);
    const backgroundColor = integer(args["backgroundColor"], "Background color", 0, 15);
    const rawShapes = args["shapes"];
    if (!Array.isArray(rawShapes) || rawShapes.length > MAX_SHAPES) {
      throw new Error(
        `Shapes must be an array of at most ${MAX_SHAPES} entries. Use write_picture for a denser vector composition.`,
      );
    }
    const shapes = rawShapes.map(parseShape);
    const totalVertices = shapes.reduce(
      (total, shape) => total + (shape.kind === "rect" ? 4 : shape.points.length),
      0,
    );
    if (totalVertices > MAX_TOTAL_VERTICES) {
      throw new Error(`Scene exceeds the ${MAX_TOTAL_VERTICES}-vertex limit.`);
    }
    const source = sceneSource(backgroundColor, shapes);
    const compiled = compilePictureSource(source, { profile: state.profile });
    if (compiled.bytes.length > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `Compiled picture payload is ${compiled.bytes.length} bytes; limit is ${MAX_PAYLOAD_BYTES}.`,
      );
    }
    const surface = createPictureSurface();
    renderPicture(compiled.bytes, surface, { profile: state.profile });
    const metrics = computePictureMetrics(surface, {
      horizon: DEFAULT_HORIZON,
      commandCount: compiled.commandCount,
    });
    const png = pictureComparisonPng(surface.visual, surface.priority);
    state.container.putResource("picture", room, compiled.bytes);
    state.sources.pictures.set(room, source);
    const revision = resourceCacheHint(compiled.bytes);
    return {
      success: true,
      message: `Picture ${room} compiled from ${shapes.length} ordered shapes (${compiled.bytes.length} bytes, ${compiled.commandCount} commands), revision ${revision}.\nDominant colour per cell, 8x7:\n${colourGrid(surface.visual)}\n${formatPriorityDiagnostics(surface.priority)}`,
      details: {
        resource: { kind: "picture", num: room },
        writtenResources: [{ kind: "picture", num: room }],
        revision,
        room,
        shapes: shapes.length,
        vertices: totalVertices,
        bytes: compiled.bytes.length,
        commandCount: compiled.commandCount,
        fillCoverage: metrics.fillCoverage,
        distinctColors: metrics.distinctColors,
        priorityBands: metrics.priorityBands,
        walkableFraction: metrics.walkableFraction,
      },
      images: [
        {
          png,
          caption: `Picture ${room}, compiled AGI vector bytes in a 960x168 comparison sheet; each 320x168 panel uses native 2:1 logical-pixel aspect. ${PICTURE_COMPARISON_LEGEND}`,
        },
      ],
    };
  } catch (error) {
    return { success: false, error: `Scene was not written: ${String(error)}` };
  }
}
