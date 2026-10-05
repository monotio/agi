import { scheduler as testScheduler } from "node:timers/promises";
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
  type TestPauseLease,
  type TestWorkerLike,
} from "../src/studio/logic/debug/testSession.ts";
import { createTestHost } from "../src/studio/logic/debug/testHost.ts";
import { bytesToBase64 } from "../src/project/bytes.ts";

class EngineWorker implements TestWorkerLike {
  onmessage: ((event: { data: WorkerOutbound }) => void) | null = null;
  readonly context = createWorkerContext({
    control: (data) => this.onmessage?.({ data }),
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
    try {
      onWorkerMessage(this.context, message);
    } finally {
      this.context.fns.stopTimers();
    }
  }

  terminate(): void {
    this.onmessage = null;
    this.context.fns.stopTimers();
  }
}

function game(): IsolatedTestGame {
  const source = "assignn(v40, 1); return;";
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

test("Test waits for the live-game park before creating its worker or publishing ready", async () => {
  let grant!: (lease: TestPauseLease) => void;
  const parked = new Promise<TestPauseLease>((resolve) => {
    grant = resolve;
  });
  let workers = 0;
  let ready = false;
  const session = createTestSession({
    acquirePauseLease: () => parked,
    createWorker: () => {
      workers++;
      return new EngineWorker();
    },
  });
  const admission = session.start(game()).then((run) => {
    ready = true;
    return run;
  });
  try {
    await testScheduler.yield();
    assert.equal(workers, 0, "a pending park must precede the isolated worker");
    assert.equal(ready, false, "ready must not authorize Test while the live game is unparked");
    grant({ release() {} });
    await admission;
    assert.equal(workers, 1);
  } finally {
    grant({ release() {} });
    await admission.catch(() => undefined);
    session.close();
  }
});

test("a returned Test stop cannot mutate the session's pinned observation", async () => {
  const session = createTestSession({ createWorker: () => new EngineWorker() });
  try {
    const run = await session.start(game());
    const offered = run.stop;
    assert.ok(offered);
    assert.equal(offered.state.vars[40], 0);
    try {
      offered.state.vars[40] = 88;
    } catch (error) {
      assert.ok(error instanceof TypeError, "deeply frozen observations may reject mutation");
    }
    assert.equal(run.stop?.state.vars[40], 0, "caller mutation cannot rewrite the published stop");
  } finally {
    session.close();
  }
});

for (const obsoleteBy of ["abort", "clear"] as const) {
  test(`a description made obsolete by ${obsoleteBy} cannot repopulate the next build's host`, async () => {
    let answer!: (value: string) => void;
    const description = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const host = createTestHost({ saveDescription: () => description });
    const cancelled = new AbortController();
    const obsolete = host.handle(
      { id: 1, op: "saveDescription", context: { initial: "", maxLen: 30, row: 1, col: 1 } },
      cancelled.signal,
    );
    if (obsoleteBy === "abort") cancelled.abort();
    host.clear();
    answer("obsolete build description");
    await obsolete.catch(() => undefined);
    await host.handle(
      { id: 2, op: "saveWrite", context: { slot: 1, image: bytesToBase64(new Uint8Array([1])) } },
      new AbortController().signal,
    );
    assert.equal(
      host.slots()[0]?.description,
      "",
      "an old callback cannot seed a new build's slot",
    );
  });
}

test("a lease callback that closes Test cannot create a worker after teardown", async () => {
  const workers: EngineWorker[] = [];
  const session = createTestSession({
    acquirePauseLease: () => {
      session.close();
      return { release() {} };
    },
    createWorker: () => {
      const worker = new EngineWorker();
      workers.push(worker);
      return worker;
    },
  });
  try {
    await assert.rejects(session.start(game()));
    assert.equal(
      workers.length,
      0,
      "ending authority inside acquisition must precede worker creation",
    );
    assert.equal(session.run, null);
  } finally {
    session.close();
    for (const worker of workers) worker.terminate();
  }
});
