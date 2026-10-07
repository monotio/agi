import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeTextRows,
  findInstalledFolder,
  preferCatalogedEdition,
  type InstalledGameDescriptor,
} from "../src/project/gameTypes.ts";
import { getKnownGameByAlias } from "../../src/games/knownGames.ts";
import { testRevision } from "./identity.ts";

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

/**
 * One known game's descriptors: the verified PC edition, a same-dictionary
 * derivative, and the Amiga port, which shares the PC release's WORDS.TOK
 * but carries its own (WORDS.TOK, OBJECT) pair and pins no revision.
 */
function sq2Editions(): {
  exact: InstalledGameDescriptor;
  derivative: InstalledGameDescriptor;
  port: InstalledGameDescriptor;
} {
  const pc = getKnownGameByAlias("sq2")!;
  const amiga = getKnownGameByAlias("sq2-amiga")!;
  return {
    exact: {
      hash: pc.wordsSha256,
      alias: "sq2",
      title: pc.title,
      folder: "sq2",
      wordsSha256: pc.wordsSha256,
      objectSha256: pc.objectSha256,
      revision: pc.targetRevision,
    },
    derivative: {
      hash: pc.wordsSha256,
      alias: "sq2-remix",
      title: "Space Quest II Remix",
      folder: "sq2-remix",
      wordsSha256: pc.wordsSha256,
      objectSha256: pc.objectSha256,
      revision: testRevision("sq2-remix-bytes"),
    },
    port: {
      hash: amiga.wordsSha256,
      alias: "sq2-amiga",
      title: amiga.title,
      folder: "sq2-amiga",
      wordsSha256: amiga.wordsSha256,
      objectSha256: amiga.objectSha256,
    },
  };
}

test("preferCatalogedEdition names only the verified exact edition", () => {
  const { exact, derivative, port } = sq2Editions();
  // The pair alone is family recognition: the derivative's changed bundle
  // and the port's own pair are not the catalogued PC edition.
  assert.equal(preferCatalogedEdition([derivative, exact]), exact);
  assert.equal(preferCatalogedEdition([derivative, exact, port]), exact);
  assert.equal(preferCatalogedEdition([derivative, port]), null);
  // No revision evidence at all leaves the pair resolution to decide: a
  // catalogued pair without a supplied revision still answers (ports pin
  // no revision; their pair is the recognition).
  const { revision: _rev, ...legacyExact } = exact;
  assert.equal(preferCatalogedEdition([derivative, legacyExact]), legacyExact);
  assert.equal(preferCatalogedEdition([]), null);
});

test("findInstalledFolder prefers the exact edition over a same-pair derivative", () => {
  const { exact, derivative, port } = sq2Editions();
  const list = [derivative, port, exact];
  // The shared vocabulary/hash spelling is a convenience query: it lands
  // on the verified edition, not on first-found or on the remix.
  const wordsHash = getKnownGameByAlias("sq2")!.wordsSha256;
  assert.equal(findInstalledFolder(list, wordsHash), "sq2");
  assert.equal(findInstalledFolder(list, wordsHash.toUpperCase()), "sq2");
  // The full revision is an exact-content spelling for each instance.
  assert.equal(findInstalledFolder(list, exact.revision!), "sq2");
  assert.equal(findInstalledFolder(list, derivative.revision!), "sq2-remix");
  // The folder remains the explicit instance selector, ports included.
  assert.equal(findInstalledFolder(list, "sq2-remix"), "sq2-remix");
  assert.equal(findInstalledFolder(list, "SQ2-AMIGA"), "sq2-amiga");
});

test("findInstalledFolder resolves the exact folder spelling before folded convenience", () => {
  // A case-sensitive filesystem can hold two folders whose names differ only
  // by case; each exact spelling selects its own instance.
  const upper: InstalledGameDescriptor = {
    hash: "hash-upper",
    alias: "upper-edition",
    title: "Upper Chamber",
    folder: "Chamber",
  };
  const lower: InstalledGameDescriptor = {
    hash: "hash-lower",
    alias: "lower-edition",
    title: "Lower Chamber",
    folder: "chamber",
  };
  const list = [upper, lower];
  assert.equal(findInstalledFolder(list, "chamber"), "chamber");
  assert.equal(findInstalledFolder(list, "Chamber"), "Chamber");
  // String-only entries follow the same policy.
  assert.equal(findInstalledFolder(["Chamber", "chamber"], "chamber"), "chamber");
  // A folded spelling that names two folders stays unresolved — the boot
  // edge refuses it rather than picking the first.
  assert.equal(findInstalledFolder(list, "CHAMBER"), "CHAMBER");
  assert.equal(findInstalledFolder(["Chamber", "chamber"], "CHAMBER"), "CHAMBER");
  // A folded spelling naming one folder still resolves.
  assert.equal(findInstalledFolder([upper], "CHAMBER"), "Chamber");
});

test("findInstalledFolder never chooses between unresolved editions", () => {
  // Two unknown editions share a vocabulary hash: no catalogued edition
  // names a preference, so the spelling stays unresolved rather than
  // landing on the first folder. The boot edge refuses it.
  const list: InstalledGameDescriptor[] = [
    {
      hash: "shared-words",
      alias: "edition-a",
      title: "Edition A",
      folder: "edition-a",
      wordsSha256: "shared-words",
    },
    {
      hash: "shared-words",
      alias: "edition-b",
      title: "Edition B",
      folder: "edition-b",
      wordsSha256: "shared-words",
    },
  ];
  assert.equal(findInstalledFolder(list, "shared-words"), "shared-words");
  assert.equal(findInstalledFolder(list, "edition-a"), "edition-a");
});
