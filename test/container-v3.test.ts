import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactContainer,
  openContainer,
  detectContainerFormat,
} from "../src/container/container.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import {
  buildLogicResource,
  parseLogicResource,
  toggleMessageEncryption,
} from "../src/logic/resource.ts";
import { RESOURCE_KINDS, type ResourceKind } from "../src/types.ts";
import { readGameZip } from "../app/src/gameZip.ts";
import { buildZip } from "../app/src/zip.ts";

// Original synthetic records; offsets and expanded payloads are specified by hand.
function record(stored: number[], expanded = stored.length, metadata = 0): Uint8Array {
  return Uint8Array.from([
    0x12,
    0x34,
    metadata,
    expanded & 255,
    expanded >> 8,
    stored.length & 255,
    stored.length >> 8,
    ...stored,
  ]);
}
/** One-entry combined directory: `entry` fills the section of `kind`, the rest are absent. */
function game(
  stored: Uint8Array,
  entry = [0, 0, 0],
  kind: ResourceKind = "logic",
): Map<string, Uint8Array> {
  const sections = RESOURCE_KINDS.flatMap((k) => (k === kind ? entry : [255, 255, 255]));
  return new Map([
    ["DEMODIR", Uint8Array.from([8, 0, 11, 0, 14, 0, 17, 0, ...sections])],
    ["DEMOVOL.0", stored],
  ]);
}

// Test-only bit placement with explicit widths: independent of dictionary state.
function packed(codes: readonly number[], widths: readonly number[]): number[] {
  const output: number[] = [];
  let position = 0;
  for (let i = 0; i < codes.length; i++) {
    for (let bit = 0; bit < widths[i]!; bit++, position++)
      output[position >> 3] =
        (output[position >> 3] ?? 0) | (((codes[i]! >> bit) & 1) << (position & 7));
  }
  return output;
}

describe("v3 combined resources", () => {
  it("discovers combined directories and patches seven-byte records without obsolete payloads", () => {
    const original = record([3, 4]);
    const c = openContainer(game(original));
    assert.deepEqual(c.getResource("logic", 0), Uint8Array.of(3, 4));
    c.putResource("logic", 0, Uint8Array.of(7));
    c.putResource("picture", 2, Uint8Array.of(255));
    assert.deepEqual(c.files.get("DEMOVOL.0"), Uint8Array.from([...record([7]), ...record([255])]));
    assert.equal(c.files.has("VOL.0"), false);
    assert.deepEqual(c.files.get("DEMODIR")!.slice(0, 8), Uint8Array.of(8, 0, 11, 0, 20, 0, 23, 0));
    const reopened = openContainer(c.files);
    assert.deepEqual(reopened.getResource("logic", 0), Uint8Array.of(7));
    assert.deepEqual(reopened.getResource("picture", 2), Uint8Array.of(255));
    assert.equal(reopened.getResource("picture", 1), null);
  });
  it("uses exact ff ff ff absence, allowing volume 15", () => {
    const files = game(record([42]), [0xf0, 0, 0]);
    files.delete("DEMOVOL.0");
    files.set("DEMOVOL.15", record([42], 1, 15));
    const c = openContainer(files);
    assert.deepEqual(c.getResource("logic", 0), Uint8Array.of(42));
    c.putResource("sound", 0, Uint8Array.of(9));
    assert.deepEqual(openContainer(c.files).getResource("sound", 0), Uint8Array.of(9));
  });
  it("selects v3 split fallback from its interpreter version with an empty prefix", () => {
    const files = new Map([
      ["LOGDIR", Uint8Array.of(0, 0, 0)],
      ["VOL.0", record([5])],
      ["AGIDATA.OVL", new TextEncoder().encode("Version 3.002.102")],
    ]);
    assert.deepEqual(openContainer(files).getResource("logic", 0), Uint8Array.of(5));
  });
  it("uses seven-byte prefixed records with split directory fallback", () => {
    const files = new Map([
      ["LOGDIR", Uint8Array.of(0, 0, 0)],
      ["DEMOVOL.0", record([5])],
    ]);
    const c = openContainer(files, { kind: "v3-combined", prefix: "DEMO" });
    assert.deepEqual(c.getResource("logic", 0), Uint8Array.of(5));
    c.putResource("view", 1, Uint8Array.of(8));
    assert.deepEqual(
      openContainer(c.files, { kind: "v3-combined", prefix: "DEMO" }).getResource("view", 1),
      Uint8Array.of(8),
    );
  });
  it("expands LSB-first reset, dictionary and special next-code sequences", () => {
    // 100, 41, 42, 102, 104, 101 => A B AB ABA.
    const compressed = [0x00, 0x83, 0x08, 0x11, 0x48, 0x30, 0x20];
    assert.deepEqual(
      openContainer(game(record(compressed, 7 + 0), undefined, "view")).getResource("view", 0),
      Uint8Array.from(compressed),
    ); // Equal lengths select direct storage before dictionary.
    const codes = [256, 65, 66, 258, 260, 257];
    // Add a repeated dictionary code to avoid equal stored/expanded lengths.
    const stored = packed([...codes.slice(0, -1), 260, 257], Array(7).fill(9));
    assert.deepEqual(
      openContainer(game(record(stored, 10), undefined, "view")).getResource("view", 0),
      Uint8Array.from([65, 66, 65, 66, 65, 66, 65, 65, 66, 65]),
    );
  });
  it("changes code width at 512 and 1024 entries and resets midstream", () => {
    const literals = Array.from({ length: 768 }, (_, i) => i & 255);
    const codes = [256, ...literals, 256, 90, 90, 257];
    const widths = [9, ...literals.map((_, i) => (i <= 254 ? 9 : i <= 766 ? 10 : 11)), 11, 9, 9, 9];
    const stored = packed(codes, widths);
    assert.deepEqual(
      openContainer(game(record(stored, 770), undefined, "view")).getResource("view", 0),
      Uint8Array.from([...literals, 90, 90]),
    );
  });
  it("re-encrypts the plain message text of a dictionary-compressed logic record", () => {
    // return; plus one message. Compressed records carry the text plain
    // (observed v3 data), so the stored stream is the toggled payload as
    // literals: reset, one 9-bit literal per byte, end.
    const encrypted = buildLogicResource(Uint8Array.of(0x00), ["Sound now Off"]);
    const plain = toggleMessageEncryption(encrypted);
    assert.notDeepEqual(plain, encrypted);
    assert.equal(
      String.fromCharCode(...plain.subarray(plain.length - 14, plain.length - 1)),
      "Sound now Off",
    );
    const stored = packed([256, ...plain, 257], Array(plain.length + 2).fill(9));
    assert.notEqual(stored.length, plain.length);
    const c = openContainer(game(record(stored, plain.length)));
    assert.deepEqual(c.getResource("logic", 0), encrypted);
    assert.deepEqual(parseLogicResource(c.getResource("logic", 0)!).messages, ["Sound now Off"]);
    // A directly stored record is already in the encrypted layout.
    assert.deepEqual(
      parseLogicResource(openContainer(game(record([...encrypted]))).getResource("logic", 0)!)
        .messages,
      ["Sound now Off"],
    );
    // Repacking copies the compressed record verbatim; it still decodes.
    c.putResource("view", 1, Uint8Array.of(8));
    assert.deepEqual(parseLogicResource(c.getResource("logic", 0)!).messages, ["Sound now Off"]);
    // Toggling tolerates framing that does not fit, leaving the bytes alone,
    // including a declared text end beyond the payload.
    assert.deepEqual(toggleMessageEncryption(Uint8Array.of(9, 9, 9)), Uint8Array.of(9, 9, 9));
    const oversized = encrypted.slice();
    const tableStart = 2 + 1 + 1;
    oversized[tableStart] = 0xff;
    oversized[tableStart + 1] = 0x7f;
    assert.deepEqual(toggleMessageEncryption(oversized), oversized);
  });
  it("expands packed picture color nibbles and an optional zero pad nibble", () => {
    for (const [stored, expected] of [
      [
        [0xf0, 0xaf, 0x2b, 0xff],
        [0xf0, 10, 0xf2, 11, 255],
      ],
      [
        [0xf0, 0xaf, 0xf0],
        [0xf0, 10, 255],
      ],
    ]) {
      assert.deepEqual(
        openContainer(game(record(stored!, expected!.length, 0x80))).getResource("logic", 0),
        Uint8Array.from(expected!),
      );
    }
  });
  it("imports and reexports a nested v3 ZIP without discarding prefixed resources", async () => {
    const files = game(record([1, 0, 0, 0, 2, 0]));
    files.set("WORDS.TOK", new Uint8Array(52));
    const imported = await readGameZip(
      buildZip([...files].map(([name, data]) => ({ name: `Demo/${name}`, data }))),
    );
    const c = openContainer(new Map(Object.entries(imported.files)));
    c.putResource("picture", 1, Uint8Array.of(255));
    const again = await readGameZip(buildZip([...c.files].map(([name, data]) => ({ name, data }))));
    assert.deepEqual(
      openContainer(new Map(Object.entries(again.files))).getResource("picture", 1),
      Uint8Array.of(255),
    );
    assert.equal("LOGDIR" in again.files, false);
  });
});

it("packing preserves v3 dictionary and picture records, including aliases and metadata", () => {
  const dictionary = record(packed([256, 65, 66, 258, 260, 260, 257], Array(7).fill(9)), 10, 15);
  const picture = record([0xf0, 0xaf, 0x2b, 0xff], 5, 0xbf);
  const files = new Map<string, Uint8Array>([
    [
      "DEMODIR",
      Uint8Array.of(8, 0, 14, 0, 17, 0, 17, 0, 0xf0, 0, 0, 0xf0, 0, 0, 0xf0, 0, dictionary.length),
    ],
    ["DEMOVOL.15", Uint8Array.from([...dictionary, ...picture, 99, 98])],
  ]);
  const clean = compactContainer(files);
  const expectedDictionary = dictionary.slice();
  expectedDictionary[2] = 0;
  const expectedPicture = picture.slice();
  expectedPicture[2] = 0xb0;
  assert.deepEqual(
    clean.get("DEMOVOL.0"),
    Uint8Array.from([...expectedDictionary, ...expectedPicture]),
  );
  assert.equal(clean.has("DEMOVOL.15"), false);
  const c = openContainer(clean);
  assert.deepEqual(
    c.getResource("logic", 0),
    Uint8Array.of(65, 66, 65, 66, 65, 66, 65, 65, 66, 65),
  );
  assert.deepEqual(c.getResource("logic", 1), c.getResource("logic", 0));
  assert.deepEqual(c.getResource("picture", 0), Uint8Array.of(0xf0, 10, 0xf2, 11, 255));
  c.putResource("sound", 255, Uint8Array.of(8));
  assert.deepEqual(
    c.files.get("DEMOVOL.0")!.slice(0, dictionary.length + picture.length),
    clean.get("DEMOVOL.0"),
  );
});

it("canonicalizes invalid compressed records without dropping their indexed identity", () => {
  const c = openContainer(game(record([0, 0], 10)));
  assert.throws(() => c.getResource("logic", 0), /Dictionary stream must start with reset/);
  c.putResource("view", 8, Uint8Array.of(1));
  assert.throws(() => c.getResource("logic", 0), /out of bounds/);
  assert.deepEqual(c.files.get("DEMODIR")!.slice(8, 11), Uint8Array.of(15, 255, 255));
  assert.deepEqual(c.getResource("view", 8), Uint8Array.of(1));
});

it("leaves all files unchanged when a combined directory cannot grow", () => {
  const directory = new Uint8Array(65535).fill(255);
  directory.set([8, 0, 8, 0, 8, 0, 8, 0]);
  const c = openContainer(
    new Map([
      ["DEMODIR", directory],
      ["DEMOVOL.0", new Uint8Array(0)],
    ]),
  );
  const before = new Map([...c.files].map(([name, bytes]) => [name, bytes.slice()]));
  assert.throws(() => c.putResource("logic", 255, Uint8Array.of(7)), /Combined directory exceeds/);
  assert.deepEqual(c.files, before);
});

it("unifies detection and profile for empty-prefix v3 container (DIR and VOL.0)", () => {
  const original = record([5, 6]);
  const sections = RESOURCE_KINDS.flatMap((k) => (k === "logic" ? [0, 0, 0] : [255, 255, 255]));
  const files = new Map<string, Uint8Array>([
    ["DIR", Uint8Array.from([8, 0, 11, 0, 14, 0, 17, 0, ...sections])],
    ["VOL.0", original],
  ]);

  // 1. Container format detection detects v3-combined with empty prefix
  const detected = detectContainerFormat(files);
  assert.deepEqual(detected, { kind: "v3-combined", prefix: "" });

  // 2. Profile detection detects v3 container and DEFAULT_V3_PROFILE without interpreter binary
  const profile = detectProfile(files);
  assert.equal(profile.container, "v3-combined");
  assert.equal(profile.id, "3.002.149");

  // 3. Opening container works seamlessly with empty prefix
  const c = openContainer(files);
  assert.deepEqual(c.getResource("logic", 0), Uint8Array.of(5, 6));
  c.putResource("logic", 0, Uint8Array.of(99));
  assert.equal(c.files.has("DIR"), true);
  assert.equal(c.files.has("VOL.0"), true);
  assert.equal(c.files.has("DEMODIR"), false);
});
