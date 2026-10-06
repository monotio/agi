import { addDiskFile, diskName, diskView, type DiskFiles } from "./files.ts";

/** Apple's ProDOS Technical Reference, appendix B (file organization):
 * https://prodos8.com/docs/techref/file-organization/
 * 2IMG header specification: https://ciderpress2.com/formatdoc/TwoIMG-notes.html
 */
export function readProDos(input: Uint8Array, wrapped: boolean): DiskFiles {
  let image = input;
  if (wrapped) {
    const header = diskView(input, 0, 64);
    if (
      header.getUint32(0) !== 0x32494d47 ||
      header.getUint16(8, true) < 64 ||
      header.getUint16(10, true) > 1
    )
      throw new Error("The 2MG header is damaged. Add a fresh copy of the disk.");
    if (header.getUint32(12, true) !== 1)
      throw new Error("This 2MG uses DOS order or nibble data. Add a 2MG saved in ProDOS order.");
    const start = header.getUint32(24, true);
    const length = header.getUint32(28, true);
    if (start < header.getUint16(8, true))
      throw new Error("The 2MG payload overlaps its header. Add a fresh copy of the disk.");
    diskView(input, start, length);
    image = input.subarray(start, start + length);
    if (header.getUint32(20, true) * 512 !== length)
      throw new Error("The 2MG block count is damaged. Add a fresh copy of the disk.");
  }
  if (image.length !== 800 * 1024) throw new Error("Choose an 800 KiB ProDOS disk image.");
  const block = (id: number): DataView => {
    if (id < 2)
      throw new Error("The disk has a damaged ProDOS block pointer. Add a fresh copy of the disk.");
    return diskView(image, id * 512, 512);
  };
  const pointer = (index: number, slot: number): number => {
    const data = block(index);
    return data.getUint8(slot) | (data.getUint8(256 + slot) << 8);
  };
  const result: DiskFiles = { files: new Map(), unreadable: new Map() };
  const directories = new Set<number>();
  const visit = (first: number, path: string, depth: number): void => {
    if (depth > 32)
      throw new Error(
        "The disk has a damaged ProDOS directory tree. Add a fresh copy of the disk.",
      );
    const header = block(first);
    if (
      header.getUint8(4) >> 4 !== (first === 2 ? 15 : 14) ||
      header.getUint8(35) !== 39 ||
      header.getUint8(36) !== 13
    )
      throw new Error(
        "The disk has a damaged ProDOS directory header. Add a fresh copy of the disk.",
      );
    let current = first;
    while (current) {
      if (directories.has(current))
        throw new Error("The disk has a ProDOS directory cycle. Add a fresh copy of the disk.");
      directories.add(current);
      const directory = block(current);
      for (let slot = current === first ? 1 : 0; slot < 13; slot++) {
        const at = 4 + slot * 39;
        const packed = directory.getUint8(at);
        const type = packed >> 4;
        if (!type) continue;
        const name =
          path +
          diskName(image.subarray(current * 512 + at + 1, current * 512 + at + 1 + (packed & 15)));
        const key = directory.getUint16(at + 17, true);
        if (type === 13) {
          visit(key, name + "/", depth + 1);
          continue;
        }
        addDiskFile(result, name, () => {
          if (![1, 2, 3].includes(type))
            throw new Error(
              "This ProDOS file uses an unsupported storage type. Add an extracted copy of the file.",
            );
          const size =
            directory.getUint8(at + 21) |
            (directory.getUint8(at + 22) << 8) |
            (directory.getUint8(at + 23) << 16);
          if (size > image.length || (type === 1 && size > 512) || (type === 2 && size > 256 * 512))
            throw new Error("The ProDOS file length is damaged. Add a fresh copy of the disk.");
          const output = new Uint8Array(size);
          for (let offset = 0; offset < size; offset += 512) {
            const index = offset / 512;
            const sapling = type === 3 ? pointer(key, Math.floor(index / 256)) : key;
            const id = type === 1 ? key : sapling ? pointer(sapling, index % 256) : 0;
            if (id) {
              block(id);
              output.set(image.subarray(id * 512, id * 512 + Math.min(512, size - offset)), offset);
            }
          }
          return output;
        });
      }
      current = directory.getUint16(2, true);
    }
  };
  visit(2, "", 0);
  return result;
}
