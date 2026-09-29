import { canonicalResourceName, isPlayableFileName } from "../container/playableFiles.ts";
import { sha256Hex } from "../crypto.ts";
import { requireResourceRevision, type ResourceRevision } from "../gameIdentity.ts";

/** Released sorted-name, length-delimited playable-byte identity. */
export function resourceRevisionBytes(files: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const normalized: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const [name, bytes] of Object.entries(files)) {
    if (!isPlayableFileName(name)) continue;
    const key = canonicalResourceName(name);
    if (Object.hasOwn(normalized, key)) throw new Error(`Duplicate game resource name: ${name}.`);
    normalized[key] = bytes;
  }
  // Playable canonical names are ASCII. Preserve the released big-endian lengths.
  const entries = Object.entries(normalized).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const packed = new Uint8Array(
    entries.reduce((size, [name, bytes]) => size + 8 + name.length + bytes.length, 0),
  );
  const view = new DataView(packed.buffer);
  let offset = 0;
  for (const [name, bytes] of entries) {
    view.setUint32(offset, name.length);
    view.setUint32(offset + 4, bytes.length);
    for (let i = 0; i < name.length; i++) packed[offset + 8 + i] = name.charCodeAt(i);
    packed.set(bytes, offset + 8 + name.length);
    offset += 8 + name.length + bytes.length;
  }
  return packed;
}

/** Synchronous core counterpart to the browser's native asynchronous digest. */
export function computeResourceRevision(
  files: Readonly<Record<string, Uint8Array>>,
): ResourceRevision {
  return requireResourceRevision(sha256Hex(resourceRevisionBytes(files)));
}
