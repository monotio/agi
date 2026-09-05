import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ANY_WORD,
  buildWordsTok,
  lookupWord,
  parseWordsTok,
  REST_OF_LINE,
  type WordEntry,
} from "../src/logic/words.ts";
import { fixtureSkip, KQ1_DIR } from "./fixtures.ts";

// Hand-computed WORDS.TOK for look=100, lookout=101, take=200.
//
// Offset table (26 u16be, entries start at byte 52):
//   'l' (index 11) -> 0x0034 = 52, 't' (index 19) -> 0x0041 = 65, rest 0.
//
// Entries (char byte = code ^ 0x7f, final suffix byte | 0x80):
//   look:    prefix 00 | l=13 o=10 o=10 k=14|80=94 | id 0064
//   lookout: prefix 04 | o=10 u=0a t=0b|80=8b      | id 0065
//   take:    prefix 00 | t=0b a=1e k=14 e=1a|80=9a | id 00c8
const HAND_BYTES = new Uint8Array([
  // offset table a..k (11 zeros)
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  // 'l' -> 52
  0x00,
  0x34,
  // m..s (7 zeros)
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  // 't' -> 65
  0x00,
  0x41,
  // u..z (6 zeros)
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  // 'l' section at 52
  0x00,
  0x13,
  0x10,
  0x10,
  0x94,
  0x00,
  0x64, // look = 100
  0x04,
  0x10,
  0x0a,
  0x8b,
  0x00,
  0x65, // lookout = 101
  // 't' section at 66
  0x00,
  0x0b,
  0x1e,
  0x14,
  0x9a,
  0x00,
  0xc8, // take = 200
]);

const HAND_ENTRIES: WordEntry[] = [
  { word: "look", id: 100 },
  { word: "lookout", id: 101 },
  { word: "take", id: 200 },
];

describe("buildWordsTok", () => {
  it("emits the exact hand-computed bytes for a three-word dictionary", () => {
    const built = buildWordsTok([
      { word: "look", id: 100 },
      { word: "lookout", id: 101 },
      { word: "take", id: 200 },
    ]);
    assert.deepEqual([...built], [...HAND_BYTES]);
  });

  it("sorts unsorted input per initial before compressing", () => {
    const built = buildWordsTok([
      { word: "take", id: 200 },
      { word: "lookout", id: 101 },
      { word: "look", id: 100 },
    ]);
    assert.deepEqual([...built], [...HAND_BYTES]);
  });

  it("rejects words that cannot be encoded", () => {
    assert.throws(() => buildWordsTok([{ word: "", id: 1 }]), /empty word/);
    assert.throws(() => buildWordsTok([{ word: "7up", id: 1 }]), /a-z/);
    assert.throws(() => buildWordsTok([{ word: "café", id: 1 }]), /non-ASCII/);
    assert.throws(() => buildWordsTok([{ word: "word", id: 0x1_0000 }]), /u16/);
  });
});

describe("parseWordsTok", () => {
  it("decodes the hand-built bytes into the exact entries", () => {
    assert.deepEqual(parseWordsTok(HAND_BYTES), HAND_ENTRIES);
  });

  it("roundtrips a larger deterministic word list", () => {
    const entries: WordEntry[] = [{ word: "the", id: 0 }]; // group-0 ignored word
    for (let i = 0; i < 200; i++) {
      // Shared prefixes exercise compression: ab00x, ab01x, ... and a solo initial.
      entries.push({ word: `ab${String(i % 50).padStart(2, "0")}x`, id: 1 + i });
    }
    entries.push({ word: "zebra", id: 0x270e });
    const parsed = parseWordsTok(buildWordsTok(entries));
    const expected = [...entries].sort((a, b) =>
      a.word < b.word ? -1 : a.word > b.word ? 1 : a.id - b.id,
    );
    assert.deepEqual(parsed, expected);
  });

  it("lowercases mixed-case input when building", () => {
    const parsed = parseWordsTok(buildWordsTok([{ word: "LoOk", id: 100 }]));
    assert.deepEqual(parsed, [{ word: "look", id: 100 }]);
  });

  it("throws on a truncated entry", () => {
    // Cut the final id byte of 'take'.
    assert.throws(() => parseWordsTok(HAND_BYTES.slice(0, HAND_BYTES.length - 1)), /truncated/);
    // Cut mid-suffix of 'look' (before the 0x80 terminator byte). Zero the 't'
    // offset first so the shortened image is not rejected on section bounds.
    const noTake = new Uint8Array(HAND_BYTES);
    noTake[19 * 2] = 0x00;
    noTake[19 * 2 + 1] = 0x00;
    assert.throws(() => parseWordsTok(noTake.slice(0, 55)), /truncated/);
  });

  it("throws on bad offsets", () => {
    const pastEnd = new Uint8Array(HAND_BYTES);
    pastEnd[11 * 2] = 0xff; // 'l' -> 0xff34, way past EOF
    pastEnd[11 * 2 + 1] = 0x34;
    assert.throws(() => parseWordsTok(pastEnd), /past end of file/);

    const intoTable = new Uint8Array(HAND_BYTES);
    intoTable[11 * 2] = 0x00; // 'l' -> 10, inside the offset table
    intoTable[11 * 2 + 1] = 0x0a;
    assert.throws(() => parseWordsTok(intoTable), /offset table/);

    assert.throws(() => parseWordsTok(new Uint8Array(10)), /too short/);
  });
});

describe("lookupWord", () => {
  it("matches ASCII case-insensitively and returns the id", () => {
    assert.equal(lookupWord(HAND_ENTRIES, "look"), 100);
    assert.equal(lookupWord(HAND_ENTRIES, "LOOK"), 100);
    assert.equal(lookupWord(HAND_ENTRIES, "LoOkOuT"), 101);
    assert.equal(lookupWord(HAND_ENTRIES, "TAKE"), 200);
  });

  it("returns null for unknown tokens", () => {
    assert.equal(lookupWord(HAND_ENTRIES, "swim"), null);
    assert.equal(lookupWord(HAND_ENTRIES, ""), null);
  });
});

describe("reserved word ids", () => {
  it("pins the said() pattern constants", () => {
    assert.equal(ANY_WORD, 0x0001);
    assert.equal(REST_OF_LINE, 0x270f);
  });
});

const FIXTURE = KQ1_DIR + "WORDS.TOK";

describe("authentic KQ1 WORDS.TOK fixture", { skip: fixtureSkip("kq1") }, () => {
  const raw = readFileSync(FIXTURE);
  const entries = parseWordsTok(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));

  it("parses a full-size dictionary", () => {
    // Observed: the authentic KQ1 dictionary decodes to 495 entries.
    assert.ok(entries.length > 400, `expected >400 entries, got ${entries.length}`);
  });

  it("finds a nonzero id for 'look'", () => {
    const id = lookupWord(entries, "look");
    assert.ok(id !== null && id !== 0, `expected nonzero id for 'look', got ${id}`);
  });

  it("is alphabetically ordered within each initial", () => {
    for (let i = 0; i + 1 < entries.length; i++) {
      const a = entries[i] as WordEntry;
      const b = entries[i + 1] as WordEntry;
      if (a.word[0] === b.word[0]) {
        assert.ok(a.word <= b.word, `'${a.word}' should sort before '${b.word}'`);
      }
    }
  });

  it("keeps every id within u16", () => {
    for (const e of entries) {
      assert.ok(Number.isInteger(e.id) && e.id >= 0 && e.id <= 0xffff, `bad id ${e.id}`);
    }
  });
});
