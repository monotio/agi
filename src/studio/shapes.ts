/**
 * Scene shapes lowered to picture source text: the pure compiler behind the
 * agent `write_scene` tool and Room Studio shape authoring. A shape with
 * `color: null` draws on the priority plane only. With `annotate` the
 * background fill and each shape are wrapped in `# @item`/`# @end` comments
 * (src/studio/pictureDocument.ts), which never change the compiled bytes.
 */

import { PICTURE_ITEM_ID, type PictureItemKind } from "./pictureDocument.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

interface NamedShape {
  /** Studio item id; derived from the label when omitted. */
  readonly id?: string | undefined;
  /** Studio item label; `Shape N` when omitted. */
  readonly label?: string | undefined;
}

export interface RectShape extends NamedShape {
  readonly kind: "rect";
  readonly color: number | null;
  readonly priority: number | null;
  readonly filled: boolean;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface PathShape extends NamedShape {
  readonly kind: "polygon" | "line";
  readonly color: number | null;
  readonly priority: number | null;
  readonly filled: boolean;
  readonly points: readonly Point[];
}

export type SceneShape = RectShape | PathShape;

export function orientation(a: Point, b: Point, c: Point): number {
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.sign(cross);
}

export function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    orientation(a, b, p) === 0 &&
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y)
  );
}

export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

export function validateSimplePolygon(points: readonly Point[], label: string): void {
  const distinct = new Set(points.map(({ x, y }) => `${x},${y}`));
  if (distinct.size !== points.length) throw new Error(`${label} has a repeated vertex.`);
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    twiceArea += a.x * b.y - b.x * a.y;
  }
  if (twiceArea === 0) throw new Error(`${label} has zero area.`);
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    for (let j = i + 1; j < points.length; j++) {
      if (j === i || j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      const c = points[j]!;
      const d = points[(j + 1) % points.length]!;
      if (segmentsIntersect(a, b, c, d)) {
        throw new Error(`${label} self-intersects between edges ${i} and ${j}.`);
      }
    }
  }
}

export function coordinates(points: readonly Point[]): string {
  return points.map(({ x, y }) => `${x},${y}`).join(" ");
}

export function polygonScanlines(points: readonly Point[]): string[] {
  const lines: string[] = [];
  const minY = Math.min(...points.map(({ y }) => y));
  const maxY = Math.max(...points.map(({ y }) => y));
  for (let y = minY; y <= maxY; y++) {
    const intersections: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        intersections.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    intersections.sort((a, b) => a - b);
    if (intersections.length % 2 !== 0) {
      throw new Error(`Polygon scanline ${y} produced an odd intersection count.`);
    }
    for (let i = 0; i < intersections.length; i += 2) {
      const x1 = Math.ceil(intersections[i]!);
      const x2 = Math.floor(intersections[i + 1]!);
      if (x1 <= x2) lines.push(`line ${x1},${y} ${x2},${y}`);
    }
  }
  return lines;
}

export function shapeSource(shape: SceneShape): string[] {
  if (shape.color === null && shape.priority === null) {
    throw new Error("shape draws on neither plane");
  }
  const lines = [
    shape.color === null ? "vis off" : `vis ${shape.color}`,
    shape.priority === null ? "pri off" : `pri ${shape.priority}`,
  ];
  if (shape.kind === "rect") {
    if (!shape.filled) {
      lines.push(`rect ${shape.x1},${shape.y1} ${shape.x2},${shape.y2}`);
      return lines;
    }
    for (let y = shape.y1; y <= shape.y2; y++) {
      lines.push(`line ${shape.x1},${y} ${shape.x2},${y}`);
    }
    return lines;
  }
  if (shape.kind === "line") {
    lines.push(`line ${coordinates(shape.points)}`);
    return lines;
  }
  lines.push(`polygon ${coordinates(shape.points)}`);
  if (shape.filled) lines.push(...polygonScanlines(shape.points));
  return lines;
}

/** The Studio item kind for a shape's planes: visual only, depth marks (priority 4+), walk control (0-3), or both planes. */
function shapeItemKind(shape: SceneShape): PictureItemKind {
  if (shape.priority === null) return "art";
  if (shape.color !== null) return "mixed";
  return shape.priority < 4 ? "walk" : "depth";
}

/** A label's id slug: lowercase, runs of other characters become `-`; `shape-<slug>` when the slug would not start with a letter. */
function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (slug.length === 0) return "";
  return (/^[a-z]/.test(slug) ? slug : `shape-${slug}`).slice(0, 32).replace(/[-_]+$/, "");
}

/**
 * Unique ids for the scene's shape items, in order. Explicit ids win and must
 * be well-formed and unused; derived ids slugify the label, fall back to
 * `shape-N`, and take a `-2`, `-3`, … suffix on collisions.
 */
function sceneItemIds(shapes: readonly SceneShape[]): string[] {
  const used = new Set(["background"]);
  return shapes.map((shape, index) => {
    if (shape.id !== undefined) {
      if (!PICTURE_ITEM_ID.test(shape.id)) {
        throw new Error(`shape id '${shape.id}' must match ${PICTURE_ITEM_ID.source}`);
      }
      if (used.has(shape.id)) throw new Error(`duplicate shape id '${shape.id}'`);
      used.add(shape.id);
      return shape.id;
    }
    const base = (shape.label !== undefined ? slugify(shape.label) : "") || `shape-${index + 1}`;
    let id = base;
    for (let n = 2; used.has(id); n++) {
      const suffix = `-${n}`;
      id = `${base.slice(0, 32 - suffix.length).replace(/[-_]+$/, "")}${suffix}`;
    }
    used.add(id);
    return id;
  });
}

export interface SceneSourceOptions {
  /**
   * Wrap the background fill and each shape in `# @item`/`# @end` directives,
   * so Room Studio opens the scene as named objects. The directives are
   * comments: annotated source compiles to the same bytes.
   */
  readonly annotate?: boolean;
}

export function sceneSource(
  backgroundColor: number,
  shapes: readonly SceneShape[],
  options?: SceneSourceOptions,
): string {
  const annotate = options?.annotate === true;
  const ids = annotate ? sceneItemIds(shapes) : [];
  const lines: string[] = [];
  if (annotate) lines.push('# @item background "Background" art');
  lines.push(`vis ${backgroundColor}`, "pri off", "fill 0,0");
  if (annotate) lines.push("# @end");
  for (const [index, shape] of shapes.entries()) {
    if (annotate) {
      const label = shape.label?.trim() || `Shape ${index + 1}`;
      lines.push(`# @item ${ids[index]!} ${JSON.stringify(label)} ${shapeItemKind(shape)}`);
    }
    lines.push(...shapeSource(shape));
    if (annotate) lines.push("# @end");
  }
  lines.push("end");
  return `${lines.join("\n")}\n`;
}
