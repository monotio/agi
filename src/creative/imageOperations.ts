/** Image attachments and art operations shared by editors and agent tools. */
import { sha256Hex } from "../crypto.ts";
import type { ProjectChange, ProjectContent } from "../authoring/projectContent.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { buildView, parseView, type BuildViewInput } from "../view/view.ts";
import { prepareView, type ViewRecipeFrame } from "../view/preparation.ts";
import { derivePicturePlacement, preparePictureUnderlay } from "../picture/preparation.ts";
import type { Rect } from "./catalog.ts";
import { readImageReferences, type ProjectImageInput } from "./imageAttachments.ts";
export {
  readImageReferences,
  readProjectImage,
  type ProjectImageInput,
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
  const raster = sha256Hex(image.rgba);
  const references = readImageReferences(documents);
  const record = {
    title: image.title,
    mime: image.mime,
    encoded,
    raster,
    width: image.width,
    height: image.height,
  };
  const changes: ProjectChange[] = [
    { key: `attachment:${encoded}`, content: new Uint8Array(image.encoded) },
    ...(raster === encoded
      ? []
      : [{ key: `attachment:${raster}`, content: new Uint8Array(image.rgba) }]),
  ];
  const next = { ...references, images: { ...references.images, [encoded]: record } };
  readImageReferences({
    ...documents,
    ...Object.fromEntries(changes.map((c) => [c.key, c.content!])),
    images: JSON.stringify(next),
  });
  return { changes, references: next, encoded };
}
/** Attach an image and set its tracing opacity in one History commit. */
export function traceImageChanges(
  documents: Documents,
  target: string,
  image: ProjectImageInput,
  opacity = 0.4,
): readonly ProjectChange[] {
  const attached = attach(documents, image);
  const references = {
    ...attached.references,
    traces: { ...attached.references.traces, [target]: { image: attached.encoded, opacity } },
  };
  const changes = [...attached.changes, { key: "images", content: JSON.stringify(references) }];
  readImageReferences({
    ...documents,
    ...Object.fromEntries(changes.map((c) => [c.key, c.content!])),
  });
  return changes;
}
/** Suggest strips separated by empty columns; otherwise offer an editable regular grid. */
export function suggestImageFrames(
  image: Pick<ProjectImageInput, "width" | "height" | "rgba">,
  count?: number,
): readonly ImageFrame[] {
  const regions: Rect[] = [];
  if (count === undefined) {
    let start = -1;
    for (let x = 0; x <= image.width; x++) {
      let opaque = false;
      if (x < image.width)
        for (let y = 0; y < image.height; y++) {
          if (image.rgba[(y * image.width + x) * 4 + 3]! >= 128) {
            opaque = true;
            break;
          }
        }
      if (opaque && start < 0) start = x;
      if (!opaque && start >= 0) {
        regions.push({ x: start, y: 0, width: x - start, height: image.height });
        start = -1;
      }
    }
  }
  if (count !== undefined || regions.length < 2) {
    regions.length = 0;
    const columns = count ?? Math.min(4, image.width);
    if (!Number.isInteger(columns) || columns < 1 || columns > image.width)
      throw new Error("Choose a frame count that fits the sheet.");
    for (let i = 0; i < columns; i++) {
      const x = Math.floor((i * image.width) / columns);
      regions.push({
        x,
        y: 0,
        width: Math.floor(((i + 1) * image.width) / columns) - x,
        height: image.height,
      });
    }
  }
  return regions.map((region) => ({
    region,
    width: Math.min(32, region.width),
    height: Math.min(48, region.height),
    loop: 0,
  }));
}
export function prepareImageCels(
  image: ProjectImageInput,
  frames: readonly ImageFrame[],
  profile: AgiProfile,
) {
  const identity = { id: sha256Hex(image.rgba), incarnation: "image", revision: 0 };
  const preparedFrames: ViewRecipeFrame[] = frames.map((frame, i) => ({
    id: `frame-${i}`,
    source: identity,
    region: frame.region,
    outputWidth: frame.width,
    outputHeight: frame.height,
    sourceAnchor: {
      x: frame.region.x + Math.floor(frame.region.width / 2),
      baselineEdgeY: frame.region.y + frame.region.height,
    },
    outputAnchorX: Math.floor(frame.width / 2),
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
      mask: { alphaThreshold: 128, key: null },
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
  const prepared = prepareImageCels(image, frames, profile);
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

/** Rebuild a saved tracing underlay from its immutable decoded raster. */
export function imageTraceUnderlay(
  documents: Documents,
  target: string,
): { pixels: Uint8Array; opacity: number } | null {
  const references = readImageReferences(documents),
    trace = references.traces[target];
  if (!trace) return null;
  const image = references.images[trace.image]!;
  const identity = { id: image.raster, incarnation: "image", revision: 0 };
  const crop = { x: 0, y: 0, width: image.width, height: image.height };
  const placement = derivePicturePlacement({
    sourceWidth: image.width,
    sourceHeight: image.height,
    crop,
    bounds: { x: 0, y: 0, width: 160, height: 168 },
    fit: "contain",
    intendedAspect: "native",
  });
  const underlay = preparePictureUnderlay(
    {
      identity,
      width: image.width,
      height: image.height,
      rgba: documents[`attachment:${image.raster}`] as Uint8Array,
    },
    {
      format: "agi.preparation",
      version: 1,
      identity,
      sources: [identity],
      algorithm: "manual-picture-underlay-v1",
      preparation: {
        kind: "picture-underlay",
        source: identity,
        ...placement,
        fit: "contain",
        intendedAspect: "native",
        sample: "nearest-centre-v1",
        opacity: trace.opacity,
        palette: "ega-weighted-243-v1",
        alpha: { threshold: 128, matte: 0 },
        scope: "art",
      },
      destination: { kind: "picture", resourceId: Number(target.slice(8)) },
    },
  );
  return { pixels: underlay.rgba, opacity: trace.opacity };
}
