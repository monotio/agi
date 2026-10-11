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
import type { WorkerControl, PreviewUpdateCandidateMessage } from "../src/worker/workerProtocol.ts";

// Room 1 counts its entries in v83 and marks its entry code's version in v81.
// LOGIC 2 is never loaded.
const ROOM = (version: number) => `if(isset(f5)){increment(v83);assignn(v81,${version});}return;`;
const LOGIC_0 = "if(equaln(v0,0)){new.room(1);}call.v(v0);return;";

function candidate(room = ROOM(1), other = "return;"): PreviewUpdateCandidateMessage {
  const documents = { "logic:0": LOGIC_0, "logic:1": room, "logic:2": other, world: "{}" };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  return {
    files: Object.fromEntries(compiled.files()),
    profile: "2.936",
    sources: { "0": LOGIC_0, "1": room, "2": other },
    sourceBindings: {},
    buildId: compiled.build.identity.buildId,
    revision: compiled.build.identity.revision,
    origins: [],
    documents: writeProjectWorkspace(compiled.documents()),
    documentId: projectDocumentId(compiled.documents(), sha256Hex),
  };
}

/** A game played into room 1, then opened in Create. */
async function created(t: TestContext, paused = false) {
  const control: WorkerControl[] = [];
  const ctx = createWorkerContext({
    control: (msg) => control.push(msg),
    presentation: () => {},
    now: () => 0,
  });
  ctx.host = createEngineHost(ctx);
  t.after(() => ctx.fns.stopTimers());
  onWorkerMessage(ctx, { type: "boot", files: candidate().files, words: [], profile: "2.936" });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  ctx.run.engine!.tick();
  ctx.run.engine!.tick();
  assert.deepEqual([ctx.run.engine!.vars[0], ctx.run.engine!.vars[83]], [1, 1]);
  if (paused) onWorkerMessage(ctx, { type: "pause", paused: true });
  onWorkerMessage(ctx, { type: "projectCreate", id: 1 });
  await ctx.projectLoader.loading;
  const grant = control.at(-1);
  assert.ok(grant?.type === "projectCreated" && grant.grant, JSON.stringify(grant));
  const update = (next: PreviewUpdateCandidateMessage, id: number) => {
    const lane = ctx.run.projectAdmission!;
    onWorkerMessage(ctx, {
      type: "previewUpdate",
      id,
      runToken: lane.runToken,
      expected: projectAdmissionIdentity(ctx, lane)!,
      candidate: next,
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
  return { ctx, update, play };
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
