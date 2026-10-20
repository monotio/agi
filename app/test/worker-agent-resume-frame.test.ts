import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSessionState } from "../../src/agent/agentState.ts";
import { installBoilerplateSeed } from "../../src/agent/baseTemplate.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { GAME_DICTIONARY, StubAgent } from "../src/agent/stubAgent.ts";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type {
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";

/** The stub agent's genesis world: the base template plus its room 1 and ego view. */
function stubWorld(stub: StubAgent): {
  files: Record<string, Uint8Array>;
  words: [string, number][];
} {
  const state = createAgentSessionState();
  installBoilerplateSeed(state);
  for (const res of stub.initialResources())
    state.container.putResource(res.kind, res.num, res.payload);
  const words: [string, number][] = [...GAME_DICTIONARY];
  state.wordsPayload = buildWordsTok(words.map(([word, id]) => ({ word, id })));
  return { files: Object.fromEntries(state.getFiles()), words };
}

function harness(): {
  ctx: WorkerContext;
  control: WorkerControl[];
  presentation: WorkerPresentation[];
  clock: { now: number };
} {
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const clock = { now: 0 };
  const ctx = createWorkerContext({
    control: (message) => control.push(message),
    presentation: (message) => presentation.push(message),
    now: () => clock.now,
    seedWord: () => 1,
  });
  ctx.host = createEngineHost(ctx);
  return { ctx, control, presentation, clock };
}

function frameOf(ctx: WorkerContext) {
  const engine = ctx.run.engine!;
  const frame = engine.getPresentation();
  return { ...frame, picRow: engine.displayBase, modal: engine.modalKind };
}

function diffBytes(a: Uint8Array, b: Uint8Array, width: number): string[] {
  const out: string[] = [];
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length && out.length < 20; i++)
    if (a[i] !== b[i]) out.push(`(${i % width},${Math.floor(i / width)}) ${a[i]} -> ${b[i]}`);
  return out;
}

/**
 * The player's rule: a resumed autosave shows the screen the game had when the
 * checkpoint was taken, picture, views and text alike. The room here did not
 * exist at boot: the stub agent authored it on the way east, so the resume
 * rebuilds the screen from a container the game grew while it was played.
 */
test("an autosave resumed after a reload shows the frame it was taken from", async () => {
  const stub = new StubAgent(() => {});
  const world = stubWorld(stub);
  const { ctx, control, presentation, clock } = harness();
  onWorkerMessage(ctx, {
    type: "boot",
    files: world.files,
    words: world.words,
    profile: "2.936",
    authorRooms: true,
    autosaveFiles: true,
  });
  ctx.fns.stopTimers();
  const tick = (cycles = 1) => {
    for (let i = 0; i < cycles; i++) {
      clock.now += 100;
      ctx.fns.tickEngine();
    }
  };
  tick();
  assert.equal(ctx.run.engine!.modalKind, "print", "room 1 opens its window");
  onWorkerMessage(ctx, { type: "key", code: 13 });
  tick();
  assert.equal(ctx.run.engine!.modalKind, null);
  onWorkerMessage(ctx, { type: "input", text: "east" });
  tick();
  const request = control.find(
    (message) => message.type === "hostRequest" && message.op === "room",
  );
  assert.ok(request?.type === "hostRequest", "east asks the host for room 2");
  const response = await stub.handle({ op: "room", context: request.context });
  onWorkerMessage(ctx, {
    type: "hostAnswer",
    generation: ctx.run.generation,
    id: request.id,
    response,
  } satisfies WorkerInbound);
  tick();
  assert.equal(ctx.run.engine!.vars[0], 2);
  assert.equal(ctx.run.engine!.modalKind, "print", "room 2 opens its window");
  onWorkerMessage(ctx, { type: "key", code: 13 });
  tick();
  assert.equal(ctx.run.engine!.modalKind, null);
  tick(50);
  assert.ok(ctx.fns.autosave(true), "a progress entry is taken in room 2");
  const saved = presentation.findLast((message) => message.type === "autosave");
  assert.ok(saved?.type === "autosave" && saved.room === 2);
  const before = frameOf(ctx);

  const resumed = harness();
  onWorkerMessage(resumed.ctx, {
    type: "boot",
    files: saved.files ?? Object.fromEntries(ctx.run.engine!.containerFiles),
    words: world.words,
    profile: "2.936",
    authorRooms: true,
    restoreImage: saved.image,
    restoreMenus: saved.menus,
    ...(saved.rng ? { restoreRng: saved.rng } : {}),
  });
  resumed.ctx.fns.stopTimers();
  const restored = resumed.control.find((message) => message.type === "restored");
  assert.ok(restored?.type === "restored" && restored.ok, JSON.stringify(restored));
  const atRestore = frameOf(resumed.ctx);
  for (let i = 0; i < 5; i++) {
    resumed.clock.now += 100;
    resumed.ctx.fns.tickEngine();
  }
  const after = frameOf(resumed.ctx);
  assert.equal(after.picRow, before.picRow);
  assert.equal(after.modal, before.modal);
  assert.deepEqual(diffBytes(before.visual, atRestore.visual, 160), [], "restore frame");
  assert.deepEqual(diffBytes(before.visual, after.visual, 160), [], "visual after cycles");
  assert.deepEqual(diffBytes(before.priority, after.priority, 160), [], "priority after cycles");
  assert.deepEqual(diffBytes(before.text, after.text, 80), [], "text after cycles");
});
