import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWorkerContext,
  type WorkerContext,
  type WorkerPorts,
} from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { createDebugController } from "../src/worker/debugController.ts";
import { createPreviewAdmission } from "../src/worker/previewAdmission.ts";
import { installDebugController } from "../src/worker/debugLoader.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type {
  FrozenTestBoot,
  PreviewLaneIdentity,
  PreviewUpdateCandidateMessage,
  SourceBindingKind,
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import type { GameContainer } from "../../src/types.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { captureProjectBuild } from "../../src/authoring/projectBuild.ts";
import { computeResourceRevision } from "../../src/authoring/resourceRevision.ts";
import { buildObjectFile } from "../../src/authoring/inventory.ts";
import { buildLogicResource } from "../../src/logic/resource.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { buildView } from "../../src/view/view.ts";
import { PROFILES, type AgiProfile } from "../../src/runtime/profile.ts";

/**
 * The play-preview lane's worker admission: a `lane: "play-preview"` frozen
 * boot grants same-Engine update authority, `previewUpdate` settles in one
 * correlated `previewUpdateResult`, and every refusal leaves image, sources
 * and identity byte-identical. Driven on real dispatch with fake ports and a
 * real Engine — the same path engine.worker.ts executes.
 */

const PROFILE = "2.411";
const profile: AgiProfile = PROFILES[PROFILE]!;

interface Harness {
  ctx: WorkerContext;
  control: WorkerControl[];
  presentation: WorkerPresentation[];
  send: (msg: WorkerInbound) => void;
  tick: (n?: number) => void;
}

function harness(): Harness {
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  let now = 0;
  const ports: WorkerPorts = {
    control: (msg) => control.push(msg),
    presentation: (msg) => presentation.push(msg),
    now: () => now,
    seedWord: () => 0x1234,
  };
  const ctx = createWorkerContext(ports);
  // The production path lazy-loads controller+admission together; the
  // fake-port harness installs both up front so assertions stay synchronous.
  installDebugController(ctx, {
    ...createDebugController(ctx),
    ...createPreviewAdmission(ctx),
  });
  ctx.host = createEngineHost(ctx);
  const send = (msg: WorkerInbound): void => {
    onWorkerMessage(ctx, msg);
    ctx.fns.stopTimers();
  };
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  return { ctx, control, presentation, send, tick };
}

function controls(h: Harness, type: string): Record<string, unknown>[] {
  return h.control.filter((m) => m.type === type) as Record<string, unknown>[];
}

function lastControl(h: Harness, type: string): Record<string, unknown> {
  const found = controls(h, type);
  assert.ok(found.length > 0, `expected a ${type} control message`);
  return found.at(-1)!;
}

function lastControlAfter(h: Harness, type: string, run: () => void): Record<string, unknown> {
  const before = controls(h, type).length;
  run();
  const found = controls(h, type);
  assert.ok(found.length > before, `expected a ${type} control message`);
  return found.at(-1)!;
}

type SourceBindings = Record<string, { kind: SourceBindingKind; num: number }>;

interface TestGame {
  files: Record<string, Uint8Array>;
  sources: Record<string, string>;
  bindings: SourceBindings;
  words: [string, number][];
}

/** Compile real LOGIC payloads under the authored binding map, then containerize. */
function testGame(
  logics: { num: number; source: string }[],
  options: {
    bindings?: SourceBindings;
    words?: { word: string; id: number }[];
    objects?: { name: string; startingRoom?: number }[];
    edit?: (c: GameContainer) => void;
  } = {},
): TestGame {
  const bindings = options.bindings ?? {};
  const words = options.words ?? [];
  const dictionary = new Map<string, number>(words.map((w) => [w.word, w.id]));
  const projected = Object.fromEntries(
    Object.entries(bindings).map(([name, b]) => [name, { num: b.num }]),
  );
  const container = createContainer();
  if (words.length > 0)
    container.putFile(
      "WORDS.TOK",
      buildWordsTok([...words].sort((a, b) => (a.word < b.word ? -1 : 1))),
    );
  if (options.objects !== undefined)
    container.putFile("OBJECT", buildObjectFile(options.objects, profile));
  const sources: Record<string, string> = {};
  for (const { num, source } of logics) {
    sources[String(num)] = source;
    container.putResource(
      "logic",
      num,
      compileProjectLogic(source, { profile, dictionary, bindings: projected }).assembly.payload,
    );
  }
  options.edit?.(container);
  return {
    files: Object.fromEntries(container.files),
    sources,
    bindings,
    words: words.map((w) => [w.word, w.id]),
  };
}

/** The expression-only subview frozen admission requires of sourceBindings. */
function expressionBindings(
  bindings: SourceBindings,
): Record<string, { kind: "variable" | "flag" | "string"; num: number }> {
  const out: Record<string, { kind: "variable" | "flag" | "string"; num: number }> = {};
  for (const [name, binding] of Object.entries(bindings)) {
    if (binding.kind === "variable" || binding.kind === "flag" || binding.kind === "string")
      out[name] = { kind: binding.kind, num: binding.num };
  }
  return out;
}

/** A well-formed candidate carrying the verified identity, not a bare claim. */
function candidateFor(
  game: TestGame,
  overrides: Partial<PreviewUpdateCandidateMessage> = {},
): PreviewUpdateCandidateMessage {
  const capture = captureProjectBuild({
    files: game.files,
    profileId: PROFILE,
    sources: game.sources,
    bindings: Object.fromEntries(
      Object.entries(game.bindings).map(([name, b]) => [name, { num: b.num }]),
    ),
  });
  return {
    files: game.files,
    profile: PROFILE,
    sources: game.sources,
    sourceBindings: game.bindings,
    buildId: capture.identity.buildId,
    revision: capture.identity.revision,
    origins: [],
    ...overrides,
  };
}

type LaneGrant = PreviewLaneIdentity & { runToken: string };

/** Boot the play-preview lane and return the lane's published identity. */
function bootPreview(
  h: Harness,
  game: TestGame,
  frozenExtra: Partial<FrozenTestBoot> = {},
): LaneGrant {
  h.send({
    type: "boot",
    files: game.files,
    words: game.words,
    profile: PROFILE,
    frozenTest: {
      id: 100,
      lane: "play-preview",
      sources: game.sources,
      sourceBindings: game.bindings,
      bindings: expressionBindings(game.bindings),
      stopOnEntry: false,
      ...frozenExtra,
    },
  });
  const attached = lastControl(h, "debugAttached");
  const preview = attached["preview"] as LaneGrant | undefined;
  assert.ok(preview !== undefined, "a play-preview boot publishes the lane identity");
  return preview;
}

function sendUpdate(
  h: Harness,
  lane: LaneGrant,
  id: number,
  candidate: PreviewUpdateCandidateMessage,
  expected: PreviewLaneIdentity | null = null,
): Record<string, unknown> {
  const before = controls(h, "previewUpdateResult").length;
  h.send({
    type: "previewUpdate",
    id,
    runToken: lane.runToken,
    expected: expected ?? {
      epoch: lane.epoch,
      buildId: lane.buildId,
      revision: lane.revision,
      updateSerial: lane.updateSerial,
    },
    candidate,
  });
  const results = controls(h, "previewUpdateResult");
  assert.equal(results.length, before + 1, "one request settles in exactly one result");
  return results.at(-1)!;
}

function currentRevision(h: Harness): string {
  const files: Record<string, Uint8Array> = {};
  for (const [name, bytes] of h.ctx.engine!.containerFiles) files[name] = bytes;
  if (h.ctx.boot.authoredWords) files["WORDS.TOK"] = h.ctx.boot.authoredWords;
  return computeResourceRevision(files);
}

/** No patch/reset/boot traffic may ever substitute for the update result. */
function assertNoSubstituteTraffic(h: Harness, since = 0): void {
  for (const msg of h.control.slice(since)) {
    assert.ok(
      !["booted", "patched", "metadataPatched", "debugSessionReset"].includes(msg.type),
      `update must not publish ${msg.type}`,
    );
  }
}

const LOGIC_0 = "assignn(v40, 1);\nreturn;";
const LOGIC_0_V2 = "assignn(v40, 1);\nassignn(v41, 7);\nreturn;";
const LOGIC_0_CALL = "assignn(v40, 1);\ncall(1);\nreturn;";
const LOGIC_0_CALL_V2 = "assignn(v40, 1);\nassignn(v41, 7);\ncall(1);\nreturn;";
const LOGIC_1 = "addn(v200, 1);\nreturn;";
const LOGIC_1_V2 = "addn(v200, 2);\nreturn;";

/** A candidate whose contents were never honestly captured: claimed ids are assertions, not facts. */
function forgedCandidate(
  game: TestGame,
  overrides: Partial<PreviewUpdateCandidateMessage> = {},
): PreviewUpdateCandidateMessage {
  return {
    files: game.files,
    profile: PROFILE,
    sources: game.sources,
    sourceBindings: game.bindings,
    buildId: "f".repeat(64),
    revision: "0".repeat(64),
    origins: [],
    ...overrides,
  };
}

test("a committed update swaps the native image in place and keeps the run", () => {
  const h = harness();
  const game = testGame([
    { num: 0, source: LOGIC_0_CALL },
    { num: 1, source: LOGIC_1 },
  ]);
  const lane = bootPreview(h, game);
  const engine = h.ctx.engine!;
  h.tick(2);
  assert.equal(engine.vars[40], 1);
  const cycleCount = h.ctx.cycle.cycleCount;
  const patchGen = engine.patchGeneration;
  const volBefore = engine.containerFiles.get("VOL.0")!.slice();
  const trafficAt = h.control.length;

  const next = testGame([
    { num: 0, source: LOGIC_0_CALL_V2 },
    { num: 1, source: LOGIC_1_V2 },
  ]);
  const result = sendUpdate(h, lane, 1, candidateFor(next));
  assert.equal(result["status"], "committed");
  assert.equal(result["id"], 1);
  assert.equal(result["runToken"], lane.runToken);
  const current = result["current"] as PreviewLaneIdentity;
  assert.equal(current.updateSerial, 1);
  assert.equal(current.revision, computeResourceRevision(next.files));
  assert.notEqual(current.buildId, lane.buildId);
  assert.equal(current.epoch > lane.epoch, true, "the source epoch moved");

  // Same worker, same Engine, preserved progress — the next cycle runs the
  // NEW code on the OLD state.
  assert.equal(h.ctx.engine, engine);
  assert.equal(engine.vars[40], 1, "vars written before the update survive");
  assert.equal(engine.patchGeneration, patchGen + 1, "native image bumped once");
  assert.equal(h.ctx.cycle.cycleCount, cycleCount, "the update itself runs no cycle");
  assert.notDeepEqual(engine.containerFiles.get("VOL.0"), volBefore);
  assertNoSubstituteTraffic(h, trafficAt);

  const v200 = engine.vars[200]!;
  h.tick(2);
  assert.equal(engine.vars[41], 7, "the committed LOGIC 0 runs on the live run");
  assert.equal(engine.vars[200], v200 + 4, "the committed LOGIC 1 is what call executes");

  // A completion-time export sees exactly the candidate image.
  const exported = lastControlAfter(h, "exportFiles", () =>
    h.send({ type: "exportFiles", id: 900 }),
  );
  const files = exported["files"] as Record<string, Uint8Array>;
  assert.deepEqual(files["VOL.0"], next.files["VOL.0"]);
});

test("a byte-identical candidate reports unchanged and moves nothing", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: LOGIC_0 }]);
  const lane = bootPreview(h, game);
  const engine = h.ctx.engine!;
  h.tick(1);
  const patchGen = engine.patchGeneration;

  const result = sendUpdate(h, lane, 1, candidateFor(game));
  assert.equal(result["status"], "unchanged");
  const current = result["current"] as PreviewLaneIdentity;
  assert.equal(current.updateSerial, 0, "no serial bump without an install");
  assert.equal(current.epoch, lane.epoch);
  assert.equal(current.buildId, lane.buildId);
  assert.equal(engine.patchGeneration, patchGen);
});

test("a source-only change installs the new build with the native image untouched", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: LOGIC_0 }]);
  const lane = bootPreview(h, game);
  const engine = h.ctx.engine!;
  h.tick(1);
  const patchGen = engine.patchGeneration;

  // A comment edits the authored text — identical bytes, new build identity.
  const edited = testGame([{ num: 0, source: "// retouched\n" + LOGIC_0 }]);
  const result = sendUpdate(h, lane, 1, candidateFor(edited));
  assert.equal(result["status"], "committed");
  const current = result["current"] as PreviewLaneIdentity;
  assert.equal(current.revision, lane.revision, "source-only keeps the native revision");
  assert.notEqual(current.buildId, lane.buildId, "the build identity tracks the sources");
  assert.equal(current.updateSerial, 1);
  assert.equal(engine.patchGeneration, patchGen, "no native-generation bump");
  h.tick(1);
  assert.equal(engine.vars[40], 1, "the run continues uninterrupted");
});

test("malformed, forged and drifting candidates refuse without mutation", () => {
  const h = harness();
  const game = testGame([
    { num: 0, source: LOGIC_0 },
    { num: 1, source: LOGIC_1 },
  ]);
  const lane = bootPreview(h, game);
  const engine = h.ctx.engine!;
  h.tick(1);
  const volBefore = engine.containerFiles.get("VOL.0")!.slice();
  const patchGen = engine.patchGeneration;

  // Claimed identities the bytes do not earn.
  let r = sendUpdate(h, lane, 1, candidateFor(game, { buildId: "forged" }));
  assert.equal(r["status"], "refused");
  r = sendUpdate(h, lane, 2, candidateFor(game, { revision: "r".repeat(64) }));
  assert.equal(r["status"], "refused");

  // Malformed wire shapes.
  r = sendUpdate(h, lane, 3, {
    ...candidateFor(game),
    files: {},
  });
  assert.equal(r["status"], "refused");
  r = sendUpdate(h, lane, 4, {
    ...candidateFor(game),
    files: { "VOL.0": "text" as unknown as Uint8Array },
  });
  assert.equal(r["status"], "refused");

  // A declared profile the run does not have.
  r = sendUpdate(h, lane, 5, candidateFor(game, { profile: "3.002.086" }));
  assert.equal(r["status"], "refused");

  // An incomplete image: the staged container synthesizes a missing
  // directory — the candidate is refused, never completed for it.
  const incomplete = testGame(
    [
      { num: 0, source: LOGIC_0 },
      { num: 1, source: LOGIC_1 },
    ],
    { edit: (c) => void (c.files as Map<string, Uint8Array>).delete("SNDDIR") },
  );
  r = sendUpdate(h, lane, 6, candidateFor(incomplete));
  assert.equal(r["status"], "refused");

  // A garbage VIEW the staged parse cannot read.
  const badView = testGame(
    [
      { num: 0, source: LOGIC_0 },
      { num: 1, source: LOGIC_1 },
    ],
    { edit: (c) => c.putResource("view", 3, new Uint8Array([0xff, 0xff])) },
  );
  r = sendUpdate(h, lane, 7, candidateFor(badView));
  assert.equal(r["status"], "refused");

  // A malformed WORDS.TOK fails the detached capture — the claim fields
  // still look honest but the bytes never verify.
  r = sendUpdate(
    h,
    lane,
    8,
    forgedCandidate(game, {
      files: { ...game.files, "WORDS.TOK": new Uint8Array([1, 2, 3]) },
    }),
  );
  assert.equal(r["status"], "refused");

  // Nothing moved: bytes, vars, generation and identity are exactly as before.
  assert.deepEqual(engine.containerFiles.get("VOL.0"), volBefore);
  assert.equal(engine.patchGeneration, patchGen);
  assert.equal(engine.vars[40], 1);
  assert.equal(currentRevision(h), lane.revision);
  h.tick(1);
  assert.equal(engine.vars[40], 1, "the refused run still advances normally");
});

test("removing a resource or changing layout requires a restart, not a partial swap", () => {
  const h = harness();
  const game = testGame([
    { num: 0, source: LOGIC_0 },
    { num: 1, source: LOGIC_1 },
  ]);
  const lane = bootPreview(h, game);
  const engine = h.ctx.engine!;
  const volBefore = engine.containerFiles.get("VOL.0")!.slice();

  // LOGIC 1 dropped out of both files and sources.
  const removed = testGame([{ num: 0, source: LOGIC_0 }]);
  let r = sendUpdate(h, lane, 1, candidateFor(removed));
  assert.equal(r["status"], "restartRequired");

  // A whole v3-combined image is a layout the installed v2-split container
  // can never become in place. Hand-authored like test/container-v3.test.ts:
  // ZZDIR sections are positional three-byte entries, ZZVOL.0 holds the
  // seven-byte-prefixed record.
  const dictionary = new Map<string, number>();
  const logic0 = compileProjectLogic(LOGIC_0, { profile, dictionary, bindings: {} }).assembly
    .payload;
  const foreignContainer = openContainer(
    new Map([
      [
        "ZZDIR",
        Uint8Array.from([
          8, 0, 11, 0, 14, 0, 17, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255,
        ]),
      ],
      [
        "ZZVOL.0",
        Uint8Array.from([
          0x12,
          0x34,
          0,
          logic0.length & 255,
          logic0.length >> 8,
          logic0.length & 255,
          logic0.length >> 8,
          ...logic0,
        ]),
      ],
    ]),
  );
  foreignContainer.putResource("logic", 0, logic0);
  const foreign: TestGame = {
    files: Object.fromEntries(foreignContainer.files),
    sources: { "0": LOGIC_0 },
    bindings: {},
    words: [],
  };
  r = sendUpdate(h, lane, 2, candidateFor(foreign));
  assert.equal(r["status"], "restartRequired");

  assert.deepEqual(engine.containerFiles.get("VOL.0"), volBefore);
  assert.equal(currentRevision(h), lane.revision);
});

test("stale identity and foreign run tokens refuse before any work", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: LOGIC_0 }]);
  const lane = bootPreview(h, game);
  const volBefore = h.ctx.engine!.containerFiles.get("VOL.0")!.slice();

  // A forged run token.
  let r = sendUpdate(h, { ...lane, runToken: "deadbeef".repeat(4) }, 1, candidateFor(game));
  assert.equal(r["status"], "refused");

  // A stale epoch: the lane identity moved past the claim.
  r = sendUpdate(h, lane, 2, candidateFor(game), { ...lane, epoch: lane.epoch + 9 });
  assert.equal(r["status"], "refused");

  // A stale update serial.
  r = sendUpdate(h, lane, 3, candidateFor(game), { ...lane, updateSerial: 4 });
  assert.equal(r["status"], "refused");

  assert.deepEqual(h.ctx.engine!.containerFiles.get("VOL.0"), volBefore);
});

test("retransmission replays the settled result; id reuse under new content refuses", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: LOGIC_0 }]);
  const lane = bootPreview(h, game);
  const engine = h.ctx.engine!;
  const next = testGame([{ num: 0, source: LOGIC_0_V2 }]);

  const candidate = candidateFor(next);
  const first = sendUpdate(h, lane, 10, candidate);
  assert.equal(first["status"], "committed");
  const serial = (first["current"] as PreviewLaneIdentity).updateSerial;
  const patchGen = engine.patchGeneration;

  // The exact retransmission replays the retained outcome verbatim — no
  // second commit, no serial bump.
  const replayed = sendUpdate(h, lane, 10, candidate);
  assert.deepEqual(replayed["status"], first["status"]);
  assert.deepEqual(replayed["current"], first["current"]);
  assert.equal(engine.patchGeneration, patchGen);
  const after = lastControl(h, "previewUpdateResult")["current"] as PreviewLaneIdentity;
  assert.equal(after.updateSerial, serial);

  // The same id under different content is a refused forgery.
  const forged = sendUpdate(h, lane, 10, candidateFor(game));
  assert.equal(forged["status"], "refused");

  // Status reconciliation: the retained outcome answers a lost-ack query.
  const status = lastControlAfter(h, "previewUpdateStatus", () =>
    h.send({ type: "previewUpdateStatus", id: 77, transactionId: 10 }),
  );
  const tx = status["transaction"] as { id: number; outcome: { status: string } };
  assert.equal(tx.id, 10);
  assert.equal(tx.outcome.status, "committed");
  assert.deepEqual(status["current"], after);
});

test("the bounded ledger reconciles retained, unavailable and unknown ids honestly", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: LOGIC_0 }]);
  const lane = bootPreview(h, game);
  const empty = candidateFor(game, { files: {} });

  // Sparse admission: id 10 settles first; nothing below it ever ran.
  const sparse = sendUpdate(h, lane, 10, empty);
  assert.equal(sparse["status"], "refused");
  const retained = lastControlAfter(h, "previewUpdateStatus", () =>
    h.send({ type: "previewUpdateStatus", id: 70, transactionId: 10 }),
  );
  const tx = retained["transaction"] as { id: number; outcome: { status: string } };
  assert.equal(tx.id, 10);
  assert.equal(tx.outcome.status, "refused");

  // Id 5 is below the admission mark with no retained result. The bounded
  // ledger cannot tell an evicted outcome from an id that never ran, so
  // the honest answer is "unavailable" — it asserts neither execution nor
  // commit, and never licenses a replay of the lower id.
  const skipped = lastControlAfter(h, "previewUpdateStatus", () =>
    h.send({ type: "previewUpdateStatus", id: 71, transactionId: 5 }),
  );
  assert.equal(skipped["transaction"], "unavailable");

  // An id above the mark was never eligible to have run: "unknown".
  const never = lastControlAfter(h, "previewUpdateStatus", () =>
    h.send({ type: "previewUpdateStatus", id: 72, transactionId: 999 }),
  );
  assert.equal(never["transaction"], "unknown");

  // Real eviction reports the same unreconcilable answer as a skipped id.
  for (let id = 11; id <= 74; id++) {
    const r = sendUpdate(h, lane, id, empty);
    assert.equal(r["status"], "refused");
  }
  const evicted = lastControlAfter(h, "previewUpdateStatus", () =>
    h.send({ type: "previewUpdateStatus", id: 90, transactionId: 10 }),
  );
  assert.equal(
    evicted["transaction"],
    "unavailable",
    "an evicted id and a skipped id are indistinguishable under bounded retention",
  );

  // A lower id can never run again — refused, not fresh.
  const below = sendUpdate(h, lane, 10, empty);
  assert.equal(below["status"], "refused");
  assert.match(String(below["reason"]), /admission mark/);
});

test("a busy boundary defers; a resume makes the lane committable again", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: LOGIC_0 }]);
  const lane = bootPreview(h, game, { stopOnEntry: true });
  const engine = h.ctx.engine!;
  // The boot latched the entry stop — a deliberate pause the update must not erase.
  const stopped = lastControl(h, "debugStopped");
  const patchGen = engine.patchGeneration;

  const next = testGame([{ num: 0, source: LOGIC_0_V2 }]);
  const deferred = sendUpdate(h, lane, 1, candidateFor(next));
  assert.equal(deferred["status"], "deferred");
  assert.equal(engine.patchGeneration, patchGen, "a deferred boundary writes nothing");
  assert.equal(engine.executionStopInfo !== null, true, "the deliberate stop still holds");
  assert.equal(engine.containerFiles.get("VOL.0") !== undefined, true);

  // Resume, then retry under a fresh transaction id: the natural boundary commits.
  const epoch = lastControl(h, "debugAttached")["epoch"] as number;
  h.send({
    type: "debugResume",
    id: 2,
    epoch,
    stopId: stopped["stopId"] as number,
    action: "continue",
  });
  const expected = deferred["current"] as PreviewLaneIdentity;
  const committed = sendUpdate(h, lane, 3, candidateFor(next), expected);
  assert.equal(committed["status"], "committed");
  h.tick(2);
  assert.equal(engine.vars[41], 7);
});

test("an armed observer defers updates; disarming returns the lane to committable", () => {
  const h = harness();
  const game = testGame([
    { num: 0, source: LOGIC_0 },
    { num: 1, source: LOGIC_1 },
  ]);
  const lane = bootPreview(h, game);
  const engine = h.ctx.engine!;
  const epoch = lastControl(h, "debugAttached")["epoch"] as number;

  // A breakpoint on a logic that never runs: armed control, quiet pass.
  h.send({
    type: "debugConfigure",
    id: 11,
    epoch,
    revision: 1,
    breakpoints: [{ id: "b1", enabled: true, logic: 1, line: 1, mode: "statement" }],
  });
  assert.equal(lastControl(h, "debugConfigured")["revision"], 1);
  assert.equal(engine.executionControlActive, true, "the spec armed the observer");

  h.tick(2);
  const r = sendUpdate(
    h,
    lane,
    1,
    candidateFor(
      testGame([
        { num: 0, source: LOGIC_0_V2 },
        { num: 1, source: LOGIC_1 },
      ]),
    ),
  );
  assert.equal(r["status"], "deferred", "armed control blocks the strict boundary");

  // Clearing the configuration disarms: the same lane commits at the next idle boundary.
  h.send({ type: "debugConfigure", id: 12, epoch, revision: 2, breakpoints: [] });
  assert.equal(lastControl(h, "debugConfigured")["revision"], 2);
  assert.equal(engine.executionControlActive, false, "an emptied plan disarms");
  const expected = r["current"] as PreviewLaneIdentity;
  const committed = sendUpdate(
    h,
    { ...lane, ...expected },
    2,
    candidateFor(
      testGame([
        { num: 0, source: LOGIC_0_V2 },
        { num: 1, source: LOGIC_1 },
      ]),
    ),
    expected,
  );
  assert.equal(committed["status"], "committed");
});

test("an empty observer never arms the lane — running play stays committable", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: LOGIC_0 }]);
  const lane = bootPreview(h, game);
  const engine = h.ctx.engine!;
  // No breakpoints, no watchpoints, no step: the lane's observer stays off.
  h.tick(3);
  assert.equal(engine.executionControlActive, false);
  const r = sendUpdate(h, lane, 1, candidateFor(testGame([{ num: 0, source: LOGIC_0_V2 }])));
  assert.equal(r["status"], "committed");
});

test("a coordinated LOGIC+WORDS+OBJECT+PIC+source candidate lands as one image", () => {
  const h = harness();
  // The run drew PIC 9 once — the replay evidence the commit's detached
  // backdrop rebuild needs is complete, so a changed PIC is committable.
  const game = testGame(
    [
      {
        num: 0,
        source:
          "if (!isset(f200)) {\n  set(f200);\n  assignn(v50, 9);\n  load.pic(v50);\n  draw.pic(v50);\n}\ncall(1);\nreturn;",
      },
      { num: 1, source: LOGIC_1 },
    ],
    {
      words: [{ word: "look", id: 100 }],
      objects: [{ name: "key", startingRoom: 1 }],
      bindings: { second_room: { kind: "logic", num: 1 } },
      edit: (c) => c.putResource("picture", 9, new Uint8Array([0xff])),
    },
  );
  const lane = bootPreview(h, game);
  const engine = h.ctx.engine!;
  h.tick(1);
  assert.equal(engine.flags[200], 1, "the boot pass drew the picture");
  const patchGen = engine.patchGeneration;
  const volBefore = engine.containerFiles.get("VOL.0")!.slice();

  const view = buildView(
    { loops: [{ cels: [{ width: 1, height: 1, pixels: new Uint8Array([5]) }] }] },
    profile,
  );
  const next = testGame(
    [
      {
        num: 0,
        source:
          "if (!isset(f200)) {\n  set(f200);\n  assignn(v50, 9);\n  load.pic(v50);\n  draw.pic(v50);\n}\ncall(1);\nreturn;",
      },
      { num: 1, source: LOGIC_1_V2 },
    ],
    {
      words: [
        { word: "look", id: 100 },
        { word: "take", id: 200 },
      ],
      objects: [
        { name: "key", startingRoom: 1 },
        { name: "coin", startingRoom: 0 },
      ],
      bindings: { second_room: { kind: "logic", num: 1 } },
      edit: (c) => {
        c.putResource("picture", 9, new Uint8Array([0xf0, 0x0e, 0xff]));
        c.putResource("view", 4, view);
      },
    },
  );
  const result = sendUpdate(h, lane, 1, candidateFor(next));
  assert.equal(result["status"], "committed", String(result["reason"] ?? ""));
  const current = result["current"] as PreviewLaneIdentity;
  assert.equal(current.revision, computeResourceRevision(next.files));
  assert.equal(engine.patchGeneration, patchGen + 1, "one commit, one generation bump");
  assert.notDeepEqual(engine.containerFiles.get("VOL.0"), volBefore);

  // The whole new authority is what external consumers now see: committed
  // container, parser dictionary, OBJECT table, and source record agree.
  assert.equal(h.ctx.boot.liveDictionary.get("take"), 200);
  assert.equal(h.ctx.boot.authoredWords !== null, true);
  const staged = openContainer(engine.containerFiles);
  assert.deepEqual(staged.getResource("picture", 9), new Uint8Array([0xf0, 0x0e, 0xff]));
  assert.notEqual(staged.getResource("view", 4), null);
  assert.deepEqual(h.ctx.debugger.preview!.sources, next.sources);
  assert.equal(engine.flags[200], 1, "gameplay flags are preserved across the swap");
  const v200 = engine.vars[200]!;
  h.tick(1);
  assert.equal(engine.vars[200], v200 + 2, "the committed LOGIC 1 runs on preserved state");
});

test("the lane is physical-run authority: it survives detach and dies with the boot", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: LOGIC_0 }]);
  const lane = bootPreview(h, game);
  const epoch = lastControl(h, "debugAttached")["epoch"] as number;

  // Detach releases the session but not the lane.
  h.send({ type: "debugDetach", id: 20, epoch });
  assert.equal(lastControl(h, "debugAck")["epoch"], epoch);
  const r = sendUpdate(h, lane, 1, candidateFor(testGame([{ num: 0, source: LOGIC_0_V2 }])));
  assert.equal(r["status"], "committed", "a detached session still holds its lane");

  // A fresh boot mints a new lane: the old run token is dead authority.
  const lane2 = bootPreview(h, testGame([{ num: 0, source: LOGIC_0 }]), { id: 101 });
  assert.notEqual(lane2.runToken, lane.runToken);
  const stale = sendUpdate(h, lane, 2, candidateFor(testGame([{ num: 0, source: LOGIC_0_V2 }])));
  assert.equal(stale["status"], "refused");
});

test("neither a debug-lane test nor a plain play boot grants update authority", () => {
  // Frozen Debug Test: identical admission minus the lane grant.
  const h = harness();
  const game = testGame([{ num: 0, source: LOGIC_0 }]);
  h.send({
    type: "boot",
    files: game.files,
    words: [],
    profile: PROFILE,
    frozenTest: {
      id: 300,
      sources: game.sources,
      sourceBindings: game.bindings,
      bindings: expressionBindings(game.bindings),
      stopOnEntry: false,
    },
  });
  const attached = lastControl(h, "debugAttached");
  assert.equal(attached["preview"], undefined, "stopOnEntry:false alone grants no lane");
  const r = sendUpdate(
    h,
    { runToken: "x".repeat(32), epoch: 0, buildId: "", revision: "", updateSerial: 0 },
    1,
    candidateFor(game),
  );
  assert.equal(r["status"], "refused");
  assert.equal(h.ctx.engine!.patchGeneration, 0);

  // Ordinary Play.
  const h2 = harness();
  h2.send({ type: "boot", files: game.files, words: [], profile: PROFILE, rngSeed: 5 });
  assert.equal(controls(h2, "booted").length, 1);
  const r2 = sendUpdate(
    h2,
    { runToken: "y".repeat(32), epoch: 0, buildId: "", revision: "", updateSerial: 0 },
    1,
    candidateFor(game),
  );
  assert.equal(r2["status"], "refused");
  assert.equal(controls(h2, "booted").length, 1, "a refused update never re-boots");
});

test("the inert seam refuses updates where no controller is loaded", () => {
  // A context with no controller installed at all: the seam answers, the
  // candidate is never staged.
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const ports: WorkerPorts = {
    control: (msg) => control.push(msg),
    presentation: (msg) => presentation.push(msg),
    now: () => 0,
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);
  const game = testGame([{ num: 0, source: LOGIC_0 }]);
  onWorkerMessage(ctx, {
    type: "boot",
    files: game.files,
    words: [],
    profile: PROFILE,
    rngSeed: 7,
  });
  ctx.fns.stopTimers();
  assert.equal(ctx.debuggerLoader.installed, false, "no controller ever loaded");
  onWorkerMessage(ctx, {
    type: "previewUpdate",
    id: 1,
    runToken: "z".repeat(32),
    expected: { epoch: 0, buildId: "", revision: "", updateSerial: 0 },
    candidate: candidateFor(testGame([{ num: 0, source: LOGIC_0_V2 }])),
  });
  const result = control.find((m) => m.type === "previewUpdateResult");
  assert.ok(result !== undefined, "the inert seam still answers the request");
  assert.equal(result.status, "refused");
  assert.equal(ctx.engine!.patchGeneration, 0);
});

test("a source-only update defers at a paused boundary and commits after continue", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: LOGIC_0 }]);
  const lane = bootPreview(h, game, { stopOnEntry: true });
  const engine = h.ctx.engine!;
  // The boot latched the entry stop with its audio hold — deliberate pause
  // authority the update must neither ride over nor silently transfer.
  const stopped = lastControl(h, "debugStopped");
  assert.equal(h.ctx.debugger.audioHold, true);
  const audioPosts = controls(h, "debugAudio").length;
  const patchGen = engine.patchGeneration;
  const debugEpoch = h.ctx.debugger.epoch;

  // A comment edits the authored text — identical bytes, new build
  // identity. Even with the native plan unchanged this is real source
  // authority and it inherits the strict idle boundary.
  const sourceOnly = { ...game, sources: { "0": LOGIC_0 + "\n// new comment" } };
  const deferred = sendUpdate(h, lane, 1, candidateFor(sourceOnly));
  assert.equal(deferred["status"], "deferred");
  const kept = deferred["current"] as PreviewLaneIdentity;
  assert.equal(kept.epoch, lane.epoch, "a deferred install mints no new source epoch");
  assert.equal(kept.buildId, lane.buildId);
  assert.equal(kept.updateSerial, lane.updateSerial);
  assert.equal(kept.revision, lane.revision);
  assert.equal(h.ctx.debugger.epoch, debugEpoch);
  assert.equal(engine.patchGeneration, patchGen, "a deferred boundary writes nothing");
  assert.equal(engine.executionStopInfo !== null, true, "the deliberate stop still holds");
  assert.deepEqual(lastControl(h, "debugStopped"), stopped, "no stop republication");
  assert.equal(controls(h, "debugAudio").length, audioPosts, "the audio hold keeps its owner");
  assert.equal(h.ctx.debugger.preview!.buildId, lane.buildId, "lane build authority unmoved");

  // A natural Continue releases the stop; the retry under a fresh
  // transaction id commits the same candidate at the idle boundary.
  const epoch = lastControl(h, "debugAttached")["epoch"] as number;
  h.send({
    type: "debugResume",
    id: 2,
    epoch,
    stopId: stopped["stopId"] as number,
    action: "continue",
  });
  const committed = sendUpdate(h, lane, 3, candidateFor(sourceOnly), kept);
  assert.equal(committed["status"], "committed");
  const current = committed["current"] as PreviewLaneIdentity;
  assert.equal(current.revision, lane.revision, "source-only keeps the native revision");
  assert.notEqual(current.buildId, lane.buildId, "the build identity tracks the sources");
  assert.equal(current.updateSerial, 1);
  h.tick(1);
  assert.equal(engine.vars[40], 1, "the run continues on the committed image");
});

test("an armed observer defers a source-only update until it disarms", () => {
  const h = harness();
  const game = testGame([
    { num: 0, source: LOGIC_0 },
    { num: 1, source: LOGIC_1 },
  ]);
  const lane = bootPreview(h, game);
  const engine = h.ctx.engine!;
  const epoch = lastControl(h, "debugAttached")["epoch"] as number;

  // A breakpoint on a logic that never runs: armed control, quiet pass.
  h.send({
    type: "debugConfigure",
    id: 11,
    epoch,
    revision: 1,
    breakpoints: [{ id: "b1", enabled: true, logic: 1, line: 1, mode: "statement" }],
  });
  assert.equal(lastControl(h, "debugConfigured")["revision"], 1);
  assert.equal(engine.executionControlActive, true, "the spec armed the observer");
  h.tick(1);

  const sourceOnly = {
    ...game,
    sources: { ...game.sources, "0": LOGIC_0 + "\n// new comment" },
  };
  const deferred = sendUpdate(h, lane, 1, candidateFor(sourceOnly));
  assert.equal(deferred["status"], "deferred", "armed control blocks the idle boundary");
  assert.equal(h.ctx.debugger.preview!.buildId, lane.buildId, "no install while armed");

  // Clearing the configuration disarms: the same candidate commits.
  h.send({ type: "debugConfigure", id: 12, epoch, revision: 2, breakpoints: [] });
  assert.equal(engine.executionControlActive, false, "an emptied plan disarms");
  const committed = sendUpdate(
    h,
    lane,
    2,
    candidateFor(sourceOnly),
    deferred["current"] as PreviewLaneIdentity,
  );
  assert.equal(committed["status"], "committed");
  assert.equal(
    (committed["current"] as PreviewLaneIdentity).revision,
    lane.revision,
    "source-only keeps the native revision",
  );
});

test("a candidate with unresolved project references refuses before any write", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: LOGIC_0 }]);
  const lane = bootPreview(h, game);
  const engine = h.ctx.engine!;
  h.tick(1);
  const patchGen = engine.patchGeneration;
  const volBefore = engine.containerFiles.get("VOL.0")!.slice();

  // Honestly compiled, honestly captured — but call(99) names a LOGIC the
  // image does not contain. Well-formed payloads alone do not make the
  // whole project valid.
  let r = sendUpdate(h, lane, 1, candidateFor(testGame([{ num: 0, source: "call(99); return;" }])));
  assert.equal(r["status"], "refused");
  assert.match(String(r["reason"]), /LOGIC 99 is absent/);

  // A literal VIEW reference with no payload behind it.
  r = sendUpdate(
    h,
    lane,
    2,
    candidateFor(testGame([{ num: 0, source: "load.view(99); return;" }])),
  );
  assert.equal(r["status"], "refused");
  assert.match(String(r["reason"]), /VIEW 99 is absent/);

  // Framing-valid bytecode whose instruction stream does not decode on the
  // selected profile: the capture only hashes it and the staged parse only
  // checks framing — the detached project inspection is what refuses it.
  const malformed = testGame([{ num: 0, source: LOGIC_0 }], {
    edit: (c) => c.putResource("logic", 7, buildLogicResource(new Uint8Array([0xc0, 0x00]), [])),
  });
  r = sendUpdate(h, lane, 3, candidateFor(malformed));
  assert.equal(r["status"], "refused");
  assert.match(String(r["reason"]), /logic:7/);

  // One refusal class, nothing moved: native bytes, caches, source
  // authority and epoch are exactly as before, and the old game runs on.
  assert.deepEqual(engine.containerFiles.get("VOL.0"), volBefore);
  assert.equal(engine.patchGeneration, patchGen);
  assert.equal(currentRevision(h), lane.revision);
  const identity = lastControl(h, "previewUpdateResult")["current"] as PreviewLaneIdentity;
  assert.equal(identity.epoch, lane.epoch);
  assert.equal(identity.updateSerial, lane.updateSerial);
  h.tick(2);
  assert.equal(engine.vars[40], 1, "the refused run still advances normally");
});

test("a binding-kind change is real source authority, not a no-op", () => {
  const h = harness();
  const game = testGame([{ num: 0, source: LOGIC_0 }], {
    bindings: { score: { kind: "variable", num: 50 } },
  });
  const lane = bootPreview(h, game);
  const engine = h.ctx.engine!;
  h.tick(1);
  const patchGen = engine.patchGeneration;

  // Same name, same num, different kind: the captured build id hashes
  // bindings as bare numbers, so the candidate's capture is identical —
  // yet the typed map is the source authority the expression subview
  // resolves under, and it must install with a fresh epoch.
  const next: TestGame = { ...game, bindings: { score: { kind: "flag", num: 50 } } };
  const result = sendUpdate(h, lane, 1, candidateFor(next));
  assert.equal(result["status"], "committed");
  const current = result["current"] as PreviewLaneIdentity;
  assert.equal(current.revision, lane.revision, "the native image did not move");
  assert.equal(current.updateSerial, 1);
  assert.equal(current.epoch, lane.epoch + 1, "kind drift mints a fresh source epoch");
  assert.equal(engine.patchGeneration, patchGen, "no native-generation bump");
  assert.equal(h.ctx.debugger.preview!.sourceBindings!["score"]!.kind, "flag");
  assert.equal(
    h.ctx.debugger.bindings["score"]!.kind,
    "flag",
    "the evaluator's expression subview follows the installed map",
  );
  assert.deepEqual(h.ctx.debugger.preview!.sources, game.sources);

  // And an exact retransmission of that authority is again a no-op:
  // identical bytes, identical typed bindings, identical build identity.
  const again = sendUpdate(h, lane, 2, candidateFor(next), current);
  assert.equal(again["status"], "unchanged");
});
