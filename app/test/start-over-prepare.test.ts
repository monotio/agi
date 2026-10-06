import assert from "node:assert/strict";
import { test } from "node:test";
import { createStartOver } from "../src/engine/startOver.ts";
import type { EngineState } from "../src/engine/useEngineTypes.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
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

test("a superseded Start over releases its hold when timeline preparation rejects", async () => {
  const game = {} as BootedGame;
  const worker = {} as Worker;
  let session = 1;
  const calls: string[] = [];
  const startOver = createStartOver({
    state: { phase: "running" } as EngineState,
    getBootedGame: () => game,
    getWorker: () => worker,
    getSessionId: () => session,
    sealHistory: async () => {},
    drainHistoryCommits: async () => {},
    pauseEngine: (owner) => calls.push(`pause:${owner}`),
    resumeEngine: (owner) => calls.push(`resume:${owner}`),
    hasEarlierSession: async () => true,
    prepareTimeline: async () => {
      session++;
      throw new Error("Old timeline failed");
    },
    expectStartOver: () => calls.push("expect"),
    bootFresh: async () => {
      calls.push("boot");
    },
    showNote: () => calls.push("note"),
  });
  await assert.doesNotReject(startOver("starter", {} as LlmConfig));
  assert.deepEqual(calls, ["pause:startOver", "resume:startOver"]);
});
