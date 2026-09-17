/**
 * Browser-side upload decode for reference art: `createImageBitmap` plus a
 * canvas readback, under the byte and pixel budgets declared in
 * referenceArt.ts. Kept out of referenceArt.ts so the storage model stays
 * platform-free — this module is UI-only and never imported by tests that
 * run under Node's strip-types runner.
 */
import { REFERENCE_BYTE_LIMIT, REFERENCE_PIXEL_LIMIT, type DecodedImage } from "./referenceArt.ts";

/**
 * Decode an upload under the byte and pixel limits. Every refusal names its
 * constraint — a failed upload changes nothing stored.
 */
export async function decodeReferenceFile(file: Blob): Promise<DecodedImage> {
  if (file.size > REFERENCE_BYTE_LIMIT)
    throw new Error(
      `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the reference limit is ${REFERENCE_BYTE_LIMIT / 1024 / 1024} MB.`,
    );
  if (file.type !== "image/png" && file.type !== "image/jpeg" && file.type !== "image/webp")
    throw new Error("Choose a PNG, JPEG or WebP reference image.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file could not be decoded as an image — PNG, JPEG or WebP work.");
  }
  try {
    if (bitmap.width * bitmap.height > REFERENCE_PIXEL_LIMIT)
      throw new Error(
        `That image is ${bitmap.width}x${bitmap.height} — the reference limit is 4096x4096 pixels.`,
      );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not decode the image.");
    context.drawImage(bitmap, 0, 0);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      rgba: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
      width: bitmap.width,
      height: bitmap.height,
      mime: file.type,
      bytes,
    };
  } finally {
    bitmap.close();
  }
}
