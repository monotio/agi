import { installWebLocksFixture } from "./webLocksFixture.ts";
import { replayHistorySegment } from "./worker-ctx.ts";
import type { HistorySegment } from "../../src/agent/history.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { createMainProjectAdmission } from "../src/engine/mainProjectAdmission.ts";
import { WorkerQueryTimeoutError } from "../src/engine/workerQueries.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";
import {
  writeProjectWorkspace,
  readProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { readProjectHistory } from "../../src/authoring/projectHistoryCodec.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import { decodeTextRows } from "../src/project/gameTypes.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import * as storage from "../src/project/gameStorage.ts";
import type {
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
  WorkerQueryFn,
} from "../src/worker/workerProtocol.ts";

installWebLocksFixture();

installIndexedDbFixture();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});

test("one MAIN run admits PICTURE, LOGIC, WORDS and Undo; autosave reopens exact source and last good bytes", async () => {
  const source =
    'if (v40 == 0) { load.pic(0); draw.pic(0); show.pic(); accept.input(); assignn(v40,1); } if (said("look")) { print("Old room"); } return;';
  const documents = {
    "logic:0": source,
    "picture:0": "vis 1\nfill 1,1\nend\n",
    words: '[["look",10]]',
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const id = requireProjectId("main-proof");
  const first = await storage.commitProject({
    projectId: id,
    commitId: "initial",
    workspaceId: "initial",
    buildId: compiled.build.identity.buildId,
    expected: null,
    documents: [],
    data: {
      title: "Proof",
      files: Object.fromEntries(compiled.files()),
      words: [["look", 10]],
      workspace: writeProjectWorkspace(documents),
    },
  });
  const messages: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  let now = 0;
  const ctx = createWorkerContext({
    control: (m) => messages.push(m),
    presentation: (m) => presentation.push(m),
    now: () => now,
    seedWord: () => 1,
  });
  ctx.host = createEngineHost(ctx);
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(compiled.files()),
    words: [["look", 10]],
    profile: "2.936",
    projectMode: "create",
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  const engine = ctx.engine!;
  const tick = () => {
    now += 100;
    ctx.fns.hostTick();
  };
  tick();
  tick();
  const ack = messages.find((m) => m.type === "booted");
  assert.ok(ack?.type === "booted" && ack.projectAdmission);
  let queryId = 0;
  let loseAck = true;
  const query = (async (type, extra) => {
    const id = ++queryId;
    onWorkerMessage(ctx, { type, id, ...extra } as WorkerInbound);
    const reply = messages.at(-1);
    for (const message of messages) {
      if (message.type === "historyBatch")
        onWorkerMessage(ctx, {
          type: "historyAck",
          epoch: message.epoch,
          batch: message.batch.batch,
        });
    }
    if (type === "previewUpdate" && loseAck) {
      loseAck = false;
      throw new WorkerQueryTimeoutError(id, type);
    }
    return reply;
  }) as WorkerQueryFn;
  const admission = createMainProjectAdmission({
    ...ack.projectAdmission,
    query,
    current: () => ctx.engine === engine,
  });
  const session = openProjectSession({
    data: (await storage.loadAuthoredGame(id))!,
    lifetime: first.receipt.saved.lifetime,
    admission,
  });
  const edit = (key: string, content: string, origin: "picture" | "logic" | "words") =>
    session.submit({
      proposal: session.model.propose(session.model.capture(), key, [{ key, content }]),
      label: key,
      origin,
      author: "creator",
    });
  assert.equal((await edit("picture:0", "vis 4\nfill 1,1\nend\n", "picture")).status, "committed");
  assert.equal(engine.getPictureSurface().visual[161], 4);
  assert.ok(
    presentation.some((message) => message.type === "autosave"),
    "an admitted native edit takes a checkpoint before the next periodic save",
  );
  assert.equal(
    (await edit("logic:0", source.replace("Old room", "New room"), "logic")).status,
    "committed",
  );
  onWorkerMessage(ctx, { type: "input", text: "look" });
  tick();
  tick();
  assert.ok(
    decodeTextRows(engine.getPresentation().text).some((line) => line.includes("New room")),
  );
  onWorkerMessage(ctx, { type: "dismissPrint" });
  tick();
  assert.equal((await edit("words", '[["look",10],["inspect",10]]', "words")).status, "committed");
  assert.equal(ctx.boot.liveDictionary.get("inspect"), 10);
  assert.equal((await session.undo())?.status, "committed");
  assert.equal(ctx.boot.liveDictionary.has("inspect"), false);
  const goodImage = session.model.capture().lastAdmissibleBuild!;
  const goodFiles = Object.fromEntries(engine.containerFiles);
  const invalid = await edit("logic:0", "if (", "logic");
  assert.equal(invalid.status, "diagnostics");
  assert.deepEqual(Object.fromEntries(engine.containerFiles), goodFiles);
  assert.equal(ctx.engine, engine);
  await session.flush();
  assert.equal(session.saveStatus().state, "saved");
  const reopened = (await storage.loadAuthoredGame(id))!;
  assert.equal(readProjectWorkspace(reopened.workspace!)["logic:0"], "if (");
  assert.deepEqual(reopened.files, goodFiles);
  const history = readProjectHistory(reopened.projectHistory, sha256Hex);
  assert.equal(history.commits.length, 5);
  const events = [
    ...ctx.history.open.events,
    ...messages.flatMap((m) => (m.type === "historyBatch" ? m.batch.events : [])),
  ];
  assert.equal(events.filter((e) => e.cause.kind === "projectImage").length, 4);
  ctx.fns.historyFlush();
  const batches = messages.flatMap((m) => (m.type === "historyBatch" ? [m.batch] : []));
  const segment: HistorySegment = {
    id: batches[0]!.segment,
    boot: batches[0]!.boot!,
    anchors: batches.flatMap((b) => (b.anchor === undefined ? [] : [b.anchor])),
    events: batches.flatMap((b) => b.events),
    marks: batches.flatMap((b) => b.marks),
    sync: batches.flatMap((b) => b.sync),
    clock: batches.flatMap((b) => b.clock ?? []),
  };
  const replayed = replayHistorySegment(segment);
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null);
  assert.deepEqual(Object.fromEntries(replayed.ctx.engine!.containerFiles), goodFiles);
  assert.equal(
    readProjectWorkspace(replayed.ctx.boot.project!.documents)["logic:0"],
    source.replace("Old room", "New room"),
  );
  const anchored = replayHistorySegment(segment, { anchor: segment.anchors.length - 1 });
  assert.equal(anchored.error, null);
  assert.equal(anchored.diverged, null);
  assert.deepEqual(anchored.ctx.boot.project, replayed.ctx.boot.project);
  session.dispose();
  ctx.fns.stopTimers();
  const again = openProjectSession({
    data: reopened,
    lifetime: first.receipt.saved.lifetime,
    admission,
  });
  assert.equal(again.model.capture().read("logic:0")!.content, "if (");
  assert.deepEqual(
    Object.fromEntries(again.model.capture().lastAdmissibleBuild!.files()),
    goodFiles,
  );
  assert.equal(again.model.capture().lastAdmissibleBuild!.documentId, goodImage.documentId);
  assert.equal(
    again.model.capture().lastAdmissibleBuild!.identity.buildId,
    goodImage.identity.buildId,
  );
  again.dispose();
});

test("Update closes a waiting message and installs all parts with one Undo", async () => {
  const documents = {
    "logic:0":
      'if (isset(f5)) { load.pic(0); draw.pic(0); show.pic(); } if (v40 == 0) { assignn(v40,1); print("Wait"); } return;',
    "picture:0": "vis 1\nfill 1,1\nend\n",
    words: '[["look",10]]',
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const messages: WorkerControl[] = [];
  const ctx = createWorkerContext({
    control: (message) => messages.push(message),
    presentation: () => {},
    now: () => 100,
    seedWord: () => 1,
  });
  ctx.host = createEngineHost(ctx);
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(compiled.files()),
    words: [["look", 10]],
    profile: "2.936",
    projectMode: "create",
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  ctx.fns.hostTick();
  const engine = ctx.engine!;
  const boot = messages.find((message) => message.type === "booted");
  assert.ok(boot?.type === "booted" && boot.projectAdmission);
  let queryId = 0;
  const query = (async (type: string, fields = {}) => {
    onWorkerMessage(ctx, { type, id: ++queryId, ...fields } as WorkerInbound);
    return messages.at(-1);
  }) as WorkerQueryFn;
  const admission = createMainProjectAdmission({
    ...boot.projectAdmission,
    query,
    current: () => ctx.engine === engine,
  });
  let boundaries = 0;
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("update-worker"),
      title: "Worker update",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [["look", 10]],
      workspace: writeProjectWorkspace(documents),
    },
    lifetime: "initial",
    admission,
    boundary: async () => {
      boundaries++;
      assert.equal(engine.getPictureSurface().visual[161], 1);
      onWorkerMessage(ctx, { type: "dismissPrint" });
      ctx.fns.hostTick();
    },
    write: async (request) => ({
      commitId: request.commitId,
      workspaceId: request.workspaceId,
      candidateHash: "a",
      documents: request.documents,
      saved: {
        ...request.expected!,
        generation: request.expected!.generation + 1,
        buildId: request.buildId,
      },
    }),
  });
  const originalHistory = session.history.capture().commits.length;
  assert.equal(
    (
      await session.update([
        { key: "picture:0", content: "vis 4\nfill 1,1\nend\n" },
        { key: "logic:0", content: "if (" },
      ])
    ).status,
    "diagnostics",
  );
  assert.equal(engine.getPictureSurface().visual[161], 1);
  assert.equal(session.history.capture().commits.length, originalHistory);
  assert.equal(
    (
      await session.update([
        { key: "picture:0", content: "vis 4\nfill 1,1\nend\n" },
        { key: "words", content: '[["look",10],["inspect",10]]' },
      ])
    ).status,
    "committed",
  );
  assert.equal(boundaries, 0);
  assert.equal(engine.modalKind, null);
  assert.equal(engine.continuationPending, false);
  ctx.fns.hostTick();
  assert.equal(ctx.engine, engine);
  assert.equal(engine.getPictureSurface().visual[161], 4);
  assert.equal(ctx.boot.liveDictionary.get("inspect"), 10);
  assert.equal(session.history.capture().commits.length, originalHistory + 1);
  const undone = await session.undo();
  assert.equal(undone?.status, "committed", JSON.stringify(undone));
  assert.equal(engine.getPictureSurface().visual[161], 1);
  assert.equal(ctx.boot.liveDictionary.has("inspect"), false);
  session.dispose();
  ctx.fns.stopTimers();
});
