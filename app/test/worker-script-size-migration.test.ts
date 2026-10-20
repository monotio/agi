import { customizedLegacyBoot } from "../../test/released-template-fixtures.ts";
/**
 * Player-visible rule (CHANGELOG 1.2.5; docs/fidelity.md "Authored script
 * buffer on live edits"): an older authored game opened in Create gains
 * script.size(200) once, and the running game, its checkpoints and its
 * recorded history use the larger buffer at once, so a busy room keeps
 * working without a restart. A game booted without the authored-project
 * option keeps the buffer its own code set.
 */
import { installWebLocksFixture } from "./webLocksFixture.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { replayHistorySegment } from "./worker-ctx.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistorySegment } from "../../src/agent/history.ts";
import { stampBoot, validateHistoryBoot } from "../../src/agent/history.ts";
import { resourceSetHint } from "../../src/agent/authoringState.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { projectDocumentId } from "../../src/authoring/projectContent.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { bytesToBase64 } from "../src/project/bytes.ts";
import { BASE_TEMPLATE_LOGIC0_SOURCE } from "../../src/authoring/baseTemplate.ts";
import { migrateScriptSize } from "../../src/authoring/scriptSizeMigration.ts";
import { createContainer } from "../../src/container/container.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import type { Engine } from "../../src/runtime/engine.ts";
import { decodeSave } from "../../src/runtime/persistence.ts";
import { createWorkerContext } from "../src/worker/context.ts";
import { openHistoryDrive } from "../src/worker/historyDrive.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { createMainProjectAdmission } from "../src/engine/mainProjectAdmission.ts";
import * as storage from "../src/project/gameStorage.ts";
import type {
  BootMessage,
  WorkerControl,
  WorkerInbound,
  WorkerQueryFn,
} from "../src/worker/workerProtocol.ts";

installWebLocksFixture();
installIndexedDbFixture();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});

const PRE_125_LOGIC0 = BASE_TEMPLATE_LOGIC0_SOURCE.replace("  script.size(200);\n", "");
// Room 1 draws on entry; with f220 set it bakes a dozen view details:
// 12 add.to.pic calls record 48 pairs on top of the picture and view loads,
// past the authentic 50-pair buffer.
const BUSY_ROOM = `if (isset(f5)) { load.pic(1); draw.pic(1); discard.pic(1); show.pic(); }
if (isset(f220)) { reset(f220); load.pic(1); draw.pic(1);
  load.view(1); ${"add.to.pic(1, 0, 0, 0, 0, 9, 0);".repeat(12)} discard.pic(1); show.pic(); }
return;`;
const documents = (logic0: string) => ({
  "logic:0": logic0,
  "logic:1": BUSY_ROOM,
  "picture:1": "vis 1\nfill 1,1\nend\n",
  "view:1": JSON.stringify({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
});
const compile = (logic0: string) =>
  compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: documents(logic0),
    profileId: "2.936",
  });
const capacity = (engine: Engine) => decodeSave(engine.serialize(), engine.profile).replayCapacity;

function bootWorker(
  files: Record<string, Uint8Array>,
  extra: Partial<BootMessage> = {},
  create = true,
) {
  const messages: WorkerControl[] = [];
  let now = 0;
  const ctx = createWorkerContext({
    control: (m) => messages.push(m),
    presentation: () => {},
    now: () => now,
    seedWord: () => 1,
  });
  ctx.host = createEngineHost(ctx);
  onWorkerMessage(ctx, {
    type: "boot",
    files,
    words: [],
    profile: "2.936",
    ...(create ? { projectMode: "create" as const } : {}),
    progressMode: "play",
    ...extra,
  });
  ctx.fns.stopTimers();
  const tick = () => {
    now += 100;
    ctx.fns.hostTick();
  };
  return { ctx, messages, tick };
}
function segmentOf(messages: WorkerControl[]): HistorySegment {
  const batches = messages.flatMap((m) => (m.type === "historyBatch" ? [m.batch] : []));
  return {
    id: batches[0]!.segment,
    boot: validateHistoryBoot(JSON.parse(JSON.stringify(batches[0]!.boot!))),
    anchors: batches.flatMap((b) => (b.anchor === undefined ? [] : [b.anchor])),
    events: batches.flatMap((b) => b.events),
    marks: batches.flatMap((b) => b.marks),
    sync: batches.flatMap((b) => b.sync),
    clock: batches.flatMap((b) => b.clock ?? []),
  };
}

async function openOlderGame(name: string, adoptDeclaredScriptSize: boolean, keepSession = false) {
  const compiled = compile(PRE_125_LOGIC0);
  const id = requireProjectId(name);
  const first = await storage.commitProject({
    projectId: id,
    commitId: "initial",
    workspaceId: "initial",
    buildId: compiled.build.identity.buildId,
    expected: null,
    documents: [],
    data: {
      title: "Older game",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents(PRE_125_LOGIC0)),
    },
  });
  const worker = bootWorker(Object.fromEntries(compiled.files()), {
    ...(adoptDeclaredScriptSize ? { adoptDeclaredScriptSize: true, legacyRoomMemory: true } : {}),
  });
  await worker.ctx.projectLoader.loading;
  const engine = worker.ctx.run.engine!;
  worker.tick();
  worker.tick();
  assert.equal(engine.vars[0], 1, "the game reached its first room");
  assert.equal(
    capacity(engine),
    adoptDeclaredScriptSize ? 200 : 50,
    adoptDeclaredScriptSize
      ? "the authored boot floor already gives the template boot shape 200 pairs"
      : "the older game booted on the authentic 50-pair buffer",
  );
  const ack = worker.messages.find((m) => m.type === "booted");
  assert.ok(ack?.type === "booted" && ack.projectAdmission);
  let queryId = 0;
  const query = (async (type, extra) => {
    onWorkerMessage(worker.ctx, { type, id: ++queryId, ...extra } as WorkerInbound);
    const reply = worker.messages.at(-1);
    for (const message of worker.messages)
      if (message.type === "historyBatch")
        onWorkerMessage(worker.ctx, {
          type: "historyAck",
          epoch: message.epoch,
          batch: message.batch.batch,
        });
    return reply;
  }) as WorkerQueryFn;
  const session = openProjectSession({
    data: (await storage.loadAuthoredGame(id))!,
    lifetime: first.receipt.saved.lifetime,
    admission: createMainProjectAdmission({
      ...ack.projectAdmission,
      query,
      current: () => worker.ctx.run.engine === engine,
    }),
  });
  for (let i = 0; i < 50 && session.saveStatus().state !== "saved"; i++) {
    await session.flush().catch(() => {});
    worker.tick();
  }
  if (!keepSession) session.dispose();
  assert.equal(worker.ctx.run.engine, engine, "the migration kept the running game");
  assert.match(
    String(session.model.capture().read("logic:0")!.content),
    /script\.size\(200\);/,
    "the session holds the migrated LOGIC 0",
  );
  return { ...worker, engine, id, session };
}

test("the running game takes the migration at once and plays the busy room; history replays it", async () => {
  const { ctx, engine, messages, tick } = await openOlderGame("script-size-worker", true);
  assert.equal(capacity(engine), 200, "the running game uses the larger buffer at once");
  engine.flags[220] = 1;
  tick();
  assert.equal(engine.flags[220], 0, "the busy room ran");
  assert.deepEqual(
    messages.filter((m) => m.type === "error"),
    [],
    "without a restart or an error",
  );
  ctx.fns.historyFlush();
  const segment = segmentOf(messages);
  assert.equal(segment.boot.adoptDeclaredScriptSize, true, "the segment records the host option");
  const replayed = replayHistorySegment(segment);
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null);
  assert.equal(capacity(replayed.ctx.run.engine!), 200, "history replays the adoption");
  ctx.fns.stopTimers();
});

test("a Play-mode boot of an unmigrated authored game already runs the busy room", () => {
  // A 1.2.4 game only ever opened in Play never meets the session migration;
  // the boot floor is what lets its busy rooms run there.
  const worker = bootWorker(
    Object.fromEntries(compile(PRE_125_LOGIC0).files()),
    { adoptDeclaredScriptSize: true, legacyRoomMemory: true },
    false,
  );
  worker.tick();
  worker.tick();
  const engine = worker.ctx.run.engine!;
  assert.equal(engine.vars[0], 1, "the game reached its first room");
  assert.equal(capacity(engine), 200, "Play boots the template boot shape at 200 pairs");
  engine.flags[220] = 1;
  worker.tick();
  assert.equal(engine.flags[220], 0, "the busy room ran");
  assert.deepEqual(
    worker.messages.filter((m) => m.type === "error"),
    [],
    "without a migration, a restart or an error",
  );
  worker.ctx.fns.stopTimers();
});

test("a Play-mode boot without the option keeps the authentic 50-pair buffer", () => {
  // Original releases, installed folders and fixtures never get the option:
  // their busy rooms fault the way the original interpreter's did.
  const worker = bootWorker(Object.fromEntries(compile(PRE_125_LOGIC0).files()), {}, false);
  worker.tick();
  worker.tick();
  const engine = worker.ctx.run.engine!;
  assert.equal(capacity(engine), 50, "a non-authored boot stays at 50");
  engine.flags[220] = 1;
  assert.throws(
    () => worker.tick(),
    /exceeded its 50-pair capacity/,
    "the busy room faults on the authentic buffer",
  );
  worker.ctx.fns.stopTimers();
});

test("a history view before the migration commit runs the busy room at 200", async () => {
  const { ctx, messages } = await openOlderGame("script-size-history-view", true);
  ctx.fns.historyFlush();
  const segment = segmentOf(messages);
  const migration = segment.events.find(
    (e) =>
      e.cause.kind === "projectImage" &&
      e.cause.documents.documents.some(
        (d) =>
          d.key === "logic:0" &&
          d.content.type === "text" &&
          d.content.text.includes("script.size"),
      ),
  );
  assert.ok(migration !== undefined, "the migration commit is on the tape");
  // The view replays the same segment to the commit's tick: the folded files
  // still hold the unmigrated LOGIC 0, and the recorded boot option gives it
  // the buffer the migration was about to add.
  const drive = openHistoryDrive(segment, createWorkerContext, { toSeq: migration.seq });
  while (!drive.halted && drive.tick < migration.tick) drive.step();
  assert.equal(drive.error, null);
  assert.equal(drive.diverged, null);
  const viewed = drive.ctx.run.engine!;
  assert.equal(
    capacity(viewed),
    200,
    "the pre-migration view runs the unmigrated LOGIC 0 at the authored buffer",
  );
  viewed.flags[220] = 1;
  viewed.tick();
  assert.equal(viewed.flags[220], 0, "the busy room runs in the pre-migration view");
  ctx.fns.stopTimers();
});

test("a checkpoint taken before the migration resumes on the migrated game with the larger buffer", async () => {
  // Play boots: a resume needs no Create admission. A checkpoint stored by a
  // run without the option (a released build, a Play session that never
  // opened Create) carries the authentic 50 pairs with f200 already set.
  const before = bootWorker(Object.fromEntries(compile(PRE_125_LOGIC0).files()), {}, false);
  before.tick();
  before.tick();
  const image = before.ctx.run.engine!.autosaveImage();
  assert.ok(image);
  assert.equal(before.ctx.run.engine!.flags[200], 1, "logic 0's boot block already ran");
  assert.equal(capacity(before.ctx.run.engine!), 50, "the stored checkpoint carries 50 pairs");
  before.ctx.fns.stopTimers();
  const migrated = migrateScriptSize({ "logic:0": PRE_125_LOGIC0 })!["logic:0"] as string;
  for (const adoptDeclaredScriptSize of [true, false]) {
    const resumed = bootWorker(
      Object.fromEntries(compile(migrated).files()),
      {
        ...(adoptDeclaredScriptSize
          ? { adoptDeclaredScriptSize: true, legacyRoomMemory: true }
          : {}),
        restoreImage: Buffer.from(image).toString("base64"),
      },
      false,
    );
    assert.equal(
      capacity(resumed.ctx.run.engine!),
      adoptDeclaredScriptSize ? 200 : 50,
      adoptDeclaredScriptSize
        ? "an authored game resumes at the buffer its LOGIC 0 declares"
        : "without the option the saved buffer stands",
    );
    resumed.ctx.fns.stopTimers();
  }
  // The same checkpoint on a still-unmigrated LOGIC 0 gets the floor too.
  const unmigrated = bootWorker(
    Object.fromEntries(compile(PRE_125_LOGIC0).files()),
    {
      adoptDeclaredScriptSize: true,
      legacyRoomMemory: true,
      restoreImage: Buffer.from(image).toString("base64"),
    },
    false,
  );
  assert.equal(
    capacity(unmigrated.ctx.run.engine!),
    50,
    "a saved capacity retains native meaning without a declaration",
  );
  unmigrated.ctx.fns.stopTimers();
});

test("a released (format-2) cold-boot segment of a busy authored room replays at 200 pairs", () => {
  // A recording from before the option existed never carries
  // adoptDeclaredScriptSize, and the released build ran every game at the
  // old 200-pair default. A cold-boot segment whose boot carries project
  // documents is an authored project: replay adopts that floor, so the
  // recorded busy room runs again instead of faulting at 50.
  const busy = `if (isset(f5)) { load.pic(1); draw.pic(1);
    load.view(1); ${"add.to.pic(1, 0, 0, 0, 0, 9, 0);".repeat(12)} discard.pic(1); show.pic(); }
  return;`;
  const docs = {
    "logic:0": customizedLegacyBoot,
    "logic:1": busy,
    "picture:1": "vis 1\nfill 1,1\nend\n",
    "view:1": JSON.stringify({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: docs,
    profileId: "2.936",
  });
  const files = new Map(compiled.files());
  const workspace = writeProjectWorkspace(docs);
  const boot = validateHistoryBoot(
    JSON.parse(
      JSON.stringify(
        stampBoot({
          files: Object.fromEntries(
            [...files].map(([name, bytes]) => [name, bytesToBase64(bytes)]),
          ),
          project: {
            documents: workspace,
            documentId: projectDocumentId(readProjectWorkspace(workspace), sha256Hex),
          },
          dictionary: [],
          authorRooms: true,
          profile: "2.936",
          rng: 0,
          soundDevice: 1,
          resourceSet: resourceSetHint({ getFiles: () => files }),
          requestSerial: 0,
        }),
      ),
    ),
  );
  assert.equal(boot.adoptDeclaredScriptSize, undefined, "a released tape has no such field");
  const segment: HistorySegment = {
    id: "v2-cold-boot",
    version: 2,
    boot,
    anchors: [],
    events: [],
    marks: [],
    sync: [],
    end: { seq: 0, tick: 30, cycle: 6, reason: "quit" },
  };
  const replayed = replayHistorySegment(segment);
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null);
  const engine = replayed.ctx.run.engine!;
  assert.equal(engine.vars[0], 1, "the recorded busy room ran");
  assert.equal(capacity(engine), 200, "the released recording replays at the 200 pairs it ran");
  replayed.ctx.fns.stopTimers();
});

test("a format-2 segment without project documents keeps the recorded 50 pairs", () => {
  // A folder or fixture tape carries no project documents: nothing marks it
  // authored, so its busy room faults on the authentic buffer as released.
  const busy = `if (isset(f5)) { load.pic(1); draw.pic(1);
    load.view(1); ${"add.to.pic(1, 0, 0, 0, 0, 9, 0);".repeat(12)} discard.pic(1); show.pic(); }
  return;`;
  const docs = {
    "logic:0": PRE_125_LOGIC0,
    "logic:1": busy,
    "picture:1": "vis 1\nfill 1,1\nend\n",
    "view:1": JSON.stringify({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: docs,
    profileId: "2.936",
  });
  const files = new Map(compiled.files());
  const boot = validateHistoryBoot(
    JSON.parse(
      JSON.stringify(
        stampBoot({
          files: Object.fromEntries(
            [...files].map(([name, bytes]) => [name, bytesToBase64(bytes)]),
          ),
          dictionary: [],
          authorRooms: false,
          profile: "2.936",
          rng: 0,
          soundDevice: 1,
          resourceSet: resourceSetHint({ getFiles: () => files }),
          requestSerial: 0,
        }),
      ),
    ),
  );
  const segment: HistorySegment = {
    id: "v2-cold-boot",
    version: 2,
    boot,
    anchors: [],
    events: [],
    marks: [],
    sync: [],
    end: { seq: 0, tick: 30, cycle: 6, reason: "quit" },
  };
  const replayed = replayHistorySegment(segment);
  assert.match(replayed.error ?? "", /exceeded its 50-pair capacity/);
  replayed.ctx.fns.stopTimers();
});

test("without the authored-project option the running game keeps the buffer its code set", async () => {
  const { ctx, engine, messages } = await openOlderGame("script-size-worker-original", false);
  assert.equal(capacity(engine), 50);
  ctx.fns.historyFlush();
  assert.equal(segmentOf(messages).boot.adoptDeclaredScriptSize, undefined);
  ctx.fns.stopTimers();
});

test("legacy f199 worker runs, resumes, restores and records a busy boot independently of later room sizing", () => {
  const custom = customizedLegacyBoot + "\nif (isset(f221)) { set(f16); restart.game(); }";
  const docs = {
    ...documents(custom),
    "logic:1": BUSY_ROOM.replace("if (isset(f220))", "if (isset(f5))"),
    "logic:5": "script.size(120); return;",
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: docs,
    profileId: "2.936",
  });
  const files = Object.fromEntries(compiled.files());
  const worker = bootWorker(
    files,
    { legacyRoomMemory: true, adoptDeclaredScriptSize: true },
    false,
  );
  try {
    for (let n = 0; n < 4; n++) worker.tick();
    const engine = worker.ctx.run.engine!;
    assert.equal(capacity(engine), 200);
    assert.ok(decodeSave(engine.serialize(), engine.profile).replayActive > 50);
    const image = engine.autosaveImage();
    assert.ok(image);
    const resumed = bootWorker(
      files,
      { legacyRoomMemory: true, adoptDeclaredScriptSize: true, restoreImage: bytesToBase64(image) },
      false,
    );
    try {
      assert.equal(capacity(resumed.ctx.run.engine!), 200);
      assert.equal(resumed.ctx.run.engine!.surface.visual[100], 1);
      resumed.tick();
    } finally {
      resumed.ctx.fns.stopTimers();
    }
    worker.ctx.fns.historyFlush();
    const segment = segmentOf(worker.messages);
    assert.equal(segment.boot.legacyRoomMemory, true);
    const replayed = replayHistorySegment(segment);
    try {
      assert.equal(replayed.error, null);
      assert.equal(replayed.diverged, null);
      assert.equal(capacity(replayed.ctx.run.engine!), 200);
    } finally {
      replayed.ctx.fns.stopTimers();
    }
    engine.flags[221] = 1;
    for (let n = 0; n < 4; n++) worker.tick();
    assert.equal(capacity(engine), 200);
    assert.equal(engine.vars[0], 1);
  } finally {
    worker.ctx.fns.stopTimers();
  }
});

test("Undo Updated for 1.2.5 keeps 200 through the earlier code room entry", async () => {
  const { ctx, engine, tick, session, id } = await openOlderGame(
    "script-size-worker-undo",
    true,
    true,
  );
  try {
    engine.flags[220] = 1;
    tick();
    const before = decodeSave(engine.serialize(), engine.profile);
    assert.ok(before.replayActive > 50);
    await session.undo();
    await session.flush();
    assert.equal(ctx.run.engine, engine);
    const after = decodeSave(engine.serialize(), engine.profile);
    assert.equal(after.replayCapacity, 200);
    // Shared LOGIC changes enter the room again through ordinary admission.
    // Its native room transition may reset replay; the allocation must stay.
    assert.deepEqual((await storage.loadAuthoredGame(id))!.authoringConventions, {
      version: 1,
      legacyRoomMemory: true,
    });
    for (let n = 0; n < 4; n++) tick();
    assert.equal(capacity(engine), 200);
    const entered = decodeSave(engine.serialize(), engine.profile);
    assert.deepEqual(entered.replay.slice(0, entered.replayActive), [
      { kind: 2, value: 1 },
      { kind: 4, value: 1 },
      { kind: 6, value: 1 },
    ]);
    assert.equal(engine.surface.visual[100], 1);
  } finally {
    session.dispose();
    ctx.fns.stopTimers();
  }
});
