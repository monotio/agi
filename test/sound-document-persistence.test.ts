import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSoundDocument,
  importSoundDocument,
  readSoundDocumentEnvelope,
  SOUND_DOCUMENT_FORMAT,
  SoundDocumentError,
  type SoundDocument,
  type SoundDocumentEnvelope,
  type SoundEvent,
} from "../src/sound/document.ts";

// Hand-written native stream helpers. The bytes below spell the SN76489
// record layout directly; they never call the encoder under test.
function toneRecord(lane: number, ticks: number, divisor: number, attenuation: number): number[] {
  return [
    ticks & 0xff,
    (ticks >> 8) & 0xff,
    (divisor >> 4) & 0x3f,
    0x80 | (lane << 5) | (divisor & 0x0f),
    0x90 | (lane << 5) | attenuation,
  ];
}
function noiseRecord(ticks: number, control: number, attenuation: number): number[] {
  return [ticks & 0xff, (ticks >> 8) & 0xff, control, 0xe0 | control, 0xf0 | attenuation];
}
const END = [0xff, 0xff];

/** Header + four contiguous streams in lane order. */
function payload(streams: readonly (readonly number[])[]): Uint8Array {
  const lengths = streams.map((s) => s.length);
  const offsets = [
    8,
    8 + lengths[0]!,
    8 + lengths[0]! + lengths[1]!,
    8 + lengths[0]! + lengths[1]! + lengths[2]!,
  ];
  const out: number[] = [];
  for (const off of offsets) out.push(off & 0xff, (off >> 8) & 0xff);
  for (const stream of streams) out.push(...stream);
  return new Uint8Array(out);
}

const BLANK = new Uint8Array([8, 0, 10, 0, 12, 0, 14, 0, ...END, ...END, ...END, ...END]);
// Padding gap between the lane 0 and lane 1 streams: opaque on import.
const GAPPED = new Uint8Array([8, 0, 12, 0, 14, 0, 16, 0, ...END, 0, 0, ...END, ...END, ...END]);

function events(doc: SoundDocument, lane: number): readonly SoundEvent[] {
  const tracks = doc.tracks();
  assert.ok(tracks !== null);
  return tracks[lane]!;
}
function ids(doc: SoundDocument, lane: number): string[] {
  return events(doc, lane).map((event) => event.id);
}

/** The honest persistence trip: serialize, JSON text, strict read. */
function readback(doc: SoundDocument): SoundDocument {
  const parsed: SoundDocumentEnvelope = JSON.parse(JSON.stringify(doc.serialize()));
  return readSoundDocumentEnvelope(parsed);
}

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => error instanceof SoundDocumentError && error.code === code);

/** A baseline editable envelope (blank document) with optional overrides. */
function baseEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: SOUND_DOCUMENT_FORMAT,
    version: 1,
    profileId: "2.936",
    payload: [...BLANK],
    eventIds: [[], [], [], []],
    nextEventId: 1,
    ...overrides,
  };
}

describe("SoundDocument.serialize", () => {
  it("serializes a blank document to a deterministic version-1 envelope", () => {
    const doc = createSoundDocument();
    const snap = doc.serialize();
    assert.equal(snap.format, "agi.sound-document");
    assert.equal(snap.version, 1);
    assert.equal(snap.profileId, "2.936");
    assert.deepEqual(snap.payload, [...BLANK]);
    assert.deepEqual(snap.eventIds, [[], [], [], []]);
    assert.equal(snap.nextEventId, 1);
    // Field order is part of the contract: JSON text is byte-stable.
    assert.equal(
      JSON.stringify(snap),
      '{"format":"agi.sound-document","version":1,"profileId":"2.936",' +
        '"payload":[8,0,10,0,12,0,14,0,255,255,255,255,255,255,255,255],' +
        '"eventIds":[[],[],[],[]],"nextEventId":1}',
    );
  });

  it("serializes the exact native bytes of an edited document", () => {
    const doc = createSoundDocument().insertEvent(1, 0);
    const snap = doc.serialize();
    // Hand-computed: lane 0 empty, lane 1 one default record, lanes 2-3 empty.
    assert.deepEqual(snap.payload, [
      8,
      0,
      10,
      0,
      17,
      0,
      19,
      0,
      ...END,
      6,
      0,
      0x0e,
      0xa2,
      0xb4,
      ...END,
      ...END,
      ...END,
    ]);
    assert.deepEqual(snap.eventIds, [[], ["e1"], [], []]);
    assert.equal(snap.nextEventId, 2);
  });

  it("returns a frozen envelope that shares no mutable state with the document", () => {
    const doc = createSoundDocument().insertEvent(0, 0, { ticks: 10 });
    const snap = doc.serialize();
    assert.ok(Object.isFrozen(snap));
    assert.ok(Object.isFrozen(snap.payload));
    assert.ok(Object.isFrozen(snap.eventIds));
    for (const lane of snap.eventIds!) assert.ok(Object.isFrozen(lane));
    const before = [...doc.encode()];
    // Mutating a thawed copy cannot reach the document.
    const copy = JSON.parse(JSON.stringify(snap)) as SoundDocumentEnvelope;
    (copy.payload as number[])[8] = 99;
    (copy.eventIds![0] as string[]).push("e9");
    assert.deepEqual([...doc.encode()], before);
    assert.equal(events(doc, 0).length, 1);
  });

  it("refuses the bounded envelope for an oversized opaque payload instead of truncating", () => {
    const doc = importSoundDocument(new Uint8Array(70000), { profileId: "2.936" });
    assert.equal(doc.representation, "opaque");
    rejects(() => doc.serialize(), "resource-too-large");
    // The oversized document continues to exist losslessly in memory.
    assert.equal(doc.encode().length, 70000);
  });
});

describe("readSoundDocumentEnvelope", () => {
  it("preserves ids, deletion gaps and next-id allocation across a JSON roundtrip", () => {
    const doc = createSoundDocument()
      .insertEvent(0, 0, { ticks: 10 }) // e1
      .insertEvent(0, 1, { ticks: 20 }) // e2
      .insertEvent(3, 0, { ticks: 8, data: { kind: "noise", control: 5, attenuation: 6 } }) // e3
      .removeEvent("e2") // gap: e2 is gone
      .duplicateEvent("e1"); // e4 lands right after e1
    assert.deepEqual(ids(doc, 0), ["e1", "e4"]);
    const restored = readback(doc);
    assert.equal(restored.representation, "four-stream");
    assert.deepEqual(ids(restored, 0), ["e1", "e4"]);
    assert.deepEqual(ids(restored, 3), ["e3"]);
    // Hand-computed bytes: lane 0 holds the duplicated 10-tick tone pair,
    // lane 3 the 8-tick noise event, offsets 8/20/22/24.
    assert.deepEqual(
      [...restored.encode()],
      [
        8,
        0,
        20,
        0,
        22,
        0,
        24,
        0,
        ...toneRecord(0, 10, 226, 4),
        ...toneRecord(0, 10, 226, 4),
        ...END,
        ...END,
        ...END,
        ...noiseRecord(8, 5, 6),
        ...END,
      ],
    );
    // The allocator resumes after the highest retained id: the next insert is
    // e5, never a reused e2.
    const next = restored.insertEvent(0, 2);
    assert.equal(events(next, 0)[2]!.id, "e5");
    assert.deepEqual(ids(restored, 0), ["e1", "e4"]); // earlier snapshot untouched
  });

  it("preserves in-lane id order that is not allocation order", () => {
    const doc = createSoundDocument()
      .insertEvent(0, 0, { ticks: 10 }) // e1
      .insertEvent(0, 0, { ticks: 20 }); // e2, inserted before e1
    const restored = readback(doc);
    assert.deepEqual(ids(restored, 0), ["e2", "e1"]);
    // Byte order follows the lanes: the e2 record (20 ticks) comes first.
    assert.deepEqual(
      [...restored.encode()],
      [
        8,
        0,
        20,
        0,
        22,
        0,
        24,
        0,
        ...toneRecord(0, 20, 226, 4),
        ...toneRecord(0, 10, 226, 4),
        ...END,
        ...END,
        ...END,
        ...END,
      ],
    );
  });

  it("keeps raw records and duration word 0 byte-exact through the roundtrip", () => {
    const rawSelector = [10, 0, 0x0e, 0xa2, 0x94]; // latch names lane 1 on lane 0
    const bytes = payload([
      [...toneRecord(0, 0, 226, 4), ...rawSelector, ...END],
      [...END],
      [...END],
      [...END],
    ]);
    const doc = importSoundDocument(bytes, { profileId: "2.936" });
    const restored = readback(doc);
    assert.equal(restored.representation, "four-stream");
    assert.deepEqual([...restored.encode()], [...bytes]);
    assert.deepEqual(ids(restored, 0), ids(doc, 0));
    assert.equal(events(restored, 0)[0]!.durationWord, 0);
    assert.equal(events(restored, 0)[0]!.durationTicks, 65536);
    assert.deepEqual(events(restored, 0)[1]!.data, {
      kind: "raw",
      toneLow: 0x0e,
      toneHigh: 0xa2,
      control: 0x94,
    });
    // A reopened raw event keeps the same editing contract.
    rejects(() => restored.updateEvent(events(restored, 0)[1]!.id, { divisor: 300 }), "raw-field");
  });

  it("keeps opaque documents opaque, byte-exact and under their stored profile", () => {
    const cases: {
      name: string;
      bytes: Uint8Array;
      profileId: "2.936" | "2.001" | "iigs-1.014";
    }[] = [
      { name: "unsupported-family", bytes: BLANK, profileId: "2.001" },
      { name: "iigs-family", bytes: BLANK, profileId: "iigs-1.014" },
      { name: "gapped-layout", bytes: GAPPED, profileId: "2.936" },
      { name: "short-header", bytes: new Uint8Array(5), profileId: "2.936" },
    ];
    for (const { name, bytes, profileId } of cases) {
      const doc = importSoundDocument(bytes, { profileId });
      assert.equal(doc.representation, "opaque", name);
      const snap = doc.serialize();
      assert.equal(snap.eventIds, null, name);
      assert.deepEqual(snap.payload, [...bytes], name);
      const restored = readback(doc);
      assert.equal(restored.representation, "opaque", name);
      assert.equal(restored.profileId, profileId, `${name}: profile is never reassigned`);
      assert.equal(restored.tracks(), null, name);
      assert.ok(restored.diagnostics.length > 0, name);
      assert.deepEqual([...restored.encode()], [...bytes], `${name} exports untouched`);
      rejects(() => restored.insertEvent(0, 0), "opaque");
    }
  });

  it("restores the allocator cursor for an opaque document too", () => {
    const doc = readSoundDocumentEnvelope(
      baseEnvelope({ payload: [1, 2, 3, 4, 5], eventIds: null, nextEventId: 9 }),
    );
    assert.equal(doc.representation, "opaque");
    assert.equal(doc.serialize().nextEventId, 9);
    assert.deepEqual([...doc.encode()], [1, 2, 3, 4, 5]);
  });

  it("is idempotent: read documents serialize to identical JSON", () => {
    const doc = createSoundDocument()
      .insertEvent(0, 0, { ticks: 30, data: { kind: "tone", divisor: 380, attenuation: 9 } })
      .insertEvent(3, 0, { ticks: 6, data: { kind: "rest" } })
      .removeEvent("e1");
    const once = JSON.stringify(doc.serialize());
    const twice = JSON.stringify(readback(doc).serialize());
    assert.equal(twice, once);
  });

  it("honours stored ids and allocator state in a hand-written envelope", () => {
    const bytes = payload([
      [...toneRecord(0, 30, 226, 4), ...toneRecord(0, 20, 380, 9), ...END],
      [...END],
      [...END],
      [...END],
    ]);
    const restored = readSoundDocumentEnvelope(
      baseEnvelope({
        payload: [...bytes],
        eventIds: [["e7", "e9"], [], [], []],
        nextEventId: 10,
      }),
    );
    assert.deepEqual(ids(restored, 0), ["e7", "e9"]);
    assert.deepEqual([...restored.encode()], [...bytes]);
    assert.equal(restored.insertEvent(0, 0).tracks()![0]![0]!.id, "e10");
  });

  it("never lets input mutation reach the restored document", () => {
    const bytes = payload([[...toneRecord(0, 30, 226, 4), ...END], [...END], [...END], [...END]]);
    const snap = baseEnvelope({
      payload: [...bytes],
      eventIds: [["e1"], [], [], []],
      nextEventId: 2,
    });
    const restored = readSoundDocumentEnvelope(snap);
    (snap["payload"] as number[])[8] = 99;
    (snap["payload"] as number[]).push(0);
    (snap["eventIds"] as string[][])[0]!.push("e2");
    assert.deepEqual([...restored.encode()], [...bytes]);
    assert.deepEqual(ids(restored, 0), ["e1"]);
    const out = restored.encode();
    out[8] = 77;
    assert.equal(restored.encode()[8], 30);
  });

  it("rejects non-plain and wrong-identity envelopes", () => {
    rejects(() => readSoundDocumentEnvelope(null), "invalid-envelope");
    rejects(() => readSoundDocumentEnvelope("text"), "invalid-envelope");
    rejects(() => readSoundDocumentEnvelope(42), "invalid-envelope");
    rejects(() => readSoundDocumentEnvelope([]), "invalid-envelope");
    rejects(
      () => readSoundDocumentEnvelope(Object.assign(new Date(0), baseEnvelope())),
      "invalid-envelope",
    );
    rejects(
      () => readSoundDocumentEnvelope(baseEnvelope({ format: "agi.sound" })),
      "unsupported-format",
    );
    rejects(() => readSoundDocumentEnvelope(baseEnvelope({ format: 1 })), "unsupported-format");
    rejects(() => readSoundDocumentEnvelope(baseEnvelope({ version: 2 })), "unsupported-version");
    rejects(() => readSoundDocumentEnvelope(baseEnvelope({ version: "1" })), "unsupported-version");
    // Format and version are identified before the field set is examined.
    const wrongFormatExtra = baseEnvelope({ format: "agi.other", extra: true });
    rejects(() => readSoundDocumentEnvelope(wrongFormatExtra), "unsupported-format");
  });

  it("rejects extra and missing envelope fields", () => {
    rejects(() => readSoundDocumentEnvelope(baseEnvelope({ note: "x" })), "invalid-envelope");
    const { payload: _p, ...missingPayload } = baseEnvelope();
    rejects(() => readSoundDocumentEnvelope(missingPayload), "invalid-envelope");
    const { eventIds: _e, ...missingIds } = baseEnvelope();
    rejects(() => readSoundDocumentEnvelope(missingIds), "invalid-envelope");
  });

  it("rejects unknown and non-string profiles", () => {
    rejects(
      () => readSoundDocumentEnvelope(baseEnvelope({ profileId: "9.999" })),
      "unknown-profile",
    );
    rejects(
      () => readSoundDocumentEnvelope(baseEnvelope({ profileId: 2.936 })),
      "invalid-envelope",
    );
    rejects(() => readSoundDocumentEnvelope(baseEnvelope({ profileId: null })), "invalid-envelope");
  });

  it("rejects non-integer, out-of-range and non-array payload bytes", () => {
    rejects(() => readSoundDocumentEnvelope(baseEnvelope({ payload: "…" })), "invalid-envelope");
    rejects(
      () => readSoundDocumentEnvelope(baseEnvelope({ payload: new Uint8Array(BLANK) })),
      "invalid-envelope",
    );
    for (const bad of [1.5, -1, 256, "8", null, Number.NaN]) {
      const bytes = [...BLANK];
      bytes[3] = bad as never;
      rejects(
        () => readSoundDocumentEnvelope(baseEnvelope({ payload: bytes })),
        "invalid-envelope",
      );
    }
    // A sparse array's holes are not bytes.
    rejects(
      () => readSoundDocumentEnvelope(baseEnvelope({ payload: new Array(16) })),
      "invalid-envelope",
    );
  });

  it("checks the payload size bound before reading a single byte", () => {
    const oversized = new Array(65_536).fill(0);
    oversized[0] = "not-a-byte"; // malformed too: the bound wins
    rejects(
      () => readSoundDocumentEnvelope(baseEnvelope({ payload: oversized })),
      "resource-too-large",
    );
  });

  it("rejects invalid allocator cursors and ids at or above the cursor", () => {
    for (const nextEventId of [0, -3, 1.5, "4", Number.NaN, 2 ** 53]) {
      rejects(() => readSoundDocumentEnvelope(baseEnvelope({ nextEventId })), "invalid-envelope");
    }
    // e5 is not below a cursor of 5.
    const bytes = payload([[...toneRecord(0, 30, 226, 4), ...END], [...END], [...END], [...END]]);
    rejects(
      () =>
        readSoundDocumentEnvelope(
          baseEnvelope({ payload: [...bytes], eventIds: [["e5"], [], [], []], nextEventId: 5 }),
        ),
      "invalid-envelope",
    );
    // The same id is fine once the cursor has moved past it.
    const ok = readSoundDocumentEnvelope(
      baseEnvelope({ payload: [...bytes], eventIds: [["e5"], [], [], []], nextEventId: 6 }),
    );
    assert.deepEqual(ids(ok, 0), ["e5"]);
  });

  it("rejects malformed, duplicate and physically impossible event ids", () => {
    const bytes = payload([
      [...toneRecord(0, 30, 226, 4), ...toneRecord(0, 20, 380, 9), ...END],
      [...END],
      [...END],
      [...END],
    ]);
    const twoEvents = { payload: [...bytes] };
    for (const id of [
      "e0",
      "e01",
      "x1",
      "E1",
      "e-1",
      "e1.5",
      "",
      "e",
      "e9007199254740993",
      1,
      null,
    ]) {
      rejects(
        () =>
          readSoundDocumentEnvelope(
            baseEnvelope({ ...twoEvents, eventIds: [[id], [], [], []], nextEventId: 100 }),
          ),
        "invalid-envelope",
      );
    }
    // Duplicate ids across lanes and inside one lane.
    rejects(
      () =>
        readSoundDocumentEnvelope(
          baseEnvelope({ ...twoEvents, eventIds: [["e1"], ["e1"], [], []], nextEventId: 100 }),
        ),
      "invalid-envelope",
    );
    rejects(
      () =>
        readSoundDocumentEnvelope(
          baseEnvelope({ ...twoEvents, eventIds: [["e1", "e1"], [], [], []], nextEventId: 100 }),
        ),
      "invalid-envelope",
    );
    // A 16-byte payload cannot physically hold four 5-byte records in a lane.
    rejects(
      () =>
        readSoundDocumentEnvelope(
          baseEnvelope({ eventIds: [["e1", "e2", "e3", "e4"], [], [], []], nextEventId: 5 }),
        ),
      "invalid-envelope",
    );
    // A bounded absurd lane refuses without walking the ids.
    rejects(
      () =>
        readSoundDocumentEnvelope(
          baseEnvelope({
            eventIds: [new Array(100_000).fill("e1"), [], [], []],
            nextEventId: 100_001,
          }),
        ),
      "invalid-envelope",
    );
  });

  it("rejects lane-count and per-lane count mismatches", () => {
    const bytes = payload([[...toneRecord(0, 30, 226, 4), ...END], [...END], [...END], [...END]]);
    for (const eventIds of ["null", 0, [], [[], [], []], [[], [], [], [], []], [[], "x", [], []]]) {
      rejects(
        () => readSoundDocumentEnvelope(baseEnvelope({ payload: [...bytes], eventIds })),
        "invalid-envelope",
      );
    }
    // One decoded lane-0 event vs zero or two ids.
    rejects(
      () =>
        readSoundDocumentEnvelope(
          baseEnvelope({ payload: [...bytes], eventIds: [[], [], [], []] }),
        ),
      "invalid-envelope",
    );
    rejects(
      () =>
        readSoundDocumentEnvelope(
          baseEnvelope({
            payload: [...bytes],
            eventIds: [["e1", "e2"], [], [], []],
            nextEventId: 3,
          }),
        ),
      "invalid-envelope",
    );
  });

  it("rejects opaque/editable identity mismatches in both directions", () => {
    const editable = payload([
      [...toneRecord(0, 30, 226, 4), ...END],
      [...END],
      [...END],
      [...END],
    ]);
    // Claims opaque, but the payload decodes as editable four-stream.
    rejects(
      () => readSoundDocumentEnvelope(baseEnvelope({ payload: [...editable], eventIds: null })),
      "invalid-envelope",
    );
    // Claims editable, but the payload stays opaque under the profile.
    rejects(
      () =>
        readSoundDocumentEnvelope(
          baseEnvelope({ payload: [...GAPPED], eventIds: [[], [], [], []] }),
        ),
      "invalid-envelope",
    );
    // An editable claim under a non-four-stream profile is the same mismatch.
    rejects(
      () =>
        readSoundDocumentEnvelope(baseEnvelope({ profileId: "2.001", eventIds: [[], [], [], []] })),
      "invalid-envelope",
    );
  });

  it("restores an exhausted allocator as a readable document that refuses new events", () => {
    const bytes = payload([[...toneRecord(0, 30, 226, 4), ...END], [...END], [...END], [...END]]);
    const restored = readSoundDocumentEnvelope(
      baseEnvelope({
        payload: [...bytes],
        eventIds: [["e1"], [], [], []],
        nextEventId: Number.MAX_SAFE_INTEGER,
      }),
    );
    rejects(() => restored.insertEvent(0, 0), "ids-exhausted");
    rejects(() => restored.duplicateEvent("e1"), "ids-exhausted");
    // Non-allocating edits still work, and the document stays serializable.
    assert.equal(restored.removeEvent("e1").tracks()![0]!.length, 0);
    assert.equal(restored.serialize().nextEventId, Number.MAX_SAFE_INTEGER);
    assert.deepEqual([...restored.encode()], [...bytes]);
  });

  it("rejects malformed input without mutating it or retaining state", () => {
    const malformed = baseEnvelope({
      payload: [...GAPPED],
      eventIds: [["e1"], [], [], []],
      nextEventId: 2,
    });
    const before = JSON.stringify(malformed);
    rejects(() => readSoundDocumentEnvelope(malformed), "invalid-envelope");
    assert.equal(JSON.stringify(malformed), before);
    // No partial state leaks into the next read.
    const doc = readSoundDocumentEnvelope(baseEnvelope());
    assert.equal(doc.representation, "four-stream");
    assert.deepEqual([...doc.encode()], [...BLANK]);
  });
});
