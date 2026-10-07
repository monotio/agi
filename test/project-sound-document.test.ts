import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { containerFromResources, openContainer } from "../src/container/container.ts";
import {
  compileProjectDocuments,
  ProjectDocumentCompileError,
  readProjectDocuments,
} from "../src/authoring/projectDocuments.ts";
import { buildSound } from "../src/sound/build.ts";
import { readSoundDocumentEnvelope } from "../src/sound/document.ts";
import type { ProfileId } from "../src/runtime/profile.ts";

const PROFILE_ID: ProfileId = "2.936";

// Hand-written native stream helpers. The bytes below spell the four-stream
// SOUND layout directly; nothing calls the encoder under test.
function toneRecord(lane: number, ticks: number, divisor: number, attenuation: number): number[] {
  return [
    ticks & 0xff,
    (ticks >> 8) & 0xff,
    (divisor >> 4) & 0x3f,
    0x80 | (lane << 5) | (divisor & 0x0f),
    0x90 | (lane << 5) | attenuation,
  ];
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

function filesWithSounds(sounds: ReadonlyMap<number, Uint8Array>) {
  return Object.fromEntries(containerFromResources({ sound: sounds }).files);
}

function envelopeText(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    format: "agi.sound-document",
    version: 1,
    profileId: PROFILE_ID,
    payload: [...TWO_TONE_PAYLOAD],
    eventIds: [["e7", "e9"], [], [], []],
    nextEventId: 10,
    ...overrides,
  });
}

// Lane 0 holds two tone events (30 ticks divisor 226, 20 ticks divisor 380);
// lanes 1-3 are bare terminators.
const TWO_TONE_PAYLOAD = payload([
  [...toneRecord(0, 30, 226, 4), ...toneRecord(0, 20, 380, 9), ...END],
  [...END],
  [...END],
  [...END],
]);

// A noncanonical record: the latch byte names lane 1 from inside lane 0 —
// structurally valid, decodes as a retained `raw` event.
const RAW_PAYLOAD = payload([
  [...toneRecord(0, 30, 226, 4), 10, 0, 0x0e, 0xa2, 0x94, ...END],
  [...END],
  [...END],
  [...END],
]);

// A padding gap between the lane 0 and lane 1 streams: opaque on import.
const GAPPED_PAYLOAD = new Uint8Array([
  8,
  0,
  12,
  0,
  14,
  0,
  16,
  0,
  ...END,
  0,
  0,
  ...END,
  ...END,
  ...END,
]);

describe("sound:N document sources", () => {
  test("a tagged envelope compiles to its exact native bytes and reopens with the same ids and cursor", () => {
    const text = envelopeText({});
    const files = filesWithSounds(new Map());

    const compiled = compileProjectDocuments({
      files,
      profileId: PROFILE_ID,
      documents: { "sound:5": text, bindings: "{}" },
    });
    const container = openContainer(compiled.files());
    assert.deepEqual([...container.getResource("sound", 5)!], [...TWO_TONE_PAYLOAD]);

    // The same claim over the stored bytes is reattached as authored source.
    const read = readProjectDocuments({
      files: Object.fromEntries(compiled.files()),
      profileId: PROFILE_ID,
      sources: { "sound:5": text },
    });
    assert.deepEqual(read.diagnostics, []);
    const document = read.documents["sound:5"];
    assert.equal(document, text, "the exact envelope text survives as the source");

    // And it reopens as a document: retained ids and the allocator cursor.
    const reopened = readSoundDocumentEnvelope(JSON.parse(document as string));
    assert.deepEqual(
      reopened.tracks()![0]!.map((event) => event.id),
      ["e7", "e9"],
    );
    assert.equal(reopened.serialize().nextEventId, 10);
    assert.equal(reopened.insertEvent(0, 2).tracks()![0]![2]!.id, "e10");
    assert.deepEqual([...reopened.encode()], [...TWO_TONE_PAYLOAD]);
  });

  test("noncanonical raw records keep their source claim while bytes are equal", () => {
    const files = filesWithSounds(new Map([[4, RAW_PAYLOAD]]));
    const text = JSON.stringify({
      format: "agi.sound-document",
      version: 1,
      profileId: PROFILE_ID,
      payload: [...RAW_PAYLOAD],
      eventIds: [["e1", "e2"], [], [], []],
      nextEventId: 3,
    });
    const read = readProjectDocuments({
      files,
      profileId: PROFILE_ID,
      sources: { "sound:4": text },
    });
    assert.deepEqual(read.diagnostics, []);
    assert.equal(read.documents["sound:4"], text);
    const reopened = readSoundDocumentEnvelope(JSON.parse(read.documents["sound:4"] as string));
    assert.deepEqual(reopened.tracks()![0]![1]!.data, {
      kind: "raw",
      toneLow: 0x0e,
      toneHigh: 0xa2,
      control: 0x94,
    });
  });

  test("an opaque envelope keeps its source claim while bytes are equal", () => {
    const files = filesWithSounds(new Map([[6, GAPPED_PAYLOAD]]));
    const text = JSON.stringify({
      format: "agi.sound-document",
      version: 1,
      profileId: PROFILE_ID,
      payload: [...GAPPED_PAYLOAD],
      eventIds: null,
      nextEventId: 4,
    });
    const read = readProjectDocuments({
      files,
      profileId: PROFILE_ID,
      sources: { "sound:6": text },
    });
    assert.deepEqual(read.diagnostics, []);
    assert.equal(read.documents["sound:6"], text);
    const reopened = readSoundDocumentEnvelope(JSON.parse(read.documents["sound:6"] as string));
    assert.equal(reopened.representation, "opaque");
    assert.equal(reopened.tracks(), null);
    assert.deepEqual([...reopened.encode()], [...GAPPED_PAYLOAD]);
  });

  test("a claim whose payload differs from the stored bytes is refused, staying byte-only", () => {
    const other = payload([[...toneRecord(0, 30, 226, 4), ...END], [...END], [...END], [...END]]);
    const files = filesWithSounds(new Map([[3, TWO_TONE_PAYLOAD]]));
    const text = envelopeText({
      payload: [...other],
      eventIds: [["e7"], [], [], []],
      nextEventId: 8,
    });
    const read = readProjectDocuments({
      files,
      profileId: PROFILE_ID,
      sources: { "sound:3": text },
    });
    const document = read.documents["sound:3"];
    assert.ok(document instanceof Uint8Array, "the refused claim keeps the native bytes");
    assert.deepEqual([...document], [...TWO_TONE_PAYLOAD]);
    assert.equal(read.diagnostics.length, 1);
    assert.match(read.diagnostics[0]!.message, /does not reproduce SOUND 3/);
  });

  test("malformed and mismatched envelopes refuse to compile without mutating the inputs", () => {
    const files = filesWithSounds(new Map([[5, TWO_TONE_PAYLOAD]]));
    const cases: { name: string; text: string; match: RegExp }[] = [
      {
        name: "unknown nested version",
        text: envelopeText({ version: 2 }),
        match: /version 2/i,
      },
      {
        name: "unknown format marker",
        text: envelopeText({ format: "agi.sound" }),
        match: /agi\.sound/,
      },
      {
        name: "extra field",
        text: envelopeText({ extra: true }),
        match: /exactly the fields/,
      },
      {
        name: "id count mismatch",
        text: envelopeText({ eventIds: [["e7"], [], [], []] }),
        match: /lane 0 has 1 ids but the decoded lane has 2 events/,
      },
      {
        name: "pinned profile mismatch",
        text: envelopeText({ profileId: "2.089" }),
        match: /pinned to profile '2\.089'.*selects '2\.936'/,
      },
    ];
    for (const { name, text, match } of cases) {
      const documents: Record<string, string | Uint8Array> = {
        "sound:5": text,
        bindings: "{}",
      };
      const before = structuredClone({ files, documents });
      assert.throws(
        () => compileProjectDocuments({ files, profileId: PROFILE_ID, documents }),
        (error: unknown) => {
          assert.ok(error instanceof ProjectDocumentCompileError, name);
          assert.equal(error.key, "sound:5", name);
          assert.match(error.message, match, name);
          return true;
        },
        name,
      );
      // Nothing was staged or rewritten: both inputs compare equal.
      assert.deepEqual(files, before.files, name);
      assert.deepEqual(documents, before.documents, name);
    }
  });

  test("the same invalid envelopes are refused claims at open, never attached", () => {
    const files = filesWithSounds(new Map([[5, TWO_TONE_PAYLOAD]]));
    for (const text of [
      envelopeText({ version: 2 }),
      envelopeText({ format: "agi.sound" }),
      envelopeText({ extra: true }),
      envelopeText({ profileId: "2.089" }),
    ]) {
      const read = readProjectDocuments({
        files,
        profileId: PROFILE_ID,
        sources: { "sound:5": text },
      });
      assert.ok(read.documents["sound:5"] instanceof Uint8Array);
      assert.equal(read.diagnostics.length, 1);
      assert.match(read.diagnostics[0]!.message, /unusable/);
    }
  });

  test("legacy track-array sources compile to exactly the hand-computed bytes", () => {
    const tracks = JSON.stringify([
      { notes: [{ duration: 30, freqDivisor: 226, attenuation: 4 }] },
      { notes: [] },
      { notes: [{ duration: 60, freqDivisor: 760, attenuation: 10 }] },
      { notes: [] },
    ]);
    // Offsets 8/15/17/24; lane 0 one record, lane 2 one record, terminators.
    const expected = [
      8, 0, 15, 0, 17, 0, 24, 0, 30, 0, 0x0e, 0x82, 0x94, 0xff, 0xff, 0xff, 0xff, 60, 0, 0x2f, 0xc8,
      0xda, 0xff, 0xff, 0xff, 0xff,
    ];
    // The literal spells the buildSound layout by hand; the builder call is a
    // cross-check that the two cannot silently drift apart.
    assert.deepEqual(
      [...buildSound(JSON.parse(tracks))],
      expected,
      "fixture sanity: literal tracks layout",
    );
    const compiled = compileProjectDocuments({
      files: filesWithSounds(new Map()),
      profileId: PROFILE_ID,
      documents: { "sound:5": tracks, bindings: "{}" },
    });
    const stored = openContainer(compiled.files()).getResource("sound", 5)!;
    assert.deepEqual([...stored], expected);

    const read = readProjectDocuments({
      files: Object.fromEntries(compiled.files()),
      profileId: PROFILE_ID,
      sources: { "sound:5": tracks },
    });
    assert.deepEqual(read.diagnostics, []);
    assert.equal(read.documents["sound:5"], tracks);
  });
});
