import {
  writeProjectWorkspace,
  readProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { projectDocumentId } from "../../src/authoring/projectContent.ts";
import { sha256Hex } from "../../src/crypto.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";
import type { WorkerControl } from "../src/worker/workerProtocol.ts";

test("MAIN Create grants a debugger-free physical run and Play revokes it", async () => {
  const messages: WorkerControl[] = [];
  const ctx = createWorkerContext({
    control: (m) => messages.push(m),
    presentation: () => {},
    now: () => 0,
  });
  ctx.host = createEngineHost(ctx);
  const build = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(build.files()),
    words: [],
    projectMode: "create",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  ctx.fns.stopTimers();
  const ack = messages.find((m) => m.type === "booted");
  assert.ok(ack?.type === "booted" && ack.projectAdmission);
  assert.equal(ctx.debuggerLoader.installed, false);
  const token = ack.projectAdmission.runToken;
  onWorkerMessage(ctx, { type: "boot", files: Object.fromEntries(build.files()), words: [] });
  ctx.fns.stopTimers();
  onWorkerMessage(ctx, { type: "previewUpdateStatus", id: 1 });
  const status = messages.at(-1);
  assert.ok(status?.type === "previewUpdateStatus");
  assert.equal(status.runToken, null);
  assert.notEqual(status.runToken, token);
});

test("admitted timeline documents own the wire payload", async () => {
  const messages: WorkerControl[] = [];
  const ctx = createWorkerContext({
    control: (m) => messages.push(m),
    presentation: () => {},
    now: () => 0,
  });
  ctx.host = createEngineHost(ctx);
  const initial = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(initial.files()),
    words: [],
    projectMode: "create",
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  const booted = messages.find((m) => m.type === "booted");
  assert.ok(booted?.type === "booted" && booted.projectAdmission);
  const documents = { "logic:0": "// exact text\nreturn;" };
  const build = compileProjectDocuments({
    files: Object.fromEntries(initial.files()),
    documents,
    profileId: "2.936",
  });
  const workspace = structuredClone(writeProjectWorkspace(documents));
  onWorkerMessage(ctx, {
    type: "previewUpdate",
    id: 1,
    runToken: booted.projectAdmission.runToken,
    expected: booted.projectAdmission.identity,
    candidate: {
      files: Object.fromEntries(build.files()),
      sources: { "0": documents["logic:0"] },
      sourceBindings: {},
      buildId: build.build.identity.buildId,
      revision: build.build.identity.revision,
      documents: workspace,
      documentId: projectDocumentId(documents, sha256Hex),
      origins: [],
    },
  });
  (workspace.documents[0]!.content as { text: string }).text = "tampered";
  assert.equal(readProjectWorkspace(ctx.boot.project!.documents)["logic:0"], documents["logic:0"]);
});
