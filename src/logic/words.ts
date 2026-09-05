/**
 * AGI WORDS.TOK dictionary: reader, writer, and lookup.
 *
 * Binary layout (Peter Kelly's agi-re spec, "Dictionary file"):
 * - 26 unsigned big-endian u16 offsets, one per lowercase initial `a`..`z`.
 *   An offset of zero means that initial has no entries. Nonzero offsets are
 *   strictly increasing; each section ends where the next nonzero section
 *   begins (or at end of file for the last one).
 * - Each entry is prefix-compressed against the preceding decoded word:
 *
 *   ```text
 *   prefix_length:u8
 *   encoded_suffix:u8[]   // char = (byte & 0x7f) ^ 0x7f; bit 0x80 marks the final suffix byte
 *   word_id:u16be
 *   ```
 *
 * Dictionary lookup is case-insensitive for ASCII letters.
 */

/** One decoded dictionary entry. */
export interface WordEntry {
  readonly word: string;
  readonly id: number;
}

/** Reserved word id: in said() patterns, matches exactly one parsed word. */
export const ANY_WORD = 0x0001;
/** Reserved word id: in said() patterns, terminates the pattern successfully (tail wildcard). */
export const REST_OF_LINE = 0x270f;
// Word id 0 is the ignored-word group: recognized at parse time but dropped
// from the parsed-word list (see parser results in the spec).

const OFFSET_TABLE_BYTES = 26 * 2;
const MAX_U16 = 0xffff;
const MAX_PREFIX_LENGTH = 0xff;

/** ASCII-only lowercase (dictionary case folding never touches non-letters). */
function asciiLower(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : s[i];
  }
  return out;
}

/**
 * Decode a WORDS.TOK image into entries, preserving file order.
 * Throws on truncated tables/entries, out-of-range offsets, over-long
 * prefixes, or sections that do not end on an entry boundary.
 */
export function parseWordsTok(data: Uint8Array): WordEntry[] {
  if (data.length < OFFSET_TABLE_BYTES) {
    throw new Error(
      `WORDS.TOK too short for the 26-offset table: ${data.length} byte(s), need ${OFFSET_TABLE_BYTES}`,
    );
  }

  const offsets: number[] = [];
  let previousNonzero = 0;
  for (let i = 0; i < 26; i++) {
    const off = ((data[i * 2] as number) << 8) | (data[i * 2 + 1] as number);
    if (off !== 0) {
      if (off < OFFSET_TABLE_BYTES) {
        throw new Error(
          `WORDS.TOK offset for initial '${String.fromCharCode(0x61 + i)}' points into the offset table: ${off}`,
        );
      }
      if (off >= data.length) {
        throw new Error(
          `WORDS.TOK offset for initial '${String.fromCharCode(0x61 + i)}' is past end of file: ${off} >= ${data.length}`,
        );
      }
      if (off <= previousNonzero) {
        throw new Error(
          `WORDS.TOK offsets not strictly increasing at initial '${String.fromCharCode(0x61 + i)}': ${off} <= ${previousNonzero}`,
        );
      }
      previousNonzero = off;
    }
    offsets.push(off);
  }

  const entries: WordEntry[] = [];
  let previousWord = "";
  for (let i = 0; i < 26; i++) {
    const start = offsets[i] as number;
    if (start === 0) continue;
    let end = data.length;
    for (let j = i + 1; j < 26; j++) {
      const next = offsets[j] as number;
      if (next !== 0) {
        end = next;
        break;
      }
    }

    let p = start;
    while (p < end) {
      // Authentic images may carry zero padding after the final entry of a
      // section (e.g. KQ1 ends with a single pad byte); skip an all-zero tail.
      let nonzeroTail = false;
      for (let q = p; q < end; q++) {
        if ((data[q] as number) !== 0) {
          nonzeroTail = true;
          break;
        }
      }
      if (!nonzeroTail) break;
      const prefixLength = data[p] as number;
      p += 1;
      if (prefixLength > previousWord.length) {
        throw new Error(
          `WORDS.TOK entry at offset ${p - 1} copies ${prefixLength} prefix char(s) from a ${previousWord.length}-char preceding word`,
        );
      }
      let suffix = "";
      for (;;) {
        if (p >= end) {
          throw new Error(
            `WORDS.TOK truncated entry at offset ${p}: suffix has no terminating byte`,
          );
        }
        const b = data[p] as number;
        p += 1;
        suffix += String.fromCharCode((b & 0x7f) ^ 0x7f);
        if ((b & 0x80) !== 0) break;
      }
      if (p + 2 > end) {
        throw new Error(`WORDS.TOK truncated entry at offset ${p}: missing u16 word id`);
      }
      const id = ((data[p] as number) << 8) | (data[p + 1] as number);
      p += 2;
      const word = previousWord.slice(0, prefixLength) + suffix;
      entries.push({ word, id });
      previousWord = word;
    }
  }
  return entries;
}

/**
 * Encode entries into a WORDS.TOK image.
 *
 * Entries are ASCII-lowercased and sorted alphabetically (per initial letter)
 * as prefix compression and the interpreter's binary-search semantics
 * require; the decoded output therefore always comes back in sorted order.
 * Group-0 (ignored) word ids are allowed. Words must be nonempty ASCII
 * starting with `a`..`z`; an exact-repeat word is re-encoded with a shorter
 * prefix because the suffix must carry at least the terminating byte.
 */
export function buildWordsTok(entries: readonly WordEntry[]): Uint8Array {
  const sorted = entries
    .map((e) => ({ word: asciiLower(e.word), id: e.id }))
    .sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : a.id - b.id));

  for (const e of sorted) {
    if (e.word.length === 0) {
      throw new Error(`WORDS.TOK cannot encode an empty word (id ${e.id})`);
    }
    const first = e.word.charCodeAt(0);
    if (first < 0x61 || first > 0x7a) {
      throw new Error(
        `WORDS.TOK word '${e.word}' does not start with a lowercase ASCII letter a-z`,
      );
    }
    for (let i = 0; i < e.word.length; i++) {
      if (e.word.charCodeAt(i) >= 0x80) {
        throw new Error(`WORDS.TOK word '${e.word}' contains a non-ASCII character`);
      }
    }
    if (e.id < 0 || e.id > MAX_U16 || !Number.isInteger(e.id)) {
      throw new Error(`WORDS.TOK word id ${e.id} for '${e.word}' does not fit u16`);
    }
  }

  const sections: Uint8Array[] = [];
  let previousWord = "";
  let previousInitial = "";
  for (const e of sorted) {
    let prefixLength = 0;
    if (e.word[0] === previousInitial) {
      const limit = Math.min(previousWord.length, e.word.length - 1, MAX_PREFIX_LENGTH);
      while (prefixLength < limit && previousWord[prefixLength] === e.word[prefixLength]) {
        prefixLength += 1;
      }
    }
    const suffixLength = e.word.length - prefixLength;
    const entry = new Uint8Array(1 + suffixLength + 2);
    entry[0] = prefixLength;
    for (let i = 0; i < suffixLength; i++) {
      let b = e.word.charCodeAt(prefixLength + i) ^ 0x7f;
      if (i === suffixLength - 1) b |= 0x80;
      entry[1 + i] = b;
    }
    const idAt = 1 + suffixLength;
    entry[idAt] = (e.id >> 8) & 0xff;
    entry[idAt + 1] = e.id & 0xff;
    sections.push(entry);
    previousWord = e.word;
    previousInitial = e.word[0] as string;
  }

  const total = OFFSET_TABLE_BYTES + sections.reduce((n, s) => n + s.length, 0);
  if (total > MAX_U16 + 1) {
    throw new Error(`WORDS.TOK image would be ${total} bytes, exceeding the u16 offset range`);
  }
  const out = new Uint8Array(total);
  let cursor = OFFSET_TABLE_BYTES;
  let sectionIndex = 0;
  for (const e of sorted) {
    const initial = (e.word.charCodeAt(0) as number) - 0x61;
    if (out[initial * 2] === 0 && out[initial * 2 + 1] === 0) {
      out[initial * 2] = (cursor >> 8) & 0xff;
      out[initial * 2 + 1] = cursor & 0xff;
    }
    out.set(sections[sectionIndex] as Uint8Array, cursor);
    cursor += (sections[sectionIndex] as Uint8Array).length;
    sectionIndex += 1;
  }
  return out;
}

/**
 * ASCII case-insensitive dictionary lookup. Returns the word id of the first
 * matching entry, or null when the token is not in the dictionary.
 */
export function lookupWord(entries: readonly WordEntry[], token: string): number | null {
  const needle = asciiLower(token);
  for (const e of entries) {
    if (asciiLower(e.word) === needle) return e.id;
  }
  return null;
}

/** Match the most specific dictionary phrase at a normalized whole-word boundary.
 * WORDS.TOK entries may contain spaces (AGI Studio's WORDS.TOK editor documentation).
 * Unknown input consumes one word, preserving the parser's unknown-position behavior.
 */
export function matchDictionaryPhrase(
  tokens: readonly string[],
  start: number,
  dictionary: ReadonlyMap<string, number>,
): { text: string; id: number | undefined; length: number } {
  let text = tokens[start] ?? "";
  let matched = { text, id: dictionary.get(text), length: 1 };
  for (let end = start + 1; end < tokens.length; end++) {
    text += ` ${tokens[end]!}`;
    const id = dictionary.get(text);
    if (id !== undefined) matched = { text, id, length: end - start + 1 };
  }
  return matched;
}
