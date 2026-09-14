/** Decode the v2 loader's 128-byte evolving XOR key. See docs/fidelity.md. */
export function descrambleAgi(data: Uint8Array, initialKey: Uint8Array): Uint8Array {
  if (initialKey.length !== 128) throw new Error("AGI loader key must be 128 bytes.");
  const key = initialKey.slice();
  const out = new Uint8Array(data.length);
  let carry = 0;
  for (let block = 0; block * 128 < data.length; block++) {
    for (let i = 0; i < 128 && block * 128 + i < data.length; i++)
      out[block * 128 + i] = data[block * 128 + i]! ^ key[i]!;
    for (let i = 0; i < 128; i++) {
      const next = key[i]! & 1;
      key[i] = (key[i]! >> 1) | (carry << 7);
      carry = next;
    }
    // The loader ORs the final carry into key[0], and its saved flags retain
    // that same carry for the first RCR of the following block.
    key[0] = key[0]! | (carry << 7);
  }
  return out;
}
