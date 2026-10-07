import test from "node:test";
import assert from "node:assert/strict";
import { resolveFixtureTarget } from "../src/library/gameDiscovery.ts";
import type { InstalledGameDescriptor } from "../src/project/gameTypes.ts";
import { getKnownGameByAlias } from "../../src/games/knownGames.ts";
import { testRevision } from "./identity.ts";

test("resolveFixtureTarget resolves matching games by alias, hash, wordsSha256 or folder", () => {
  const games: InstalledGameDescriptor[] = [
    {
      hash: "hash-kq1",
      alias: "kq1",
      folder: "kings-quest",
      wordsSha256: "words-sha-kq1",
      title: "King's Quest I",
    },
    {
      hash: "hash-sq1",
      alias: "sq1",
      folder: "space-quest",
      title: "Space Quest I",
    },
  ];

  // Match by alias
  const byAlias = resolveFixtureTarget(games, "KQ1");
  assert.equal(byAlias.target, "kings-quest");
  assert.equal(byAlias.match?.alias, "kq1");

  // Match by folder
  const byFolder = resolveFixtureTarget(games, "space-quest");
  assert.equal(byFolder.target, "space-quest");
  assert.equal(byFolder.match?.alias, "sq1");

  // Match by hash
  const byHash = resolveFixtureTarget(games, "hash-kq1");
  assert.equal(byHash.target, "kings-quest");

  // Fallback when not found
  const unknown = resolveFixtureTarget(games, "unknown-game");
  assert.equal(unknown.target, "unknown-game");
  assert.equal(unknown.match, undefined);

  // Null installedGames list
  const nullList = resolveFixtureTarget(null, "kq1");
  assert.equal(nullList.target, "kq1");
  assert.equal(nullList.match, undefined);
});

test("resolveFixtureTarget handles shared vocabulary and requires disambiguation", () => {
  const games: InstalledGameDescriptor[] = [
    {
      hash: "edition-a",
      alias: "edition-a",
      folder: "edition-a",
      wordsSha256: "shared-words-sha",
      title: "Edition A",
    },
    {
      hash: "edition-b",
      alias: "edition-b",
      folder: "edition-b",
      wordsSha256: "shared-words-sha",
      title: "Edition B",
    },
  ];

  // Resolving by folder is unambiguous
  assert.equal(resolveFixtureTarget(games, "edition-a").target, "edition-a");
  assert.equal(resolveFixtureTarget(games, "edition-b").target, "edition-b");

  // Resolving by shared words hash throws ambiguous error
  assert.throws(
    () => resolveFixtureTarget(games, "shared-words-sha"),
    /Ambiguous fixture query.*specify the fixture folder/,
  );
});

test("resolveFixtureTarget selects the exact folder spelling before folded convenience", () => {
  // Two folders differing only by case are distinct instances on a
  // case-sensitive filesystem: each exact spelling reaches its own folder.
  const games: InstalledGameDescriptor[] = [
    { hash: "hash-upper", alias: "upper-edition", folder: "Chamber", title: "Upper Chamber" },
    { hash: "hash-lower", alias: "lower-edition", folder: "chamber", title: "Lower Chamber" },
  ];
  const lower = resolveFixtureTarget(games, "chamber");
  assert.equal(lower.target, "chamber");
  assert.equal(lower.match?.folder, "chamber");
  const upper = resolveFixtureTarget(games, "Chamber");
  assert.equal(upper.target, "Chamber");
  assert.equal(upper.match?.folder, "Chamber");
  // A folded spelling that names two folders refuses at the boot edge.
  assert.throws(
    () => resolveFixtureTarget(games, "CHAMBER"),
    /Ambiguous fixture query "CHAMBER".*Chamber, chamber.*specify the fixture folder/,
  );
  // A folded spelling naming one folder still resolves.
  assert.equal(resolveFixtureTarget([games[0]!], "CHAMBER").target, "Chamber");
});

test("resolveFixtureTarget prefers the exact edition over a same-pair derivative and port", () => {
  const pc = getKnownGameByAlias("sq2")!;
  const amiga = getKnownGameByAlias("sq2-amiga")!;
  const exact: InstalledGameDescriptor = {
    hash: pc.wordsSha256,
    alias: "sq2",
    title: pc.title,
    folder: "sq2",
    wordsSha256: pc.wordsSha256,
    objectSha256: pc.objectSha256,
    revision: pc.targetRevision,
  };
  // Same WORDS.TOK + OBJECT pair, different playable bundle: the derivative
  // must never steal the canonical original's convenience spellings.
  const derivative: InstalledGameDescriptor = {
    hash: pc.wordsSha256,
    alias: "sq2-remix",
    title: "Space Quest II Remix",
    folder: "sq2-remix",
    wordsSha256: pc.wordsSha256,
    objectSha256: pc.objectSha256,
    revision: testRevision("sq2-remix-bytes"),
  };
  // The port shares the PC vocabulary hash but is its own catalogued pair.
  const port: InstalledGameDescriptor = {
    hash: amiga.wordsSha256,
    alias: "sq2-amiga",
    title: amiga.title,
    folder: "sq2-amiga",
    wordsSha256: amiga.wordsSha256,
    objectSha256: amiga.objectSha256,
  };
  const games = [derivative, port, exact];

  // The vocabulary hash is a convenience spelling: the verified edition
  // answers it, whichever folder happens to be listed first.
  const byWords = resolveFixtureTarget(games, pc.wordsSha256);
  assert.equal(byWords.target, "sq2");
  assert.equal(byWords.match?.folder, "sq2");

  // Full revisions are exact-content spellings; each resolves to its own
  // instance even when the bundle is the same recognized family.
  const byExactRevision = resolveFixtureTarget(games, pc.targetRevision!);
  assert.equal(byExactRevision.target, "sq2");
  const byDerivativeRevision = resolveFixtureTarget(games, derivative.revision!);
  assert.equal(byDerivativeRevision.target, "sq2-remix");
  assert.equal(byDerivativeRevision.match?.folder, "sq2-remix");

  // Alias and folder spellings reach each instance directly.
  assert.equal(resolveFixtureTarget(games, "sq2-remix").target, "sq2-remix");
  assert.equal(resolveFixtureTarget(games, "sq2-amiga").target, "sq2-amiga");
});

test("resolveFixtureTarget refuses two unresolved instances of one vocabulary", () => {
  const pc = getKnownGameByAlias("sq2")!;
  // Two changed bundles share the recognized (WORDS.TOK, OBJECT) pair but
  // supply revisions the catalog does not verify: neither is the exact
  // edition, and the query must not pick the first folder.
  const first: InstalledGameDescriptor = {
    hash: pc.wordsSha256,
    alias: "sq2-remix-a",
    title: "Space Quest II Remix A",
    folder: "sq2-remix-a",
    wordsSha256: pc.wordsSha256,
    objectSha256: pc.objectSha256,
    revision: testRevision("sq2-remix-a-bytes"),
  };
  const second: InstalledGameDescriptor = {
    hash: pc.wordsSha256,
    alias: "sq2-remix-b",
    title: "Space Quest II Remix B",
    folder: "sq2-remix-b",
    wordsSha256: pc.wordsSha256,
    objectSha256: pc.objectSha256,
    revision: testRevision("sq2-remix-b-bytes"),
  };
  const games = [first, second];
  assert.throws(
    () => resolveFixtureTarget(games, pc.wordsSha256),
    /Ambiguous fixture query.*sq2-remix-a, sq2-remix-b.*specify the fixture folder/,
  );
  // Exact spellings still reach each instance.
  assert.equal(resolveFixtureTarget(games, "sq2-remix-a").target, "sq2-remix-a");
  assert.equal(resolveFixtureTarget(games, first.revision!).target, "sq2-remix-a");
});
