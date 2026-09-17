import { test } from "node:test";
import assert from "node:assert/strict";
import { useGameLifecycle, type GameLifecycleOptions } from "../src/useGameLifecycle.ts";

test("Exit preserves the worker and session when autosave succeeds but history cannot become durable", async () => {
  const calls: string[] = [];
  const state = { leaving: false, powerUp: { busy: false } };
  const lifecycle = useGameLifecycle({
    state,
    authoring: { getSession: () => null },
    autosave: { flushAutosaveDetailed: async () => ({ status: "saved" }) },
    link: {
      query: async () => {
        throw new Error("history timeout");
      },
      terminateWorker: () => calls.push("terminate"),
      drainPendingQueries: () => calls.push("drain queries"),
    },
    pauseEngine: () => calls.push("pause"),
    resumeEngine: () => calls.push("resume"),
    abortWalkthrough: () => calls.push("abort"),
    promptCancel: () => calls.push("cancel"),
    drainHistoryCommits: async () => {},
    nextSessionId: () => calls.push("next session"),
  } as unknown as GameLifecycleOptions);
  await assert.rejects(lifecycle.ejectGame(), /history.*not.*saved/i);
  assert.equal(state.leaving, false);
  assert.deepEqual(calls, ["pause", "resume"]);
});
