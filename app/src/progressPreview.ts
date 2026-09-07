/** Authentic composed-frame thumbnails stored with resumable autosaves. */

import { encodePngPaletteRgb } from "../../src/picture/png.ts";
import { compositeFrame, FRAME_HEIGHT, FRAME_WIDTH, type CompositeInput } from "./composite.ts";

const PREVIEW_PREFIX = "data:image/png;base64,";
export const MAX_PROGRESS_PREVIEW_DATA_URL_LENGTH = 128 * 1024;

function pngDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `${PREVIEW_PREFIX}${btoa(binary)}`;
}

/** Compose and losslessly encode the exact engine frame at an autosave boundary. */
export function createProgressPreview(input: CompositeInput): string {
  if (input.visual.length !== 160 * 168) {
    throw new RangeError(
      `progress preview: expected 26880 visual bytes, got ${input.visual.length}`,
    );
  }
  if (input.text.length !== 40 * 25 * 2) {
    throw new RangeError(`progress preview: expected 2000 text bytes, got ${input.text.length}`);
  }
  if (!Number.isInteger(input.picRow) || input.picRow < 0 || input.picRow >= 25) {
    throw new RangeError(`progress preview: bad picture row ${input.picRow}`);
  }
  const rgba = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  compositeFrame(input, rgba);
  const rgb = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 3);
  for (let pixel = 0; pixel < FRAME_WIDTH * FRAME_HEIGHT; pixel++) {
    rgb[pixel * 3] = rgba[pixel * 4]!;
    rgb[pixel * 3 + 1] = rgba[pixel * 4 + 1]!;
    rgb[pixel * 3 + 2] = rgba[pixel * 4 + 2]!;
  }
  const preview = pngDataUrl(encodePngPaletteRgb(FRAME_WIDTH, FRAME_HEIGHT, rgb));
  if (preview.length > MAX_PROGRESS_PREVIEW_DATA_URL_LENGTH) {
    throw new RangeError(`progress preview exceeds ${MAX_PROGRESS_PREVIEW_DATA_URL_LENGTH} bytes`);
  }
  return preview;
}

/** Reject active, remote, oversized or structurally invalid content before a resume card. */
export function isProgressPreview(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_PROGRESS_PREVIEW_DATA_URL_LENGTH ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return false;
  }
  try {
    const png = atob(value.slice(PREVIEW_PREFIX.length));
    if (
      png.length < 57 ||
      png.charCodeAt(0) !== 0x89 ||
      png.slice(1, 4) !== "PNG" ||
      png.charCodeAt(4) !== 13 ||
      png.charCodeAt(5) !== 10 ||
      png.charCodeAt(6) !== 26 ||
      png.charCodeAt(7) !== 10
    ) {
      return false;
    }
    let offset = 8;
    let palette = false;
    let pixels = false;
    while (offset + 12 <= png.length) {
      const length =
        png.charCodeAt(offset) * 0x1000000 +
        png.charCodeAt(offset + 1) * 0x10000 +
        png.charCodeAt(offset + 2) * 0x100 +
        png.charCodeAt(offset + 3);
      if (length > png.length - offset - 12) return false;
      const type = png.slice(offset + 4, offset + 8);
      if (offset === 8) {
        if (
          type !== "IHDR" ||
          length !== 13 ||
          png.charCodeAt(offset + 8) * 0x1000000 +
            png.charCodeAt(offset + 9) * 0x10000 +
            png.charCodeAt(offset + 10) * 0x100 +
            png.charCodeAt(offset + 11) !==
            FRAME_WIDTH ||
          png.charCodeAt(offset + 12) * 0x1000000 +
            png.charCodeAt(offset + 13) * 0x10000 +
            png.charCodeAt(offset + 14) * 0x100 +
            png.charCodeAt(offset + 15) !==
            FRAME_HEIGHT ||
          png.charCodeAt(offset + 16) !== 8 ||
          png.charCodeAt(offset + 17) !== 3
        ) {
          return false;
        }
      } else if (type === "PLTE") {
        palette = length >= 3 && length <= 768 && length % 3 === 0;
      } else if (type === "IDAT") {
        pixels ||= length > 0;
      } else if (type === "IEND") {
        return length === 0 && offset + 12 === png.length && palette && pixels;
      }
      offset += 12 + length;
    }
    return false;
  } catch {
    return false;
  }
}

export interface ProgressRecordStorage {
  setItem(key: string, value: string): void;
}

export type StoredProgressRecord<T> = Omit<T, "preview"> & { preview?: string };

/** Retry quota-sensitive persistence without the optional thumbnail. */
export function storeRecordWithPreviewFallback<T extends { preview?: string }>(
  storage: ProgressRecordStorage,
  key: string,
  record: T,
): StoredProgressRecord<T> | null {
  try {
    storage.setItem(key, JSON.stringify(record));
    return record;
  } catch {
    if (!record.preview) return null;
  }
  const fallback: StoredProgressRecord<T> = { ...record };
  delete fallback.preview;
  try {
    storage.setItem(key, JSON.stringify(fallback));
    return fallback;
  } catch {
    return null;
  }
}
