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
import { createContainer } from "../../src/container/container.ts";
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

function candidate(source = "return;", world = "{}"): PreviewUpdateCandidateMessage {
  const documents = { "logic:0": source, world };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
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
