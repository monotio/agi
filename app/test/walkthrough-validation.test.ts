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
    schema: "monotio_agi.walkthrough.v1",
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

  // Unknown game slug
  assert.throws(
    () =>
      validateWalkthroughArtifact({
        schema: "monotio_agi.walkthrough.v1",
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
        schema: "monotio_agi.walkthrough.v1",
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
        schema: "monotio_agi.walkthrough.v1",
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
        schema: "monotio_agi.walkthrough.v1",
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
        schema: "monotio_agi.walkthrough.v1",
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
        schema: "monotio_agi.walkthrough.v1",
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
        schema: "monotio_agi.walkthrough.v1",
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
        schema: "monotio_agi.walkthrough.v1",
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
        schema: "monotio_agi.walkthrough.v1",
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

    // 3. Subsequent request for the same slug should be memoized
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
