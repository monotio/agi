import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWorkerContext,
  type WorkerContext,
  type WorkerPorts,
} from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { createDebugController } from "../src/worker/debugController.ts";
import { ensureDebugController } from "../src/worker/debugLoader.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerControl, WorkerInbound } from "../src/worker/workerProtocol.ts";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { PROFILES, type AgiProfile } from "../../src/runtime/profile.ts";

/**
 * The lazy controller boundary: a `debug*` command starts the one-shot
 * import and queues behind it in arrival order, while ordinary traffic
 * passes through. A refused load refuses every later demand explicitly —
 * and never wedges an ordinary boot. The fake-port context injects the
 * module so the loader's order, not the network, is under test.
 */

const PROFILE = "2.411";
const profile: AgiProfile = PROFILES[PROFILE];

interface Harness {
  ctx: WorkerContext;
  control: WorkerControl[];
  send: (msg: WorkerInbound) => void;
  tick: () => void;
}

function harness(): Harness {
  const control: WorkerControl[] = [];
  let now = 0;
  const ports: WorkerPorts = {
    control: (msg) => control.push(msg),
    presentation: () => {},
    now: () => now,
    seedWord: () => 0x1234,
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);
  const send = (msg: WorkerInbound): void => {
    onWorkerMessage(ctx, msg);
    ctx.fns.stopTimers();
  };
  const tick = (): void => {
    now += 1000 / 60;
    ctx.fns.hostTick();
  };
  return { ctx, control, send, tick };
}

function game(): { files: Record<string, Uint8Array> } {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    compileProjectLogic("assignn(v40, 1);\nreturn;", {
      profile,
      dictionary: new Map(),
      bindings: {},
    }).assembly.payload,
  );
  return { files: Object.fromEntries(container.files) };
}

function plainBoot(): WorkerInbound {
  return { type: "boot", files: game().files, words: [], profile: PROFILE };
}

/**
 * Dispatch registers its queue drain before this await, so loader completion
 * also completes the drain. Stop the boot's timers before yielding a macrotask:
 * the test drives polls explicitly and checks the queued key before consumption.
 */
async function flush(ctx: WorkerContext): Promise<void> {
  await ctx.debuggerLoader.loading;
  ctx.fns.stopTimers();
}

function controls(h: Harness, type: string): Record<string, unknown>[] {
  return h.control.filter((m) => m.type === type) as Record<string, unknown>[];
}

/** A module-load gate the test resolves when it chooses. */
function deferredModule(ctx: WorkerContext): {
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  ctx.debuggerLoader.importModule = () =>
    new Promise((yes, no) => {
      resolve = () => yes({ createDebugController });
      reject = no;
    });
  return {
    resolve: () => resolve(),
    reject: (error: unknown) => reject(error),
  };
}

test("a debug demand kicks off the import; queued traffic drains in arrival order", async () => {
  const h = harness();
  const gate = deferredModule(h.ctx);

  // Ordinary traffic passes straight through while nothing loads.
  h.send({ type: "state", id: 1 });
  assert.equal(controls(h, "engineState").length, 1);

  h.send({ type: "debugAttach", id: 2 });
  assert.equal(controls(h, "debugAttached").length, 0, "the attach waits on the import");
  assert.deepEqual(h.ctx.debuggerLoader.queue.length, 1);

  // Traffic that lands mid-load queues behind the demand, in order.
  h.send(plainBoot());
  h.send({ type: "key", code: 0x0d });
  h.send({ type: "state", id: 4 });
  assert.deepEqual(h.ctx.debuggerLoader.queue.length, 4);
  assert.equal(controls(h, "booted").length, 0);

  gate.resolve();
  await flush(h.ctx);

  const order = h.control.map((m) => m.type);
  // Arrival order held across the load: the attach drained first — refused
  // `noEngine` since its boot had not run yet — then the boot, then the
  // ordinary query.
  const refused = h.control.find((m) => m.type === "debugError") as
    { id: number; code: string } | undefined;
  assert.equal(refused?.["id"], 2);
  assert.equal(refused?.["code"], "noEngine");
  const booted = order.indexOf("booted");
  const engineState = order.lastIndexOf("engineState");
  assert.ok(booted > 0, "the boot drained after the refused attach");
  assert.ok(engineState > booted, "the state query drained after the boot");
  // The key drained into the running game's input queue.
  assert.equal(h.ctx.run.input.keyQueue.length, 1);
  assert.equal(h.ctx.debuggerLoader.queue.length, 0);
});

test("a refused module load reports and refuses every later demand", async () => {
  const h = harness();
  const gate = deferredModule(h.ctx);

  h.send({ type: "debugAttach", id: 11 });
  gate.reject(new Error("chunk gone"));
  await flush(h.ctx);

  assert.equal(h.ctx.debuggerLoader.failed, true);
  assert.equal(h.ctx.run.engine, null);
  const errors = controls(h, "error").map((m) => String(m["message"]));
  assert.ok(
    errors.some((m) => m.includes("execution debugger failed to load")),
    "the load failure reported on the error channel",
  );
  const refusals = controls(h, "debugError");
  assert.equal(refusals.length, 1, "the queued demand answered its refusal");
  assert.equal(refusals[0]!["id"], 11);
  assert.equal(refusals[0]!["code"], "unavailable");

  // Later debug commands refuse fast on the debug channel.
  h.send({ type: "debugPause", id: 12, epoch: 1 });
  assert.equal(controls(h, "debugError").length, 2);
  assert.equal(controls(h, "debugError")[1]!["code"], "unavailable");

  // An ordinary boot is untouched by the failed debugger load.
  h.send(plainBoot());
  assert.equal(controls(h, "booted").length, 1, "a boot still runs the game");
  assert.ok(h.ctx.run.engine !== null);

  // Ordinary traffic still flows — a failed debugger cannot wedge the worker.
  h.send({ type: "state", id: 14 });
  assert.equal(controls(h, "engineState").length, 1);
});

test("the import resolves once per context; later demands pass the gate free", async () => {
  const h = harness();
  let fetches = 0;
  h.ctx.debuggerLoader.importModule = () => {
    fetches++;
    return Promise.resolve({ createDebugController });
  };

  await ensureDebugController(h.ctx);
  await ensureDebugController(h.ctx);
  assert.equal(fetches, 1, "the one-shot import does not refetch");
  assert.equal(h.ctx.debuggerLoader.installed, true);

  // An installed table answers synchronously — no queue, no await.
  h.send({ type: "state", id: 21 });
  assert.equal(controls(h, "engineState").length, 1);
  assert.equal(h.ctx.debuggerLoader.queue.length, 0);
});

test("a stale epoch command against the replaced run is refused", async () => {
  const h = harness();
  const gate = deferredModule(h.ctx);

  // The boot and the attach queue behind the load, then drain in order.
  h.send({ type: "boot", files: game().files, words: [], profile: PROFILE });
  h.send({ type: "debugAttach", id: 31 });
  gate.resolve();
  await flush(h.ctx);
  assert.equal(controls(h, "booted").length, 1);

  const attached = controls(h, "debugAttached").at(-1)!;
  const epoch = attached["epoch"] as number;

  // A fresh boot replaces the run; the session rebinds under a new epoch.
  h.send({ type: "boot", files: game().files, words: [], profile: PROFILE });
  const reset = controls(h, "debugSessionReset").at(-1)!;
  assert.notEqual(reset["epoch"], epoch, "the boot rebound the session under a fresh epoch");

  // A command carrying the old epoch names a run that no longer exists —
  // refused, never applied to the new one.
  h.send({ type: "debugPause", id: 32, epoch });
  const refusal = controls(h, "debugError").at(-1)!;
  assert.equal(refusal["code"], "staleEpoch");
});
