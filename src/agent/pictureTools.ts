import { toolDescription, parameterDescriptions } from "../vocabulary.ts";
/** Accessible, bounded shape authoring compiled to authentic AGI picture commands. */
import { resourceCacheHint } from "./authoringState.ts";
import {
  colourGrid,
  formatPriorityDiagnostics,
  PICTURE_COMPARISON_LEGEND,
  pictureComparisonPng,
} from "./pictureFeedback.ts";
import type { AgentSessionState, AgentToolResult } from "./agentState.ts";
import type { ToolDefinition } from "./tools.ts";
import { computePictureMetrics, DEFAULT_HORIZON } from "../picture/metrics.ts";
import { renderPicture } from "../picture/renderer.ts";
import { compilePictureSource } from "../picture/source.ts";
import { sceneSource, validateSimplePolygon } from "../studio/shapes.ts";
import type { Point, SceneShape } from "../studio/shapes.ts";
import { createPictureSurface, SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import { editableSource, sourceContextRevision } from "./authoringTools.ts";
import { applyEdit } from "../studio/editOperations.ts";
import { parsePictureDocument, serializePictureDocument } from "../studio/pictureDocument.ts";

const MAX_SHAPES = 128;
const MAX_VERTICES_PER_SHAPE = 64;
const MAX_TOTAL_VERTICES = 2048;
/** The largest picture draw_picture_items compiles; Room Studio's byte meter warns against it. */
export const MAX_PAYLOAD_BYTES = 60_000;
const MAX_SHAPE_NAME = 48;

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
    name: "add_depth",
    description: toolDescription(
      "add_depth",
      "Adds derived Depth to picture `num` item `itemId`. Read the picture first and pass its `expectedRevision`. Null `baseY` uses the item's lowest drawn row; null `priorityBase` uses 48, the default set.pri.base. Supply the room's current priority base when it differs. Replaces the item's painted Depth with ordinary AGI lines and records the base line so later item edits regenerate it. Locked items, stale revisions, invalid source or excessive byte size leave the resource unchanged. Returns the new editable-source revision and written resource. Art stays unchanged.",
    ),
    parameters: parameterDescriptions("add_depth", {
      type: "object",
      additionalProperties: false,
      properties: {
        num: { type: "integer", minimum: 0, maximum: 255 },
        itemId: { type: "string", minLength: 1 },
        expectedRevision: { type: "string", minLength: 1 },
        baseY: { type: ["integer", "null"], minimum: 0, maximum: 167 },
        priorityBase: { type: ["integer", "null"], minimum: 0, maximum: 167 },
      },
      required: ["num", "itemId", "expectedRevision", "baseY", "priorityBase"],
    }),
  },
  {
    name: "draw_picture_items",
    description: toolDescription(
      "draw_picture_items",
      "Compile a complete picture `room` from ordered `shapes` (rects, polygons and lines in logical coordinates) over a full `backgroundColor` fill. Rects use x1,y1,x2,y2; other shapes use points. Unused coordinates and visual-only priority are null. Later shapes paint over earlier ones. Returns the rendered comparison, spatial metrics and revision; invalid geometry stores nothing. Name shapes so the creator can find and edit them in Room Studio.",
    ),
    parameters: parameterDescriptions("draw_picture_items", {
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
              name: { type: ["string", "null"], maxLength: MAX_SHAPE_NAME },
            },
            required: [
              "kind",
              "color",
              "priority",
              "filled",
              "x1",
              "y1",
              "x2",
              "y2",
              "points",
              "name",
            ],
          },
        },
      },
      required: ["room", "backgroundColor", "shapes"],
    }),
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
  // Calls predating `name` omit it; the schema's nullable normalization and
  // this check both read that as null.
  const name = item["name"];
  if (name !== null && name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_SHAPE_NAME) {
      throw new Error(
        `${label} name must be null or a non-empty string of at most ${MAX_SHAPE_NAME} characters.`,
      );
    }
  }
  const shapeLabel = typeof name === "string" ? name.trim() : undefined;
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
      label: shapeLabel,
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
  return { kind, color, priority, filled, points, label: shapeLabel };
}

/** Execute draw_picture_items, or return undefined when another registry owns the name. */
export function executePictureTool(
  state: AgentSessionState,
  name: string,
  args: Record<string, unknown>,
): AgentToolResult | undefined {
  if (name === "add_depth") {
    try {
      const num = integer(args["num"], "Picture number", 0, 255);
      const source = editableSource(state, "picture", num);
      if (source === undefined)
        throw new Error(`Picture ${num} is missing. Read the plan to choose an existing picture.`);
      if (sourceContextRevision(state, "picture", num, source) !== args["expectedRevision"])
        throw new Error("The picture changed. Read it again and retry with its current revision.");
      const parsed = parsePictureDocument(source);
      if (parsed.diagnostics.length)
        throw new Error("The picture's item annotations are invalid. Repair its source first.");
      const result = applyEdit(
        parsed.document,
        {
          type: "addDepth",
          itemId: String(args["itemId"]),
          ...(args["baseY"] == null ? {} : { baseY: integer(args["baseY"], "Base line", 0, 167) }),
        },
        {
          profile: state.profile,
          priorityBase:
            args["priorityBase"] == null
              ? 48
              : integer(args["priorityBase"], "Priority base", 0, 167),
        },
      );
      if ("error" in result) throw new Error(result.error);
      const next = serializePictureDocument(result.document);
      const compiled = compilePictureSource(next, { profile: state.profile });
      if (compiled.bytes.length > MAX_PAYLOAD_BYTES)
        throw new Error(`Depth exceeds ${MAX_PAYLOAD_BYTES} bytes. Simplify the item first.`);
      state.container.putResource("picture", num, compiled.bytes);
      state.sources.pictures.set(num, next);
      return {
        success: true,
        message: `Added depth to ${args["itemId"]}.`,
        details: {
          revision: sourceContextRevision(state, "picture", num, next),
          writtenResources: [{ kind: "picture", num }],
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
  if (name !== "draw_picture_items") return undefined;
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
    const source = sceneSource(backgroundColor, shapes, { annotate: true });
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
