import { test } from "node:test";
import assert from "node:assert/strict";
import { useEngineDebug } from "../src/useEngineDebug.ts";
import type { EngineState } from "../src/useEngineTypes.ts";
import type { WorkerLink } from "../src/useWorkerLink.ts";
import type { DebugChannels } from "../src/workerProtocol.ts";

function harness() {
  const posted: { type: string; channels?: DebugChannels }[] = [];
  const state = {
    debugConsumers: {
      dock: false,
      overlay: false,
      inspect: false,
      exploded: false,
      trace: false,
    },
    debugChannels: { ownership: false, objects: false, trace: false, picture: false },
  } as EngineState;
  const link = {
    getWorker: () => ({ postMessage: (m: { type: string }) => posted.push(m) }),
  } as unknown as WorkerLink;
  return { debug: useEngineDebug({ state, link }), state, posted };
}

test("one consumer turning off cannot disarm channels another needs", () => {
  const { debug, state } = harness();
  debug.setDebugConsumer("exploded", true);
  debug.setDebugConsumer("overlay", true);
  assert.deepEqual(state.debugChannels, {
    objects: true,
    ownership: true,
    picture: true,
    trace: false,
  });
  // Objects off must not disarm what exploded Layers still consumes.
  debug.setDebugConsumer("overlay", false);
  assert.deepEqual(state.debugChannels, {
    objects: true,
    ownership: true,
    picture: true,
    trace: false,
  });
  // Leaving the exploded view releases all three channels it armed.
  debug.setDebugConsumer("exploded", false);
  assert.deepEqual(state.debugChannels, {
    objects: false,
    ownership: false,
    picture: false,
    trace: false,
  });
});

test("dock, inspect and trace consumers derive independently", () => {
  const { debug, state } = harness();
  debug.setDebugConsumer("dock", true);
  assert.deepEqual(state.debugChannels, {
    objects: true,
    ownership: true,
    picture: false,
    trace: false,
  });
  debug.setDebugConsumer("trace", true);
  debug.setDebugConsumer("dock", false);
  debug.setDebugConsumer("inspect", true);
  assert.deepEqual(state.debugChannels, {
    objects: true,
    ownership: true,
    picture: false,
    trace: true,
  });
  debug.setDebugConsumer("inspect", false);
  assert.deepEqual(state.debugChannels, {
    objects: false,
    ownership: false,
    picture: false,
    trace: true,
  });
});

test("every consumer change posts the full derived channel set", () => {
  const { debug, posted } = harness();
  debug.setDebugConsumer("dock", true);
  debug.setDebugConsumer("inspect", true);
  const last = posted.at(-1)!;
  assert.equal(last.type, "debug");
  assert.deepEqual(last.channels, {
    objects: true,
    ownership: true,
    picture: false,
    trace: false,
  });
});
