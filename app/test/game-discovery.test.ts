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
  assert.equal(byAlias.target, "words-sha-kq1");
  assert.equal(byAlias.match?.alias, "kq1");

  // Match by folder
  const byFolder = resolveFixtureTarget(games, "space-quest");
  assert.equal(byFolder.target, "hash-sq1");
  assert.equal(byFolder.match?.alias, "sq1");

  // Match by hash
  const byHash = resolveFixtureTarget(games, "hash-kq1");
  assert.equal(byHash.target, "words-sha-kq1");

  // Fallback when not found
  const unknown = resolveFixtureTarget(games, "unknown-game");
  assert.equal(unknown.target, "unknown-game");
  assert.equal(unknown.match, undefined);

  // Null installedGames list
  const nullList = resolveFixtureTarget(null, "kq1");
  assert.equal(nullList.target, "kq1");
  assert.equal(nullList.match, undefined);
});
