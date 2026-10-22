/**
 * A remix turn that adds a word and an object reaches the running
 * game and its export: the metadata patch carries the vocabulary and the
 * object file, so a typed command works at once and a download keeps both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSessionState } from "../../src/agent/agentState.ts";
import { executeAgentTool } from "../../src/agent/tools.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
import { changedResources } from "../src/agent/sessionState.ts";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerControl, WorkerInbound } from "../src/worker/workerProtocol.ts";

type Call = readonly [string, Record<string, unknown>];

function author(calls: readonly Call[]) {
  const state = createAgentSessionState();
  for (const [name, args] of calls) {
    const result = executeAgentTool(state, name, args);
    if (!result.success) throw new Error(result.error);
  }
  return state;
}

const INITIAL: readonly Call[] = [
  ["write_words", { words: ["look"] }],
  ["write_objects", { objects: [{ name: "Old key", startingRoom: 1 }] }],
  ["write_logic", { room: 0, source: "accept.input(); get(0); return;" }],
];
const TURN: readonly Call[] = [
  ["write_words", { words: ["sparkle"] }],
  [
    "write_objects",
    {
      objects: [
        { name: "Old key", startingRoom: 2 },
        { name: "Crystal", startingRoom: 255 },
      ],
    },
  ],
  [
    "write_logic",
    {
      room: 0,
      source: `
        accept.input();
        if (said("sparkle")) { assignn(v200, 77); }
        assignn(v202, 0); get.room.v(v202, v201);
        assignn(v202, 1); get.room.v(v202, v203);
        return;
      `,
    },
  ],
];

test("power-up vocabulary and inventory reach the live worker and exported game", async () => {
  const before = author(INITIAL);
  const after = author([...INITIAL, ...TURN]);
  const control: WorkerControl[] = [];
  let now = 0;
  const ctx = createWorkerContext({
    control: (message) => control.push(message),
    presentation: () => {},
    now: () => now,
    seedWord: () => 1,
  });
  ctx.host = createEngineHost(ctx);
  const send = (message: WorkerInbound): void => onWorkerMessage(ctx, message);
  const tick = (cycles: number): void => {
    for (let i = 0; i < cycles; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  let queryId = 0;
  const vars = (): readonly number[] => {
    const id = ++queryId;
    send({ type: "state", id });
    const reply = control.findLast((message) => "id" in message && message.id === id);
    assert.ok(reply?.type === "engineState" && reply.state);
    return reply.state.vars;
  };
  send({
    type: "boot",
    files: Object.fromEntries([...before.getFiles()].map(([name, bytes]) => [name, bytes.slice()])),
    words: [...before.sources.words],
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  tick(5);
  send({ type: "patch", resources: changedResources(before, after) });
  // The old transport: logic arrives without the vocabulary, so sparkle cannot fire.
  send({ type: "input", text: "sparkle" });
  tick(5);
  assert.equal(vars()[200], 0, "logic alone leaves the new word unknown");
  const files = Object.fromEntries(after.getFiles());
  send({ type: "patchMetadata", files });
  assert.ok(control.some((message) => message.type === "metadataPatched"));
  send({ type: "input", text: "sparkle" });
  tick(5);
  assert.equal(vars()[200], 77, "the new word reaches the running game");
  assert.equal(vars()[201], 255, "the old key is carried, as the live pickup left it");
  assert.equal(vars()[203], 255, "the new crystal is carried");
  const id = ++queryId;
  send({ type: "exportFiles", id });
  const exported = control.findLast((message) => "id" in message && message.id === id);
  assert.ok(exported?.type === "exportFiles" && exported.files);
  assert.ok(parseWordsTok(exported.files["WORDS.TOK"]!).some(({ word }) => word === "sparkle"));
  assert.deepEqual([...exported.files["OBJECT"]!], [...files["OBJECT"]!]);
});
