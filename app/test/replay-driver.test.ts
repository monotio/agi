import test from "node:test";
import assert from "node:assert/strict";
import { createReplayDriver } from "../src/useReplayDriver.ts";
import type { ReplayObservation } from "../src/replay.ts";

function createMockObservation(revision: number, blocked: string | null = null): ReplayObservation {
  return {
    revision,
    tick: 10,
    cycle: 5,
    blocked,
    state: {
      room: 1,
      inputEnabled: true,
      pictureShown: true,
      terminated: false,
      profile: "2.936",
    } as unknown as ReplayObservation["state"],
    rows: [],
    egoView: 0,
    releaseGate: 0,
  };
}

test("createReplayDriver delegates input and queries cleanly", async () => {
  const sentKeys: [number, number | undefined][] = [];
  const sentDirs: [number, number | undefined][] = [];
  const submittedPrompts: string[] = [];
  let currentSession = 3;
  let promptPending = false;
  const observationListeners = new Set<(obs: ReplayObservation) => void>();

  const driver = createReplayDriver({
    query: async <T>(type: string, extra?: Record<string, unknown>) => {
      return { type, extra } as unknown as T;
    },
    sendKey: (code, sessionId) => {
      sentKeys.push([code, sessionId]);
    },
    sendDirection: (dir, sessionId) => {
      sentDirs.push([dir, sessionId]);
    },
    submitPrompt: (text) => {
      submittedPrompts.push(text);
    },
    setPromptEcho: () => {},
    isPromptPending: () => promptPending,
    getActiveWalkthroughSession: () => currentSession,
    getLatestFrame: () => null,
    observationListeners,
  });

  assert.equal(driver.sessionId, 3);
  currentSession = 5;
  assert.equal(driver.sessionId, 5);

  driver.key(13, 2);
  assert.deepEqual(sentKeys, [[13, 2]]);

  driver.direction(4, 2);
  assert.deepEqual(sentDirs, [[4, 2]]);

  driver.answer("take key");
  assert.deepEqual(submittedPrompts, ["take key"]);

  assert.equal(driver.promptPending(), false);
  promptPending = true;
  assert.equal(driver.promptPending(), true);
});

test("createReplayDriver waitForRevision resolves when matching observation fires", async () => {
  const observationListeners = new Set<(obs: ReplayObservation) => void>();
  const driver = createReplayDriver({
    query: async <T>() => ({}) as T,
    sendKey: () => {},
    sendDirection: () => {},
    submitPrompt: () => {},
    isPromptPending: () => false,
    getActiveWalkthroughSession: () => 1,
    getLatestFrame: () => null,
    observationListeners,
  });

  assert.ok(driver.waitForRevision);
  const waitPromise = driver.waitForRevision(10);
  assert.equal(observationListeners.size, 1);

  // An observation with revision <= 10 should not resolve the waiter
  for (const listener of observationListeners) {
    listener(createMockObservation(10));
  }
  assert.equal(observationListeners.size, 1);

  // An observation with revision 11 resolves the waiter
  const expectedObs = createMockObservation(11);
  for (const listener of observationListeners) {
    listener(expectedObs);
  }

  const result = await waitPromise;
  assert.equal(result.revision, 11);
  assert.equal(observationListeners.size, 0);
});

test("createReplayDriver waitForRevision respects abort signal", async () => {
  const observationListeners = new Set<(obs: ReplayObservation) => void>();
  const driver = createReplayDriver({
    query: async <T>() => ({}) as T,
    sendKey: () => {},
    sendDirection: () => {},
    submitPrompt: () => {},
    isPromptPending: () => false,
    getActiveWalkthroughSession: () => 1,
    getLatestFrame: () => null,
    observationListeners,
  });

  const controller = new AbortController();
  assert.ok(driver.waitForRevision);
  const waitPromise = driver.waitForRevision(10, { signal: controller.signal });
  assert.equal(observationListeners.size, 1);

  controller.abort();
  await assert.rejects(waitPromise, (err: unknown) => {
    assert.ok(err instanceof DOMException);
    assert.equal(err.name, "AbortError");
    return true;
  });
  assert.equal(observationListeners.size, 0);
});
