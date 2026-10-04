/** Strict codecs for immutable project image attachments. */
import { inspectCreativeImageHeader } from "./imageHeader.ts";
import { sha256Hex } from "../crypto.ts";
import type { ProjectContent } from "../authoring/projectContent.ts";
export interface ProjectImageInput {
  readonly title: string;
  readonly mime: string;
  readonly encoded: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}
interface ProjectImageReference {
  readonly title: string;
  readonly mime: string;
  readonly encoded: string;
  readonly raster: string;
  readonly rasterEncoding?: "png";
  readonly width: number;
  readonly height: number;
}
export interface ImageReferences {
  readonly format: "agi.image-references";
  readonly version: 1;
  readonly images: Readonly<Record<string, ProjectImageReference>>;
  readonly traces: Readonly<
    Record<
      string,
      { readonly image: string; readonly opacity: number; readonly behindArt?: boolean }
    >
  >;
}
type Documents = Readonly<Record<string, ProjectContent>>;
function exactFields(value: unknown, fields: readonly string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Invalid image reference fields.");
}
/** Resolve an attachment for reuse without sharing mutable project bytes. */
export function readProjectImage(documents: Documents, id: string): ProjectImageInput {
  const image = readImageReferences(documents).images[id];
  if (!image) throw new Error("Choose an image attached to this project.");
  return {
    title: image.title,
    mime: image.mime,
    width: image.width,
    height: image.height,
    encoded: new Uint8Array(documents[`attachment:${image.encoded}`] as Uint8Array),
    rgba: readRaster(documents, image),
  };
}
export function readImageReferences(documents: Documents): ImageReferences {
  const text = documents["images"];
  if (text === undefined)
    return { format: "agi.image-references", version: 1, images: {}, traces: {} };
  if (typeof text !== "string") throw new Error("Image references must be text.");
  const value = JSON.parse(text) as ImageReferences;
  exactFields(value, ["format", "version", "images", "traces"]);
  if (value.format !== "agi.image-references" || value.version !== 1)
    throw new Error("Unsupported image references format or version.");
  exactFields(value.images, Object.keys(value.images ?? {}));
  exactFields(value.traces, Object.keys(value.traces ?? {}));
  for (const [hash, image] of Object.entries(value.images)) {
    exactFields(image, [
      "title",
      "mime",
      "encoded",
      "raster",
      "width",
      "height",
      ...(Object.hasOwn(image, "rasterEncoding") ? ["rasterEncoding"] : []),
    ]);
    if (image.rasterEncoding !== undefined && image.rasterEncoding !== "png")
      throw new Error("Unsupported image raster encoding.");
    if (
      hash !== image.encoded ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      !/^[a-f0-9]{64}$/.test(image.raster) ||
      typeof image.title !== "string" ||
      typeof image.mime !== "string" ||
      !Number.isInteger(image.width) ||
      !Number.isInteger(image.height) ||
      image.width < 1 ||
      image.height < 1 ||
      image.width * image.height > 16 * 1024 * 1024
    )
      throw new Error("Invalid image attachment descriptor.");
    for (const id of [image.encoded, image.raster]) {
      const bytes = documents[`attachment:${id}`];
      if (!(bytes instanceof Uint8Array) || sha256Hex(bytes) !== id)
        throw new Error("Image attachment bytes differ from their hash.");
    }
    if (readRaster(documents, image).length !== image.width * image.height * 4)
      throw new Error("Image attachment raster has the wrong length.");
  }
  for (const [key, trace] of Object.entries(value.traces)) {
    exactFields(trace, [
      "image",
      "opacity",
      ...(Object.hasOwn(trace, "behindArt") ? ["behindArt"] : []),
    ]);
    if (trace.behindArt !== undefined && typeof trace.behindArt !== "boolean")
      throw new Error("Invalid image trace placement.");
    if (
      !/^picture:(0|[1-9]\d{0,2})$/.test(key) ||
      Number(key.slice(8)) > 255 ||
      !Object.hasOwn(value.images, trace.image) ||
      !Number.isFinite(trace.opacity) ||
      trace.opacity < 0 ||
      trace.opacity > 1
    )
      throw new Error("Invalid image trace opacity or target.");
  }
  return value;
}

/** Decode the deterministic PNG raster written by image operations; old raw bytes remain readable. */
function readRaster(documents: Documents, image: ProjectImageReference): Uint8Array {
  const bytes = documents[`attachment:${image.raster}`] as Uint8Array;
  if (image.rasterEncoding === undefined) return new Uint8Array(bytes);
  // The canonical writer uses filter 0 and stored deflate blocks. Provider PNGs
  // are kept as originals; only canonical rasters use this restricted reader.
  const header = inspectCreativeImageHeader(bytes);
  if (
    !header.ok ||
    header.header.format !== "png" ||
    header.header.width !== image.width ||
    header.header.height !== image.height ||
    bytes[24] !== 8 ||
    bytes[25] !== 6
  )
    throw new Error("Invalid image raster PNG header.");
  const stride = image.width * 4 + 1;
  const raw = new Uint8Array(stride * image.height);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8,
    written = 0;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) throw new Error("Invalid image raster PNG.");
    if (
      bytes[offset + 4] === 73 &&
      bytes[offset + 5] === 68 &&
      bytes[offset + 6] === 65 &&
      bytes[offset + 7] === 84
    ) {
      let cursor = offset + 10;
      const end = offset + 8 + length - 4;
      while (cursor < end) {
        if ((bytes[cursor++]! & 6) !== 0 || cursor + 4 > end)
          throw new Error("Invalid image raster PNG block.");
        const size = view.getUint16(cursor, true);
        if (
          view.getUint16(cursor + 2, true) !== (size ^ 65535) ||
          cursor + 4 + size > end ||
          written + size > raw.length
        )
          throw new Error("Invalid image raster PNG length.");
        cursor += 4;
        raw.set(bytes.subarray(cursor, cursor + size), written);
        written += size;
        cursor += size;
      }
    }
    offset += length + 12;
  }
  if (written !== raw.length) throw new Error("Invalid image raster PNG size.");
  const rgba = new Uint8Array(image.width * image.height * 4);
  for (let y = 0; y < image.height; y++) {
    if (raw[y * stride] !== 0) throw new Error("Invalid image raster PNG filter.");
    rgba.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * image.width * 4);
  }
  return rgba;
}
