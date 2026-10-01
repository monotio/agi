import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import {
  writeProjectWorkspace,
  readProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { createMainProjectAdmission } from "../src/engine/mainProjectAdmission.ts";
import { WorkerQueryTimeoutError } from "../src/engine/workerQueries.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import type { ProjectCommitRequest } from "../src/project/gameStorage.ts";
import type { WorkerControl, WorkerInbound, WorkerQueryFn } from "../src/worker/workerProtocol.ts";

async function fixture(name: string) {
  const documents = {
    "logic:0": "if (isset(f5)) { load.pic(0); draw.pic(0); show.pic(); accept.input(); } return;",
    "picture:0": "vis 1\nfill 1,1\nend\n",
    inventory: '[{"name":"key","startingRoom":1},{"name":"coin","startingRoom":2}]',
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const messages: WorkerControl[] = [];
  const ctx = createWorkerContext({
    control: (m) => messages.push(m),
    presentation: () => {},
    now: () => 0,
  });
  ctx.host = createEngineHost(ctx);
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(compiled.files()),
    words: [],
    profile: "2.936",
    projectMode: "create",
    projectDocuments: writeProjectWorkspace(documents),
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  ctx.engine!.tick();
  const boot = messages.find((m) => m.type === "booted");
  assert.ok(boot?.type === "booted" && boot.projectAdmission);
  let id = 0;
  let loseAck = false;
  let tamper = false;
  const query = (async (type, extra) => {
    const queryId = ++id;
    const request = { type, id: queryId, ...extra } as WorkerInbound;
    if (tamper && request.type === "previewUpdate") request.candidate.buildId = "forged";
    onWorkerMessage(ctx, request);
    const reply = messages.findLast((m) => "id" in m && m.id === queryId);
    if (loseAck && type === "previewUpdate") {
      loseAck = false;
      throw new WorkerQueryTimeoutError(queryId, type);
    }
    return reply;
  }) as WorkerQueryFn;
  const admission = createMainProjectAdmission({
    ...boot.projectAdmission,
    query,
    current: () => true,
  });
  const writes: ProjectCommitRequest[] = [];
  const published: string[] = [];
  const session = openProjectSession({
    data: {
      projectId: requireProjectId(name),
      title: "Restart",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
    },
    lifetime: "initial",
    admission,
    publish: (_snapshot, _data, outcome) => published.push(outcome?.status ?? "diagnostics"),
    write: async (request) => {
      writes.push(request);
      return {
        commitId: request.commitId,
        workspaceId: request.workspaceId,
        candidateHash: "a",
        documents: request.documents,
        saved: {
          ...request.expected!,
          generation: (request.expected?.generation ?? 0) + 1,
          buildId: request.buildId,
        },
      };
    },
  });
  const edit = (key: string, content: string) =>
    session.submit({
      proposal: session.model.propose(session.model.capture(), key, [{ key, content }]),
      label: key,
      origin: "logic",
      author: "creator",
    });
  return {
    ctx,
    messages,
    session,
    writes,
    published,
    edit,
    admission,
    loseAck: () => {
      loseAck = true;
    },
    tamper: () => {
      tamper = true;
    },
  };
}

test("OBJECT removal is saved in History while the old run continues; acknowledged restart uses the complete candidate and a fresh token", async () => {
  const f = await fixture("restart-inventory");
  try {
    const old = f.ctx.engine!;
    const token = f.session.runToken;
    old.vars[80] = 42;
    const outcome = await f.edit("inventory", '[{"name":"key","startingRoom":1}]');
    assert.equal(outcome.status, "restartRequired");
    assert.equal(
      f.session.model.capture().read("inventory")!.content,
      '[{"name":"key","startingRoom":1}]',
    );
    assert.equal(f.session.history.capture().commits.length, 2);
    assert.equal(f.ctx.engine, old);
    assert.equal(old.itemLocation(1), 2);
    assert.equal(f.session.pendingRestart?.action, "restart");
    assert.match(f.session.pendingRestart!.reason, /OBJECT/);
    await f.session.flush();
    assert.equal(
      readProjectWorkspace(f.writes[0]!.data.workspace)["inventory"],
      '[{"name":"key","startingRoom":1}]',
    );
    assert.deepEqual(f.published, ["restartRequired"]);
    f.loseAck();
    assert.equal((await f.session.restartWithChanges())?.status, "committed");
    assert.notEqual(f.ctx.engine, old);
    assert.notEqual(f.session.runToken, token);
    assert.equal(f.session.runToken, f.ctx.projectAdmission!.runToken);
    assert.equal(f.session.pendingRestart, null);
    assert.equal(f.ctx.engine!.vars[80], 0);
    assert.equal(f.ctx.engine!.itemLocation(1), 0);
    f.ctx.engine!.tick();
    assert.equal(f.ctx.engine!.getPictureSurface().visual[161], 1);
    assert.equal(f.session.history.capture().commits.length, 2);
    assert.ok(
      f.messages.some(
        (m) =>
          m.type === "historyBatch" &&
          m.batch.events.some((e) => e.cause.kind === "end" && e.cause.reason === "boot"),
      ),
    );
    assert.equal((await f.edit("picture:0", "vis 4\nfill 1,1\nend\n")).status, "committed");
  } finally {
    f.session.dispose();
    f.ctx.fns.stopTimers();
  }
});

test("a forged restart refuses before Engine replacement, History changes or storage writes", async () => {
  const f = await fixture("restart-refusal");
  try {
    await f.edit("inventory", "[]");
    await f.session.flush();
    const old = f.ctx.engine!;
    const token = f.session.runToken;
    const writes = f.writes.length;
    f.tamper();
    assert.equal((await f.session.restartWithChanges())?.status, "refused");
    await f.session.flush();
    assert.equal(f.ctx.engine, old);
    assert.equal(f.session.runToken, token);
    assert.equal(f.writes.length, writes);
    assert.equal(f.session.history.capture().commits.length, 2);
    assert.ok(f.session.pendingRestart);
  } finally {
    f.session.dispose();
    f.ctx.fns.stopTimers();
  }
});

test("restart recompiles current documents before replacing the run; invalid source remains saved with its working image", async () => {
  const f = await fixture("restart-invalid");
  try {
    await f.edit("inventory", "[]");
    await f.edit("logic:0", "if (");
    await f.session.flush();
    const old = f.ctx.engine!;
    const writes = f.writes.length;
    assert.equal((await f.session.restartWithChanges())?.status, "diagnostics");
    assert.equal(f.ctx.engine, old);
    assert.equal(f.writes.length, writes);
    assert.ok(f.session.pendingRestart);
  } finally {
    f.session.dispose();
    f.ctx.fns.stopTimers();
  }
});
