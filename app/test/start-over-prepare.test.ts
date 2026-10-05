import assert from "node:assert/strict";
import { test } from "node:test";
import { createStartOver } from "../src/engine/startOver.ts";
import type { EngineState } from "../src/engine/useEngineTypes.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";

test("Start over from Home prepares the timeline before marking the fresh boot", async () => {
  // No game has run on this page yet: the timeline view is created by the
  // run preparation, so marking before it exists has nothing to mark.
  let timeline: { expect(expected: boolean): void } | undefined;
  const calls: string[] = [];
  const startOver = createStartOver({
    state: { phase: "idle" } as EngineState,
    getBootedGame: () => null,
    getWorker: () => null,
    sealHistory: async () => {},
    drainHistoryCommits: async () => {},
    pauseEngine: () => {},
    resumeEngine: () => {},
    hasEarlierSession: async () => false,
    prepareTimeline: async () => {
      await Promise.resolve();
      timeline = { expect: (expected) => void calls.push(`expect:${expected}`) };
    },
    expectStartOver: (expected = true) => timeline!.expect(expected),
    bootFresh: async () => {
      calls.push("boot");
    },
    showNote: () => {},
  });
  await startOver("kq1", {} as LlmConfig);
  assert.deepEqual(calls, ["expect:true", "boot", "expect:false"]);
});
