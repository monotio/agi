/**
 * FNV-1a 32-bit content hash. Continuations and checkpoints key on resource
 * bytes rather than an instance counter, so a parked pass survives a reload
 * of the same files and is dropped when the bytes it resumes into changed.
 */
export function fnv1a32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}
