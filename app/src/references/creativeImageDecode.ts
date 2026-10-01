/**
 * Browser-side intake for creative image originals.
 *
 * Unlike the legacy reference decode (which downsizes and re-encodes for
 * provider transport), this adapter keeps the offered file as the stored
 * original: it captures the exact encoded bytes and their SHA-256, inspects
 * the header while the input is still just bytes — oversized files, unknown
 * signatures, truncated structure and over-budget dimensions all refuse
 * before createImageBitmap or a canvas exists — then decodes once into an
 * sRGB canvas and freezes an owned unpremultiplied RGBA8 snapshot with its
 * SHA-256 in the catalog's `rgba8-srgb-unpremultiplied-v1` representation.
 *
 * The decoded raster is the observed authority for replay: no claim is made
 * that another browser would decode lossy input identically. Browsers also
 * disagree on applying EXIF orientation during decode, so the decoder is
 * fed a transient copy with orientation metadata removed and the captured
 * orientation is applied exactly once through the canvas transform; a
 * decoded size that disagrees with the admitted header is an honest
 * refusal, never silently trusted.
 *
 * Animated containers refuse with the named `frame-selection` condition: a
 * still here would silently pick a first frame the user never chose. The
 * error carries the inspected header so a later UI can offer the selection.
 *
 * One image decodes at a time through a module queue, bounding transient
 * memory; an AbortSignal refuses already-aborted work up front and late
 * results after every await. Nothing here touches the network, a provider
 * or any stored state.
 */
import { sha256Hex } from "../../../src/crypto.ts";
import {
  CREATIVE_LIMITS,
  RASTER_FORMAT,
  type BlobRef,
  type RasterRef,
} from "../../../src/creative/catalog.ts";
import {
  CREATIVE_IMAGE_MIME,
  decodeCopyWithoutOrientation,
  inspectCreativeImageHeader,
  orientedImageDimensions,
  type CreativeImageFormat,
  type CreativeImageHeader,
  type ImageHeaderReason,
} from "../../../src/creative/imageHeader.ts";

/** MIME label carried by canonical raster blobs. */
export const CREATIVE_RASTER_MIME = "application/x-rgba8";

/** Why an image offer was refused. */
export type CreativeImageReason =
  | ImageHeaderReason
  /** The source is animated; picking one frame lands with the 1.2 frame-selection work. */
  | "frame-selection"
  /** The browser could not decode the admitted bytes. */
  | "decode"
  /** The decoded pixels disagree with the admitted header. */
  | "inconsistent"
  /** The caller aborted the import. */
  | "cancelled";

export class CreativeImageError extends Error {
  readonly reason: CreativeImageReason;
  /** The inspected header, present when inspection succeeded before the refusal. */
  readonly header?: CreativeImageHeader;
  constructor(reason: CreativeImageReason, message: string, header?: CreativeImageHeader) {
    super(message);
    this.name = "CreativeImageError";
    this.reason = reason;
    if (header !== undefined) this.header = header;
  }
}

export interface CreativeImageIntake {
  readonly format: CreativeImageFormat;
  /** Declared stored dimensions before orientation. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** EXIF orientation 1..8 that was applied exactly once. */
  readonly orientation: number;
  /** Descriptor for the exact offered bytes. */
  readonly encoded: BlobRef;
  /** The exact encoded original, owned by the caller. */
  readonly encodedBytes: Uint8Array;
  /** Descriptor for the canonical raster blob. */
  readonly normalized: RasterRef;
  /** Owned unpremultiplied RGBA8 pixels; normalized.blob.hash authenticates them. */
  readonly pixels: Uint8Array;
}

const MAX_FILE_BYTES = CREATIVE_LIMITS.maxFileBytes;

/**
 * The canvas transform that draws a stored w×h bitmap into its oriented
 * output for each TIFF orientation. The decode copy carries no orientation
 * metadata, so this single drawImage is the only application — the same in
 * every engine.
 */
function orientationTransform(
  orientation: number,
  width: number,
  height: number,
): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, width, 0];
    case 3:
      return [-1, 0, 0, -1, width, height];
    case 4:
      return [1, 0, 0, -1, 0, height];
    case 5:
      return [0, 1, 1, 0, 0, 0];
    case 6:
      return [0, 1, -1, 0, height, 0];
    case 7:
      return [0, -1, -1, 0, height, width];
    case 8:
      return [0, -1, 1, 0, 0, width];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

async function decodeOnce(file: Blob, signal?: AbortSignal): Promise<CreativeImageIntake> {
  const checkAborted = (): void => {
    if (signal?.aborted) throw new CreativeImageError("cancelled", "The import was cancelled.");
  };
  checkAborted();
  if (!(file instanceof Blob))
    throw new CreativeImageError("signature", "Choose a PNG, JPEG or WebP image file.");
  if (file.size > MAX_FILE_BYTES)
    throw new CreativeImageError(
      "oversize",
      `That file is ${Math.ceil(file.size / 1024 / 1024)} MB; imports accept up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
    );
  // The offered bytes are captured once and kept whole: what the caller gave
  // is what the original descriptor hashes.
  const encodedBytes = new Uint8Array(await file.arrayBuffer());
  checkAborted();
  const verdict = inspectCreativeImageHeader(encodedBytes);
  if (!verdict.ok) throw new CreativeImageError(verdict.reason, verdict.message);
  const header = verdict.header;
  if (header.animated)
    throw new CreativeImageError(
      "frame-selection",
      "That image is animated; this version imports still images.",
      header,
    );
  const oriented = orientedImageDimensions(header);
  // The transient decode copy carries no orientation metadata: browser
  // decoders disagree on whether and how they apply EXIF, so the captured
  // header orientation is applied explicitly through the canvas transform
  // below — once, and identically in every engine. The stored original
  // bytes keep all of their metadata untouched.
  const decodeBytes = decodeCopyWithoutOrientation(encodedBytes, header.format);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([decodeBytes]), {
      colorSpaceConversion: "default",
      premultiplyAlpha: "none",
    });
  } catch (cause) {
    checkAborted();
    const error = new CreativeImageError(
      "decode",
      "That file could not be decoded as an image. Choose a PNG, JPEG or WebP file.",
      header,
    );
    error.cause = cause;
    throw error;
  }
  try {
    checkAborted();
    // The copy holds no orientation, so the decode must match the stored
    // dimensions exactly.
    if (bitmap.width !== header.width || bitmap.height !== header.height)
      throw new CreativeImageError(
        "inconsistent",
        `That image decoded to ${bitmap.width}x${bitmap.height}; its header declares ${header.width}x${header.height}.`,
        header,
      );
    let pixels: Uint8Array;
    const canvas = document.createElement("canvas");
    canvas.width = oriented.width;
    canvas.height = oriented.height;
    try {
      const context = canvas.getContext("2d", {
        colorSpace: "srgb",
        willReadFrequently: true,
      });
      if (context === null)
        throw new CreativeImageError("decode", "This browser could not decode the image.", header);
      context.setTransform(
        ...orientationTransform(header.orientation, header.width, header.height),
      );
      context.drawImage(bitmap, 0, 0);
      // getImageData returns unpremultiplied sRGB RGBA8 — the canonical form.
      pixels = new Uint8Array(
        context.getImageData(0, 0, oriented.width, oriented.height).data.buffer,
      );
    } finally {
      // Release the backing store now rather than leaving it to collection.
      canvas.width = 0;
      canvas.height = 0;
    }
    checkAborted();
    return {
      format: header.format,
      sourceWidth: header.width,
      sourceHeight: header.height,
      orientation: header.orientation,
      encoded: {
        hash: sha256Hex(encodedBytes),
        byteLength: encodedBytes.length,
        mime: CREATIVE_IMAGE_MIME[header.format],
      },
      encodedBytes,
      normalized: {
        blob: {
          hash: sha256Hex(pixels),
          byteLength: pixels.length,
          mime: CREATIVE_RASTER_MIME,
        },
        format: RASTER_FORMAT,
        width: oriented.width,
        height: oriented.height,
      },
      pixels,
    };
  } finally {
    bitmap.close();
  }
}

// Decodes are serialized so transient peak memory stays at one image.
let intakeTail: Promise<unknown> = Promise.resolve();

/**
 * Inspect and decode one still image file into a creative-source intake
 * record: exact original bytes + canonical sRGB raster, each with its hash.
 * Throws CreativeImageError with a stable reason on any refusal.
 */
export function decodeCreativeImage(
  file: Blob,
  signal?: AbortSignal,
): Promise<CreativeImageIntake> {
  const run = intakeTail.then(() => decodeOnce(file, signal));
  intakeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
