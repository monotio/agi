/**
 * Compute SHA-256 hex digest of a byte array safely in browser environments.
 * Copies the bytes first so a view over a larger or transferred buffer hashes correctly.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
