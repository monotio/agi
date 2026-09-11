import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  containerFromResources,
  compactContainer,
  createContainer,
  DIRECTORY_FILES,
  ENTRY_BYTES,
  INITIAL_DIRECTORY_ENTRIES,
  openContainer,
  PAYLOAD_MAX_BYTES,
  RECORD_HEADER_BYTES,
  VOLUME_MAX_BYTES,
} from "../src/container/container.ts";
import { RESOURCE_KINDS } from "../src/types.ts";

function payloadOf(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

describe("createContainer", () => {
  it("creates four 256-entry absent directories and an empty VOL.0", () => {
    const c = createContainer();
    assert.equal(c.files.size, 5);
    for (const kind of RESOURCE_KINDS) {
      const dir = c.files.get(DIRECTORY_FILES[kind]);
      assert.ok(dir, `missing ${DIRECTORY_FILES[kind]}`);
      assert.equal(dir.length, INITIAL_DIRECTORY_ENTRIES * ENTRY_BYTES);
      assert.ok(
        dir.every((b) => b === 0xff),
        "directory must be all-absent",
      );
    }
    assert.deepEqual(c.files.get("VOL.0"), new Uint8Array(0));
  });

  it("reports every entry absent, including beyond the first 256", () => {
    const c = createContainer();
    for (const kind of RESOURCE_KINDS) {
      assert.equal(c.getResource(kind, 0), null);
      assert.equal(c.getResource(kind, 255), null);
      assert.equal(c.getResource(kind, 999), null);
    }
  });
});

describe("put/get roundtrip", () => {
  it("roundtrips each kind at the edges of the 256-entry directory (0 and 255)", () => {
    const c = createContainer();
    for (const kind of RESOURCE_KINDS) {
      const p0 = payloadOf(0xde, 0xad, 0xbe, 0xef);
      const p255 = payloadOf(1, 2, 3);
      c.putResource(kind, 0, p0);
      c.putResource(kind, 255, p255);
      assert.deepEqual(c.getResource(kind, 0), p0);
      assert.deepEqual(c.getResource(kind, 255), p255);
      assert.equal(c.getResource(kind, 1), null);
      assert.equal(c.getResource(kind, 254), null);
    }
  });

  it("roundtrips an empty payload", () => {
    const c = createContainer();
    c.putResource("sound", 5, new Uint8Array(0));
    assert.deepEqual(c.getResource("sound", 5), new Uint8Array(0));
  });

  it("limits lookup and patching to the first 256 addressable entries", () => {
    const c = createContainer();
    assert.throws(() => c.putResource("logic", 300, payloadOf(42)), /0\.\.255/);
    const files = new Map(c.files);
    const oversized = new Uint8Array(301 * ENTRY_BYTES).fill(0xff);
    oversized.set([0, 0, 0], 300 * ENTRY_BYTES);
    files.set("LOGDIR", oversized);
    files.set("VOL.0", Uint8Array.of(0x12, 0x34, 0, 1, 0, 42));
    assert.equal(openContainer(files).getResource("logic", 300), null);
  });

  it("replacement removes obsolete records and repoints the entry", () => {
    const c = createContainer();
    c.putResource("view", 7, payloadOf(1, 2, 3, 4));
    c.putResource("view", 7, payloadOf(9, 9));
    assert.deepEqual(c.getResource("view", 7), payloadOf(9, 9));
    assert.deepEqual(c.files.get("VOL.0"), payloadOf(0x12, 0x34, 0, 2, 0, 9, 9));
    assert.deepEqual(c.files.get("VIEWDIR")!.slice(21, 24), payloadOf(0, 0, 0));
  });

  it("encodes multi-byte offsets in big-endian 20-bit form", () => {
    const c = createContainer();
    // Push the volume past 0x10000 so the offset needs the low nibble of byte 0.
    c.putResource("logic", 0, new Uint8Array(0x10000 - RECORD_HEADER_BYTES));
    const marker = payloadOf(0xaa);
    c.putResource("logic", 1, marker);
    assert.deepEqual(c.getResource("logic", 1), marker);
    const dir = c.files.get("LOGDIR")!;
    assert.equal(dir[3], 0x01); // volume 0, offset high nibble 1 -> offset 0x10000
    assert.equal(dir[4], 0x00);
    assert.equal(dir[5], 0x00);
  });
});

describe("absent-entry rule", () => {
  it("treats any high-nibble 0xf first byte as absent, not just ff ff ff", () => {
    // Hand-build a container whose LOGDIR entry 0 is f0 00 00 (absent) while
    // VOL.0 still holds a perfectly valid record at offset 0.
    const c = createContainer();
    c.putResource("logic", 0, payloadOf(1, 2, 3));
    const files = new Map(c.files);
    const dir = new Uint8Array(files.get("LOGDIR")!);
    dir[0] = 0xf0;
    dir[1] = 0x00;
    dir[2] = 0x00;
    files.set("LOGDIR", dir);
    const reopened = openContainer(files);
    assert.equal(reopened.getResource("logic", 0), null);
  });
});

describe("volume rollover", () => {
  it("rolls to VOL.1 when another record would exceed the 20-bit ceiling", () => {
    const c = createContainer();
    const payloads: Uint8Array[] = [];
    let i = 0;
    while (!c.files.has("VOL.1")) {
      assert.ok(i < 64, "rollover did not happen within the expected number of records");
      const p = new Uint8Array(PAYLOAD_MAX_BYTES).fill(i);
      payloads.push(p);
      c.putResource("logic", i, p);
      i += 1;
    }
    // The record that triggered the roll landed at offset 0 of VOL.1.
    const vol0 = c.files.get("VOL.0")!;
    const vol1 = c.files.get("VOL.1")!;
    assert.ok(vol0.length <= VOLUME_MAX_BYTES, "VOL.0 must respect the 20-bit ceiling");
    assert.ok(vol0.length + RECORD_HEADER_BYTES + PAYLOAD_MAX_BYTES > VOLUME_MAX_BYTES);
    assert.equal(vol1.length, RECORD_HEADER_BYTES + PAYLOAD_MAX_BYTES);
    assert.equal(vol1[0], 0x12);
    assert.equal(vol1[1], 0x34);
    assert.equal(vol1[2], 1); // record volume byte matches VOL.1
    // Every resource is still retrievable across the volume boundary.
    for (let n = 0; n < payloads.length; n++) {
      assert.deepEqual(c.getResource("logic", n), payloads[n]);
    }
    // Writes continue into VOL.1.
    const extra = payloadOf(7, 7, 7);
    c.putResource("logic", 254, extra);
    assert.deepEqual(c.getResource("logic", 254), extra);
    const entry = 254 * ENTRY_BYTES;
    const dir = c.files.get("LOGDIR")!;
    assert.equal(dir[entry]! >> 4, 1, "entry must name volume 1");
  });
});

describe("openContainer", () => {
  it("re-reads everything a previous container wrote (persistence roundtrip)", () => {
    const c1 = containerFromResources({
      logic: new Map([
        [0, payloadOf(0xa0)],
        [42, payloadOf(1, 2, 3)],
      ]),
      picture: new Map([[1, payloadOf(0xf0, 0x0a, 0xff)]]),
      view: new Map([[7, payloadOf(5, 5)]]),
      sound: new Map([[255, payloadOf(0)]]),
    });
    const c2 = openContainer(c1.files);
    assert.deepEqual(c2.getResource("logic", 0), payloadOf(0xa0));
    assert.deepEqual(c2.getResource("logic", 42), payloadOf(1, 2, 3));
    assert.deepEqual(c2.getResource("picture", 1), payloadOf(0xf0, 0x0a, 0xff));
    assert.deepEqual(c2.getResource("view", 7), payloadOf(5, 5));
    assert.deepEqual(c2.getResource("sound", 255), payloadOf(0));
    assert.equal(c2.getResource("logic", 1), null);
    assert.equal(c2.getResource("sound", 0), null);
  });

  it("patches a reopened container without aliasing the previous image", () => {
    const c1 = createContainer();
    c1.putResource("logic", 3, payloadOf(1));
    const c2 = openContainer(c1.files);
    // In-place directory write (no growth) must not leak into c1's image.
    c2.putResource("logic", 4, payloadOf(2));
    c2.putResource("logic", 3, payloadOf(9)); // replace: c1 must keep the old payload
    assert.equal(c1.getResource("logic", 4), null);
    assert.deepEqual(c1.getResource("logic", 3), payloadOf(1));
    assert.deepEqual(c2.getResource("logic", 3), payloadOf(9));
    assert.deepEqual(c2.getResource("logic", 4), payloadOf(2));
    // A second reopen over c2's files sees the patched state.
    const c3 = openContainer(c2.files);
    assert.deepEqual(c3.getResource("logic", 3), payloadOf(9));
    assert.deepEqual(c3.getResource("logic", 4), payloadOf(2));
  });

  it("normalizes a partial file set: missing directories and volumes", () => {
    const c = openContainer(new Map());
    for (const kind of RESOURCE_KINDS) assert.equal(c.getResource(kind, 0), null);
    c.putResource("sound", 1, payloadOf(4, 2));
    assert.deepEqual(c.getResource("sound", 1), payloadOf(4, 2));
  });
});

describe("auxiliary file patching", () => {
  it("copies replacement dictionary and inventory bytes into persisted files", () => {
    const container = createContainer();
    const payload = Uint8Array.of(4, 5, 6);
    container.putFile("WORDS.TOK", payload);
    container.putFile("OBJECT", Uint8Array.of(7));
    payload[0] = 9;
    assert.deepEqual(container.files.get("WORDS.TOK"), Uint8Array.of(4, 5, 6));
    assert.deepEqual(openContainer(container.files).files.get("OBJECT"), Uint8Array.of(7));
  });
});

describe("validation", () => {
  it("rejects payloads that do not fit the u16le record length", () => {
    const c = createContainer();
    assert.throws(
      () => c.putResource("logic", 0, new Uint8Array(PAYLOAD_MAX_BYTES + 1)),
      RangeError,
    );
  });

  it("rejects non-integer and negative resource numbers", () => {
    const c = createContainer();
    assert.throws(() => c.putResource("logic", -1, payloadOf(0)), RangeError);
    assert.throws(() => c.getResource("logic", 1.5), RangeError);
  });

  it("throws on corrupt records instead of returning garbage", () => {
    const c = createContainer();
    c.putResource("logic", 0, payloadOf(1, 2, 3));
    const tampered = new Map(c.files);
    const vol = new Uint8Array(tampered.get("VOL.0")!);
    vol[0] = 0x99; // break the magic
    tampered.set("VOL.0", vol);
    assert.throws(() => openContainer(tampered).getResource("logic", 0), /magic/);
  });
});

describe("transactional packing", () => {
  it("keeps thousands of variable-size replacements bounded with no obsolete sentinel", () => {
    const c = createContainer();
    c.putResource("logic", 255, Uint8Array.of(0x7e));
    c.putResource("view", 17, new TextEncoder().encode("OBSOLETE_PRIVATE_DRAFT"));
    for (let i = 0; i < 2000; i++) {
      const bytes = new Uint8Array(1 + (i % 131)).fill(i % 32);
      c.putResource("view", 17, bytes);
      assert.equal(c.files.get("VOL.0")!.length, 11 + bytes.length);
      assert.deepEqual(c.getResource("view", 17), bytes);
    }
    assert.deepEqual(c.getResource("logic", 255), Uint8Array.of(0x7e));
    assert.equal(new TextDecoder().decode(c.files.get("VOL.0")).includes("OBSOLETE"), false);
  });

  it("packs legacy slack, preserves aliases and separates a replaced alias", () => {
    const files = new Map<string, Uint8Array>([
      ["LOGDIR", Uint8Array.of(0, 0, 8, 0, 0, 8)],
      ["VOL.0", Uint8Array.of(0x12, 0x34, 0, 3, 0, 99, 98, 97, 0x12, 0x34, 0, 1, 0, 42)],
      ["VOL.9", Uint8Array.of(88, 89)],
      ["OBJECT", Uint8Array.of(1, 2)],
    ]);
    const packed = compactContainer(files);
    assert.deepEqual(packed.get("VOL.0"), Uint8Array.of(0x12, 0x34, 0, 1, 0, 42));
    assert.deepEqual(packed.get("LOGDIR"), Uint8Array.of(0, 0, 0, 0, 0, 0));
    assert.equal(packed.has("VOL.9"), false);
    assert.deepEqual(packed.get("OBJECT"), Uint8Array.of(1, 2));
    const c = openContainer(packed);
    c.putResource("logic", 0, Uint8Array.of(7, 8));
    assert.deepEqual(c.getResource("logic", 0), Uint8Array.of(7, 8));
    assert.deepEqual(c.getResource("logic", 1), Uint8Array.of(42));
    assert.equal(c.files.get("VOL.0")!.length, 13);
    assert.equal(files.get("VOL.0")!.length, 14);
    packed.get("OBJECT")![0] = 99;
    assert.equal(files.get("OBJECT")![0], 1);
  });

  it("preserves damaged indexed resources as dangling entries while packing healthy ones", () => {
    for (const volume of [
      undefined,
      Uint8Array.of(99, 0, 0, 0, 0),
      Uint8Array.of(0x12, 0x34, 0, 4, 0, 42),
    ]) {
      const files = new Map<string, Uint8Array>([["LOGDIR", Uint8Array.of(0, 0, 0)]]);
      if (volume) files.set("VOL.0", volume);
      const c = openContainer(files);
      const before = new Map([...c.files].map(([name, bytes]) => [name, bytes.slice()]));
      const clean = compactContainer(c.files);
      assert.deepEqual(c.files, before);
      assert.deepEqual(clean.get("LOGDIR"), Uint8Array.of(0x0f, 0xff, 0xff));
      assert.throws(() => openContainer(clean).getResource("logic", 0), /out of bounds/);
      c.putResource("view", 0, Uint8Array.of(1));
      assert.deepEqual(c.getResource("view", 0), Uint8Array.of(1));
      assert.throws(() => c.getResource("logic", 0), /out of bounds/);
      assert.equal(c.files.get("VOL.0")!.length, 6);
      c.putResource("logic", 0, Uint8Array.of(7));
      assert.deepEqual(c.getResource("logic", 0), Uint8Array.of(7));
    }
  });

  it("detaches Node Buffer inputs: container writes never alias caller storage", () => {
    // fs.readFile returns Buffer, whose .slice() is a view: a copy made with
    // .slice() would alias the caller's buffers, and repack writes the new
    // volume nibble back through that view into the caller's VOL bytes.
    const dir = Buffer.from(Uint8Array.of(0x10, 0, 0)); // logic 0 in VOL.1 offset 0
    const vol1 = Buffer.from(Uint8Array.of(0x12, 0x34, 1, 1, 0, 42));
    const files = new Map<string, Uint8Array>([
      ["LOGDIR", dir],
      ["VOL.1", vol1],
    ]);
    const c = openContainer(files);
    c.putResource("view", 0, Uint8Array.of(1, 2, 3)); // repack moves logic 0 to VOL.0
    c.putResource("logic", 1, Uint8Array.of(9));
    assert.deepEqual([...dir], [0x10, 0, 0]);
    assert.deepEqual([...vol1], [0x12, 0x34, 1, 1, 0, 42]);
    assert.deepEqual(c.getResource("view", 0), Uint8Array.of(1, 2, 3));
    assert.deepEqual(c.getResource("logic", 0), Uint8Array.of(42));
  });
});
