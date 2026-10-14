import { installWebLocksFixture } from "./webLocksFixture.ts";
import { replayHistorySegment } from "./worker-ctx.ts";
import type { HistorySegment } from "../../src/agent/history.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { createMainProjectAdmission } from "../src/engine/mainProjectAdmission.ts";
import { useTestRecorder } from "../src/authoring/useTestRecorder.ts";
import { WorkerQueryTimeoutError } from "../src/engine/workerQueries.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import {
  writeProjectWorkspace,
  readProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { readProjectHistory } from "../../src/authoring/projectHistoryCodec.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { computeResourceRevision } from "../../src/authoring/resourceRevision.ts";
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
    progressMode: "play",
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  const engine = ctx.run.engine!;
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
    current: () => ctx.run.engine === engine,
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
  // The picture on screen changed, so the room re-entered; its entry pass runs first.
  assert.ok(!presentation.some((message) => message.type === "autosave"));
  tick();
  assert.ok(
    presentation.some((message) => message.type === "autosave"),
    "an admitted native edit takes a checkpoint at the first boundary, before the next periodic save",
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
  assert.equal(ctx.run.engine, engine);
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
  assert.deepEqual(Object.fromEntries(replayed.ctx.run.engine!.containerFiles), goodFiles);
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

test("Update and restart closes a waiting message and installs all parts with one Undo", async () => {
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
  const engine = ctx.run.engine!;
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
    current: () => ctx.run.engine === engine,
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
      await session.update(
        [
          { key: "picture:0", content: "vis 4\nfill 1,1\nend\n" },
          { key: "words", content: '[["look",10],["inspect",10]]' },
        ],
        true,
      )
    ).status,
    "committed",
  );
  assert.equal(boundaries, 0);
  assert.equal(engine.modalKind, null);
  assert.equal(engine.continuationPending, false);
  ctx.fns.hostTick();
  assert.equal(ctx.run.engine, engine);
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

test("acquiring project admission for a Play conversation preserves the interpreter and play state", async () => {
  const messages: WorkerControl[] = [];
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "assignn(v40, 17); return;", words: "[]" },
    profileId: "2.936",
  });
  const ctx = createWorkerContext({
    control: (message) => messages.push(message),
    presentation: () => {},
    now: () => 0,
    seedWord: () => 1,
  });
  ctx.host = createEngineHost(ctx);
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(compiled.files()),
    words: [],
    profile: "2.936",
    progressMode: "play",
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  const engine = ctx.run.engine!;
  const before = engine.serialize();
  const recordingSession = ctx.history.session;
  const progress = ctx.run.progress;
  assert.equal(progress.mode, "play");
  onWorkerMessage(ctx, { type: "projectCreate", id: 91, progressMode: "play" });
  await ctx.projectLoader.loading;
  const reply = messages.find((message) => message.type === "projectCreated" && message.id === 91);
  assert.ok(reply?.type === "projectCreated" && reply.grant);
  assert.equal(ctx.run.engine, engine);
  assert.deepEqual(engine.serialize(), before);
  assert.equal(ctx.history.session, recordingSession);
  assert.equal(ctx.run.progress, progress);
  assert.equal(ctx.run.progress.mode, "play");
  ctx.fns.stopTimers();
});

async function openNativeTestsProject(
  t: TestContext,
  name: string,
  documents: Record<string, string>,
  storedDocuments = documents,
) {
  const { saveTests } = await import("../src/authoring/saveTests.ts");
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const storedImage = compileProjectDocuments({
    files: Object.fromEntries(compiled.files()),
    documents: storedDocuments,
    profileId: "2.936",
  });
  const id = requireProjectId(name);
  const first = await storage.commitProject({
    projectId: id,
    commitId: "initial",
    workspaceId: "initial",
    buildId: storedImage.build.identity.buildId,
    expected: null,
    documents: [],
    data: {
      title: "Tests",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(storedDocuments),
    },
  });
  const messages: WorkerControl[] = [];
  const sent: WorkerInbound[] = [];
  let now = 0;
  const ctx = createWorkerContext({
    control: (message) => messages.push(message),
    presentation: () => {},
    now: () => now,
    seedWord: () => 1,
  });
  ctx.host = createEngineHost(ctx);
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(compiled.files()),
    words: [],
    profile: "2.936",
    projectMode: "create",
    progressMode: "play",
    projectDocuments: writeProjectWorkspace(documents),
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  t.after(() => ctx.fns.stopTimers());
  for (let i = 0; i < 4; i++) {
    now += 100;
    ctx.fns.hostTick();
  }
  const tick = () => {
    now += 100;
    ctx.fns.hostTick();
  };
  const engine = ctx.run.engine!;
  const boot = messages.find((message) => message.type === "booted");
  assert.ok(boot?.type === "booted" && boot.projectAdmission);
  let queryId = 0;
  const query = (async (type, extra) => {
    const id = ++queryId;
    const request = { type, id, ...extra } as WorkerInbound;
    sent.push(request);
    onWorkerMessage(ctx, request);
    const reply = messages.at(-1);
    assert.ok(reply && "id" in reply && reply.id === id, `worker answered ${type}`);
    return reply;
  }) as WorkerQueryFn;
  const admission = createMainProjectAdmission({
    ...boot.projectAdmission,
    query,
    current: () => ctx.run.engine === engine,
    acceptedImage: () => session.model.capture().lastAdmissibleBuild,
  });
  const session = openProjectSession({
    data: (await storage.loadAuthoredGame(id))!,
    lifetime: first.receipt.saved.lifetime,
    admission,
  });
  t.after(() => session.dispose());
  return {
    saveTests,
    session,
    ctx,
    engine,
    sent,
    messages,
    query,
    admission,
    tick,
    grant: boot.projectAdmission,
  };
}

test("saving tests leaves Play, the timeline and recording intact; the next resource edit admits the complete project", async (t) => {
  const documents = {
    bindings: "{}",
    "logic:0": "if (v0 == 0) { new.room(1); } call.v(v0); return;",
    "logic:1":
      "if (isset(f5)) { assignn(v50,1); load.pic(v50); draw.pic(v50); show.pic(); accept.input(); } return;",
    "picture:1": "vis 1\nfill 1,1\nend\n",
  };
  const { saveTests, session, ctx, engine, sent, messages, query } = await openNativeTestsProject(
    t,
    "tests-native-admission",
    documents,
  );
  const start = await query("startRecording");
  assert.equal(start.ok, true);
  const recording = ctx.run.recording.recording;
  assert.ok(recording);
  const before = {
    engineState: engine.captureReplayState(),
    timeline: structuredClone(ctx.history),
    lane: structuredClone({
      documentId: ctx.run.projectAdmission!.documentId,
      epoch: ctx.run.projectAdmission!.epoch,
      serial: ctx.run.projectAdmission!.updateSerial,
    }),
    posted: messages.length,
    sent: sent.length,
    tape: structuredClone(recording.tape.operations),
  };
  const saved = await saveTests(session, {
    kind: "merge",
    tests: [{ name: "stay in room", room: 1, steps: [], expect: { room: 1 } }],
  });
  assert.equal(sent.length, before.sent, "tests-only saves send no native admission requests");
  assert.equal(messages.length, before.posted, "tests-only saves emit no worker timeline events");
  assert.equal(ctx.run.engine, engine);
  assert.deepEqual(engine.captureReplayState(), before.engineState);
  assert.deepEqual(ctx.history, before.timeline);
  assert.equal(ctx.run.recording.recording, recording);
  assert.equal(recording.tainted, null);
  assert.deepEqual(recording.tape.operations, before.tape);
  assert.deepEqual(
    {
      documentId: ctx.run.projectAdmission!.documentId,
      epoch: ctx.run.projectAdmission!.epoch,
      serial: ctx.run.projectAdmission!.updateSerial,
    },
    before.lane,
  );
  await saveTests(session, {
    kind: "merge",
    tests: [{ name: "stay in room", room: 1, steps: [], expect: { room: 1 } }],
  });
  assert.equal(sent.length, before.sent, "an identical test save sends no native request");
  assert.deepEqual(
    ctx.history,
    before.timeline,
    "an identical test save leaves the timeline intact",
  );
  assert.equal(session.saveStatus().state, "saved", "an identical save still flushes persistence");
  const tests = new TextDecoder().decode(saved.payload);
  const outcome = await session.submit({
    proposal: session.model.propose(session.model.capture(), "Picture", [
      { key: "picture:1", content: "vis 4\nfill 1,1\nend\n" },
    ]),
    label: "Picture",
    origin: "picture",
    author: "creator",
  });
  assert.equal(outcome.status, "committed");
  assert.equal(engine.getPictureSurface().visual[161], 4);
  assert.equal(readProjectWorkspace(ctx.boot.project!.documents)["tests"], tests);
  assert.equal(ctx.run.projectAdmission!.documentId, session.model.capture().documentId);
  const update = sent.find((message) => message.type === "previewUpdate");
  assert.ok(update?.type === "previewUpdate");
  assert.equal(readProjectWorkspace(update.candidate.documents!)["tests"], tests);
});

test("removing the test that blocked a room deletion admits the newly executable image", async (t) => {
  const documents = {
    "logic:0":
      "if (v40 == 0) { assignn(v50,1); load.pic(v50); draw.pic(v50); show.pic(); accept.input(); assignn(v40,1); } return;",
    "logic:1": "return;",
    "picture:1": "vis 1\nfill 1,1\nend\n",
  };
  const { saveTests, session, ctx, engine, sent } = await openNativeTestsProject(
    t,
    "tests-unblock-room-removal",
    documents,
  );
  await saveTests(session, {
    kind: "merge",
    tests: [{ name: "room one", room: 1, steps: [], expect: { room: 1 } }],
  });
  const held = await session.submit({
    proposal: session.model.propose(session.model.capture(), "Delete room", [
      { key: "logic:1", content: null },
    ]),
    label: "Delete room",
    origin: "logic",
    author: "creator",
  });
  assert.equal(held.status, "diagnostics");
  assert.equal(
    session.model.capture().read("logic:1"),
    undefined,
    "the deletion stays in project documents",
  );
  assert.ok(engine.containerFiles.get("LOGDIR")!.length > 3);
  assert.ok(
    openContainer(ctx.run.engine!.containerFiles).getResource("logic", 1),
    "the worker retains the held-back room",
  );
  const count = sent.filter((message) => message.type === "previewUpdate").length;
  await saveTests(session, { kind: "remove", names: ["room one"] });
  assert.ok(
    sent.filter((message) => message.type === "previewUpdate").length > count,
    "unblocking a resource deletion attempts native admission",
  );
  assert.ok(
    !openContainer(ctx.run.engine!.containerFiles).getResource("logic", 1) ||
      session.capture().pendingAdmission ||
      session.pendingRestart,
    "the room deletion reaches the worker or remains explicitly pending",
  );
  if (!session.capture().pendingAdmission && !session.pendingRestart) {
    assert.equal(readProjectWorkspace(ctx.boot.project!.documents)["logic:1"], undefined);
    assert.equal(ctx.run.projectAdmission!.documentId, session.model.capture().documentId);
  }
});

test("a test save admits source authority that differs from the worker despite identical native bytes", async (t) => {
  const documents = {
    "logic:0":
      "if (v40 == 0) { assignn(v50,1); load.pic(v50); draw.pic(v50); show.pic(); accept.input(); assignn(v40,1); } return;",
    "logic:1": "return;",
    "picture:1": "vis 1\nfill 1,1\nend\n",
  };
  const claimed = { ...documents, "logic:0": `${documents["logic:0"]}\n// Current editor source` };
  const { saveTests, session, ctx, engine, sent, grant } = await openNativeTestsProject(
    t,
    "tests-unconfirmed-source",
    documents,
    claimed,
  );
  const image = session.model.capture().lastAdmissibleBuild!;
  assert.equal(image.identity.revision, grant.identity.revision);
  assert.notEqual(image.identity.buildId, grant.identity.buildId);
  const native = Object.fromEntries(engine.containerFiles);
  await saveTests(session, {
    kind: "merge",
    tests: [{ name: "source test", room: 1, steps: [], expect: null }],
  });
  assert.ok(
    sent.some((message) => message.type === "previewUpdate"),
    "the worker's confirmed source authority decides admission",
  );
  assert.deepEqual(Object.fromEntries(engine.containerFiles), native);
  assert.equal(ctx.run.projectAdmission!.sources["0"], claimed["logic:0"]);
  assert.equal(ctx.run.projectAdmission!.buildId, image.identity.buildId);
});

test("a refused recorded-test admission keeps the recording for retry and stores no test", async (t) => {
  const documents = {
    bindings: "{}",
    "logic:0": "if (v0 == 0) { new.room(1); } call.v(v0); return;",
    "logic:1":
      "if (isset(f5)) { assignn(v50,1); load.pic(v50); draw.pic(v50); show.pic(); accept.input(); } return;",
    "picture:1": "vis 1\nfill 1,1\nend\n",
  };
  const claimed = { ...documents, "logic:0": `${documents["logic:0"]}\n// Current source` };
  const f = await openNativeTestsProject(t, "tests-refused-recording", documents, claimed);
  const admit = f.admission.admit;
  f.admission.admit = async () => ({
    status: "refused",
    expected: f.grant.identity,
    current: f.grant.identity,
    patchGeneration: 0,
    reason: "The running game changed.",
  });
  const projectId = requireProjectId("tests-refused-recording");
  const game = (await storage.loadAuthoredGame(projectId))!;
  const booted = { ...game, installed: false, revision: computeResourceRevision(game.files) };
  let flushed = 0;
  const recorder = useTestRecorder({
    state: {
      phase: "running",
      recording: { active: false, starting: false, error: "" },
      powerUp: { open: false, busy: false },
      modal: null,
      prompt: null,
      waitingForKey: false,
    },
    getWorker: () => ({}) as Worker,
    query: f.query,
    logAgent: () => {},
    getBootedGame: () => booted,
    getProjectSession: () => f.session,
    flushAutosave: async () => {
      flushed++;
    },
  });
  await recorder.startTestRecording();
  const snapshot = await recorder.stopTestRecording();
  assert.ok(snapshot && !("endedBy" in snapshot));
  const before = f.session.model.capture().documentId;
  const storedGeneration = game.generation;
  const result = await recorder.saveRecordedTest(snapshot, "recorded", []);
  assert.equal(result.ok, false);
  assert.match(result.message, /running game changed.*Reopen/s);
  assert.equal(flushed, 0, "refusal must not flush or report success");
  assert.equal(f.session.model.capture().documentId, before);
  const stored = (await storage.loadAuthoredGame(projectId))!;
  assert.equal(stored.generation, storedGeneration, "a refusal cannot persist another capture");
  assert.equal(readProjectWorkspace(stored.workspace!)["tests"], undefined);
  f.admission.admit = admit;
  // The same stopped recording remains available for the player's next Save.
  const saved = await recorder.saveRecordedTest(snapshot, "recorded", []);
  assert.equal(saved.ok, true);
  assert.equal(flushed, 1);
  assert.equal(snapshot.tainted, null);
});

for (const next of ["deferred", "moved room"] as const) {
  test(`a test save preserves a pending restart when the worker is ${next}`, async (t) => {
    const documents = {
      bindings: "{}",
      "logic:0":
        "if (isset(f5) && v0 == 0) { assignn(v50,1); load.pic(v50); draw.pic(v50); show.pic(); new.room(1); } if (v0 != 0) { call.v(v0); } return;",
      "logic:1": "return;",
      "logic:2":
        "if (isset(f5)) { assignn(v50,2); load.pic(v50); draw.pic(v50); show.pic(); } return;",
      "picture:1": "vis 1\nfill 1,1\nend\n",
      "picture:2": "vis 2\nfill 1,1\nend\n",
    };
    const f = await openNativeTestsProject(
      t,
      `tests-pending-restart-${next.replaceAll(" ", "-")}`,
      documents,
    );
    assert.equal(f.engine.vars[0], 1);
    const outcome = await f.session.submit({
      proposal: f.session.model.propose(f.session.model.capture(), "Picture", [
        { key: "picture:1", content: "vis 4\nfill 1,1\nend\n" },
      ]),
      label: "Picture",
      origin: "picture",
      author: "creator",
    });
    assert.equal(outcome.status, "restartRequired");
    const restart = f.session.pendingRestart;
    assert.ok(restart);
    f.engine.reenterRoom(next === "deferred" ? 1 : 2);
    if (next === "moved room") f.tick();
    const before = {
      sent: f.sent.length,
      timeline: structuredClone(f.ctx.history),
      state: f.engine.serialize(),
    };
    await f.saveTests(f.session, {
      kind: "merge",
      tests: [{ name: "pending", room: 1, steps: [], expect: null }],
    });
    assert.equal(f.sent.length, before.sent, "test saves cannot retry a pending resource restart");
    assert.equal(f.session.pendingRestart, restart);
    assert.equal(f.session.capture().pendingAdmission, false);
    assert.deepEqual(f.ctx.history, before.timeline);
    assert.deepEqual(f.engine.serialize(), before.state);
  });
}
