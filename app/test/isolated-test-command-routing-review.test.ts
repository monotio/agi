import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { createDebugController } from "../src/worker/debugController.ts";
import { installDebugController } from "../src/worker/debugLoader.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerInbound, WorkerOutbound } from "../src/worker/workerProtocol.ts";
import {
  createTestSession,
  type IsolatedTestGame,
  type TestWorkerLike,
} from "../src/studio/logic/debug/testSession.ts";

class EngineWorker implements TestWorkerLike {
  onmessage: ((event: { data: WorkerOutbound }) => void) | null = null;
  terminated = false;
  readonly posts: WorkerInbound[] = [];
  readonly hostIds: number[] = [];
  heldPause: Extract<WorkerInbound, { type: "debugPause" }> | null = null;
  readonly context = createWorkerContext({
    control: (data) => {
      if (data.type === "hostRequest") this.hostIds.push(data.id);
      this.onmessage?.({ data });
    },
    presentation: (data) => this.onmessage?.({ data }),
    now: () => 0,
    seedWord: () => 1234,
  });

  constructor() {
    // The production path lazy-loads the controller; the fake-port worker
    // installs it up front so session traffic stays synchronous.
    installDebugController(this.context, createDebugController(this.context));
    this.context.host = createEngineHost(this.context);
  }

  postMessage(message: WorkerInbound): void {
    if (this.terminated) return;
    this.posts.push(message);
    if (message.type === "debugPause") {
      this.heldPause = message;
      return;
    }
    this.dispatch(message);
  }

  dispatch(message: WorkerInbound): void {
    try {
      onWorkerMessage(this.context, message);
    } finally {
      this.context.fns.stopTimers();
    }
  }

  terminate(): void {
    this.terminated = true;
    this.onmessage = null;
    this.context.fns.stopTimers();
  }
}

function game(source: string): IsolatedTestGame {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    compileProjectLogic(source, {
      profile: PROFILES["2.411"],
      dictionary: new Map(),
      bindings: {},
    }).assembly.payload,
  );
  return {
    profile: "2.411",
    files: Object.fromEntries(container.files),
    sources: { "0": source },
    sourceBindings: {},
  };
}

test("an engine host request cannot consume a pending debugger command with the same id", async () => {
  const worker = new EngineWorker();
  let answer!: (value: string) => void;
  let prompts = 0;
  const session = createTestSession({
    createWorker: () => worker,
    prompts: {
      getString: () => {
        prompts++;
        return prompts === 1
          ? new Promise<string>((resolve) => {
              answer = resolve;
            })
          : "Second";
      },
    },
  });
  try {
    await session.start(
      game('get.string(s1, "First?", 0, 0, 10); get.string(s2, "Second?", 0, 0, 10); return;'),
      { stopOnEntry: false },
    );
    worker.context.fns.hostTick();
    assert.deepEqual(worker.hostIds, [1], "the first real prompt suspends execution");
    let acknowledged = false;
    void session.pause().then(
      () => {
        acknowledged = true;
      },
      () => {},
    );
    assert.ok(worker.heldPause);
    const pauseId = worker.heldPause.id;
    answer("First");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(worker.hostIds.includes(pauseId), "the engine minted an overlapping host id");
    worker.dispatch(worker.heldPause);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(acknowledged, true, "only the debugger reply may settle its pending command");
  } finally {
    session.close();
    worker.terminate();
  }
});

test("closing Test inside its worker factory disposes the returned worker before boot", async () => {
  const worker = new EngineWorker();
  const session = createTestSession({
    createWorker: () => {
      session.close();
      return worker;
    },
  });
  try {
    await assert.rejects(session.start(game("return;")));
    assert.equal(worker.posts.length, 0, "a revoked run cannot boot the worker it just acquired");
    assert.equal(
      worker.terminated,
      true,
      "a late worker belongs to the closed run and is disposed",
    );
    assert.equal(session.run, null);
  } finally {
    session.close();
    worker.terminate();
  }
});
