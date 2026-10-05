import { test } from "node:test";
import assert from "node:assert/strict";
import { readDiskImage } from "../src/container/disk/image.ts";
import { fatDisk, adfDisk, prodosDisk, twoMg, td0Disk } from "./disk-images.ts";

for (const bpb of [true, false])
  test(`FAT12 ${bpb ? "BPB" : "pre-BPB"} extracts exact files`, () => {
    const expected = new Map([
      ["WORDS.TOK", new Uint8Array([17, 34, 51])],
      ["VOL.0", new Uint8Array(1100).fill(85)],
    ]);
    assert.deepEqual(readDiskImage("disk.img", fatDisk(expected, bpb)).files, expected);
  });
for (const ffs of [false, true])
  test(`ADF ${ffs ? "FFS" : "OFS"} follows subdirectory hash tables`, () => {
    assert.deepEqual(
      readDiskImage("disk.adf", adfDisk(ffs)).files,
      new Map([["GAME/WORDS.TOK", new Uint8Array([17, 34, 51])]]),
    );
  });
for (const wrapped of [false, true])
  test(`ProDOS ${wrapped ? "2MG" : "PO"} sapling file`, () => {
    const disk = prodosDisk();
    const files = readDiskImage(
      wrapped ? "disk.2mg" : "disk.po",
      wrapped ? twoMg(disk) : disk,
    ).files;
    assert.deepEqual(
      files.get("WORDS.TOK"),
      new Uint8Array([...new Uint8Array(512).fill(17), 34, 51, 68]),
    );
  });
test("DOS-order 2MG names the next action", () => {
  assert.throws(() => readDiskImage("disk.2mg", twoMg(prodosDisk(), 0)), /DOS order.*ProDOS order/);
});
test("TeleDisk normal extracts FAT files", () => {
  const expected = new Map([["WORDS.TOK", new Uint8Array([17, 34, 51])]]);
  assert.deepEqual(readDiskImage("disk.td0", td0Disk(fatDisk(expected))).files, expected);
});

test("TeleDisk advanced adaptive Huffman stream extracts exact files through frequency rebuilds", async () => {
  const { advancedTd0 } = await import("./lzh-writer.ts");
  const expected = new Map([["WORDS.TOK", new Uint8Array([17, 34, 51])]]);
  assert.deepEqual(
    readDiskImage("disk.td0", advancedTd0(td0Disk(fatDisk(expected)))).files,
    expected,
  );
});

test("LH1 hand-computed match vectors cover minimum and maximum length and distance", async () => {
  const { advancedBytes } = await import("../src/container/disk/lzh.ts");
  // Initial symbol 256: 10001100; distance zero: 000 000000.
  const short = advancedBytes(new Uint8Array([0x8c, 0, 0]));
  assert.deepEqual(Array.from({ length: 3 }, short), [32, 32, 32]);
  // Initial symbol 313: 11000101; distance 4095: 11111111 111111.
  const long = advancedBytes(new Uint8Array([0xc5, 0xff, 0xfc]));
  assert.deepEqual(Array.from({ length: 60 }, long), new Array(60).fill(32));
});

test("FAT file damage is retained by filename and an unrelated file survives", () => {
  const disk = fatDisk(
    new Map([
      ["WORDS.TOK", new Uint8Array([17])],
      ["BAD.TXT", new Uint8Array([34])],
    ]),
  );
  // Root second entry at byte 2592: cluster 356 exceeds this medium's data area.
  new DataView(disk.buffer).setUint16(5 * 512 + 32 + 26, 356, true);
  const result = readDiskImage("disk.img", disk);
  assert.deepEqual(result.files.get("WORDS.TOK"), new Uint8Array([17]));
  assert.match(result.unreadable.get("BAD.TXT")!, /cluster chain/);
});

test("FAT12 rejects a cluster cycle when a file needs more bytes", () => {
  const disk = fatDisk(new Map([["VOL.0", new Uint8Array(1100).fill(17)]]));
  // Cluster 2 now points back to itself, packed in FAT bytes 3..4.
  disk[515] = 2;
  disk[516] = disk[516]! & 240;
  assert.match(readDiskImage("disk.img", disk).unreadable.get("VOL.0")!, /cluster chain/);
});

test("ADF follows extension pointers after 72 data blocks", () => {
  const disk = adfDisk(true);
  const view = new DataView(disk.buffer);
  view.setUint32(11 * 512 + 8, 72);
  view.setUint32(11 * 512 + 324, 72 * 512 + 3);
  view.setUint32(11 * 512 + 504, 100);
  for (let index = 0; index < 72; index++) {
    view.setUint32(11 * 512 + 308 - index * 4, 20 + index);
    disk.fill(index, (20 + index) * 512, (21 + index) * 512);
  }
  view.setUint32(100 * 512, 16);
  view.setUint32(100 * 512 + 8, 1);
  view.setUint32(100 * 512 + 308, 101);
  view.setUint32(100 * 512 + 508, 0xfffffffd);
  disk.set([17, 34, 51], 101 * 512);
  for (const block of [11, 100]) {
    view.setUint32(block * 512 + 20, 0);
    let sum = 0;
    for (let at = 0; at < 512; at += 4) sum = (sum + view.getUint32(block * 512 + at)) >>> 0;
    view.setUint32(block * 512 + 20, -sum >>> 0);
  }
  const expected = new Uint8Array(72 * 512 + 3);
  for (let index = 0; index < 72; index++) expected.fill(index, index * 512, (index + 1) * 512);
  expected.set([17, 34, 51], 72 * 512);
  assert.deepEqual(readDiskImage("disk.adf", disk).files.get("GAME/WORDS.TOK"), expected);
});

test("ProDOS follows subdirectories and tree indexes including sparse blocks", () => {
  const disk = prodosDisk();
  const view = new DataView(disk.buffer);
  const at = 1028 + 39;
  disk[at] = 0xd4;
  disk.set(new TextEncoder().encode("DATA"), at + 1);
  view.setUint16(at + 17, 10, true);
  disk[10 * 512 + 4] = 0xe4;
  disk.set(new TextEncoder().encode("DATA"), 10 * 512 + 5);
  disk[10 * 512 + 35] = 39;
  disk[10 * 512 + 36] = 13;
  const file = 10 * 512 + 43;
  disk[file] = 0x35;
  disk.set(new TextEncoder().encode("VOL.0"), file + 1);
  view.setUint16(file + 17, 11, true);
  const size = 256 * 512 + 3;
  disk[file + 21] = size & 255;
  disk[file + 22] = (size >> 8) & 255;
  disk[file + 23] = size >> 16;
  disk[11 * 512] = 12;
  disk[11 * 512 + 1] = 13;
  disk[12 * 512] = 14;
  disk[13 * 512] = 15;
  disk.fill(85, 14 * 512, 15 * 512);
  disk.set([17, 34, 51], 15 * 512);
  const expected = new Uint8Array(size);
  expected.fill(85, 0, 512);
  expected.set([17, 34, 51], 256 * 512);
  assert.deepEqual(readDiskImage("disk.po", disk).files.get("DATA/VOL.0"), expected);
});

test("malformed image lengths and pointers fail without out-of-bounds reads", () => {
  for (const name of ["disk.img", "disk.adf", "disk.po", "disk.2mg", "disk.td0"])
    assert.throws(() => readDiskImage(name, new Uint8Array(8)), /disk|Disk|KiB/);
  const disk = adfDisk(true);
  new DataView(disk.buffer).setUint32(8, 1760);
  assert.throws(() => readDiskImage("disk.adf", disk), /block pointer/);
});

test("TeleDisk damaged protection sector is ignored, while a needed file names its damage", () => {
  const expected = new Map([["WORDS.TOK", new Uint8Array([17, 34, 51])]]);
  const td = td0Disk(fatDisk(expected));
  // Each track has four header bytes and nine 521-byte sector records.
  // Disk sector 18 is unused. Disk sector 12 holds the first file cluster.
  const record = (logical: number) =>
    12 + Math.floor(logical / 9) * (4 + 9 * 521) + 4 + (logical % 9) * 521;
  td[record(18) + 4] = 2;
  assert.deepEqual(readDiskImage("disk.td0", td).files, expected);
  td[record(12) + 4] = 2;
  assert.match(readDiskImage("disk.td0", td).unreadable.get("WORDS.TOK")!, /missing or damaged/);
});

test("a flagged damaged TeleDisk protection sector can carry undecodable bytes", () => {
  const expected = new Map([["WORDS.TOK", new Uint8Array([17, 34, 51])]]);
  const td = td0Disk(fatDisk(expected));
  const unused = 12 + 2 * (4 + 9 * 521) + 4;
  td[unused + 4] = 2;
  td[unused + 8] = 9;
  assert.deepEqual(readDiskImage("disk.td0", td).files, expected);
});

for (const encoding of [1, 2] as const)
  test(`TeleDisk sector RLE encoding ${encoding} preserves exact bytes`, () => {
    const data = Uint8Array.from({ length: 1100 }, (_, index) =>
      encoding === 1 ? (index % 2) + 17 : (index % 4) + 17,
    );
    const expected = new Map([
      ["VOL.0", data],
      ["WORDS.TOK", new Uint8Array([1, 2, 3])],
    ]);
    assert.deepEqual(
      readDiskImage("disk.td0", td0Disk(fatDisk(expected), encoding)).files,
      expected,
    );
  });

test("FAT12 reads a 1.44 MiB BPB and a nested 8.3 directory", () => {
  const large = new Uint8Array(1440 * 1024);
  const view = new DataView(large.buffer);
  view.setUint16(11, 512, true);
  large[13] = 1;
  view.setUint16(14, 1, true);
  large[16] = 2;
  view.setUint16(17, 224, true);
  view.setUint16(19, 2880, true);
  large[21] = 0xf0;
  view.setUint16(22, 9, true);
  large.set([0xf0, 255, 255, 255, 15], 512);
  large.set(new TextEncoder().encode("WORDS   TOK"), 19 * 512);
  view.setUint16(19 * 512 + 26, 2, true);
  view.setUint32(19 * 512 + 28, 3, true);
  large.set([17, 34, 51], 33 * 512);
  assert.deepEqual(
    readDiskImage("disk.ima", large).files.get("WORDS.TOK"),
    new Uint8Array([17, 34, 51]),
  );
  const small = fatDisk(
    new Map([
      ["GAME", new Uint8Array(1024)],
      ["VOL.0", new Uint8Array([17, 34, 51])],
    ]),
  );
  const sv = new DataView(small.buffer);
  small[5 * 512 + 11] = 16;
  small[5 * 512 + 32] = 0;
  small.set(new TextEncoder().encode("WORDS   TOK"), 12 * 512);
  sv.setUint16(12 * 512 + 26, 3, true);
  sv.setUint32(12 * 512 + 28, 3, true);
  assert.deepEqual(
    readDiskImage("disk.dsk", small).files.get("GAME/WORDS.TOK"),
    new Uint8Array([17, 34, 51]),
  );
});
