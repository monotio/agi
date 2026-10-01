/** Strict codecs for immutable project image attachments. */
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
  readonly width: number;
  readonly height: number;
}
export interface ImageReferences {
  readonly format: "agi.image-references";
  readonly version: 1;
  readonly images: Readonly<Record<string, ProjectImageReference>>;
  readonly traces: Readonly<Record<string, { readonly image: string; readonly opacity: number }>>;
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
    rgba: new Uint8Array(documents[`attachment:${image.raster}`] as Uint8Array),
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
    exactFields(image, ["title", "mime", "encoded", "raster", "width", "height"]);
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
    if (
      (documents[`attachment:${image.raster}`] as Uint8Array).length !==
      image.width * image.height * 4
    )
      throw new Error("Image attachment raster has the wrong length.");
  }
  for (const [key, trace] of Object.entries(value.traces)) {
    exactFields(trace, ["image", "opacity"]);
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
