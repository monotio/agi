import { advancedBytes } from "./lzh.ts";
import { diskView, type DiskFiles } from "./files.ts";
import { readFat12 } from "./fat12.ts";

/** TeleDisk records, sector RLE and flags, from the public format notes:
 * https://github.com/jmechnich/wteledsk/blob/master/doc/wteledsk.htm
 * https://www.classiccmp.org/dunfield/img54306/td0notes.txt
 * CRC polynomial 0xA097, initial value zero, most significant bit first.
 */
function checksum(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0xa097 : 0)) & 0xffff;
  }
  return crc;
}

export function readTeleDisk(input: Uint8Array): DiskFiles {
  const header = diskView(input, 0, 12);
  const advanced = input[0] === 116 && input[1] === 100;
  if ((!advanced && (input[0] !== 84 || input[1] !== 68)) || input[2] !== 0)
    throw new Error(
      "The TeleDisk header is damaged or names another image part. Add a complete disk image.",
    );
  if (advanced && input[4]! < 20)
    throw new Error(
      "This TeleDisk uses old advanced compression. Add a raw sector image or a TeleDisk 2 image.",
    );
  if (checksum(input.subarray(0, 10)) !== header.getUint16(10, true))
    throw new Error("The TeleDisk header checksum is damaged. Add a fresh copy of the disk.");
  let offset = 12;
  const next = advanced
    ? advancedBytes(input.subarray(12))
    : () => {
        if (offset >= input.length)
          throw new Error("TeleDisk ends early. Add a fresh copy of the disk.");
        return input[offset++]!;
      };
  const take = (count: number): Uint8Array => {
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i++) bytes[i] = next();
    return bytes;
  };
  if (input[7]! & 128) {
    const comment = take(10);
    take(comment[2]! | (comment[3]! << 8));
  }
  const sectors = new Map<string, Uint8Array>();
  let maxCylinder = 0;
  let maxHead = 0;
  let maxSector = 0;
  for (let tracks = 0; ; tracks++) {
    const count = next();
    if (count === 255) break;
    if (tracks >= 168) throw new Error("TeleDisk has too many tracks. Add a floppy disk image.");
    const track = take(3);
    const cylinder = track[0]!;
    const head = track[1]! & 1;
    maxCylinder = Math.max(maxCylinder, cylinder);
    maxHead = Math.max(maxHead, head);
    if ((checksum(new Uint8Array([count, ...track.subarray(0, 2)])) & 255) !== track[2])
      throw new Error("A TeleDisk track header is damaged. Add a fresh copy of the disk.");
    for (let index = 0; index < count; index++) {
      const sector = take(6);
      const id = sector[2]!;
      const flags = sector[4]!;
      if (sector[3]! > 6)
        throw new Error("A TeleDisk sector size is damaged. Add a fresh copy of the disk.");
      const size = 128 << sector[3]!;
      let decoded: Uint8Array | undefined;
      if (!(flags & 0x30)) {
        const lengthBytes = take(2);
        const length = lengthBytes[0]! | (lengthBytes[1]! << 8);
        if (!length)
          throw new Error("A TeleDisk sector record is empty. Add a fresh copy of the disk.");
        const packed = take(length);
        // Copy protection may deliberately store data that is not readable.
        // Consume the record, leaving its physical sector unavailable to FAT.
        if (flags & 0x42 || size !== 512) continue;
        decoded = new Uint8Array(size);
        let written = 0;
        const append = (pattern: Uint8Array, repeats: number): void => {
          if (written + pattern.length * repeats > size)
            throw new Error("TeleDisk sector RLE exceeds its size. Add a fresh copy of the disk.");
          for (let repeat = 0; repeat < repeats; repeat++) {
            decoded!.set(pattern, written);
            written += pattern.length;
          }
        };
        if (packed[0] === 0) append(packed.subarray(1), 1);
        else if (packed[0] === 1 && length === 5)
          append(packed.subarray(3, 5), packed[1]! | (packed[2]! << 8));
        else if (packed[0] === 2) {
          for (let at = 1; at < packed.length;) {
            if (at + 2 > packed.length)
              throw new Error("TeleDisk sector RLE ends early. Add a fresh copy of the disk.");
            const exponent = packed[at++]!;
            const repeats = packed[at++]!;
            if (exponent > 6)
              throw new Error(
                "TeleDisk sector RLE pattern is too large. Add a fresh copy of the disk.",
              );
            const countBytes = exponent ? 1 << exponent : repeats;
            if (at + countBytes > packed.length)
              throw new Error("TeleDisk sector RLE ends early. Add a fresh copy of the disk.");
            append(packed.subarray(at, at + countBytes), exponent ? repeats : 1);
            at += countBytes;
          }
        } else throw new Error("TeleDisk has an unknown sector encoding. Add a raw sector image.");
        if (written !== size)
          throw new Error(
            "TeleDisk sector size differs from its record. Add a fresh copy of the disk.",
          );
        if (flags & 2 || (checksum(decoded) & 255) !== sector[5]) decoded = undefined;
      }
      // Physical track addresses place sectors. Phantom IDs and missing ID
      // records belong to protection, not the filesystem's sector numbering.
      if (!id || id > 36 || flags & 64 || size !== 512) continue;
      maxSector = Math.max(maxSector, id);
      const key = `${cylinder}/${head}/${id}`;
      if (decoded && !sectors.has(key)) sectors.set(key, decoded);
    }
  }
  const boot = sectors.get("0/0/1");
  const bpb = boot && diskView(boot, 0, 512);
  const hasBpb = bpb?.getUint16(11, true) === 512;
  const perTrack = hasBpb ? bpb!.getUint16(24, true) : maxSector;
  const heads = hasBpb ? bpb!.getUint16(26, true) : maxHead + 1;
  const total = hasBpb ? bpb!.getUint16(19, true) : (maxCylinder + 1) * heads * perTrack;
  if (!perTrack || perTrack > 36 || ![1, 2].includes(heads) || total < 320 || total > 2880)
    throw new Error("TeleDisk has an unreadable PC geometry. Add a raw sector image.");
  const image = new Uint8Array(total * 512);
  const unavailable = new Set<number>();
  for (let logical = 0; logical < total; logical++) {
    const cylinder = Math.floor(logical / (heads * perTrack));
    const head = Math.floor(logical / perTrack) % heads;
    const sector = (logical % perTrack) + 1;
    const data = sectors.get(`${cylinder}/${head}/${sector}`);
    if (data) image.set(data, logical * 512);
    else unavailable.add(logical);
  }
  return readFat12(image, unavailable);
}
