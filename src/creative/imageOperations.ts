/** Image attachments and art operations shared by editors and agent tools. */
import { snapImageToEga } from "./imageStyle.ts";
import { encodePngRgba } from "./composite.ts";
import { sha256Hex } from "../crypto.ts";
import type { ProjectChange, ProjectContent } from "../authoring/projectContent.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { buildView, parseView, type BuildViewInput } from "../view/view.ts";
import { prepareView, type ViewRecipeFrame } from "../view/preparation.ts";
import type { Rect } from "./catalog.ts";
import {
  readImageReferences,
  readProjectImage,
  type ProjectImageInput,
  type TraceTransform,
} from "./imageAttachments.ts";
export {
  readImageReferences,
  readProjectImage,
  type ProjectImageInput,
  type TraceTransform,
} from "./imageAttachments.ts";
type Documents = Readonly<Record<string, ProjectContent>>;

export interface ImageFrame {
  readonly region: Rect;
  readonly width: number;
  readonly height: number;
  readonly loop: number;
}
function attach(documents: Documents, image: ProjectImageInput) {
  const encoded = sha256Hex(image.encoded);
  const png = encodePngRgba(image.width, image.height, image.rgba);
  const raster = sha256Hex(png);
  const references = readImageReferences(documents);
  const record = {
    title: image.title,
    mime: image.mime,
    encoded,
    raster,
    rasterEncoding: "png" as const,
    width: image.width,
    height: image.height,
  };
  const changes: ProjectChange[] = [
    { key: `attachment:${encoded}`, content: new Uint8Array(image.encoded) },
    ...(raster === encoded ? [] : [{ key: `attachment:${raster}`, content: png }]),
  ];
  const next = { ...references, images: { ...references.images, [encoded]: record } };
  readImageReferences({
    ...documents,
    ...Object.fromEntries(changes.map((c) => [c.key, c.content!])),
    images: JSON.stringify(next),
  });
  return { changes, references: next, encoded };
}
/** Attach an image and set its tracing opacity and placement in one History commit. */
export function traceImageChanges(
  documents: Documents,
  target: string,
  image: ProjectImageInput,
  opacity = 0.4,
  behindArt = false,
): readonly ProjectChange[] {
  const attached = attach(documents, image);
  const references = {
    ...attached.references,
    traces: {
      ...attached.references.traces,
      [target]: {
        image: attached.encoded,
        opacity,
        behindArt,
        transform: { x: 0, y: 0, scale: 1 },
      },
    },
  };
  const changes = [...attached.changes, { key: "images", content: JSON.stringify(references) }];
  readImageReferences({
    ...documents,
    ...Object.fromEntries(changes.map((c) => [c.key, c.content!])),
  });
  return changes;
}
/** Change display options while reusing immutable image attachments. */
export function traceOptionsChanges(
  documents: Documents,
  target: string,
  opacity: number,
  behindArt: boolean,
  transform?: TraceTransform,
): readonly ProjectChange[] {
  const references = readImageReferences(documents);
  const trace = references.traces[target];
  if (!trace) throw new Error("Choose an image to trace first.");
  const next = {
    ...references,
    traces: {
      ...references.traces,
      [target]: { ...trace, opacity, behindArt, ...(transform ? { transform } : {}) },
    },
  };
  readImageReferences({ ...documents, images: JSON.stringify(next) });
  return [{ key: "images", content: JSON.stringify(next) }];
}

/** Transparent sheets use alpha; opaque sheets use the most common corner colour. */
export function detectImageBackground(
  image: Pick<ProjectImageInput, "width" | "height" | "rgba">,
): readonly [number, number, number] | null {
  for (let i = 3; i < image.rgba.length; i += 4) if (image.rgba[i]! < 128) return null;
  const colours: Record<string, number> = {};
  const size = Math.min(16, Math.max(1, Math.floor(Math.min(image.width, image.height) / 8)));
  for (const left of [0, image.width - size])
    for (const top of [0, image.height - size])
      for (let y = top; y < top + size; y++)
        for (let x = left; x < left + size; x++) {
          const offset = (y * image.width + x) * 4;
          const key = `${image.rgba[offset]},${image.rgba[offset + 1]},${image.rgba[offset + 2]}`;
          colours[key] = (colours[key] ?? 0) + 1;
        }
  const key = Object.keys(colours).sort((a, b) => colours[b]! - colours[a]!)[0]!;
  const rgb = key.split(",").map(Number);
  return [rgb[0]!, rgb[1]!, rgb[2]!];
}
/** One scale for both axes, rounded to native cel pixels. */
export function scaleImageFrame(region: Rect, requestedHeight: number) {
  const scale =
    Math.min(Math.max(1, Math.round(requestedHeight)), 168, (160 * region.height) / region.width) /
    region.height;
  return {
    width: Math.max(1, Math.round(region.width * scale)),
    height: Math.max(1, Math.round(region.height * scale)),
  };
}
/** Separate figures at empty column and row gaps, then box each region tightly. */
export function suggestImageFrames(
  image: Pick<ProjectImageInput, "width" | "height" | "rgba">,
  count?: number,
): readonly ImageFrame[] {
  const background = detectImageBackground(image);
  const foreground = new Uint8Array(image.width * image.height);
  for (let i = 0; i < foreground.length; i++) {
    const offset = i * 4;
    foreground[i] =
      image.rgba[offset + 3]! >= 128 &&
      (background === null ||
        background.some((c, channel) => Math.abs(image.rgba[offset + channel]! - c) > 24))
        ? 1
        : 0;
  }
  function bands(region: Rect, horizontal: boolean): Rect[] {
    const result: Rect[] = [];
    const length = horizontal ? region.width : region.height;
    let start = -1;
    for (let axis = 0; axis <= length; axis++) {
      let occupied = false;
      if (axis < length) {
        for (let cross = 0; cross < (horizontal ? region.height : region.width); cross++) {
          const x = region.x + (horizontal ? axis : cross);
          const y = region.y + (horizontal ? cross : axis);
          if (foreground[y * image.width + x]) {
            occupied = true;
            break;
          }
        }
      }
      if (occupied && start < 0) start = axis;
      if (!occupied && start >= 0) {
        result.push(
          horizontal
            ? { ...region, x: region.x + start, width: axis - start }
            : { ...region, y: region.y + start, height: axis - start },
        );
        start = -1;
      }
    }
    return result;
  }
  function connected(region: Rect): Rect[] {
    const result: Rect[] = [];
    for (let y = region.y; y < region.y + region.height; y++)
      for (let x = region.x; x < region.x + region.width; x++) {
        const start = y * image.width + x;
        if (foreground[start] !== 1) continue;
        const pending = [start];
        foreground[start] = 2;
        let left = x,
          right = x,
          top = y,
          bottom = y;
        while (pending.length) {
          const pixel = pending.pop()!;
          const px = pixel % image.width,
            py = Math.floor(pixel / image.width);
          left = Math.min(left, px);
          right = Math.max(right, px);
          top = Math.min(top, py);
          bottom = Math.max(bottom, py);
          for (
            let ny = Math.max(region.y, py - 1);
            ny <= Math.min(region.y + region.height - 1, py + 1);
            ny++
          )
            for (
              let nx = Math.max(region.x, px - 1);
              nx <= Math.min(region.x + region.width - 1, px + 1);
              nx++
            ) {
              const neighbour = ny * image.width + nx;
              if (foreground[neighbour] !== 1) continue;
              foreground[neighbour] = 2;
              pending.push(neighbour);
            }
        }
        result.push({ x: left, y: top, width: right - left + 1, height: bottom - top + 1 });
      }
    return result;
  }
  const whole = { x: 0, y: 0, width: image.width, height: image.height };
  let regions: Rect[];
  if (count !== undefined) {
    if (!Number.isInteger(count) || count < 1 || count > image.width)
      throw new Error("Choose a frame count that fits the sheet.");
    regions = Array.from({ length: count }, (_, i) => {
      const x = Math.floor((i * image.width) / count);
      return { ...whole, x, width: Math.floor(((i + 1) * image.width) / count) - x };
    });
  } else {
    // A column band can contain several rows; recheck columns within each row.
    regions = bands(whole, true).flatMap((column) =>
      bands(column, false).flatMap((row) => bands(row, true)),
    );
    regions = regions.flatMap(connected);
    regions.sort((a, b) => a.y - b.y || a.x - b.x);
    // Single-row sheets read left to right even when the figures have uneven tops.
    if (regions.every((a) => regions.every((b) => a.y < b.y + b.height && b.y < a.y + a.height)))
      regions.sort((a, b) => a.x - b.x);
  }
  return regions.map((region) => ({
    region,
    ...scaleImageFrame(region, Math.min(24, region.height)),
    loop: 0,
  }));
}
export function prepareImageCels(
  image: ProjectImageInput,
  frames: readonly ImageFrame[],
  profile: AgiProfile,
  background = detectImageBackground(image),
  transparent = true,
) {
  const identity = { id: sha256Hex(image.rgba), incarnation: "image", revision: 0 };
  const preparedFrames: ViewRecipeFrame[] = frames.map((frame, i) => ({
    id: `frame-${i}`,
    source: identity,
    region: frame.region,
    outputWidth: frame.width,
    outputHeight: frame.height,
    sourceAnchor: {
      x: frame.region.x,
      baselineEdgeY: frame.region.y + frame.region.height,
    },
    outputAnchorX: 0,
    sample: "nearest-centre-v1",
    allowCropBelowBaseline: false,
    allowCropOutsideCanvas: false,
  }));
  if (frames.some((f) => !Number.isInteger(f.loop) || f.loop < 0 || f.loop > 254))
    throw new Error("Choose a loop from 0 to 254.");
  const loops = [...new Set(frames.map((f) => f.loop))].sort((a, b) => a - b);
  return prepareView(
    [{ identity, width: image.width, height: image.height, rgba: image.rgba }],
    {
      format: "agi.preparation",
      version: 1,
      kind: "view",
      algorithm: "manual-view-preparation-v1",
      sources: [identity],
      palette: "ega-weighted-243-v1",
      mask: {
        alphaThreshold: transparent ? 128 : 0,
        key: !transparent || background === null ? null : { mode: "ega-index-v1", rgb: background },
      },
      frames: preparedFrames,
      loops: loops.map((loop) => ({
        id: `loop-${loop}`,
        frameIds: frames.flatMap((f, i) => (f.loop === loop ? [`frame-${i}`] : [])),
      })),
    },
    profile,
  );
}
/** Append all selected frames and their attachment atomically, preserving existing cels. */
export function makeCelsChanges(
  documents: Documents,
  target: string,
  image: ProjectImageInput,
  frames: readonly ImageFrame[],
  profile: AgiProfile,
  background = detectImageBackground(image),
  transparent = true,
): readonly ProjectChange[] {
  if (!/^view:(0|[1-9]\d{0,2})$/.test(target) || Number(target.slice(5)) > 255)
    throw new Error("Choose a VIEW target.");
  const existing = documents[target];
  const parsed = existing instanceof Uint8Array ? parseView(existing, profile) : undefined;
  const input: BuildViewInput =
    typeof existing === "string"
      ? (JSON.parse(existing) as BuildViewInput)
      : {
          loops:
            parsed?.loops.map((loop) => ({
              cels: loop.cels.map((cel) => ({
                width: cel.width,
                height: cel.height,
                transparentColor: cel.transparentColor,
                pixels: cel.pixels,
              })),
            })) ?? [],
          ...(parsed?.description ? { description: parsed.description } : {}),
        };
  const prepared = prepareImageCels(image, frames, profile, background, transparent);
  const loops = input.loops.map((loop) => ({ ...loop, cels: [...(loop.cels ?? [])] }));
  const destinations = [...new Set(frames.map((f) => f.loop))].sort((a, b) => a - b);
  for (const [i, destination] of destinations.entries()) {
    while (loops.length <= destination) loops.push({ cels: [] });
    const loop = loops[destination]!;
    if (typeof loop.mirrorLoop === "number" && !loop.cels.length) {
      const displayed = parseView(buildView(input, profile), profile).loops[destination]!;
      loop.cels.push(
        ...displayed.cels.map((cel) => ({
          width: cel.width,
          height: cel.height,
          transparentColor: cel.transparentColor,
          pixels: cel.pixels,
        })),
      );
    }
    delete loop.mirrorLoop;
    loop.cels.push(...prepared.input.loops[i]!.cels!);
  }
  for (const loop of loops.slice(input.loops.length)) {
    if (!loop.cels.length)
      loop.cels.push({ width: 1, height: 1, transparentColor: 0, pixels: [0] });
  }
  const attached = attach(documents, image);
  return [
    ...attached.changes,
    { key: "images", content: JSON.stringify(attached.references) },
    { key: target, content: buildView({ ...input, loops }, profile) },
  ];
}

/** Cover the native picture frame, preserving the source aspect at two display pixels per cell. */
export function prepareTracePixels(
  image: Pick<ProjectImageInput, "width" | "height" | "rgba">,
  transform: TraceTransform = { x: 0, y: 0, scale: 1 },
): Uint8Array {
  const factor = Math.max(320 / image.width, 168 / image.height) * transform.scale;
  const pixels = new Uint8Array(160 * 168 * 4);
  for (let y = 0; y < 168; y++)
    for (let x = 0; x < 160; x++) {
      const sx = Math.floor(image.width / 2 + ((x + 0.5 - 80 - transform.x) * 2) / factor);
      const sy = Math.floor(image.height / 2 + (y + 0.5 - 84 - transform.y) / factor);
      if (sx >= 0 && sx < image.width && sy >= 0 && sy < image.height) {
        const source = (sy * image.width + sx) * 4;
        pixels.set(image.rgba.subarray(source, source + 4), (y * 160 + x) * 4);
      }
    }
  return snapImageToEga(pixels);
}

/** Rebuild a saved tracing underlay from its immutable decoded raster. */
export function imageTraceUnderlay(
  documents: Documents,
  target: string,
): { pixels: Uint8Array; opacity: number; behindArt: boolean; transform: TraceTransform } | null {
  const references = readImageReferences(documents),
    trace = references.traces[target];
  if (!trace) return null;
  const image = readProjectImage(documents, trace.image);
  const transform = trace.transform ?? {
    x: 0,
    y: 0,
    scale:
      Math.min(320 / image.width, 168 / image.height) /
      Math.max(320 / image.width, 168 / image.height),
  };
  return {
    pixels: prepareTracePixels(image, transform),
    opacity: trace.opacity,
    behindArt: trace.behindArt ?? false,
    transform,
  };
}
