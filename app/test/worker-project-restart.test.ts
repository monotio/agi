import { replayHistorySegment } from "./worker-ctx.ts";
import type { HistorySegment } from "../../src/agent/history.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { decodeTextRows } from "../src/project/gameTypes.ts";
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
import type {
  WorkerControl,
  WorkerInbound,
  WorkerQueryFn,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";

async function fixture(name: string, overrides: Record<string, string> = {}, opaqueView = false) {
  const documents: Record<string, string | Uint8Array> = {
    "logic:0":
      'if (isset(f5)) { load.pic(0); draw.pic(0); show.pic(); accept.input(); } if (said("look")) { assignn(v80,42); } return;',
    "picture:0": "vis 1\nfill 1,1\nend\n",
    inventory: '[{"name":"key","startingRoom":1},{"name":"coin","startingRoom":2}]',
    words: '[["look",10]]',
    ...overrides,
  };
  let compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  if (opaqueView) {
    const imported = openContainer(compiled.files());
    imported.putResource("view", 255, new Uint8Array([0xff]));
    documents["view:255"] = new Uint8Array([0xff]);
    compiled = compileProjectDocuments({
      files: Object.fromEntries(imported.files),
      documents,
      profileId: "2.936",
    });
  }
  const messages: WorkerControl[] = [];
  const presentations: WorkerPresentation[] = [];
  let now = 0;
  const ctx = createWorkerContext({
    control: (m) => messages.push(m),
    presentation: (m) => presentations.push(m),
    now: () => now,
  });
  ctx.host = createEngineHost(ctx);
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(compiled.files()),
    words: [["look", 10]],
    profile: "2.936",
    projectMode: "create",
    autosaveFiles: true,
    projectDocuments: writeProjectWorkspace(documents),
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  const tick = () => {
    now += 100;
    ctx.fns.hostTick();
  };
  tick();
  tick();
  const boot = messages.find((m) => m.type === "booted");
  assert.ok(boot?.type === "booted" && boot.projectAdmission);
  let id = 0;
  let loseAck = false;
  let tamper = false;
  let holdReply = false;
  let reachedAck: (() => void) | undefined;
  let releaseAck: (() => void) | undefined;
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
    if (holdReply) {
      holdReply = false;
      await new Promise<void>((resolve) => {
        releaseAck = resolve;
        reachedAck!();
      });
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
      words: [["look", 10]],
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
    presentations,
    session,
    writes,
    published,
    edit,
    tick,
    admission,
    holdAck() {
      return {
        reached: new Promise<void>((resolve) => {
          reachedAck = resolve;
          holdReply = true;
        }),
        release() {
          releaseAck?.();
        },
      };
    },
    loseAck: () => {
      loseAck = true;
    },
    tamper: () => {
      tamper = true;
    },
  };
}

for (const restart of [false, true]) {
  test(`Create saves and shows a LOGIC message beside an untouched malformed imported VIEW${restart ? " after restart" : " live"}`, async () => {
    const source =
      'if (isset(f5)) { load.pic(0); draw.pic(0); show.pic(); accept.input(); } if (said("look")) { print("Old room"); } return;';
    const f = await fixture(`opaque-view-${restart}`, { "logic:0": source }, true);
    try {
      const old = f.ctx.engine!;
      assert.equal(old.getPictureSurface().visual[161], 1);
      const changed = source.replace("Old room", "Changed room");
      const result = await f.session.submit({
        proposal: f.session.model.propose(f.session.model.capture(), "Change message", [
          { key: "logic:0", content: changed },
          ...(restart ? [{ key: "inventory", content: "[]" }] : []),
        ]),
        label: "Change message",
        origin: "logic",
        author: "creator",
      });
      assert.equal(result.status, restart ? "restartRequired" : "committed");
      await f.session.flush();
      assert.equal(f.session.saveStatus().state, "saved");
      const saved = f.writes.at(-1)!.data;
      assert.equal(readProjectWorkspace(saved.workspace)["logic:0"], changed);
      assert.deepEqual(
        openContainer(new Map(Object.entries(saved.files))).getResource("view", 255),
        new Uint8Array([0xff]),
      );
      if (restart) {
        assert.equal((await f.session.restartWithChanges())?.status, "committed");
        assert.notEqual(f.ctx.engine, old);
        f.ctx.fns.stopTimers();
        f.tick();
        f.tick();
      } else assert.equal(f.ctx.engine, old);
      onWorkerMessage(f.ctx, { type: "input", text: "look" });
      f.tick();
      f.tick();
      assert.ok(
        decodeTextRows(f.ctx.engine!.getPresentation().text).some((row) =>
          row.includes("Changed room"),
        ),
      );
      assert.deepEqual(
        openContainer(f.ctx.engine!.containerFiles).getResource("view", 255),
        new Uint8Array([0xff]),
      );
    } finally {
      f.session.dispose();
      f.ctx.fns.stopTimers();
    }
  });
}

test("OBJECT removal is saved in History while the old run continues; acknowledged restart uses the complete candidate and a fresh token", async () => {
  const f = await fixture("restart-inventory");
  try {
    const old = f.ctx.engine!;
    const token = f.session.runToken;
    onWorkerMessage(f.ctx, { type: "input", text: "look" });
    f.tick();
    f.tick();
    assert.equal(old.vars[80], 42);
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
    const batches = f.messages.flatMap((m) => (m.type === "historyBatch" ? [m.batch] : []));
    const oldBatches = batches.filter((b) => b.segment === batches[0]!.segment);
    const segment: HistorySegment = {
      id: oldBatches[0]!.segment,
      boot: oldBatches[0]!.boot!,
      anchors: oldBatches.flatMap((b) => (b.anchor === undefined ? [] : [b.anchor])),
      events: oldBatches.flatMap((b) => b.events),
      marks: oldBatches.flatMap((b) => b.marks),
      sync: oldBatches.flatMap((b) => b.sync),
      clock: oldBatches.flatMap((b) => b.clock ?? []),
    };
    const replay = replayHistorySegment(segment);
    assert.equal(replay.error, null);
    assert.equal(replay.diverged, null);
    assert.equal(replay.ctx.engine!.vars[80], 42);
    assert.equal(replay.ctx.engine!.itemLocation(1), 2);
    assert.notDeepEqual(
      Object.fromEntries(replay.ctx.engine!.containerFiles),
      Object.fromEntries(f.ctx.engine!.containerFiles),
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

test("session offers room re-entry for a loaded VIEW layout, keeps its token and global state, and records executable candidate files", async () => {
  const cel = { width: 2, height: 2, pixels: [14, 14, 14, 14] };
  const f = await fixture("reenter-view", {
    "logic:0":
      "if (isset(f5)) { load.pic(0); draw.pic(0); show.pic(); load.view(0); animate.obj(o0); set.view(o0,0); position(o0,40,100); draw(o0); stop.motion(o0); } return;",
    "view:0": JSON.stringify({ loops: [{ cels: [cel] }] }),
  });
  try {
    const old = f.ctx.engine!;
    const token = f.session.runToken;
    old.vars[80] = 77;
    old.flags[80] = 1;
    const result = await f.edit(
      "view:0",
      JSON.stringify({ loops: [{ cels: [{ ...cel, pixels: [4, 4, 4, 4] }] }, { cels: [cel] }] }),
    );
    assert.equal(result.status, "restartRequired");
    assert.equal(f.session.capture().pendingRestart?.action, "reenter");
    assert.equal((await f.session.reenterRoom())?.status, "committed");
    assert.equal(f.ctx.engine, old);
    assert.equal(f.session.runToken, token);
    assert.equal(f.session.pendingRestart, null);
    assert.equal(old.vars[80], 77);
    assert.equal(old.flags[80], 1);
    assert.equal(old.itemLocation(1), 2);
    old.tick();
    assert.equal(old.getPresentation().visual[100 * 160 + 40], 4);
    const recorded = f.messages
      .filter((m) => m.type === "historyBatch")
      .findLast((m) => m.batch.boot)?.batch.boot;
    assert.ok(recorded);
    assert.ok(recorded.project);
    assert.deepEqual(
      readProjectWorkspace(recorded.project.documents),
      f.session.model.capture().documents(),
    );
    assert.deepEqual(
      recorded.files,
      Object.fromEntries(
        [...old.containerFiles].map(([name, bytes]) => [
          name,
          Buffer.from(bytes).toString("base64"),
        ]),
      ),
    );
    await f.session.flush();
    assert.equal(f.session.history.capture().commits.length, 2);
    assert.equal((await f.session.undo())?.status, "restartRequired");
    assert.equal(f.session.capture().pendingRestart?.action, "reenter");
    assert.equal((await f.session.reenterRoom())?.status, "committed");
    old.tick();
    assert.equal(old.getPresentation().visual[100 * 160 + 40], 14);
  } finally {
    f.session.dispose();
    f.ctx.fns.stopTimers();
  }
});

test("the session keeps the pending notice and running token until replacement acknowledgement", async () => {
  const f = await fixture("restart-ack-fence");
  let held: ReturnType<typeof f.holdAck> | undefined;
  try {
    await f.edit("inventory", "[]");
    await f.session.flush();
    const token = f.session.runToken;
    const writes = f.writes.length;
    held = f.holdAck();
    const restart = f.session.restartWithChanges();
    await held.reached;
    assert.notEqual(f.ctx.projectAdmission!.runToken, token);
    assert.equal(f.session.runToken, token);
    assert.ok(f.session.pendingRestart);
    assert.deepEqual(f.published, ["restartRequired"]);
    assert.equal(f.writes.length, writes);
    held.release();
    assert.equal((await restart)?.status, "committed");
    assert.equal(f.session.pendingRestart, null);
    assert.deepEqual(f.published, ["restartRequired", "committed"]);
  } finally {
    held?.release();
    f.session.dispose();
    f.ctx.fns.stopTimers();
  }
});

test("Create keeps progress temporary and Play autosave leaves the saved pending candidate to the session", async () => {
  const f = await fixture("restart-autosave-owner");
  try {
    assert.equal((await f.edit("picture:0", "vis 4\nfill 1,1\nend\n")).status, "committed");
    await f.edit("inventory", '[{"name":"key","startingRoom":1}]');
    await f.session.flush();
    assert.equal(f.ctx.fns.autosave(true), false, "Create progress stays temporary");
    onWorkerMessage(f.ctx, { type: "projectPlay" });
    assert.equal(f.ctx.fns.autosave(true), true);
    const progress = f.presentations.findLast((m) => m.type === "autosave");
    assert.ok(progress?.type === "autosave");
    assert.equal(progress.files, undefined);
    assert.equal(f.ctx.engine!.itemLocation(1), 2);
    assert.equal(
      readProjectWorkspace(f.writes.at(-1)!.data.workspace)["inventory"],
      '[{"name":"key","startingRoom":1}]',
    );
    assert.equal(f.session.pendingRestart?.action, "restart");
  } finally {
    f.session.dispose();
    f.ctx.fns.stopTimers();
  }
});

test("acknowledged project restart ends Playtest recording and starts a fresh history segment", async () => {
  const f = await fixture("restart-recording");
  try {
    onWorkerMessage(f.ctx, { type: "startRecording", id: 900 });
    assert.ok(f.ctx.recording.recording);
    const oldSegment = f.ctx.history.segment;
    await f.edit("inventory", "[]");
    assert.ok(f.ctx.recording.recording, "a pending candidate keeps recording the old run");
    assert.equal((await f.session.restartWithChanges())?.status, "committed");
    f.ctx.fns.stopTimers();
    assert.equal(f.ctx.recording.recording, null);
    assert.ok(f.messages.some((m) => m.type === "recordingReset"));
    f.tick();
    assert.notEqual(f.ctx.history.segment, oldSegment);
    onWorkerMessage(f.ctx, { type: "startRecording", id: 901 });
    assert.ok(f.ctx.recording.recording, "the replacement run can start a new Playtest");
  } finally {
    f.session.dispose();
    f.ctx.fns.stopTimers();
  }
});
