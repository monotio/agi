import { buildZip } from "../src/archive/zip.ts";

/** Reproduce the released omission in a production-written STORED ZIP, keeping every other entry. */
export function unstampedArchive(zip: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries = [];
  for (let at = 0; view.getUint32(at, true) === 0x04034b50;) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extraLength;
    let data = zip.subarray(start, start + size);
    if (name === "GAME.JSON" || name === "PROJECT.JSON") {
      const metadata = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
      delete metadata["authoringConventions"];
      data = new TextEncoder().encode(JSON.stringify(metadata));
    }
    entries.push({ name, data });
    at = start + size;
  }
  return buildZip(entries);
}
