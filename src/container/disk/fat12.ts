import {
  addDiskFile,
  diskName,
  diskView,
  createDiskExtractionBudget,
  reserveDiskBytes,
  type DiskExtractionBudget,
  type DiskFiles,
} from "./files.ts";

/** Microsoft FAT specification, BPB, cluster chains and 8.3 directory entries:
 * https://www.scs.stanford.edu/~zyedidia/docs/_other/fat.pdf
 * Pre-BPB DOS media geometry: IBM PC DOS Technical Reference, diskette formats.
 */
export function readFat12(
  image: Uint8Array,
  unavailable: ReadonlySet<number> = new Set(),
  budget: DiskExtractionBudget = createDiskExtractionBudget(),
): DiskFiles {
  if (image.length < 36)
    throw new Error("The disk has an unreadable FAT12 header. Add a fresh raw sector image.");
  const view = diskView(image, 0, image.length);
  let sectorBytes = view.getUint16(11, true);
  let clusterSectors = image[13]!;
  let reserved = view.getUint16(14, true);
  let fats = image[16]!;
  let rootEntries = view.getUint16(17, true);
  let sectors = view.getUint16(19, true) || view.getUint32(32, true);
  let fatSectors = view.getUint16(22, true);
  if (sectorBytes !== 512) {
    const legacy: Record<string, readonly number[]> = {
      "163840": [0xfe, 1, 1, 64],
      "184320": [0xfc, 1, 2, 64],
      "327680": [0xff, 2, 1, 112],
      "368640": [0xfd, 2, 2, 112],
    };
    const geometry = legacy[String(image.length)];
    if (!geometry || image[512] !== geometry[0])
      throw new Error("The disk has an unreadable FAT12 header. Add a fresh raw sector image.");
    sectorBytes = 512;
    clusterSectors = geometry[1]!;
    fatSectors = geometry[2]!;
    rootEntries = geometry[3]!;
    reserved = 1;
    fats = 2;
    sectors = image.length / 512;
  }
  const rootSectors = Math.ceil((rootEntries * 32) / sectorBytes);
  const rootStart = reserved + fats * fatSectors;
  const dataStart = rootStart + rootSectors;
  const clusters = Math.floor((sectors - dataStart) / clusterSectors);
  if (
    image.length < 160 * 1024 ||
    image.length > 1440 * 1024 ||
    ![1, 2, 4, 8].includes(clusterSectors) ||
    reserved < 1 ||
    fats < 1 ||
    fats > 2 ||
    !rootEntries ||
    !fatSectors ||
    sectors * sectorBytes > image.length ||
    clusters < 1 ||
    clusters >= 4085 ||
    Math.ceil(((clusters + 2) * 3) / 2) > fatSectors * sectorBytes
  )
    throw new Error("The disk has an invalid FAT12 layout. Add a fresh raw sector image.");
  const read = (start: number, length: number): Uint8Array => {
    diskView(image, start, length);
    for (let sector = Math.floor(start / 512); sector < Math.ceil((start + length) / 512); sector++)
      if (unavailable.has(sector))
        throw new Error(
          `Sector ${sector + 1} is missing or damaged. Add a fresh copy of the disk.`,
        );
    return image.subarray(start, start + length);
  };
  const fat = read(reserved * sectorBytes, fatSectors * sectorBytes);
  const chain = (first: number, size?: number): Uint8Array => {
    if (size !== undefined) reserveDiskBytes(budget, size);
    if (size === 0) return new Uint8Array();
    const parts: Uint8Array[] = [];
    const seen = new Set<number>();
    let cluster = first;
    let total = 0;
    while (cluster < 0xff8) {
      if (cluster < 2 || cluster >= clusters + 2 || seen.has(cluster))
        throw new Error(
          "The file has a damaged FAT12 cluster chain. Add a fresh copy of the disk.",
        );
      seen.add(cluster);
      const part = read(
        (dataStart + (cluster - 2) * clusterSectors) * sectorBytes,
        clusterSectors * sectorBytes,
      );
      if (size === undefined) reserveDiskBytes(budget, part.length);
      parts.push(part);
      total += part.length;
      if (size !== undefined && total >= size) break;
      const at = Math.floor((cluster * 3) / 2);
      const pair = fat[at]! | (fat[at + 1]! << 8);
      cluster = cluster & 1 ? pair >> 4 : pair & 0xfff;
    }
    if (size !== undefined && total < size)
      throw new Error("The file ends early. Add a fresh copy of the disk.");
    const output = new Uint8Array(size ?? total);
    let offset = 0;
    for (const part of parts) {
      output.set(part.subarray(0, output.length - offset), offset);
      offset += Math.min(part.length, output.length - offset);
    }
    return output;
  };
  const result: DiskFiles = { files: new Map(), unreadable: new Map() };
  const directories = new Set<number>();
  const visit = (bytes: Uint8Array, path: string, depth: number): void => {
    if (depth > 32)
      throw new Error("The disk has a damaged directory tree. Add a fresh copy of the disk.");
    const directory = diskView(bytes, 0, bytes.length);
    for (let at = 0; at + 32 <= bytes.length; at += 32) {
      if (bytes[at] === 0) break;
      if (bytes[at] === 0xe5 || bytes[at + 11]! & 8 || bytes[at] === 46) continue;
      const base = diskName(bytes.subarray(at, at + 8)).trimEnd();
      const ext = Array.from(bytes.subarray(at + 8, at + 11), (b) => String.fromCharCode(b))
        .join("")
        .trimEnd();
      const name =
        path +
        base +
        (ext ? "." + diskName(Uint8Array.from(ext, (letter) => letter.charCodeAt(0))) : "");
      const first = directory.getUint16(at + 26, true);
      if (bytes[at + 11]! & 16) {
        if (directories.has(first))
          throw new Error("The disk has a directory cycle. Add a fresh copy of the disk.");
        directories.add(first);
        visit(chain(first), name + "/", depth + 1);
      } else
        addDiskFile(result, name, budget, () => chain(first, directory.getUint32(at + 28, true)));
    }
  };
  visit(read(rootStart * sectorBytes, rootEntries * 32), "", 0);
  return result;
}
