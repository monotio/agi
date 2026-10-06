import { addDiskFile, diskName, diskView, type DiskFiles } from "./files.ts";

/** ADF format FAQ, §§4.2–4.4: hash chains, reversed pointers, extension blocks.
 * https://adflib.github.io/FAQ/adf_info.html
 */
export function readAdf(image: Uint8Array): DiskFiles {
  if (
    image.length !== 880 * 1024 ||
    image[0] !== 68 ||
    image[1] !== 79 ||
    image[2] !== 83 ||
    image[3]! > 5
  )
    throw new Error("Choose an 880 KiB Amiga OFS or FFS disk image.");
  const ffs = Boolean(image[3]! & 1);
  const block = (id: number, metadata = true): DataView => {
    if (id < 2)
      throw new Error("The disk has a damaged Amiga block pointer. Add a fresh copy of the disk.");
    const view = diskView(image, id * 512, 512);
    if (metadata) {
      let sum = 0;
      for (let at = 0; at < 512; at += 4) sum = (sum + view.getUint32(at)) >>> 0;
      if (sum)
        throw new Error(`Amiga block ${id} has a damaged checksum. Add a fresh copy of the disk.`);
    }
    return view;
  };
  const result: DiskFiles = { files: new Map(), unreadable: new Map() };
  const seen = new Set<number>();
  const visit = (id: number, path: string, depth: number): void => {
    if (seen.has(id) || depth > 32)
      throw new Error("The disk has a damaged Amiga directory tree. Add a fresh copy of the disk.");
    seen.add(id);
    const dir = block(id);
    if (dir.getUint32(0) !== 2)
      throw new Error("The disk has a damaged Amiga directory. Add a fresh copy of the disk.");
    for (let slot = 0; slot < 72; slot++) {
      let entry = dir.getUint32(24 + slot * 4);
      while (entry) {
        if (seen.has(entry))
          throw new Error("The disk has an Amiga hash chain cycle. Add a fresh copy of the disk.");
        const header = block(entry);
        const length = header.getUint8(432);
        if (!length || length > 30)
          throw new Error("The disk has a damaged Amiga filename. Add a fresh copy of the disk.");
        const name = path + diskName(image.subarray(entry * 512 + 433, entry * 512 + 433 + length));
        const type = header.getInt32(508);
        if (type === 2) visit(entry, name + "/", depth + 1);
        else {
          seen.add(entry);
          if (type === -3)
            addDiskFile(result, name, () => {
              const size = header.getUint32(324);
              if (size > image.length)
                throw new Error(
                  "The Amiga file length exceeds the disk. Add a fresh copy of the disk.",
                );
              const output = new Uint8Array(size);
              let written = 0;
              let current = entry;
              const extensions = new Set<number>();
              while (written < size) {
                if (extensions.has(current))
                  throw new Error(
                    "The Amiga file has an extension cycle. Add a fresh copy of the disk.",
                  );
                extensions.add(current);
                const pointers = block(current);
                if (
                  pointers.getUint32(0) !== (current === entry ? 2 : 16) ||
                  pointers.getUint32(8) > 72
                )
                  throw new Error(
                    "The Amiga file has a damaged header. Add a fresh copy of the disk.",
                  );
                for (let index = 0; index < pointers.getUint32(8) && written < size; index++) {
                  const dataId = pointers.getUint32(308 - index * 4);
                  const data = block(dataId, !ffs);
                  const count = ffs ? 512 : data.getUint32(12);
                  if (!count || count > (ffs ? 512 : 488) || (!ffs && data.getUint32(0) !== 8))
                    throw new Error(
                      "The Amiga file has a damaged data block. Add a fresh copy of the disk.",
                    );
                  const take = Math.min(count, size - written);
                  output.set(
                    image.subarray(
                      dataId * 512 + (ffs ? 0 : 24),
                      dataId * 512 + (ffs ? 0 : 24) + take,
                    ),
                    written,
                  );
                  written += take;
                }
                current = pointers.getUint32(504);
                if (!current && written < size)
                  throw new Error("The Amiga file ends early. Add a fresh copy of the disk.");
              }
              return output;
            });
        }
        entry = header.getUint32(496);
      }
    }
  };
  visit(diskView(image, 0, 12).getUint32(8) || 880, "", 0);
  return result;
}
