import test from "node:test";
import assert from "node:assert/strict";
import { resolveFixtureTarget } from "../src/gameDiscovery.ts";
import type { InstalledGameDescriptor } from "../src/gameTypes.ts";

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
