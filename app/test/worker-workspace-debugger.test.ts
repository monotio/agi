import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerContext } from "../src/worker/context.ts";
import { createMainProjectAdmission } from "../src/engine/mainProjectAdmission.ts";
import { prepareRoomLaunch } from "../src/worker/roomLaunch.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { projectDocumentId } from "../../src/authoring/projectContent.ts";
import { sha256Hex } from "../../src/crypto.ts";
import type { WorkerControl, WorkerInbound, WorkerQueryFn } from "../src/worker/workerProtocol.ts";

async function main() {
  const messages: WorkerControl[] = [];
  const ctx = createWorkerContext({
    control: (m) => messages.push(m),
    presentation: () => {},
    now: () => 0,
  });
  ctx.host = createEngineHost(ctx);
  const documents = {
    "logic:0": "load.pic(0); draw.pic(0); show.pic(); call(1); return;",
    "picture:0": "vis 0\nfill 1,1\nend\n",
    "logic:1": "assignn(v40, 1);\ncall(2);\nassignn(v41, 2);\nreturn;",
    "logic:2": "assignn(v42, 3);\nreturn;",
  };
  const build = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const send = (msg: WorkerInbound) => onWorkerMessage(ctx, msg);
  send({
    type: "boot",
    files: Object.fromEntries(build.files()),
    words: [],
    projectMode: "create",
    projectDocuments: writeProjectWorkspace(documents),
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  const engine = ctx.run.engine!;
  assert.equal(engine.executionStopInfo, null);
  assert.equal(ctx.debuggerLoader.installed, false);
  const boot = messages.find((m) => m.type === "booted");
  assert.ok(boot?.type === "booted" && boot.projectAdmission);
  send({
    type: "debugAttach",
    id: 1,
    sources: { "0": documents["logic:0"], "1": documents["logic:1"], "2": documents["logic:2"] },
  });
  await ctx.debuggerLoader.loading;
  assert.equal(ctx.run.engine, engine);
  assert.equal(engine.executionStopInfo, null);
  function last<T extends WorkerControl["type"]>(type: T): Extract<WorkerControl, { type: T }> {
    const found = messages.findLast((m) => m.type === type);
    assert.ok(found, `expected ${type}`);
    return found as Extract<WorkerControl, { type: T }>;
  }
  return { ctx, engine, documents, build, send, last, grant: boot.projectAdmission };
}

test("MAIN attaches while running, steps calls, edits values and detaches into normal play", async () => {
  const h = await main();
  const epoch = h.last("debugAttached").epoch;
  h.send({
    type: "debugConfigure",
    id: 2,
    epoch,
    revision: 1,
    breakpoints: [{ id: "call", enabled: true, logic: 1, line: 2, mode: "statement" }],
  });
  h.ctx.fns.stepHostTick(10, { cycle: true, sound: 0 });
  assert.equal(h.last("debugStopped").location?.logic, 1);
  assert.equal(h.engine.vars[42], 0);
  h.send({
    type: "debugResume",
    id: 3,
    epoch,
    stopId: h.last("debugStopped").stopId,
    action: "into",
  });
  assert.equal(h.last("debugStopped").location?.logic, 2);
  h.send({
    type: "debugResume",
    id: 4,
    epoch,
    stopId: h.last("debugStopped").stopId,
    action: "out",
  });
  assert.equal(h.last("debugStopped").location?.logic, 1);
  assert.equal(h.engine.vars[42], 3);
  h.send({
    type: "debugResume",
    id: 5,
    epoch,
    stopId: h.last("debugStopped").stopId,
    action: "over",
  });
  assert.equal(h.engine.vars[41], 2);
  h.send({
    type: "debugSetValues",
    id: 6,
    epoch,
    stopId: h.last("debugStopped").stopId,
    vars: [[50, 77]],
    flags: [[50, 1]],
  });
  assert.equal(h.last("debugStopped").state.vars[50], 77);
  assert.equal(h.engine.flags[50], 1);
  h.send({ type: "debugDetach", id: 7, epoch });
  assert.equal(h.engine.executionStopInfo, null);
  assert.equal(h.ctx.run.engine, h.engine);
  const cycles = h.ctx.run.cycle.cycleCount;
  h.ctx.fns.stepHostTick(10, { cycle: true, sound: 0 });
  h.ctx.fns.stepHostTick(10, { cycle: true, sound: 0 });
  assert.ok(h.ctx.run.cycle.cycleCount > cycles);
});

test("MAIN live admission keeps the stopped build, then rebinds debugging to the admitted source", async () => {
  const h = await main();
  const attached = h.last("debugAttached");
  h.send({
    type: "debugConfigure",
    id: 2,
    epoch: attached.epoch,
    revision: 1,
    breakpoints: [{ id: "call", enabled: true, logic: 1, line: 2, mode: "statement" }],
  });
  h.ctx.fns.stepHostTick(10, { cycle: true, sound: 0 });
  const documents = {
    ...h.documents,
    "logic:1": h.documents["logic:1"].replace("v41, 2", "v41, 9"),
  };
  const build = compileProjectDocuments({
    files: Object.fromEntries(h.build.files()),
    documents,
    profileId: "2.936",
  });
  const update = (id: number) =>
    h.send({
      type: "previewUpdate",
      id,
      runToken: h.grant.runToken,
      expected: h.grant.identity,
      candidate: {
        files: Object.fromEntries(build.files()),
        sources: Object.fromEntries(
          Object.entries(documents)
            .filter(([key]) => key.startsWith("logic:"))
            .map(([key, source]) => [key.slice(6), source]),
        ),
        sourceBindings: {},
        buildId: build.build.identity.buildId,
        revision: build.build.identity.revision,
        documents: writeProjectWorkspace(documents),
        documentId: projectDocumentId(documents, sha256Hex),
        origins: [],
      },
    });
  update(3);
  assert.equal(h.last("previewUpdateResult").status, "deferred");
  assert.equal(h.ctx.run.debugger.buildId, attached.buildId);
  h.send({
    type: "debugResume",
    id: 4,
    epoch: attached.epoch,
    stopId: h.last("debugStopped").stopId,
    action: "continue",
  });
  update(5);
  assert.equal(h.last("previewUpdateResult").status, "committed");
  assert.equal(h.ctx.run.debugger.buildId, build.build.identity.buildId);
  assert.equal(h.last("debugSessionReset").buildId, build.build.identity.buildId);
  assert.equal(h.ctx.run.projectAdmission?.runToken, h.grant.runToken);
  h.ctx.fns.stepHostTick(10, { cycle: true, sound: 0 });
  assert.equal(h.last("debugStopped").buildId, build.build.identity.buildId);
});

for (const beginning of [false, true]) {
  test(`Launch replacement keeps armed breakpoints on an updated engine (beginning=${beginning})`, async (t) => {
    const h = await main();
    t.after(() => h.ctx.fns.stopTimers());
    h.ctx.fns.stepHostTick(10, { cycle: true, sound: 0 });
    h.send({ type: "startRecording", id: 19 });
    assert.ok(h.ctx.run.recording.recording, JSON.stringify(h.last("recordingStarted")));
    h.send({
      type: "debugConfigure",
      id: 20,
      epoch: h.last("debugAttached").epoch,
      revision: 1,
      breakpoints: [{ id: "entry", enabled: true, logic: 1, line: 1, mode: "statement" }],
    });
    const documents = {
      ...h.documents,
      "logic:1": h.documents["logic:1"].replace("v40, 1", "v40, 9"),
    };
    const build = compileProjectDocuments({
      files: Object.fromEntries(h.build.files()),
      documents,
      profileId: "2.936",
    });
    const prepared = prepareRoomLaunch(h.ctx, { room: 0, beginning }, build.files(), undefined, {
      sources: Object.fromEntries(
        Object.entries(documents)
          .filter(([key]) => key.startsWith("logic:"))
          .map(([key, source]) => [key.slice(6), source]),
      ),
      sourceBindings: {},
      bindings: {},
    });
    assert.ok(
      prepared.debugSession,
      "attached launches prevalidate debugger plans against the candidate",
    );
    h.ctx.fns.stepHostTick(10, { cycle: true, sound: 0 });
    assert.equal(h.last("debugStopped").location?.logic, 1);
    const query = (async (type, extra) => {
      h.send({ type, id: 21, ...extra } as WorkerInbound);
      return h.last("previewUpdateResult");
    }) as WorkerQueryFn;
    const admission = createMainProjectAdmission({
      ...h.grant,
      current: () => true,
      query,
      waitForContinue: () => {
        throw new Error("Replacement must not wait for the abandoned breakpoint stop.");
      },
    });
    await admission.reenter(build, [], { room: 0, beginning });
    assert.equal(
      h.last("previewUpdateResult").status,
      "committed",
      JSON.stringify(h.last("previewUpdateResult")),
    );
    assert.notEqual(h.ctx.run.engine, h.engine);
    assert.equal(h.ctx.run.debugger.engine, h.ctx.run.engine);
    assert.equal(h.ctx.run.projectAdmission?.engine, h.ctx.run.engine);
    assert.equal(h.ctx.run.recording.recording, null);
    assert.ok(h.ctx.run.debugger.epoch > 0, "breakpoints remain attached after replacement");
    assert.equal(h.last("debugStopped").buildId, build.build.identity.buildId);
    assert.ok(h.last("debugStopped").reasons.some((r) => r.kind === "breakpoint"));
    assert.equal(
      h.ctx.run.engine!.vars[40],
      beginning ? 0 : 1,
      "the breakpoint stops before the new assignment",
    );
  });
}
