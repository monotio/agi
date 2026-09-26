/**
 * Scene shapes lowered to picture source text: the pure compiler behind the
 * agent `write_scene` tool and Room Studio shape authoring. A shape with
 * `color: null` draws on the priority plane only.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface RectShape {
  readonly kind: "rect";
  readonly color: number | null;
  readonly priority: number | null;
  readonly filled: boolean;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface PathShape {
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

export function sceneSource(backgroundColor: number, shapes: readonly SceneShape[]): string {
  const lines = [`vis ${backgroundColor}`, "pri off", "fill 0,0"];
  for (const shape of shapes) lines.push(...shapeSource(shape));
  lines.push("end");
  return `${lines.join("\n")}\n`;
}
