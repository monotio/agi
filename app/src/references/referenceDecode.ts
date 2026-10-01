/**
 * Browser-side upload decode for reference art: `createImageBitmap` plus a
 * canvas readback, under the byte and pixel budgets declared in
 * referenceArt.ts. Kept out of referenceArt.ts so the storage model stays
 * platform-free — this module is UI-only and never imported by tests that
 * run under Node's strip-types runner.
 */
import { PROVIDER_IMAGE_BYTES, REFERENCE_WORKING_EDGE } from "../../../src/agent/toolTransport.ts";
import { REFERENCE_BYTE_LIMIT, REFERENCE_PIXEL_LIMIT, type DecodedImage } from "./referenceArt.ts";

function encode(canvas: HTMLCanvasElement, mime: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
          : reject(new Error("This browser could not encode the image.")),
      mime,
      0.92,
    ),
  );
}

/**
 * Decode an upload under the byte and pixel limits. Every refusal names its
 * constraint — a failed upload changes nothing stored.
 */
export async function decodeReferenceFile(file: Blob): Promise<DecodedImage> {
  if (file.size > REFERENCE_BYTE_LIMIT)
    throw new Error(
      `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB; the reference limit is ${REFERENCE_BYTE_LIMIT / 1024 / 1024} MB.`,
    );
  if (file.type !== "image/png" && file.type !== "image/jpeg" && file.type !== "image/webp")
    throw new Error("Choose a PNG, JPEG or WebP reference image.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file could not be decoded as an image. Choose a PNG, JPEG or WebP file.");
  }
  try {
    if (bitmap.width * bitmap.height > REFERENCE_PIXEL_LIMIT)
      throw new Error(
        `That image is ${bitmap.width}x${bitmap.height}; the reference limit is 4096x4096 pixels.`,
      );
    // A larger upload is stored at the working size agent turns view it at.
    const scale = Math.min(1, REFERENCE_WORKING_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not decode the image.");
    context.drawImage(bitmap, 0, 0, width, height);
    let mime = file.type;
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    if (scale < 1 || bytes.length > PROVIDER_IMAGE_BYTES) {
      bytes = await encode(canvas, mime);
      if (bytes.length > PROVIDER_IMAGE_BYTES) {
        mime = "image/jpeg";
        bytes = await encode(canvas, mime);
      }
    }
    return { rgba: context.getImageData(0, 0, width, height).data, width, height, mime, bytes };
  } finally {
    bitmap.close();
  }
}

/** A stored reference image's pixels, for read_reference_image and the turn manifest. */
export async function decodeStoredImage(
  bytes: Uint8Array,
  mime: string,
): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not decode the image.");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, rgba: data };
  } finally {
    bitmap.close();
  }
}
