import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { projectAdmissionIdentity } from "../src/worker/projectAdmission.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";
import { projectDocumentId } from "../../src/authoring/projectContent.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { historySyncDigest } from "../../src/agent/history.ts";
import { collectSegments, replayHistorySegment } from "./worker-ctx.ts";
import type {
  WorkerControl,
  WorkerPresentation,
  PreviewUpdateCandidateMessage,
} from "../src/worker/workerProtocol.ts";

// Room 1 counts its entries in v83 and marks its entry code's version in v81.
// LOGIC 2 is never loaded.
const ROOM = (version: number) => `if(isset(f5)){increment(v83);assignn(v81,${version});}return;`;
const LOGIC_0 = "if(equaln(v0,0)){new.room(1);}call.v(v0);return;";

function candidate(
  room = ROOM(1),
  other = "return;",
  logic0 = LOGIC_0,
  extra: Record<string, string> = {},
): PreviewUpdateCandidateMessage {
  const documents = {
    "logic:0": logic0,
    "logic:1": room,
    "logic:2": other,
    world: "{}",
    ...extra,
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  return {
    files: Object.fromEntries(compiled.files()),
    profile: "2.936",
    sources: { "0": logic0, "1": room, "2": other },
    sourceBindings: {},
    buildId: compiled.build.identity.buildId,
    revision: compiled.build.identity.revision,
    origins: [],
    documents: writeProjectWorkspace(compiled.documents()),
    documentId: projectDocumentId(compiled.documents(), sha256Hex),
  };
}

/** A game played into room 1, then opened in Create; a cold one opens before it runs. */
async function created(t: TestContext, paused = false, cold = false, first = candidate()) {
  const control: WorkerControl[] = [];
  const presentations: WorkerPresentation[] = [];
  const ctx = createWorkerContext({
    control: (msg) => {
      control.push(msg);
      // The page acknowledges each timeline batch so recording keeps flowing.
      if (msg.type === "historyBatch")
        onWorkerMessage(ctx, { type: "historyAck", epoch: msg.epoch, batch: msg.batch.batch });
    },
    presentation: (msg) => presentations.push(msg),
    now: () => 0,
  });
  ctx.host = createEngineHost(ctx);
  t.after(() => ctx.fns.stopTimers());
  onWorkerMessage(ctx, {
    type: "boot",
    files: first.files,
    words: [],
    profile: "2.936",
    ...(cold ? { projectMode: "create" as const, projectDocuments: first.documents } : {}),
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  if (!cold) {
    ctx.run.engine!.tick();
    ctx.run.engine!.tick();
    assert.deepEqual([ctx.run.engine!.vars[0], ctx.run.engine!.vars[83]], [1, 1]);
    if (paused) onWorkerMessage(ctx, { type: "pause", paused: true });
    onWorkerMessage(ctx, { type: "projectCreate", id: 1 });
    await ctx.projectLoader.loading;
    const grant = control.at(-1);
    assert.ok(grant?.type === "projectCreated" && grant.grant, JSON.stringify(grant));
  }
  assert.equal(ctx.run.progress.mode, "create");
  const update = (next: PreviewUpdateCandidateMessage, id: number, mode?: "restart") => {
    const lane = ctx.run.projectAdmission!;
    onWorkerMessage(ctx, {
      type: "previewUpdate",
      id,
      runToken: lane.runToken,
      expected: projectAdmissionIdentity(ctx, lane)!,
      candidate: next,
      ...(mode ? { mode } : {}),
    });
    const result = control.findLast((m) => m.type === "previewUpdateResult");
    assert.ok(result?.type === "previewUpdateResult" && result.status === "committed");
    ctx.run.engine!.tick();
  };
  const play = () => {
    onWorkerMessage(ctx, { type: "projectPlay", id: 9 });
    const reply = control.findLast((m) => m.type === "projectPlayed");
    assert.ok(reply?.type === "projectPlayed" && reply.ok, JSON.stringify(reply));
    ctx.run.engine!.tick();
    return reply;
  };
  return { ctx, control, presentations, update, play };
}

test("an applied change to the room's LOGIC re-runs its entry code at once", async (t) => {
  const { ctx, update } = await created(t);
  update(candidate(ROOM(2)), 2);
  assert.deepEqual([ctx.run.engine!.vars[81], ctx.run.engine!.vars[83]], [2, 2]);
});

test("an applied change to a LOGIC the room does not use leaves the room running", async (t) => {
  const { ctx, update } = await created(t);
  update(candidate(ROOM(1), "assignn(v82,1);return;"), 2);
  assert.deepEqual([ctx.run.engine!.vars[81], ctx.run.engine!.vars[83]], [1, 1]);
});

test("Play re-enters its room when Create changed what that room uses, and names it", async (t) => {
  const { ctx, update, play } = await created(t);
  update(candidate(ROOM(2)), 2);
  const reply = play();
  assert.equal(reply.restartedRoom, 1);
  // The captured moment had entered once; Play's own re-entry runs the new code.
  assert.deepEqual([ctx.run.engine!.vars[81], ctx.run.engine!.vars[83]], [2, 2]);
});

test("Play keeps its moment when Create changed only what its room does not use", async (t) => {
  const { ctx, update, play } = await created(t);
  update(candidate(ROOM(1), "assignn(v82,1);return;"), 2);
  const reply = play();
  assert.equal(reply.restartedRoom, undefined);
  assert.deepEqual([ctx.run.engine!.vars[81], ctx.run.engine!.vars[83]], [1, 1]);
});

test("Play follows the page's pause, not the pause captured when Create opened", async (t) => {
  const { ctx, play } = await created(t, true);
  onWorkerMessage(ctx, { type: "pause", paused: false });
  play();
  assert.equal(ctx.run.cycle.paused, false);
});

test("Play from a Create opened before the game ran starts the edited game without a restart note", async (t) => {
  const { ctx, update, play } = await created(t, false, true);
  update(candidate(ROOM(1), "return;", `assignn(v84,1);${LOGIC_0}`), 2);
  const reply = play();
  assert.equal(reply.restartedRoom, undefined);
  assert.equal(ctx.run.engine!.vars[84], 1);
});

test("a project restart and Take control keep a pause the page still holds", async (t) => {
  const { ctx, update } = await created(t);
  onWorkerMessage(ctx, { type: "pause", paused: true });
  const engine = ctx.run.engine;
  update(candidate(ROOM(2)), 2, "restart");
  assert.notEqual(ctx.run.engine, engine, "the restart replaced the run");
  assert.equal(ctx.run.cycle.paused, true);
  onWorkerMessage(ctx, { type: "resetReplay", seed: 1 });
  onWorkerMessage(ctx, { type: "exitReplay" });
  assert.equal(ctx.run.cycle.paused, true);
  onWorkerMessage(ctx, { type: "pause", paused: false });
  assert.equal(ctx.run.cycle.paused, false);
});

// Room 1 draws PICTURE 1 and stamps a frame of VIEW 0 into it. A change that
// gives VIEW 0 fewer frames and stamps frame 0 instead cannot replay the old
// picture, so Play starts the room fresh from the moment it left, keeping its
// progress, rather than asking for a restart from the beginning.
const STAMPING = (version: number, cel: number) =>
  `if(isset(f5)){increment(v83);assignn(v81,${version});assignn(v10,1);load.pic(v10);draw.pic(v10);discard.pic(v10);load.view(0);add.to.pic(0,0,${cel},40,100,4,0);show.pic();}return;`;
const frame = (color: number) => ({ width: 2, height: 2, pixels: [color, color, color, color] });
const STAMP_PIXEL = 100 * 160 + 40;

test("Play starts its room fresh when a stamped VIEW lost the frame it showed", async (t) => {
  const art = (cels: ReturnType<typeof frame>[]) => ({
    "picture:1": "vis 1\nfill 1,1\nend\n",
    "view:0": JSON.stringify({ loops: [{ cels }] }),
  });
  const first = candidate(STAMPING(1, 2), "return;", LOGIC_0, art([frame(3), frame(4), frame(7)]));
  const { ctx, control, presentations, update, play } = await created(t, false, false, first);
  // The captured moment: room 1 entered once, frame 2 stamped.
  const next = candidate(STAMPING(2, 0), "return;", LOGIC_0, art([frame(5)]));
  update(next, 2);
  assert.equal(ctx.run.engine!.getPresentation().visual[STAMP_PIXEL], 5, "Create shows the edit");
  const mark = control.length;
  const reply = play();
  assert.equal(reply.restartedRoom, 1);
  ctx.run.engine!.tick();
  const engine = ctx.run.engine!;
  assert.equal(ctx.run.progress.mode, "play");
  assert.deepEqual(
    [engine.vars[0], engine.vars[81], engine.vars[83]],
    [1, 2, 2],
    "the room ran its new entry code once more, from the captured progress",
  );
  assert.equal(engine.getPresentation().visual[STAMP_PIXEL], 5);
  assert.equal(ctx.run.cycle.paused, false);
  assert.equal(ctx.fns.autosave(true), true);
  const saved = presentations.findLast((m) => m.type === "autosave");
  assert.ok(saved?.type === "autosave");
  assert.equal(saved.revision, next.revision, "Play saves the edited game");
  // The timeline replays it: the moment on the captured files, then the entry
  // on the edited ones, to the same state the player sees.
  onWorkerMessage(ctx, { type: "flush", id: 20 });
  const segments = collectSegments(control.slice(mark));
  assert.ok(segments.length >= 2, "the entry opened a segment of its own");
  for (const segment of segments) {
    const replayed = replayHistorySegment(segment);
    assert.equal(replayed.error, null);
    assert.equal(replayed.diverged, null);
    if (segment === segments.at(-1))
      assert.equal(historySyncDigest(replayed.ctx.run.engine!), historySyncDigest(engine));
  }
});

// The page pauses Play for an Agent kept open from Create right after Play
// answers. The room entry Play began still runs and is saved; then it waits.
test("Play's room entry runs and is saved under a pause that lands right after it", async (t) => {
  // The engine saves only a room that has drawn, so this room draws PICTURE 1.
  const drawn = (version: number) =>
    candidate(
      `if(isset(f5)){increment(v83);assignn(v81,${version});assignn(v10,1);load.pic(v10);draw.pic(v10);show.pic();}return;`,
      "return;",
      LOGIC_0,
      { "picture:1": "vis 1\nfill 1,1\nend\n" },
    );
  const { ctx, control, presentations, update } = await created(t, false, false, drawn(1));
  const next = drawn(2);
  update(next, 2);
  onWorkerMessage(ctx, { type: "projectPlay", id: 9 });
  const reply = control.findLast((m) => m.type === "projectPlayed");
  assert.ok(reply?.type === "projectPlayed" && reply.restartedRoom === 1, JSON.stringify(reply));
  onWorkerMessage(ctx, { type: "pause", paused: true });
  ctx.fns.hostTick();
  const engine = ctx.run.engine!;
  assert.deepEqual([engine.vars[81], engine.vars[83]], [2, 2], "the room entered on the new code");
  const saved = presentations.findLast((m) => m.type === "autosave");
  assert.ok(saved?.type === "autosave" && saved.revision === next.revision, "and Play saved it");
  const cycles = ctx.run.cycle.cycleCount;
  ctx.fns.hostTick();
  assert.equal(ctx.run.cycle.cycleCount, cycles, "then the game waits");
  assert.equal(ctx.run.cycle.paused, true);
  // The timeline replays the entry under the pause to the same state.
  onWorkerMessage(ctx, { type: "flush", id: 20 });
  const replayed = replayHistorySegment(collectSegments(control).at(-1)!);
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null);
  assert.equal(historySyncDigest(replayed.ctx.run.engine!), historySyncDigest(engine));
});
