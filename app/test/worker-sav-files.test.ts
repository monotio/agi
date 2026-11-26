/**
 * Worker-side original .SAV import/export tests: drives dispatch.ts with fake
 * ports and a real Engine across PC, Amiga PAL and Apple IIgs profiles, plus
 * every refusal boundary and post-import reconciliation step.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { PROFILES, type ProfileId } from "../../src/runtime/profile.ts";
import { decodeOriginalSav, encodeOriginalSav } from "../../src/runtime/savFile.ts";
import { loadAppearance } from "../src/render/appearance.ts";
import { createWorkerContext } from "../src/worker/context.ts";
import { createDebugController } from "../src/worker/debugController.ts";
import { installDebugController } from "../src/worker/debugLoader.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { MAX_ORIGINAL_SAV_BYTES } from "../src/worker/savFiles.ts";
import type {
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";

await Promise.all(["amiga-2.202", "iigs-1.014"].map((profile) => loadAppearance(profile)));

function makeGame(profileId: ProfileId, gameId = "DEMO", suffix = "") {
  const profile = PROFILES[profileId];
  const game = createContainer();
  game.putResource("picture", 0, Uint8Array.of(0xf0, 1, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
      if (!isset(f200)) {
        set(f200);
        set.game.id("${gameId}");
        load.pic(v0);
        draw.pic(v0);
        show.pic();
        assignn(v100, 37);
        set(f100);
        get(0);
      }
      ${suffix}
      return;`,
      { dictionary: new Map(), profile },
    ).payload,
  );
  const stride = profile.inventoryEntryBytes;
  const metadata = new Uint8Array(profile.inventoryHeaderBytes + stride + 4);
  metadata.set([stride, 0, 1]);
  metadata.set([stride, 0, 0], profile.inventoryHeaderBytes);
  metadata.set([107, 101, 121, 0], profile.inventoryHeaderBytes + stride);
  game.putFile("OBJECT", metadata);
  return game;
}

function makeHarness(t: test.TestContext) {
  let now = 1_000;
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const waiters: {
    type: WorkerControl["type"];
    id: number;
    resolve: (msg: WorkerControl) => void;
  }[] = [];
  const ctx = createWorkerContext({
    control: (message) => {
      control.push(message);
      if ("id" in message && typeof message.id === "number") {
        for (let i = waiters.length - 1; i >= 0; i--) {
          const waiter = waiters[i]!;
          if (waiter.type === message.type && waiter.id === message.id) {
            waiters.splice(i, 1);
            waiter.resolve(message);
          }
        }
      }
    },
    presentation: (message) => presentation.push(message),
    now: () => now,
  });
  installDebugController(ctx, createDebugController(ctx));
  ctx.host = createEngineHost(ctx);
  t.after(() => ctx.fns.stopTimers());
  const send = (msg: WorkerInbound) => onWorkerMessage(ctx, msg);
  const tick = () => {
    now += 100;
    ctx.fns.hostTick();
  };
  function waitForReply<T extends WorkerControl["type"]>(
    type: T,
    id: number,
  ): Promise<Extract<WorkerControl, { type: T }>> {
    const existing = control.find(
      (m): m is Extract<WorkerControl, { type: T }> => m.type === type && "id" in m && m.id === id,
    );
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      waiters.push({
        type,
        id,
        resolve: (msg) => resolve(msg as Extract<WorkerControl, { type: T }>),
      });
    });
  }
  return { ctx, control, presentation, send, tick, waitForReply };
}

for (const profile of ["2.936", "amiga-2.202", "iigs-1.014"] as const) {
  test(`${profile}: worker exports .SAV, imports it back, and reconciles state`, async (t) => {
    const { ctx, control, presentation, send, tick, waitForReply } = makeHarness(t);
    const game = makeGame(profile);
    send({
      type: "boot",
      files: Object.fromEntries(game.files),
      words: [],
      profile,
      ...(profile === "amiga-2.202" ? { amigaRegion: "pal" as const } : {}),
    });
    await ctx.projectLoader.loading;
    ctx.fns.stopTimers();
    // Amiga and Apple IIgs finish the initial show.pic dissolve across ~15-20 ticks.
    for (let step = 0; step < 40; step++) tick();
    const initialSegment = ctx.history.segment;
    assert.ok(initialSegment, "live play starts a history segment");

    send({ type: "exportSav", id: 1, description: "Courtyard" });
    const exported = await waitForReply("savExported", 1);
    assert.ok(exported.bytes, exported.error ?? "expected bytes");
    assert.equal(decodeOriginalSav(exported.bytes, PROFILES[profile]).description, "Courtyard");

    // Mutate state, queue stale inputs, and start a test recording.
    const engine = ctx.run.engine!;
    engine.vars[100] = 99;
    engine.flags[100] = 0;
    engine.setItemLocation(0, 2);
    ctx.run.input.keyQueue.push(65);
    ctx.run.input.deferredMovement.push(1);
    ctx.run.input.inputBuffer.push("look");
    ctx.run.input.clickQueue.push([50, 100]);
    send({ type: "startRecording", id: 2 });
    const recStart = await waitForReply("recordingStarted", 2);
    assert.equal(recStart.ok, true);

    const presentationBefore = presentation.length;
    const controlBefore = control.length;

    send({ type: "importSav", id: 3, bytes: exported.bytes });
    const imported = await waitForReply("savImported", 3);
    assert.equal(imported.ok, true, imported.error);
    assert.equal(engine.vars[100], 37);
    assert.equal(engine.flags[100], 1);
    assert.equal(engine.itemLocation(0), 255);
    if (profile === "amiga-2.202") {
      assert.equal(engine.amigaRegion, "pal", "Amiga PAL timing survives .SAV import");
    }

    // Queued inputs are cleared so stale keys never run into the restored room.
    assert.deepEqual(ctx.run.input.keyQueue, []);
    assert.deepEqual(ctx.run.input.deferredMovement, []);
    assert.deepEqual(ctx.run.input.inputBuffer, []);
    assert.deepEqual(ctx.run.input.clickQueue, []);

    // Active test recording is tainted.
    assert.ok(ctx.run.recording.recording?.tainted, "recording should be tainted on import");

    // History ended the old segment and opened a fresh segment for the imported state.
    assert.ok(ctx.history.segment && ctx.history.segment !== initialSegment);
    const newControl = control.slice(controlBefore);
    assert.ok(
      newControl.some((m) => m.type === "historyBatch" && m.batch.end?.reason === "resume"),
      "previous history segment ended cleanly",
    );

    // Frame and forced autosave were posted so the screen and browser storage update immediately.
    const newPresentation = presentation.slice(presentationBefore);
    assert.ok(newPresentation.some((m) => m.type === "frame"));
    assert.ok(newPresentation.some((m) => m.type === "autosave"));
  });
}

test("worker refuses export and import on 2.001, open modal, textMode, historyView, replay, and debugger stop", async (t) => {
  // 1. 2.001 booter refuses both
  {
    const { ctx, send, tick, waitForReply } = makeHarness(t);
    const game = makeGame("2.001");
    send({ type: "boot", files: Object.fromEntries(game.files), words: [], profile: "2.001" });
    await ctx.projectLoader.loading;
    ctx.fns.stopTimers();
    for (let step = 0; step < 5; step++) tick();
    send({ type: "exportSav", id: 10 });
    const exp = await waitForReply("savExported", 10);
    assert.equal(exp.bytes, null);
    assert.match(exp.error ?? "", /2\.001|disk sectors/);
    send({ type: "importSav", id: 11, bytes: new Uint8Array([1, 2, 3]) });
    const imp = await waitForReply("savImported", 11);
    assert.equal(imp.ok, false);
    assert.match(imp.error ?? "", /2\.001|disk sectors/);
  }

  // 2. Open modal refuses both
  {
    const { ctx, send, tick, waitForReply } = makeHarness(t);
    const game = makeGame("2.936", "DEMO", 'if (!isset(f201)) { set(f201); print("Wait"); }');
    send({ type: "boot", files: Object.fromEntries(game.files), words: [], profile: "2.936" });
    await ctx.projectLoader.loading;
    ctx.fns.stopTimers();
    for (let step = 0; step < 5; step++) tick();
    assert.equal(ctx.run.engine!.modalOpen, true);
    send({ type: "exportSav", id: 20 });
    assert.equal((await waitForReply("savExported", 20)).bytes, null);
    send({ type: "importSav", id: 21, bytes: new Uint8Array([1, 2, 3]) });
    assert.equal((await waitForReply("savImported", 21)).ok, false);
  }

  // 3. textModeActive, historyView, replay, debugger-blocked refuse both
  {
    const { ctx, send, tick, waitForReply } = makeHarness(t);
    const game = makeGame(
      "2.936",
      "DEMO",
      `
      if (isset(f202)) { reset(f202); text.screen(); }
      if (isset(f203)) { reset(f203); graphics(); }
      `,
    );
    send({ type: "boot", files: Object.fromEntries(game.files), words: [], profile: "2.936" });
    await ctx.projectLoader.loading;
    ctx.fns.stopTimers();
    for (let step = 0; step < 5; step++) tick();

    // Valid save bytes for import checks
    send({ type: "exportSav", id: 30 });
    const valid = (await waitForReply("savExported", 30)).bytes!;
    assert.ok(valid);

    // textModeActive via real text.screen() opcode
    ctx.run.engine!.flags[202] = 1;
    tick();
    assert.equal(ctx.run.engine!.textModeActive, true);
    send({ type: "exportSav", id: 31 });
    assert.equal((await waitForReply("savExported", 31)).bytes, null);
    send({ type: "importSav", id: 32, bytes: valid });
    assert.equal((await waitForReply("savImported", 32)).ok, false);
    ctx.run.engine!.flags[203] = 1;
    tick();
    assert.equal(ctx.run.engine!.textModeActive, false);

    // historyView active
    ctx.view.recording = { version: 1, segments: [] } as never;
    send({ type: "exportSav", id: 33 });
    assert.equal((await waitForReply("savExported", 33)).bytes, null);
    send({ type: "importSav", id: 34, bytes: valid });
    assert.equal((await waitForReply("savImported", 34)).ok, false);
    ctx.view.recording = null;

    // replay active
    ctx.replay.replay = { tick: 0, revision: 0 };
    send({ type: "exportSav", id: 35 });
    assert.equal((await waitForReply("savExported", 35)).bytes, null);
    send({ type: "importSav", id: 36, bytes: valid });
    assert.equal((await waitForReply("savImported", 36)).ok, false);
    ctx.replay.replay = null;

    // debugger stopped
    send({ type: "debugAttach", id: 37 });
    const attached = await waitForReply("debugAttached", 37);
    send({ type: "debugPause", id: 38, epoch: attached.epoch });
    await waitForReply("debugAck", 38);
    tick();
    assert.equal(ctx.fns.debugCaptureBlocked(), true);
    send({ type: "exportSav", id: 39 });
    assert.equal((await waitForReply("savExported", 39)).bytes, null);
    send({ type: "importSav", id: 40, bytes: valid });
    assert.equal((await waitForReply("savImported", 40)).ok, false);
  }
});

test("Create mode and inactive tab owner allow export but refuse import", async (t) => {
  // Create mode
  {
    const { ctx, send, tick, waitForReply } = makeHarness(t);
    const game = makeGame("2.936");
    send({
      type: "boot",
      files: Object.fromEntries(game.files),
      words: [],
      profile: "2.936",
      projectMode: "create",
    });
    await ctx.projectLoader.loading;
    ctx.fns.stopTimers();
    for (let step = 0; step < 5; step++) tick();
    send({ type: "exportSav", id: 50 });
    const exported = await waitForReply("savExported", 50);
    assert.ok(exported.bytes, "export works in Create mode");
    send({ type: "importSav", id: 51, bytes: exported.bytes });
    const imported = await waitForReply("savImported", 51);
    assert.equal(imported.ok, false);
    assert.match(imported.error ?? "", /Switch to Play/);
  }

  // Second tab (owner inactive)
  {
    const { ctx, send, tick, waitForReply } = makeHarness(t);
    const game = makeGame("2.936");
    send({ type: "boot", files: Object.fromEntries(game.files), words: [], profile: "2.936" });
    await ctx.projectLoader.loading;
    ctx.fns.stopTimers();
    for (let step = 0; step < 5; step++) tick();
    ctx.run.owner.active = false;
    send({ type: "exportSav", id: 52 });
    const exported = await waitForReply("savExported", 52);
    assert.ok(exported.bytes, "export stays read-only even when another tab owns progress");
    send({ type: "importSav", id: 53, bytes: exported.bytes });
    const imported = await waitForReply("savImported", 53);
    assert.equal(imported.ok, false);
    assert.match(imported.error ?? "", /another tab/);
  }
});

test("empty, oversize, corrupt, and foreign-signature files leave the live game and history intact", async (t) => {
  const { ctx, send, tick, waitForReply } = makeHarness(t);
  const game = makeGame("2.936", "DEMO");
  send({ type: "boot", files: Object.fromEntries(game.files), words: [], profile: "2.936" });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  for (let step = 0; step < 5; step++) tick();

  send({ type: "exportSav", id: 60 });
  const valid = (await waitForReply("savExported", 60)).bytes!;
  const before = ctx.run.engine!.serialize();
  const segmentBefore = ctx.history.segment;

  // Empty
  send({ type: "importSav", id: 61, bytes: new Uint8Array(0) });
  const empty = await waitForReply("savImported", 61);
  assert.equal(empty.ok, false);
  assert.match(empty.error ?? "", /empty/);

  // Oversized
  send({ type: "importSav", id: 62, bytes: new Uint8Array(MAX_ORIGINAL_SAV_BYTES + 1) });
  const big = await waitForReply("savImported", 62);
  assert.equal(big.ok, false);
  assert.match(big.error ?? "", /256 KB/);

  // Corrupt
  send({ type: "importSav", id: 63, bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) });
  const corrupt = await waitForReply("savImported", 63);
  assert.equal(corrupt.ok, false);

  // Foreign signature
  const foreignState = decodeOriginalSav(valid, PROFILES["2.936"]);
  foreignState.signature[0] = 88; // "XEMO"
  const foreignBytes = encodeOriginalSav(foreignState, PROFILES["2.936"]);
  send({ type: "importSav", id: 64, bytes: foreignBytes });
  const foreign = await waitForReply("savImported", 64);
  assert.equal(foreign.ok, false);
  assert.match(foreign.error ?? "", /signature/);

  assert.deepEqual(ctx.run.engine!.serialize(), before);
  assert.equal(ctx.history.segment, segmentBefore);
});

test("generation change during async import refuses cleanly without touching the replacement engine", async (t) => {
  const { ctx, send, tick, waitForReply } = makeHarness(t);
  const game = makeGame("2.936", "DEMO");
  send({ type: "boot", files: Object.fromEntries(game.files), words: [], profile: "2.936" });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  for (let step = 0; step < 5; step++) tick();

  send({ type: "exportSav", id: 70 });
  const valid = (await waitForReply("savExported", 70)).bytes!;
  ctx.run.engine!.vars[100] = 88;

  // Trigger importSav, then immediately advance generation before the dynamic import microtask resolves.
  send({ type: "importSav", id: 71, bytes: valid });
  ctx.run.generation += 1;
  const result = await waitForReply("savImported", 71);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /running game changed/);
  assert.equal(ctx.run.engine!.vars[100], 88, "replacement engine state stays untouched");
});
