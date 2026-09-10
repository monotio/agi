import test from "node:test";
import assert from "node:assert/strict";
import { decodeTextRows, findInstalledFolder } from "../src/gameTypes.ts";

test("decodeTextRows decodes 40x25 buffer into rows, handling nulls, glyphs, and ascii", () => {
  const buffer = new Uint8Array(40 * 25 * 2);
  // Write "SCORE: 10" on row 0
  const message = "SCORE: 10";
  for (let i = 0; i < message.length; i++) {
    buffer[i * 2] = message.charCodeAt(i);
    buffer[i * 2 + 1] = 0x0f;
  }
  // Write glyph (>= 0x80) on row 1 col 5
  buffer[(40 * 1 + 5) * 2] = 0x90;

  const rows = decodeTextRows(buffer);
  assert.equal(rows.length, 25);
  assert.equal(rows[0]?.slice(0, 9), "SCORE: 10");
  assert.equal(rows[0]?.slice(9), " ".repeat(31));
  assert.equal(rows[1]?.[5], "#");
});

test("findInstalledFolder matches case-insensitively and falls back to key", () => {
  const list = [
    { hash: "HASH1", alias: "kq1", folder: "kings-quest-1", title: "KQ1" },
    { hash: "HASH2", alias: "sq1", folder: "space-quest-1", title: "SQ1" },
  ];
  assert.equal(findInstalledFolder(list, "KQ1"), "kings-quest-1");
  assert.equal(findInstalledFolder(list, "space-quest-1"), "space-quest-1");
  assert.equal(findInstalledFolder(list, "HASH1"), "kings-quest-1");
  assert.equal(findInstalledFolder(list, "unknown"), "unknown");
});
