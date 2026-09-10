import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fixtureDir, fixtureSkip, KNOWN_GAME_HASH } from "../../test/fixtures.ts";
import {
  KNOWN_GAMES,
  detectKnownGame,
  detectKnownGameByHashes,
  getKnownGameByAlias,
  getKnownGameById,
  getKnownGameByRevision,
} from "../src/knownGames.ts";
import { KNOWN_WALKTHROUGHS, hasWalkthrough, resolveWalkthrough } from "../src/walkthrough.ts";
import { addLibraryGame } from "../src/gameLibrary.ts";
import { loadAuthoredGame } from "../src/gameStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();

test("known games catalog is internally consistent and collision-free", () => {
  const hex64 = /^[0-9a-f]{64}$/;
  const aliases = new Set<string>();
  const wordsHashes = new Set<string>();

  for (const game of KNOWN_GAMES) {
    assert.ok(!aliases.has(game.alias), `Duplicate known game alias: ${game.alias}`);
    aliases.add(game.alias);

    assert.ok(
      !wordsHashes.has(game.wordsSha256),
      `Collision on WORDS.TOK hash for ${game.alias}: ${game.wordsSha256}`,
    );
    wordsHashes.add(game.wordsSha256);

    assert.match(game.wordsSha256, hex64, `${game.alias} wordsSha256 must be a 64-char hex string`);
    assert.match(
      game.objectSha256,
      hex64,
      `${game.alias} objectSha256 must be a 64-char hex string`,
    );
    if (game.targetRevision) {
      assert.match(
        game.targetRevision,
        hex64,
        `${game.alias} targetRevision must be a 64-char hex string`,
      );
    }

    if (KNOWN_WALKTHROUGHS[game.alias]) {
      assert.equal(KNOWN_WALKTHROUGHS[game.alias]?.alias, game.alias);
    }
  }
});

test("detectKnownGameByHashes identifies games case-insensitively and avoids collisions", () => {
  const mh1 = KNOWN_GAMES.find((g) => g.alias === "mh1")!;
  assert.ok(mh1);

  // Exact match
  const matchExact = detectKnownGameByHashes(mh1.wordsSha256, mh1.objectSha256);
  assert.equal(matchExact?.alias, "mh1");
  assert.equal(matchExact?.title, "Manhunter: New York");
  assert.equal(hasWalkthrough(matchExact?.alias ?? ""), true);

  // Uppercase hash matching
  const matchUpper = detectKnownGameByHashes(
    mh1.wordsSha256.toUpperCase(),
    mh1.objectSha256.toUpperCase(),
  );
  assert.equal(matchUpper?.alias, "mh1");

  // Match without object hash
  const matchWordsOnly = detectKnownGameByHashes(mh1.wordsSha256);
  assert.equal(matchWordsOnly?.alias, "mh1");

  // Mismatched object hash rejects
  const mismatchedObj = detectKnownGameByHashes(
    mh1.wordsSha256,
    "0000000000000000000000000000000000000000000000000000000000000000",
  );
  assert.equal(mismatchedObj, null);

  // Unknown words hash
  const unknown = detectKnownGameByHashes(
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  );
  assert.equal(unknown, null);
});

test("getKnownGameByAlias, getKnownGameById and getKnownGameByRevision look up games accurately", () => {
  const kq1 = getKnownGameByAlias("kq1");
  assert.equal(kq1?.alias, "kq1");
  assert.equal(getKnownGameByAlias("KQ1")?.alias, "kq1");
  assert.equal(getKnownGameById("KQ1")?.alias, "kq1");
  assert.equal(getKnownGameByAlias("nonexistent"), null);

  const mh1 = KNOWN_GAMES.find((g) => g.alias === "mh1")!;
  if (mh1.targetRevision) {
    const byRev = getKnownGameByRevision(mh1.targetRevision);
    assert.equal(byRev?.alias, "mh1");
    assert.equal(getKnownGameByRevision(mh1.targetRevision.toUpperCase())?.alias, "mh1");
  }
  assert.equal(getKnownGameByRevision("0000000000000000000000000000000000000000"), null);
});

test("hasWalkthrough and resolveWalkthrough resolve by game ID or content hashes", () => {
  // Direct walkthrough ID
  assert.equal(hasWalkthrough("kq1"), true);
  assert.equal(hasWalkthrough("kq2"), true);
  assert.equal(hasWalkthrough("sq1"), true);
  assert.equal(hasWalkthrough("mh1"), true);
  assert.equal(hasWalkthrough("unknown-game"), false);

  assert.equal(resolveWalkthrough("kq1"), "kq1");
  assert.equal(resolveWalkthrough("MH1"), "mh1");
  assert.equal(resolveWalkthrough("unknown"), null);

  // By WORDS.TOK hash
  const mh1 = KNOWN_GAMES.find((g) => g.alias === "mh1")!;
  assert.equal(hasWalkthrough(mh1.wordsSha256), true);
  assert.equal(resolveWalkthrough(mh1.wordsSha256), "mh1");

  // By target revision
  if (mh1.targetRevision) {
    assert.equal(hasWalkthrough(mh1.targetRevision), true);
    assert.equal(resolveWalkthrough(mh1.targetRevision), "mh1");
  }
});

for (const targetHash of [KNOWN_GAME_HASH.MH1, KNOWN_GAME_HASH.KQ1, KNOWN_GAME_HASH.SQ1] as const) {
  test(
    `detectKnownGame correctly fingerprints local fixture "${targetHash.slice(0, 8)}"`,
    { skip: fixtureSkip(targetHash, ["WORDS.TOK", "OBJECT"]) },
    async () => {
      const dir = fixtureDir(targetHash);
      const files: Record<string, Uint8Array> = {};
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile()) {
          files[entry.name] = new Uint8Array(readFileSync(dir + entry.name));
        }
      }

      const detected = await detectKnownGame(files);
      assert.ok(detected, `Expected game to be detected from fixture files`);
      assert.equal(detected.wordsSha256, targetHash);
      assert.ok(detected.title.length > 0);
      assert.equal(hasWalkthrough(detected.alias), true);
    },
  );
}

function installLocalStorage(t: { after(callback: () => void): void }): void {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        values.set(key, value);
        Object.defineProperty(this, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      },
      removeItem(key: string): void {
        values.delete(key);
        Reflect.deleteProperty(this, key);
      },
    },
  });
}

test(
  "addLibraryGame automatically fingerprints uploaded game and attaches canonical metadata",
  { skip: fixtureSkip(KNOWN_GAME_HASH.MH1, ["WORDS.TOK", "OBJECT"]) },
  async (t) => {
    installLocalStorage(t);
    const dir = fixtureDir(KNOWN_GAME_HASH.MH1);
    const files: Record<string, Uint8Array> = {};
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) {
        files[entry.name] = new Uint8Array(readFileSync(dir + entry.name));
      }
    }

    // Pretend the user uploaded this under an arbitrary title
    const openedGame = {
      files,
      words: [],
    };
    const opening = {
      preview: "data:image/png;base64,iVBORw0KGgo=",
      status: "ready" as const,
      message: "Checked.",
      profile: "3.002.102",
      rows: [],
      rgba: new Uint8Array(),
    };

    const gameId = await addLibraryGame(openedGame, "My Uploaded Game", "zip", opening);

    const loaded = await loadAuthoredGame(gameId);
    assert.ok(loaded);
    assert.equal(loaded.library?.gameId, "mh1");
    assert.equal(hasWalkthrough(loaded.library?.gameId ?? ""), true);
    assert.equal(loaded.title, "Manhunter: New York");
    assert.equal(loaded.library?.validation.profile, "3.002.102");
  },
);
