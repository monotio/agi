import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateWalkthroughArtifact,
  loadWalkthrough,
  clearWalkthroughCache,
  type WalkthroughArtifact,
} from "../src/walkthrough.ts";

test("validateWalkthroughArtifact accepts valid walkthrough structure", () => {
  const valid: WalkthroughArtifact = {
    schema: "monotio.agi.walkthrough.v1",
    game: "kq1",
    coverage: "complete-game",
    profile: "2.917",
    seed: 12345,
    virtualTicks: 500,
    cycles: 100,
    elapsedMs: 250,
    actions: [
      { kind: "key", code: 0x000d },
      { kind: "advance", ticks: 20 },
      { kind: "direction", dir: 3 },
      { kind: "answer", text: "yes" },
      { kind: "checkpoint", label: "Start", room: 1, score: 0, x: 80, y: 120 },
    ],
  };
  const result = validateWalkthroughArtifact(valid);
  assert.deepEqual(result, valid);
});

test("validateWalkthroughArtifact rejects invalid structures and out-of-bound values", () => {
  assert.throws(() => validateWalkthroughArtifact(null), /must be an object/);
  assert.throws(() => validateWalkthroughArtifact(undefined), /must be an object/);
  assert.throws(() => validateWalkthroughArtifact("string"), /must be an object/);

  // Unsupported schema
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "invalid.schema.v2",
        game: "kq1",
        coverage: "complete-game",
        profile: "2.917",
        seed: 0,
        virtualTicks: 100,
        cycles: 10,
        elapsedMs: 50,
        actions: [],
      }),
    /Unsupported walkthrough schema/,
  );

  // Unknown game identifier
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio.agi.walkthrough.v1",
        game: "unknown-game",
        coverage: "complete-game",
        profile: "2.917",
        seed: 0,
        virtualTicks: 100,
        cycles: 10,
        elapsedMs: 50,
        actions: [],
      }),
    /Unsupported game/,
  );

  // Out of bounds ticks / seed / cycles
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio.agi.walkthrough.v1",
        game: "kq1",
        coverage: "complete-game",
        profile: "2.917",
        seed: -1,
        virtualTicks: 100,
        cycles: 10,
        elapsedMs: 50,
        actions: [],
      }),
    /seed/,
  );
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio.agi.walkthrough.v1",
        game: "kq1",
        coverage: "complete-game",
        profile: "2.917",
        seed: 0,
        virtualTicks: -5,
        cycles: 10,
        elapsedMs: 50,
        actions: [],
      }),
    /virtualTicks/,
  );
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio.agi.walkthrough.v1",
        game: "kq1",
        coverage: "complete-game",
        profile: "2.917",
        seed: 0,
        virtualTicks: 100,
        cycles: -1,
        elapsedMs: 50,
        actions: [],
      }),
    /cycles/,
  );

  // Invalid actions
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio.agi.walkthrough.v1",
        game: "kq1",
        coverage: "complete-game",
        profile: "2.917",
        seed: 0,
        virtualTicks: 100,
        cycles: 10,
        elapsedMs: 50,
        actions: [{ kind: "unknown" }],
      }),
    /action/,
  );
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio.agi.walkthrough.v1",
        game: "kq1",
        coverage: "complete-game",
        profile: "2.917",
        seed: 0,
        virtualTicks: 100,
        cycles: 10,
        elapsedMs: 50,
        actions: [{ kind: "key", code: -1 }],
      }),
    /key code/,
  );
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio.agi.walkthrough.v1",
        game: "kq1",
        coverage: "complete-game",
        profile: "2.917",
        seed: 0,
        virtualTicks: 100,
        cycles: 10,
        elapsedMs: 50,
        actions: [{ kind: "advance", ticks: 0 }],
      }),
    /advance ticks/,
  );
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio.agi.walkthrough.v1",
        game: "kq1",
        coverage: "complete-game",
        profile: "2.917",
        seed: 0,
        virtualTicks: 100,
        cycles: 10,
        elapsedMs: 50,
        actions: [{ kind: "checkpoint", label: "Bad", room: -1, score: 0, x: 0, y: 0 }],
      }),
    /room/,
  );
});

test("validateWalkthroughArtifact validates targetHash and supportedHashes when present", () => {
  const validHash = "41d863172326c712c0aebadf12fc63b049ff5d892743f4ee990004c344eb3780";
  const validUpper = "41D863172326C712C0AEBADF12FC63B049FF5D892743F4EE990004C344EB3780";

  // Valid targetHash and supportedHashes (normalized to lowercase)
  const result = validateWalkthroughArtifact({
    schema: "monotio.agi.walkthrough.v1",
    game: "kq1",
    targetHash: validUpper,
    supportedHashes: [validUpper],
    coverage: "complete-game",
    profile: "2.917",
    seed: 1,
    virtualTicks: 100,
    cycles: 10,
    elapsedMs: 50,
    actions: [],
  });
  assert.equal(result.targetHash, validHash);
  assert.deepEqual(result.supportedHashes, [validHash]);

  // Invalid targetHash (too short, non-hex, wrong type)
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio.agi.walkthrough.v1",
        game: "kq1",
        targetHash: "not-a-hash",
        coverage: "complete-game",
        profile: "2.917",
        seed: 1,
        virtualTicks: 100,
        cycles: 10,
        elapsedMs: 50,
        actions: [],
      }),
    /Invalid walkthrough targetHash/,
  );
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio.agi.walkthrough.v1",
        game: "kq1",
        targetHash: 12345,
        coverage: "complete-game",
        profile: "2.917",
        seed: 1,
        virtualTicks: 100,
        cycles: 10,
        elapsedMs: 50,
        actions: [],
      }),
    /Invalid walkthrough targetHash/,
  );

  // Invalid supportedHashes (not array, entry invalid)
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio.agi.walkthrough.v1",
        game: "kq1",
        supportedHashes: "not-an-array",
        coverage: "complete-game",
        profile: "2.917",
        seed: 1,
        virtualTicks: 100,
        cycles: 10,
        elapsedMs: 50,
        actions: [],
      }),
    /supportedHashes must be an array/,
  );
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio.agi.walkthrough.v1",
        game: "kq1",
        supportedHashes: ["short"],
        coverage: "complete-game",
        profile: "2.917",
        seed: 1,
        virtualTicks: 100,
        cycles: 10,
        elapsedMs: 50,
        actions: [],
      }),
    /Invalid walkthrough supportedHash at index 0/,
  );
});

test("loadWalkthrough memoizes results and evicts failed fetches", async () => {
  clearWalkthroughCache();

  let fetchCount = 0;
  let shouldFail = true;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
    fetchCount++;
    if (shouldFail) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        schema: "monotio.agi.walkthrough.v1",
        game: "kq1",
        coverage: "complete-game",
        profile: "2.917",
        seed: 42,
        virtualTicks: 100,
        cycles: 20,
        elapsedMs: 50,
        actions: [{ kind: "advance", ticks: 10 }],
      }),
    } as Response;
  }) as typeof globalThis.fetch;

  try {
    // 1. Initial failing request should reject and evict from cache
    await assert.rejects(() => loadWalkthrough("kq1"), /404/);
    assert.equal(fetchCount, 1);

    // 2. Next request after failure should re-fetch (eviction succeeded)
    shouldFail = false;
    const secondResult = await loadWalkthrough("kq1");
    assert.notEqual(secondResult, null);
    assert.equal(secondResult.game, "kq1");
    assert.equal(fetchCount, 2);

    // 3. Subsequent request for the same game should be memoized
    const thirdResult = await loadWalkthrough("kq1");
    assert.equal(thirdResult, secondResult);
    assert.equal(fetchCount, 2);

    // 4. clearWalkthroughCache allows re-fetching
    clearWalkthroughCache();
    const fourthResult = await loadWalkthrough("kq1");
    assert.deepEqual(fourthResult, secondResult);
    assert.equal(fetchCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
    clearWalkthroughCache();
  }
});
