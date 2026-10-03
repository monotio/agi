import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContainer, openContainer, PAYLOAD_MAX_BYTES } from "../src/container/container.ts";
import type { GameContainer, ResourceKind } from "../src/types.ts";

function snapshotFiles(c: GameContainer): Map<string, Uint8Array> {
  return new Map([...c.files].map(([name, bytes]) => [name, bytes.slice()]));
}

describe("putResources deletion in a v2 split container", () => {
  it("deletes one of two resources and reclaims its record bytes", () => {
    const c = createContainer();
    c.putResources([
      { kind: "logic", num: 0, payload: Uint8Array.of(1, 2, 3) },
      { kind: "logic", num: 1, payload: Uint8Array.of(4, 5) },
    ]);
    c.putResources([{ kind: "logic", num: 0, payload: null }]);
    assert.equal(c.getResource("logic", 0), null);
    assert.deepEqual(c.getResource("logic", 1), Uint8Array.of(4, 5));
    // Only logic 1's record survives, repacked at offset 0.
    assert.deepEqual(c.files.get("VOL.0"), Uint8Array.of(0x12, 0x34, 0, 2, 0, 4, 5));
    assert.deepEqual(
      c.files.get("LOGDIR")!.subarray(0, 6),
      Uint8Array.of(0xff, 0xff, 0xff, 0, 0, 0),
    );
    assert.ok(c.files.get("PICDIR")!.every((b) => b === 0xff));
  });

  it("leaves every file untouched when any entry fails validation", () => {
    const c = createContainer();
    c.putResource("logic", 0, Uint8Array.of(1, 2, 3));
    const before = snapshotFiles(c);
    assert.throws(
      () =>
        c.putResources([
          { kind: "logic", num: 0, payload: null },
          { kind: "logic", num: 1, payload: new Uint8Array(PAYLOAD_MAX_BYTES + 1) },
        ]),
      /u16le record length/,
    );
    assert.deepEqual(c.files, before);
    assert.deepEqual(c.getResource("logic", 0), Uint8Array.of(1, 2, 3));
    // Out-of-range, non-integer and negative IDs refuse a delete the same way.
    for (const num of [256, 1.5, -1]) {
      assert.throws(() => c.putResources([{ kind: "logic", num, payload: null }]), RangeError);
    }
    // An unrecognized family refuses even a well-formed delete.
    assert.throws(
      () => c.putResources([{ kind: "bogus" as ResourceKind, num: 0, payload: null }]),
      /unknown resource kind/,
    );
    assert.deepEqual(c.files, before);
  });

  it("lets the last duplicate entry win, upsert or delete", () => {
    const c = createContainer();
    c.putResource("logic", 0, Uint8Array.of(7));
    c.putResource("logic", 1, Uint8Array.of(8));
    c.putResources([
      { kind: "logic", num: 0, payload: Uint8Array.of(9) },
      { kind: "logic", num: 0, payload: null }, // upsert then delete: delete wins
      { kind: "logic", num: 1, payload: null },
      { kind: "logic", num: 1, payload: Uint8Array.of(6, 6) }, // delete then upsert: upsert wins
    ]);
    assert.equal(c.getResource("logic", 0), null);
    assert.deepEqual(c.getResource("logic", 1), Uint8Array.of(6, 6));
    assert.deepEqual(c.files.get("VOL.0"), Uint8Array.of(0x12, 0x34, 0, 2, 0, 6, 6));
    assert.deepEqual(
      c.files.get("LOGDIR")!.subarray(0, 6),
      Uint8Array.of(0xff, 0xff, 0xff, 0, 0, 0),
    );
  });

  it("treats deleting an absent ID as a no-op, even past the directory end", () => {
    const files = new Map<string, Uint8Array>([
      ["LOGDIR", Uint8Array.of(0, 0, 0)],
      ["VOL.0", Uint8Array.of(0x12, 0x34, 0, 1, 0, 42)],
    ]);
    const c = openContainer(files);
    const before = snapshotFiles(c);
    c.putResources([
      { kind: "sound", num: 77, payload: null }, // absent in a full-length directory
      { kind: "logic", num: 100, payload: null }, // beyond this directory's 1 entry
    ]);
    assert.deepEqual(c.files, before);
    assert.equal(c.getResource("sound", 77), null);
    assert.equal(c.files.get("LOGDIR")!.length, 3, "deletion must not grow the directory");
  });

  it("deletes one aliased entry while the other keeps the shared record", () => {
    const files = new Map<string, Uint8Array>([
      ["LOGDIR", Uint8Array.of(0, 0, 0, 0, 0, 0)],
      ["VOL.0", Uint8Array.of(0x12, 0x34, 0, 1, 0, 42)],
    ]);
    const c = openContainer(files);
    c.putResources([{ kind: "logic", num: 0, payload: null }]);
    assert.equal(c.getResource("logic", 0), null);
    assert.deepEqual(c.getResource("logic", 1), Uint8Array.of(42));
    assert.deepEqual(c.files.get("VOL.0"), Uint8Array.of(0x12, 0x34, 0, 1, 0, 42));
    assert.deepEqual(
      c.files.get("LOGDIR")!.subarray(0, 6),
      Uint8Array.of(0xff, 0xff, 0xff, 0, 0, 0),
    );
    // Deleting the surviving alias drops the record entirely.
    c.putResources([{ kind: "logic", num: 1, payload: null }]);
    assert.equal(c.getResource("logic", 1), null);
    assert.deepEqual(c.files.get("VOL.0"), new Uint8Array(0));
    assert.deepEqual(
      c.files.get("LOGDIR")!.subarray(0, 6),
      Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
    );
  });
});

describe("putResources deletion in a v3 combined container", () => {
  // Seven-byte record: magic, metadata, expanded length, stored length, bytes.
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

  it("deletes one of two entries and repacks the survivor", () => {
    const recA = record([3, 4]); // 9 bytes at DEMOVOL.0 offset 0
    const recB = record([5]); // 8 bytes at DEMOVOL.0 offset 9
    const files = new Map<string, Uint8Array>([
      [
        "DEMODIR",
        Uint8Array.from([
          8,
          0,
          14,
          0,
          17,
          0,
          20,
          0, // section offsets
          0,
          0,
          0,
          0,
          0,
          9, // logic 0 @0, logic 1 @9
          255,
          255,
          255, // picture
          255,
          255,
          255, // view
          255,
          255,
          255, // sound
        ]),
      ],
      ["DEMOVOL.0", Uint8Array.from([...recA, ...recB])],
    ]);
    const c = openContainer(files);
    c.putResources([{ kind: "logic", num: 0, payload: null }]);
    assert.equal(c.getResource("logic", 0), null);
    assert.deepEqual(c.getResource("logic", 1), Uint8Array.of(5));
    // The survivor repacks to offset 0, its seven-byte record kept verbatim.
    assert.deepEqual(c.files.get("DEMOVOL.0"), record([5]));
    assert.deepEqual(
      c.files.get("DEMODIR"),
      Uint8Array.from([
        8, 0, 14, 0, 17, 0, 20, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255,
        255,
      ]),
    );
  });

  it("retains a compressed sibling record verbatim when its neighbor is deleted", () => {
    const log = record([1]); // 8 bytes at DEMOVOL.0 offset 0
    const pic = record([0xf0, 0xaf, 0x2b, 0xff], 5, 0x80); // 11 bytes at offset 8
    const files = new Map<string, Uint8Array>([
      [
        "DEMODIR",
        Uint8Array.from([
          8,
          0,
          11,
          0,
          14,
          0,
          17,
          0, // section offsets
          0,
          0,
          0, // logic 0 @0
          0,
          0,
          8, // picture 0 @8
          255,
          255,
          255, // view
          255,
          255,
          255, // sound
        ]),
      ],
      ["DEMOVOL.0", Uint8Array.from([...log, ...pic])],
    ]);
    const c = openContainer(files);
    c.putResources([{ kind: "logic", num: 0, payload: null }]);
    assert.equal(c.getResource("logic", 0), null);
    // The picture record keeps its nibble compression and 0x80 metadata.
    const expected = pic.slice();
    expected[2] = 0x80;
    assert.deepEqual(c.files.get("DEMOVOL.0"), expected);
    assert.deepEqual(c.getResource("picture", 0), Uint8Array.of(0xf0, 10, 0xf2, 11, 255));
    assert.deepEqual(
      c.files.get("DEMODIR"),
      Uint8Array.from([
        8, 0, 11, 0, 14, 0, 17, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255,
      ]),
    );
  });
});

it("an absent-only delete preserves imported slack and unindexed volumes byte for byte", () => {
  const files = new Map<string, Uint8Array>([
    ["LOGDIR", Uint8Array.of(0, 0, 6)],
    ["VOL.0", Uint8Array.of(0x12, 0x34, 0, 1, 0, 99, 0x12, 0x34, 0, 1, 0, 42)],
    ["VOL.9", Uint8Array.of(88, 89)],
  ]);
  const container = openContainer(files);
  const before = snapshotFiles(container);
  container.putResources([{ kind: "logic", num: 200, payload: null }]);
  assert.deepEqual(container.files, before);
});

it("rejects non-byte payloads even when a later duplicate would hide them", () => {
  const container = createContainer();
  container.putResource("logic", 0, Uint8Array.of(42));
  const before = snapshotFiles(container);
  assert.throws(
    () =>
      container.putResources([
        { kind: "logic", num: 0, payload: null },
        { kind: "view", num: 0, payload: { length: 1, 0: 42 } as unknown as Uint8Array },
        { kind: "view", num: 0, payload: null },
      ]),
    /payload/i,
  );
  assert.deepEqual(container.files, before);
});

it("a packing-capacity failure cannot publish a deletion from the same batch", () => {
  const container = createContainer();
  container.putResource("logic", 0, Uint8Array.of(42));
  const before = snapshotFiles(container);
  const payload = new Uint8Array(PAYLOAD_MAX_BYTES);
  assert.throws(
    () =>
      container.putResources([
        { kind: "logic", num: 0, payload: null },
        ...Array.from({ length: 226 }, (_, num) => ({ kind: "view" as const, num, payload })),
      ]),
    /container is full/,
  );
  assert.deepEqual(container.files, before);
});
