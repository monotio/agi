import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSoundDocument,
  importSoundDocument,
  SoundDocumentError,
  type SoundDocument,
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
function restRecord(lane: number, ticks: number): number[] {
  return [ticks & 0xff, (ticks >> 8) & 0xff, 0x00, 0x80 | (lane << 5), 0x9f | (lane << 5)];
}
const END = [0xff, 0xff];

/** Header + four contiguous streams in lane order. */
function payload(
  streams: readonly (readonly number[])[],
  extras?: { tail?: number[] },
): Uint8Array {
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
  out.push(...(extras?.tail ?? []));
  return new Uint8Array(out);
}

const BLANK = new Uint8Array([8, 0, 10, 0, 12, 0, 14, 0, ...END, ...END, ...END, ...END]);

function events(doc: SoundDocument, lane: number): readonly SoundEvent[] {
  const tracks = doc.tracks();
  assert.ok(tracks !== null);
  return tracks[lane]!;
}

describe("createSoundDocument", () => {
  it("creates a blank four-stream document that encodes to the 16-byte empty payload", () => {
    const doc = createSoundDocument();
    assert.equal(doc.profileId, "2.936");
    assert.equal(doc.family, "four-stream");
    assert.equal(doc.representation, "four-stream");
    assert.deepEqual(doc.diagnostics, []);
    assert.deepEqual([...doc.encode()], [...BLANK]);
    assert.equal(doc.extentTicks(), 0);
    const tracks = doc.tracks();
    assert.ok(tracks !== null);
    assert.equal(tracks.length, 4);
    for (const lane of tracks) assert.equal(lane.length, 0);
  });
});

describe("importSoundDocument strict decode", () => {
  it("decodes a hand-written tone event exactly and re-encodes to identical bytes", () => {
    // lane0: 30 ticks, divisor 226 (~A4), attenuation 4 -> 1e 00 0e 82 94
    const bytes = payload([[...toneRecord(0, 30, 226, 4), ...END], [...END], [...END], [...END]]);
    const doc = importSoundDocument(bytes, { profileId: "2.936" });
    assert.equal(doc.representation, "four-stream");
    const event = events(doc, 0)[0]!;
    assert.equal(event.durationWord, 30);
    assert.equal(event.durationTicks, 30);
    assert.deepEqual(event.data, { kind: "tone", divisor: 226, attenuation: 4 });
    assert.deepEqual([...doc.encode()], [...bytes]);
  });

  it("decodes noise and canonical rest events on their lanes", () => {
    const bytes = payload([
      [...restRecord(0, 60), ...END],
      [...END],
      [...END],
      [...noiseRecord(12, 5, 4), ...END],
    ]);
    const doc = importSoundDocument(bytes, { profileId: "2.936" });
    assert.equal(doc.representation, "four-stream");
    assert.deepEqual(events(doc, 0)[0]!.data, { kind: "rest" });
    assert.deepEqual(events(doc, 3)[0]!.data, { kind: "noise", control: 5, attenuation: 4 });
    assert.deepEqual([...doc.encode()], [...bytes]);
  });

  it("keeps duration word 0 as 65536 ticks and 65534 as itself", () => {
    const bytes = payload([
      [...toneRecord(0, 0, 226, 4), ...toneRecord(0, 65534, 226, 4), ...END],
      [...END],
      [...END],
      [...END],
    ]);
    const doc = importSoundDocument(bytes, { profileId: "2.936" });
    const lane = events(doc, 0);
    assert.equal(lane[0]!.durationWord, 0);
    assert.equal(lane[0]!.durationTicks, 65536);
    assert.equal(lane[1]!.durationWord, 65534);
    assert.equal(lane[1]!.durationTicks, 65534);
    assert.equal(doc.trackExtentTicks(0), 65536 + 65534);
    assert.equal(doc.extentTicks(), 65536 + 65534);
    assert.deepEqual([...doc.encode()], [...bytes]);
  });

  it("accepts boundary divisors 1 and 1023 and attenuations 0 and 15", () => {
    const bytes = payload([
      [
        ...toneRecord(0, 4, 1, 0),
        ...toneRecord(0, 4, 1023, 15),
        ...toneRecord(0, 4, 226, 15),
        ...END,
      ],
      [...END],
      [...END],
      [...END],
    ]);
    const doc = importSoundDocument(bytes, { profileId: "2.936" });
    assert.equal(doc.representation, "four-stream");
    assert.deepEqual(events(doc, 0)[0]!.data, { kind: "tone", divisor: 1, attenuation: 0 });
    assert.deepEqual(events(doc, 0)[1]!.data, { kind: "tone", divisor: 1023, attenuation: 15 });
    // Divisor present with attenuation 15 stays a tone event (silenced, keeps pitch).
    assert.deepEqual(events(doc, 0)[2]!.data, { kind: "tone", divisor: 226, attenuation: 15 });
  });

  it("keeps noncanonical event words as raw and re-encodes them verbatim", () => {
    // Selector mismatch: tone lane 0 event whose latch names lane 1 (0xa2).
    const rawTone = [10, 0, 0x0e, 0xa2, 0x94];
    // Data byte bit 7 set: would be a second latch on the chip.
    const rawData = [6, 0, 0x8e, 0x82, 0x94];
    // Zero divisor with attenuation < 15: silent but not the canonical rest.
    const rawSilent = [6, 0, 0x00, 0x80, 0x94];
    // Noise lane whose padding byte differs from the control nibble.
    const rawNoise = [6, 0, 0x01, 0xe5, 0xf4];
    const bytes = payload([
      [...rawTone, ...rawData, ...rawSilent, ...END],
      [...END],
      [...END],
      [...rawNoise, ...END],
    ]);
    const doc = importSoundDocument(bytes, { profileId: "2.936" });
    assert.equal(doc.representation, "four-stream");
    const lane = events(doc, 0);
    assert.deepEqual(lane[0]!.data, { kind: "raw", toneLow: 0x0e, toneHigh: 0xa2, control: 0x94 });
    assert.deepEqual(lane[1]!.data, { kind: "raw", toneLow: 0x8e, toneHigh: 0x82, control: 0x94 });
    assert.deepEqual(lane[2]!.data, { kind: "raw", toneLow: 0x00, toneHigh: 0x80, control: 0x94 });
    assert.deepEqual(events(doc, 3)[0]!.data, {
      kind: "raw",
      toneLow: 0x01,
      toneHigh: 0xe5,
      control: 0xf4,
    });
    assert.deepEqual([...doc.encode()], [...bytes]);
  });

  it("retains a 0x0000-tone silence as raw, distinct from the canonical rest", () => {
    const bytes = payload([[10, 0, 0, 0, 0x9f, ...END], [...END], [...END], [...END]]);
    const doc = importSoundDocument(bytes, { profileId: "2.936" });
    assert.equal(doc.representation, "four-stream");
    assert.deepEqual(events(doc, 0)[0]!.data, {
      kind: "raw",
      toneLow: 0,
      toneHigh: 0,
      control: 0x9f,
    });
    assert.deepEqual([...doc.encode()], [...bytes]);
  });

  it("keeps a payload shorter than the 8-byte header as opaque", () => {
    const doc = importSoundDocument(new Uint8Array(5), { profileId: "2.936" });
    assert.equal(doc.representation, "opaque");
    assert.equal(doc.tracks(), null);
    assert.equal(doc.extentTicks(), null);
    assert.ok(doc.diagnostics.length > 0);
    assert.deepEqual([...doc.encode()], [0, 0, 0, 0, 0]);
  });

  it("keeps malformed and noncanonical layouts opaque instead of normalizing them", () => {
    const cases: { name: string; bytes: Uint8Array }[] = [
      // Offset inside the 8-byte header.
      { name: "offset-in-header", bytes: new Uint8Array([4, 0, 8, 0, 10, 0, 12, 0, ...END]) },
      // Offset beyond the payload.
      { name: "offset-out-of-bounds", bytes: new Uint8Array([200, 0, 8, 0, 8, 0, 8, 0]) },
      // Offset at payload end leaves no room for the terminator.
      {
        name: "offset-at-end",
        bytes: payload([[...END], [...END], [...END], []]).subarray(0, 14),
      },
      // Lane 0 stream is never terminated.
      {
        name: "unterminated",
        bytes: new Uint8Array([8, 0, 15, 0, 15, 0, 15, 0, ...toneRecord(0, 30, 226, 4), 1, 0]),
      },
      // Event record truncated by the payload end.
      {
        name: "truncated-record",
        bytes: new Uint8Array([8, 0, 8, 0, 8, 0, 8, 0, 30, 0, 0x0e]),
      },
      // Two lanes share one stream (aliased offsets).
      { name: "aliased", bytes: new Uint8Array([8, 0, 8, 0, 8, 0, 8, 0, ...END]) },
      // Lane 1 starts inside lane 0's stream (overlap).
      {
        name: "overlap",
        bytes: new Uint8Array([
          8,
          0,
          10,
          0,
          20,
          0,
          22,
          0,
          ...toneRecord(0, 30, 226, 4),
          ...END,
          ...END,
          ...END,
        ]),
      },
      // Streams stored out of lane order.
      {
        name: "noncanonical-order",
        bytes: new Uint8Array([10, 0, 8, 0, 12, 0, 14, 0, ...END, ...END, ...END, ...END]),
      },
      // Padding gap between lane 0 and lane 1.
      {
        name: "gap",
        bytes: new Uint8Array([8, 0, 12, 0, 14, 0, 16, 0, ...END, 0, 0, ...END, ...END, ...END]),
      },
      // Trailing bytes after the last stream.
      {
        name: "trailing",
        bytes: payload([[...END], [...END], [...END], [...END]], { tail: [0xaa, 0xbb] }),
      },
    ];
    for (const { name, bytes } of cases) {
      const doc = importSoundDocument(bytes, { profileId: "2.936" });
      assert.equal(doc.representation, "opaque", name);
      assert.ok(doc.diagnostics.length > 0, name);
      assert.deepEqual([...doc.encode()], [...bytes], `${name} must export untouched`);
    }
  });

  it("keeps oversized payloads opaque rather than rejecting them outright", () => {
    const doc = importSoundDocument(new Uint8Array(70000), { profileId: "2.936" });
    assert.equal(doc.representation, "opaque");
    assert.equal(doc.encode().length, 70000);
  });

  it("never guesses unsupported families as four-stream from header coincidences", () => {
    for (const profileId of ["2.001", "iigs-1.014"] as const) {
      const doc = importSoundDocument(BLANK, { profileId });
      assert.equal(doc.representation, "opaque", profileId);
      assert.equal(doc.tracks(), null);
      assert.ok(doc.diagnostics.some((line) => line.includes(profileId)));
      assert.deepEqual([...doc.encode()], [...BLANK]);
    }
  });

  it("rejects an unknown profile identity explicitly", () => {
    assert.throws(
      () => importSoundDocument(BLANK, { profileId: "9.999" as never }),
      (error: unknown) => error instanceof SoundDocumentError && error.code === "unknown-profile",
    );
  });

  it("imports four-stream payloads under Amiga and early profiles", () => {
    for (const profileId of ["amiga-2.202", "amiga-2.082", "2.089", "2.936"] as const) {
      const doc = importSoundDocument(BLANK, { profileId });
      assert.equal(doc.representation, "four-stream", profileId);
      assert.equal(doc.family, "four-stream");
    }
  });
});

describe("editing", () => {
  const base = () =>
    importSoundDocument(
      payload([[...toneRecord(0, 30, 226, 4), ...END], [...END], [...END], [...END]]),
      { profileId: "2.936" },
    );

  it("inserts a default event of six ticks, divisor 226 and attenuation 4", () => {
    const doc = createSoundDocument().insertEvent(1, 0);
    const event = events(doc, 1)[0]!;
    assert.equal(event.durationTicks, 6);
    assert.deepEqual(event.data, { kind: "tone", divisor: 226, attenuation: 4 });
    // Hand-checked bytes: lane 0 empty, lane 1 one record, lanes 2-3 empty.
    assert.deepEqual(
      [...doc.encode()],
      [8, 0, 10, 0, 17, 0, 19, 0, ...END, ...[6, 0, 0x0e, 0xa2, 0xb4], ...END, ...END, ...END],
    );
  });

  it("inserts a noise-capable default on lane 3 and rejects tone data there", () => {
    const doc = createSoundDocument().insertEvent(3, 0);
    assert.deepEqual(events(doc, 3)[0]!.data, { kind: "noise", control: 4, attenuation: 4 });
    assert.throws(
      () => createSoundDocument().insertEvent(3, 0, { data: { kind: "tone", divisor: 226 } }),
      (error: unknown) => error instanceof SoundDocumentError && error.code === "lane-kind",
    );
    assert.throws(
      () => createSoundDocument().insertEvent(0, 0, { data: { kind: "noise", control: 4 } }),
      (error: unknown) => error instanceof SoundDocumentError && error.code === "lane-kind",
    );
  });

  it("rejects a 65535-tick event with a split/retrigger explanation", () => {
    const doc = base();
    const id = events(doc, 0)[0]!.id;
    assert.throws(
      () => doc.updateEvent(id, { ticks: 65535 }),
      (error: unknown) =>
        error instanceof SoundDocumentError &&
        error.code === "duration-not-representable" &&
        /terminator|split|retrigger/i.test(error.message),
    );
    assert.throws(
      () => doc.insertEvent(0, 0, { ticks: 65535 }),
      (error: unknown) =>
        error instanceof SoundDocumentError && error.code === "duration-not-representable",
    );
  });

  it("accepts 65536 ticks as duration word 0", () => {
    const doc = createSoundDocument().insertEvent(0, 0, { ticks: 65536 });
    const event = events(doc, 0)[0]!;
    assert.equal(event.durationWord, 0);
    assert.equal(event.durationTicks, 65536);
    assert.equal(doc.extentTicks(), 65536);
  });

  it("rejects fractional, NaN, infinite and out-of-range values without clamping", () => {
    const doc = base();
    const id = events(doc, 0)[0]!.id;
    for (const ticks of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 65537]) {
      assert.throws(
        () => doc.updateEvent(id, { ticks }),
        (error: unknown) => error instanceof SoundDocumentError,
        `ticks ${ticks}`,
      );
    }
    for (const divisor of [0, 1024, -1, 226.5, Number.NaN]) {
      assert.throws(
        () => doc.updateEvent(id, { divisor }),
        (error: unknown) => error instanceof SoundDocumentError,
        `divisor ${divisor}`,
      );
    }
    for (const attenuation of [-1, 16, 4.5, Number.NaN]) {
      assert.throws(
        () => doc.updateEvent(id, { attenuation }),
        (error: unknown) => error instanceof SoundDocumentError,
        `attenuation ${attenuation}`,
      );
    }
    for (const control of [-1, 8, 4.5]) {
      assert.throws(
        () => doc.replaceEventData(id, { kind: "noise", control }),
        (error: unknown) => error instanceof SoundDocumentError,
        `control ${control}`,
      );
    }
    for (const lane of [-1, 4, 1.5]) {
      assert.throws(
        () => doc.insertEvent(lane, 0),
        (error: unknown) => error instanceof SoundDocumentError,
        `lane ${lane}`,
      );
    }
    assert.throws(() => doc.insertEvent(0, 5), SoundDocumentError);
    assert.throws(() => doc.updateEvent("missing", { ticks: 4 }), SoundDocumentError);
    assert.throws(() => doc.removeEvent("missing"), SoundDocumentError);
  });

  it("edits one event while every untouched record byte stays exact", () => {
    const rawEvent = [8, 0, 0x0e, 0xa2, 0x94]; // selector names lane 1: raw on lane 0
    const bytes = payload([
      [...rawEvent, ...toneRecord(0, 30, 226, 4), ...restRecord(0, 60), ...END],
      [...noiseRecord(12, 5, 4), ...END],
      [...END],
      [...END],
    ]);
    const doc = importSoundDocument(bytes, { profileId: "2.936" });
    const edited = doc.updateEvent(events(doc, 0)[1]!.id, { divisor: 380, attenuation: 2 });
    const out = [...edited.encode()];
    // Lane 0: raw event verbatim, edited record canonical for 380/2, rest verbatim.
    const lane0 = [...rawEvent, ...toneRecord(0, 30, 380, 2), ...restRecord(0, 60), ...END];
    assert.deepEqual(out.slice(8, 8 + lane0.length), lane0);
    // Lanes 1-3 verbatim.
    const lane1 = [...noiseRecord(12, 5, 4), ...END];
    assert.deepEqual(out.slice(8 + lane0.length, 8 + lane0.length + lane1.length), lane1);
    assert.deepEqual(events(doc, 0)[1]!.data, { kind: "tone", divisor: 226, attenuation: 4 });
    assert.deepEqual(events(edited, 0)[1]!.data, { kind: "tone", divisor: 380, attenuation: 2 });
  });

  it("edits a raw event's duration without touching its data bytes", () => {
    const rawEvent = [8, 0, 0x0e, 0xa2, 0x94];
    const doc = importSoundDocument(
      payload([[...rawEvent, ...END], [...END], [...END], [...END]]),
      { profileId: "2.936" },
    );
    const edited = doc.updateEvent(events(doc, 0)[0]!.id, { ticks: 40 });
    assert.deepEqual([...edited.encode()].slice(8, 13), [40, 0, 0x0e, 0xa2, 0x94]);
    assert.throws(
      () => doc.updateEvent(events(doc, 0)[0]!.id, { divisor: 300 }),
      (error: unknown) => error instanceof SoundDocumentError && error.code === "raw-field",
    );
    // Replacing raw data with a canonical event is an explicit operation.
    const replaced = doc.replaceEventData(events(doc, 0)[0]!.id, { kind: "rest" });
    assert.deepEqual([...replaced.encode()].slice(8, 13), restRecord(0, 8));
  });

  it("turns note names into stored divisors without storing the aid", () => {
    const doc = createSoundDocument().insertEvent(0, 0, {
      ticks: 30,
      data: { kind: "tone", note: "A4" },
    });
    assert.deepEqual(events(doc, 0)[0]!.data, { kind: "tone", divisor: 226, attenuation: 4 });
    assert.deepEqual([...doc.encode()].slice(8, 13), [30, 0, 0x0e, 0x82, 0x94]);
  });

  it("duplicates with a distinct stable id and keeps order", () => {
    const doc = base();
    const source = events(doc, 0)[0]!;
    const copy = doc.duplicateEvent(source.id);
    const lane = events(copy, 0);
    assert.equal(lane.length, 2);
    assert.equal(lane[0]!.id, source.id);
    assert.notEqual(lane[1]!.id, source.id);
    assert.deepEqual(lane[1]!.data, source.data);
    // The duplicate lands right after its source.
    assert.deepEqual([...copy.encode()].slice(8, 18), [
      ...toneRecord(0, 30, 226, 4),
      ...toneRecord(0, 30, 226, 4),
    ]);
  });

  it("keeps ids deterministic for equal operation sequences", () => {
    const build = () =>
      createSoundDocument()
        .insertEvent(0, 0, { ticks: 10 })
        .insertEvent(0, 1, { ticks: 20 })
        .duplicateEvent("e2");
    const a = build();
    const b = build();
    assert.deepEqual(
      events(a, 0).map((event) => event.id),
      events(b, 0).map((event) => event.id),
    );
  });

  it("removes events and never mutates earlier document snapshots", () => {
    const doc = base();
    const withExtra = doc.insertEvent(0, 1, { ticks: 10 });
    const removed = withExtra.removeEvent(events(withExtra, 0)[0]!.id);
    // An "undo-like" earlier snapshot still encodes the original bytes.
    assert.deepEqual(
      [...doc.encode()],
      [...payload([[...toneRecord(0, 30, 226, 4), ...END], [...END], [...END], [...END]])],
    );
    assert.equal(events(removed, 0).length, 1);
    assert.equal(events(removed, 0)[0]!.durationTicks, 10);
    assert.equal(events(withExtra, 0).length, 2);
  });

  it("refuses edits on opaque documents", () => {
    const doc = importSoundDocument(new Uint8Array(5), { profileId: "2.936" });
    assert.throws(
      () => doc.insertEvent(0, 0),
      (error: unknown) => error instanceof SoundDocumentError && error.code === "opaque",
    );
    assert.throws(
      () => doc.removeEvent("e1"),
      (error: unknown) => error instanceof SoundDocumentError && error.code === "opaque",
    );
  });

  it("rejects fractional, prefix-parsed and non-note pitch input on insert and update", () => {
    const doc = base();
    const id = events(doc, 0)[0]!.id;
    // Legacy builder coercion rounded numbers and parseInt'd string prefixes;
    // the document editor must refuse all of them, on both entry paths.
    const invalid = [69.25, "69.25", "69junk", "1e2", "", "A", "H4", "rest", Number.NaN];
    for (const note of invalid) {
      assert.throws(
        () => doc.insertEvent(0, 0, { data: { kind: "tone", note } }),
        (error: unknown) =>
          error instanceof SoundDocumentError &&
          error.code === "invalid-value" &&
          /note|pitch|integer|invalid/i.test(error.message),
        `insert note ${String(note)}`,
      );
      assert.throws(
        () => doc.updateEvent(id, { note }),
        (error: unknown) =>
          error instanceof SoundDocumentError &&
          error.code === "invalid-value" &&
          /note|pitch|integer|invalid/i.test(error.message),
        `update note ${String(note)}`,
      );
    }
    // Rejected edits leave the document untouched.
    assert.equal(events(doc, 0).length, 1);
    assert.deepEqual(events(doc, 0)[0]!.data, { kind: "tone", divisor: 226, attenuation: 4 });
  });

  it("rejects pitches outside the representable divisor range instead of clamping", () => {
    const doc = base();
    const id = events(doc, 0)[0]!.id;
    // A0 (midi 21) needs divisor ~3616 and F#2 (42) ~1075: both above the
    // 10-bit ceiling. C-1 (midi 0) is a valid MIDI note but needs ~12157.
    for (const note of ["A0", 21, "F#2", "C-1"]) {
      assert.throws(
        () => doc.insertEvent(0, 0, { data: { kind: "tone", note } }),
        (error: unknown) =>
          error instanceof SoundDocumentError &&
          error.code === "invalid-value" &&
          /range|represent|divisor|pitch/i.test(error.message),
        `insert note ${String(note)}`,
      );
      assert.throws(
        () => doc.updateEvent(id, { note }),
        (error: unknown) =>
          error instanceof SoundDocumentError &&
          error.code === "invalid-value" &&
          /range|represent|divisor|pitch/i.test(error.message),
        `update note ${String(note)}`,
      );
    }
    // Out-of-MIDI-range input is invalid input, not a range miss.
    for (const note of [-1, 128, "128", "C11", "C-2"]) {
      assert.throws(
        () => doc.insertEvent(0, 0, { data: { kind: "tone", note } }),
        (error: unknown) => error instanceof SoundDocumentError,
        `insert note ${String(note)}`,
      );
    }
  });

  it("quantizes an in-range note to the nearest integer divisor", () => {
    // Hand-computed against 99431.67 / Hz: G2 is the deepest representable
    // note (ideal divisor ~1014.6 -> 1015), C4 is 380, "69" is A4 -> 226.
    const doc = createSoundDocument()
      .insertEvent(0, 0, { ticks: 10, data: { kind: "tone", note: "G2" } })
      .insertEvent(0, 1, { ticks: 10, data: { kind: "tone", note: 60 } })
      .insertEvent(0, 2, { ticks: 10, data: { kind: "tone", note: "69" } });
    const lane = events(doc, 0);
    assert.deepEqual(lane[0]!.data, { kind: "tone", divisor: 1015, attenuation: 4 });
    assert.deepEqual(lane[1]!.data, { kind: "tone", divisor: 380, attenuation: 4 });
    assert.deepEqual(lane[2]!.data, { kind: "tone", divisor: 226, attenuation: 4 });
    // A valid note edit replaces the stored divisor.
    const edited = doc.updateEvent(lane[0]!.id, { note: "E5" });
    assert.deepEqual(events(edited, 0)[0]!.data, { kind: "tone", divisor: 151, attenuation: 4 });
    // The explicit divisor path still takes canonical 1..1023 values verbatim.
    const maxed = doc.updateEvent(lane[0]!.id, { divisor: 1023 });
    assert.deepEqual(events(maxed, 0)[0]!.data, { kind: "tone", divisor: 1023, attenuation: 4 });
  });

  it("rejects edits that would exceed the 16-bit resource bound", () => {
    let doc = createSoundDocument();
    // 13,103 five-byte events + four terminators + header = 65,531 bytes; one
    // more record would exceed the 65,535-byte resource bound.
    for (let i = 0; i < 13103; i++) doc = doc.insertEvent(0, i, { ticks: 1 });
    assert.equal(doc.encode().length, 65531);
    assert.throws(
      () => doc.insertEvent(0, 0, { ticks: 1 }),
      (error: unknown) =>
        error instanceof SoundDocumentError && error.code === "resource-too-large",
    );
    assert.equal(doc.encode().length, 65531);
  });
});

describe("buffer ownership", () => {
  it("detaches the supplied payload and returns fresh encode buffers", () => {
    const bytes = payload([[...toneRecord(0, 30, 226, 4), ...END], [...END], [...END], [...END]]);
    const doc = importSoundDocument(bytes, { profileId: "2.936" });
    bytes.fill(0);
    const encoded = doc.encode();
    assert.equal(encoded[8], 30);
    encoded[8] = 99;
    assert.equal(doc.encode()[8], 30);
    // Mutating a returned buffer cannot corrupt the document either.
    const lane = doc.tracks()!;
    assert.throws(() => {
      (lane as unknown as SoundEvent[][])[0]!.length = 0;
    });
  });
});
