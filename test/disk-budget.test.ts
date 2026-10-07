import assert from "node:assert/strict";
import { test } from "node:test";
import { readDiskImage } from "../src/container/disk/image.ts";
import { fatDisk, adfDisk, prodosDisk, td0Disk, twoMg } from "./disk-images.ts";

function budget(maxBytes: number, maxFiles = 1024) {
  return { bytes: 0, files: 0, maxBytes, maxFiles };
}
for (const [name, image] of [
  ["disk.img", fatDisk(new Map([["IGNORED.TXT", Uint8Array.of(1, 2, 3)]]))],
  ["disk.adf", adfDisk(true)],
  ["disk.po", prodosDisk()],
  ["disk.2mg", twoMg(prodosDisk())],
  ["disk.td0", td0Disk(fatDisk(new Map([["IGNORED.TXT", Uint8Array.of(1, 2, 3)]])))],
] as const) {
  test(`${name} refuses output bytes before allocation, including ignored files`, () => {
    const shared = budget(2);
    assert.throws(
      () => readDiskImage(name, image, shared),
      /disks expand beyond.*Add one game at a time/,
    );
    assert.equal(shared.bytes, 0, "a refused allocation must not consume the budget");
  });
}
test("sparse ProDOS files share a byte budget across files and disks", () => {
  const disk = prodosDisk();
  const view = new DataView(disk.buffer);
  for (let slot = 1; slot <= 2; slot++) {
    const at = 1028 + slot * 39;
    disk.fill(0, at, at + 39);
    disk[at] = 0x35;
    disk.set(new TextEncoder().encode(`JUNK${slot}`), at + 1);
    view.setUint16(at + 17, 6, true);
    disk[at + 21] = 16;
  }
  disk.fill(0, 6 * 512, 7 * 512); // shared sparse master index
  const shared = budget(32);
  assert.equal(readDiskImage("one.po", disk, shared).files.size, 2);
  assert.equal(shared.bytes, 32);
  assert.throws(() => readDiskImage("two.po", disk, shared), /disks expand beyond/);
  assert.equal(shared.bytes, 32);
});
test("file count is shared across disks, including empty ignored files", () => {
  const image = fatDisk(new Map([["IGNORED.TXT", new Uint8Array()]]));
  const shared = budget(1024, 1);
  readDiskImage("one.img", image, shared);
  assert.throws(
    () => readDiskImage("two.img", image, shared),
    /too many files.*Add one game at a time/,
  );
});
