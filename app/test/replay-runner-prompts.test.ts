import { test } from "node:test";
import assert from "node:assert/strict";
import { runReplayBatch } from "../src/replayRunner.ts";
import type { ReplayAction, ReplayDriver, ReplayObservation } from "../src/replay.ts";

/**
 * Manhunter, Manhunter 2 and Police Quest ask two names in one logic pass:
 * the first answer lands the engine straight on the second get.string. The
 * runner must treat that fresh wait as the answer having been consumed and
 * let the next recorded answer resolve it.
 */
function observation(revision: number, blocked: string | null): ReplayObservation {
  return {
    revision,
    tick: 0,
    cycle: 0,
    blocked,
    state: { room: 1, vars: [0, 0, 0, 0], flags: [], egoX: 0, egoY: 0 } as never,
    rows: [],
    egoView: 0,
    releaseGate: 0,
  };
}

test("an answer that lands on the next prompt counts as consumed", async () => {
  const answers: string[] = [];
  const driver: ReplayDriver = {
    latest: observation(1, "getstring"),
    advance: async () => driver.latest!,
    key() {},
    direction() {},
    answer(text) {
      answers.push(text);
      // Prompt one resolves into prompt two; prompt two resolves into play.
      driver.latest = observation(
        driver.latest!.revision + 1,
        answers.length === 1 ? "getstring" : null,
      );
    },
    setPromptEcho() {},
    promptPending: () => true,
    playBatch: async () => ({ completed: true }) as never,
  };
  const actions: ReplayAction[] = [
    { kind: "answer", text: "Tad Timov" },
    { kind: "answer", text: "Mic Stone" },
  ];
  await runReplayBatch(driver, actions, { speed: 0 });
  assert.deepEqual(answers, ["Tad Timov", "Mic Stone"]);
  assert.equal(driver.latest?.blocked, null);
});
