import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import {
  createProjectAdmission,
  projectAdmissionIdentity,
} from "../src/worker/projectAdmission.ts";
import { newProjectAdmissionState } from "../src/worker/projectAdmissionState.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { projectDocumentId } from "../../src/authoring/projectContent.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { sha256Hex } from "../../src/crypto.ts";
import type { WorkerControl, PreviewUpdateCandidateMessage } from "../src/worker/workerProtocol.ts";

test("walkthrough rebuilds revoke Create admission; taking control can grant the replacement", async (t) => {
  const control: WorkerControl[] = [];
  const ctx = createWorkerContext({
    control: (msg) => control.push(msg),
    presentation: () => {},
    now: () => 0,
  });
  ctx.host = createEngineHost(ctx);
  t.after(() => ctx.fns.stopTimers());
  const initial = candidate("// Authored source\nreturn;");
  assert.ok(initial.documents);
  onWorkerMessage(ctx, {
    type: "boot",
    files: initial.files,
    words: [],
    profile: "2.936",
    projectMode: "create",
    projectDocuments: initial.documents,
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  for (const type of ["resetReplay", "replayRestore"] as const) {
    const token = ctx.projectAdmission!.runToken;
    if (type === "replayRestore") onWorkerMessage(ctx, { type: "resetReplay", seed: 1 });
    const engine = ctx.engine;
    onWorkerMessage(ctx, type === "resetReplay" ? { type, seed: 1 } : { type, tick: 0, id: 1 });
    assert.notEqual(ctx.engine, engine);
    assert.ok(ctx.projectAdmission === null, "a tape-driven engine has no Create authority");
    onWorkerMessage(ctx, { type: "projectCreate", id: 2, documents: initial.documents });
    const denied = control.at(-1);
    assert.ok(denied?.type === "projectCreated" && !denied.grant);
    onWorkerMessage(ctx, { type: "exitReplay" });
    onWorkerMessage(ctx, { type: "projectCreate", id: 3, documents: initial.documents });
    const granted = control.at(-1);
    assert.ok(granted?.type === "projectCreated" && granted.grant?.identity);
    assert.notEqual(granted.grant.runToken, token);
    assert.equal(granted.grant.identity.documentId, initial.documentId);
  }
  ctx.fns.stopTimers();
});

test("an installed game with an unreadable SOUND can enter Create and run an unrelated LOGIC edit", async (t) => {
  const control: WorkerControl[] = [];
  const ctx = createWorkerContext({
    control: (msg) => control.push(msg),
    presentation: () => {},
    now: () => 0,
  });
  ctx.host = createEngineHost(ctx);
  t.after(() => ctx.fns.stopTimers());
  const files = candidate().files;
  const directory = new Uint8Array(files["SNDDIR"]!);
  directory.set([0x30, 0, 0], 34 * 3);
  files["SNDDIR"] = directory;
  onWorkerMessage(ctx, { type: "boot", files, words: [], profile: "2.936" });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  onWorkerMessage(ctx, { type: "projectCreate", id: 1 });
  await ctx.projectLoader.loading;
  const created = control.at(-1);
  assert.ok(created?.type === "projectCreated" && created.grant, JSON.stringify(created));
  const edited = candidate("assignn(v80,42); return;", "{}", files);
  onWorkerMessage(ctx, {
    type: "previewUpdate",
    id: 2,
    runToken: created.grant.runToken,
    expected: created.grant.identity,
    candidate: edited,
  });
  const result = control.at(-1);
  assert.ok(
    result?.type === "previewUpdateResult" && result.status === "committed",
    JSON.stringify(result),
  );
  ctx.engine!.tick();
  assert.equal(ctx.engine!.vars[80], 42);
  assert.throws(
    () => openContainer(ctx.engine!.containerFiles).getResource("sound", 34),
    /corrupt/i,
  );
});

function candidate(
  source = "return;",
  world = "{}",
  files = Object.fromEntries(createContainer().files),
): PreviewUpdateCandidateMessage {
  const documents = { "logic:0": source, world };
  const compiled = compileProjectDocuments({
    files,
    documents,
    profileId: "2.936",
  });
  return {
    files: Object.fromEntries(compiled.files()),
    profile: "2.936",
    sources: { "0": source },
    sourceBindings: {},
    buildId: compiled.build.identity.buildId,
    revision: compiled.build.identity.revision,
    origins: [],
    documents: writeProjectWorkspace(compiled.documents()),
    documentId: projectDocumentId(compiled.documents(), sha256Hex),
  };
}
function harness() {
  const control: WorkerControl[] = [];
  const ctx = createWorkerContext({
    control: (msg) => control.push(msg),
    presentation: () => {},
    now: () => 0,
    seedWord: () => 1,
  });
  ctx.host = createEngineHost(ctx);
  const initial = candidate();
  onWorkerMessage(ctx, { type: "boot", files: initial.files, words: [], profile: "2.936" });
  ctx.fns.stopTimers();
  const state = newProjectAdmissionState("test-run", ctx.engine!);
  state.buildId = initial.buildId;
  state.documentId = initial.documentId;
  state.sources = initial.sources;
  state.sourceBindings = {};
  const admission = createProjectAdmission(ctx, { lane: () => state });
  return { ctx, state, admission, control };
}

test("project admission installs complete document identities with no debugger controller", () => {
  const h = harness();
  assert.equal(h.ctx.debuggerLoader.installed, false);
  assert.equal(h.ctx.debugger.epoch, 0);
  const initial = projectAdmissionIdentity(h.ctx, h.state)!;
  const source = candidate("// exact source-only edit\nreturn;");
  h.admission.onPreviewUpdate({
    type: "previewUpdate",
    id: 1,
    runToken: h.state.runToken,
    expected: initial,
    candidate: source,
  });
  let result = h.control.at(-1)!;
  assert.equal(result.type, "previewUpdateResult");
  if (result.type !== "previewUpdateResult") throw new Error("Missing admission result");
  assert.equal(result.status, "committed", result.reason ?? "Expected committed admission");
  assert.equal(result.current!.documentId, source.documentId);
  assert.equal(result.current!.revision, initial.revision);
  const metadata = candidate("// exact source-only edit\nreturn;", '{"title":"Changed"}');
  h.admission.onPreviewUpdate({
    type: "previewUpdate",
    id: 2,
    runToken: h.state.runToken,
    expected: result.current!,
    candidate: metadata,
  });
  result = h.control.at(-1)!;
  if (result.type !== "previewUpdateResult") throw new Error("Missing admission result");
  assert.equal(result.status, "committed", result.reason ?? "Expected committed admission");
  assert.equal(result.current!.documentId, metadata.documentId);
  assert.notEqual(metadata.documentId, source.documentId);
  assert.equal(metadata.buildId, source.buildId);
  assert.equal(h.ctx.debuggerLoader.installed, false);
});

test("independent admission keeps its ledger across adapter replacement and reconciles lost ACKs", () => {
  const h = harness();
  const update = {
    type: "previewUpdate" as const,
    id: 1,
    runToken: h.state.runToken,
    expected: projectAdmissionIdentity(h.ctx, h.state)!,
    candidate: candidate("// edit\nreturn;"),
  };
  h.admission.onPreviewUpdate(update);
  const settled = h.control.at(-1);
  const replacement = createProjectAdmission(h.ctx, { lane: () => h.state });
  replacement.onPreviewUpdate(update);
  assert.deepEqual(h.control.at(-1), settled);
  replacement.onPreviewStatus({ type: "previewUpdateStatus", id: 2, transactionId: 1 });
  const status = h.control.at(-1)!;
  assert.equal(status.type, "previewUpdateStatus");
  if (status.type !== "previewUpdateStatus") throw new Error("Missing status");
  assert.equal(typeof status.transaction, "object");
  replacement.onPreviewUpdate({
    ...update,
    candidate: { ...update.candidate, documentId: "b".repeat(64) },
  });
  const refused = h.control.at(-1)!;
  if (refused.type !== "previewUpdateResult") throw new Error("Missing result");
  assert.equal(refused.status, "refused");
  assert.equal(h.state.updateSerial, 1);
});

test("plain Play has no admission grant; forged document identities and stale run tokens refuse", () => {
  const h = harness();
  const request = {
    type: "previewUpdate" as const,
    id: 1,
    runToken: h.state.runToken,
    expected: projectAdmissionIdentity(h.ctx, h.state)!,
    candidate: candidate(),
  };
  onWorkerMessage(h.ctx, request);
  assert.equal(h.control.at(-1)?.type, "previewUpdateResult");
  const result = h.control.at(-1)!;
  if (result.type !== "previewUpdateResult") throw new Error("Missing result");
  assert.equal(result.status, "refused");
  assert.equal(h.ctx.debuggerLoader.installed, false);
  h.admission.onPreviewUpdate({
    ...request,
    candidate: { ...request.candidate, documentId: "a".repeat(64) },
  });
  assert.equal(h.state.updateSerial, 0);
  h.admission.onPreviewUpdate({ ...request, id: 2, runToken: "stale-run" });
  assert.equal(h.state.highWater, 1);
});

for (const wait of ["print", "key"] as const)
  test(`Update during a ${wait} wait closes its old continuation and re-enters with the new code`, async (t) => {
    const control: WorkerControl[] = [];
    const ctx = createWorkerContext({
      control: (msg) => control.push(msg),
      presentation: () => {},
      now: () => 0,
    });
    ctx.host = createEngineHost(ctx);
    t.after(() => ctx.fns.stopTimers());
    const initial = candidate(
      wait === "print"
        ? 'if (isset(f5)) { print("Old message"); assignn(v80,1); } return;'
        : "if (isset(f5)) { wait: if (!have.key()) { goto wait; } assignn(v80,1); } return;",
    );
    onWorkerMessage(ctx, {
      type: "boot",
      files: initial.files,
      words: [],
      projectMode: "create",
      projectDocuments: initial.documents!,
    });
    await ctx.projectLoader.loading;
    ctx.fns.stopTimers();
    ctx.fns.tickEngine();
    assert.equal(ctx.engine!.modalKind, wait === "print" ? "print" : null);
    assert.equal(ctx.engine!.awaitingKey, wait === "key");
    const text = ctx.engine!.textCells.slice();
    const image = ctx.engine!.recordingImage();
    const edited = candidate(
      'if (isset(f5)) { print("New message"); assignn(v80,2); } return;',
      "{}",
      initial.files,
    );
    // Refusal must leave the old message and its continuation intact.
    onWorkerMessage(ctx, {
      type: "previewUpdate",
      id: 201,
      runToken: ctx.projectAdmission!.runToken,
      expected: projectAdmissionIdentity(ctx, ctx.projectAdmission)!,
      candidate: { ...edited, buildId: "wrong" },
    });
    assert.deepEqual(ctx.engine!.recordingImage(), image);
    assert.deepEqual(ctx.engine!.textCells, text);
    assert.equal(ctx.engine!.continuationPending, true);
    onWorkerMessage(ctx, {
      type: "previewUpdate",
      id: 202,
      mode: "reenter",
      runToken: ctx.projectAdmission!.runToken,
      expected: projectAdmissionIdentity(ctx, ctx.projectAdmission)!,
      candidate: edited,
    });
    const result = control.findLast((msg) => msg.type === "previewUpdateResult");
    assert.ok(result?.type === "previewUpdateResult");
    assert.equal(result.status, "committed", JSON.stringify(result));
    assert.equal(ctx.input.keyWaiting, false, "the abandoned key wait is cleared on the host too");
    assert.ok(ctx.previewVisitEngine === ctx.engine, "Update restart stays outside saved progress");
    ctx.fns.tickEngine();
    assert.equal(ctx.engine!.modalKind, "print", "the new entrance message is shown");
    ctx.engine!.ackPrint();
    ctx.fns.tickEngine();
    assert.equal(ctx.engine!.vars[80], 2, "the discarded old message never resumes into old code");
  });

test("keep-playing Update settles during a message and resumes the old pass before using new code", async (t) => {
  const control: WorkerControl[] = [];
  const ctx = createWorkerContext({
    control: (message) => control.push(message),
    presentation() {},
    now: () => 0,
  });
  ctx.host = createEngineHost(ctx);
  t.after(() => ctx.fns.stopTimers());
  const initial = candidate('if(isset(f5)){print("Waiting");assignn(v80,1);}return;');
  onWorkerMessage(ctx, {
    type: "boot",
    files: initial.files,
    words: [],
    projectMode: "create",
    projectDocuments: initial.documents!,
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  ctx.fns.tickEngine();
  const edited = candidate(
    'if(isset(f5)){print("Changed");assignn(v80,2);}assignn(v81,9);return;',
    "{}",
    initial.files,
  );
  onWorkerMessage(ctx, {
    type: "previewUpdate",
    id: 301,
    mode: "keep",
    runToken: ctx.projectAdmission!.runToken,
    expected: projectAdmissionIdentity(ctx, ctx.projectAdmission)!,
    candidate: edited,
  });
  const result = control.findLast((m) => m.type === "previewUpdateResult");
  assert.ok(
    result?.type === "previewUpdateResult" && result.status === "committed",
    JSON.stringify(result),
  );
  assert.equal(ctx.engine!.modalKind, "print");
  assert.equal(ctx.engine!.vars[80], 0);
  assert.equal(
    ctx.engine!.recordingImage(),
    null,
    "the old pass cannot be saved against new instruction offsets",
  );
  ctx.engine!.ackPrint();
  ctx.fns.tickEngine();
  assert.equal(ctx.engine!.vars[80], 1, "the parked pass completes its own instructions");
  ctx.fns.tickEngine();
  assert.equal(ctx.engine!.vars[81], 9, "the following cycle runs the new instructions");
});

test("Update and launch refuses invalid entry inputs before changing resources or the current run", async (t) => {
  const control: WorkerControl[] = [];
  const ctx = createWorkerContext({
    control: (m) => control.push(m),
    presentation() {},
    now: () => 0,
  });
  ctx.host = createEngineHost(ctx);
  t.after(() => ctx.fns.stopTimers());
  const initial = candidate("return;");
  onWorkerMessage(ctx, {
    type: "boot",
    files: initial.files,
    words: [],
    projectMode: "create",
    projectDocuments: initial.documents!,
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  ctx.fns.tickEngine();
  const engine = ctx.engine!;
  const bytes = sha256Hex(engine.serialize());
  const identity = projectAdmissionIdentity(ctx, ctx.projectAdmission)!;
  onWorkerMessage(ctx, {
    type: "previewUpdate",
    id: 302,
    mode: "reenter",
    runToken: ctx.projectAdmission!.runToken,
    expected: identity,
    candidate: candidate("assignn(v70,99);return;", "{}", initial.files),
    launch: { room: 0, state: { variables: { "70": 12 }, hero: { x: 160, y: 100 } } },
  } as never);
  const result = control.findLast((m) => m.type === "previewUpdateResult");
  assert.ok(
    result?.type === "previewUpdateResult" && result.status === "refused",
    JSON.stringify(result),
  );
  assert.ok(ctx.engine === engine);
  assert.equal(sha256Hex(engine.serialize()), bytes);
  assert.deepEqual(projectAdmissionIdentity(ctx, ctx.projectAdmission), identity);
});

test("Update and launch uses the new LOGIC 0 with carried state, pause holds and random state", async (t) => {
  const ctx = createWorkerContext({ control() {}, presentation() {}, now: () => 0 });
  ctx.host = createEngineHost(ctx);
  t.after(() => ctx.fns.stopTimers());
  const initial = candidate("return;");
  onWorkerMessage(ctx, {
    type: "boot",
    files: initial.files,
    words: [],
    projectMode: "create",
    projectDocuments: initial.documents!,
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  ctx.fns.tickEngine();
  ctx.cycle.paused = true;
  ctx.history.rng = 4321;
  onWorkerMessage(ctx, {
    type: "previewUpdate",
    id: 303,
    mode: "reenter",
    runToken: ctx.projectAdmission!.runToken,
    expected: projectAdmissionIdentity(ctx, ctx.projectAdmission)!,
    candidate: candidate("assignv(v71,v70);return;", "{}", initial.files),
    launch: { room: 0, state: { variables: { "70": 12 } } },
  });
  assert.equal(ctx.engine!.vars[71], 12, "new global code sees the Launch inputs");
  assert.equal(ctx.cycle.paused, true, "the app still owns its pause hold");
  assert.equal(ctx.history.rng, 4321, "Carry over keeps the random state");
});
