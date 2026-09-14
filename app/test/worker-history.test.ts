/**
 * The always-on recording's proof: a live session driven through the real
 * dispatch — boot, ticks on a controlled clock, input, a suspended prompt,
 * a pause, a quit — must replay offline from its boot and from any anchor to
 * the same observed state, with every recorded sync mark holding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameContainer } from "../../src/types.ts";
import {
  HISTORY_INFLIGHT_MAX,
  historySyncDigest,
  type HistoryBatch,
  type HistorySegment,
} from "../../src/agent/history.ts";
import { resourceSetRevision } from "../../src/agent/authoringState.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { gameContainer } from "./worker-ctx.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { appendHistoryBatch, loadGameHistory } from "../src/historyStorage.ts";

installIndexedDbFixture();
import {
  createWorkerContext,
  type WorkerContext,
  type WorkerPorts,
} from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { replayHistorySegment } from "../src/worker/replay.ts";
import type {
  BootMessage,
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../src/workerProtocol.ts";

// Blue box — the same fixture bytes test/worker-journal uses.
const PICTURE_1 = new Uint8Array([
  0xf0, 0x01, 0xf6, 10, 10, 60, 10, 60, 40, 10, 40, 10, 10, 0xf8, 30, 20, 0xf1, 0xf2, 0x05, 0xf6, 0,
  150, 159, 150, 0xf3, 0xff,
]);
const OBJECT_FILE = new Uint8Array([
  6, 0, 10, 6, 0, 0, 10, 0, 0, 107, 101, 121, 0, 99, 111, 105, 110, 0,
]);

/**
 * logic 0 scripts the session's boundaries: f200 an edge exit to room 2
 * with a score gain and a pickup, f201 a get.num suspension whose resumed
 * pass scores and rooms to 3, f202 an LCG roll, f203 the quit confirmation,
 * f206/f215 the string/number prompts,
 * f207–f210 the save selector's cancel/write-failure/write/restore chain,
 * f211 restart, f212/f213 missing-room authoring, f214 a call into patched
 * logic. Each room logic draws a picture so anchors can snapshot.
 */
function historyGame(): GameContainer {
  return gameContainer(
    [
      `if (isset(f6)) { reset(f6); new.room(1); }
       if (isset(f200)) { reset(f200); assignn(v3, 5); get(0); assignn(v2, 3); new.room(2); }
       if (isset(f201)) { reset(f201); get.num("n?", v11); addv(v3, v11); new.room(3); }
       if (isset(f202)) { reset(f202); random(1, 250, v60); }
       if (isset(f203)) { reset(f203); quit(0); }
       if (isset(f204)) { reset(f204); hold.key(); }
       if (isset(f206)) { reset(f206); get.string(s1, "name?", 22, 1, 20); assignn(v64, 1); }
       if (isset(f207)) { reset(f207); save.game(); assignn(v65, 1); }
       if (isset(f208)) { reset(f208); save.game(); assignn(v66, 1); }
       if (isset(f209)) { reset(f209); save.game(); assignn(v67, 1); }
       if (isset(f210)) { reset(f210); restore.game(); }
       if (isset(f211)) { reset(f211); restart.game(); }
       if (isset(f212)) { reset(f212); new.room(8); }
       if (isset(f213)) { reset(f213); new.room(9); }
       if (isset(f214)) { reset(f214); call(12); }
       if (isset(f215)) { reset(f215); get.num("p2?", v12); }
       if (isset(f216)) { reset(f216); accept.input(); }
       if (v0 > 0) { call.v(v0); }
       return;`,
      `if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
      `if (isset(f5)) { assignn(v50, 2); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
      `if (isset(f5)) { assignn(v50, 3); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
    ],
    (c) => {
      c.putResource("picture", 1, PICTURE_1);
      c.putResource("picture", 2, PICTURE_1);
      c.putResource("picture", 3, PICTURE_1);
      c.putFile("OBJECT", OBJECT_FILE);
    },
  );
}

interface HistoryHarness {
  ctx: WorkerContext;
  control: WorkerControl[];
  presentation: WorkerPresentation[];
  send(msg: WorkerInbound): void;
  /** One 60 Hz host poll: one recorded sound tick and one cycle poll. */
  tick(n?: number): void;
  /** Pending resend timers (the backoff schedule), run on demand. */
  timers: { fn: () => void; ms: number }[];
  /** Fire and consume the oldest pending resend timer. */
  fireTimer(): void;
}

function historyHarness(
  container: GameContainer,
  boot?: Partial<BootMessage>,
  opts?: { autoAck?: boolean; stepMs?: (n: number) => number },
): HistoryHarness {
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let now = 0;
  const ports: WorkerPorts = {
    control: (message) => control.push(message),
    presentation: (message) => presentation.push(message),
    now: () => now,
    schedule: (fn, ms) => {
      const entry = { fn, ms };
      timers.push(entry);
      return entry;
    },
    cancelSchedule: (timer) => {
      const index = timers.indexOf(timer as { fn: () => void; ms: number });
      if (index >= 0) timers.splice(index, 1);
    },
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);
  // The host commits each batch and acks it; resent duplicates get acked
  // again — that is how the worker's resend converges. Track messages by
  // cursor, not batch number, so a reposted batch is answered every time.
  let ackCursor = 0;
  const ackAll = (): void => {
    while (ackCursor < control.length) {
      const message = control[ackCursor++]!;
      if (message.type === "historyBatch")
        onWorkerMessage(ctx, {
          type: "historyAck",
          epoch: message.epoch,
          batch: message.batch.batch,
        });
    }
  };
  const autoAck = opts?.autoAck !== false;
  const send = (msg: WorkerInbound): void => {
    onWorkerMessage(ctx, msg);
    if (autoAck) ackAll();
  };
  send({ type: "boot", files: Object.fromEntries(container.files), words: [], ...boot });
  // The test drives hostTick on the controlled clock; the real timers would
  // interleave polls at unpredictable points.
  ctx.fns.stopTimers();
  let polls = 0;
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += opts?.stepMs?.(polls) ?? 1000 / 60;
      polls++;
      ctx.fns.hostTick();
    }
    if (autoAck) ackAll();
  };
  const fireTimer = (): void => {
    timers.shift()?.fn();
  };
  return { ctx, control, presentation, send, tick, timers, fireTimer };
}

/**
 * Fold the posted historyBatch traffic into per-segment records, deduped by
 * batch number — the resend path reposts un-acked batches and the host
 * filters the duplicates the same way.
 */
function collectSegments(control: WorkerControl[]): HistorySegment[] {
  const segments = new Map<string, HistorySegment>();
  const seen = new Set<string>();
  for (const message of control) {
    if (message.type !== "historyBatch") continue;
    const batch: HistoryBatch = message.batch;
    const key = `${batch.segment}:${batch.batch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let segment = segments.get(batch.segment);
    if (segment === undefined) {
      assert.ok(batch.boot !== undefined, `segment ${batch.segment} opens with a boot batch`);
      segment = {
        id: batch.segment,
        boot: batch.boot,
        anchors: [],
        events: [],
        marks: [],
        sync: [],
      };
      segments.set(batch.segment, segment);
    }
    segment.events.push(...batch.events);
    segment.marks.push(...batch.marks);
    segment.sync.push(...batch.sync);
    if (batch.clock !== undefined) (segment.clock ??= []).push(...batch.clock);
    if (batch.anchor !== undefined) segment.anchors.push(batch.anchor);
    if (batch.end !== undefined) segment.end = batch.end;
  }
  return [...segments.values()];
}

test("a recorded live session replays from its boot to the same observed state", () => {
  const h = historyHarness(historyGame(), { rngSeed: 0x5eed });
  const { ctx, send, tick } = h;
  tick(4);

  // hold.key arms the key-release gate so direction messages record as
  // direction/release boundaries rather than raw keys.
  send({ type: "debugWrite", id: 0, flags: [[204, 1]] });
  tick(3);

  // Player boundaries: a direction hold+release, a raw key, a typed line
  // and an edit mirror — each lands in the stream.
  send({ type: "key", code: 65 });
  send({ type: "direction", dir: 8 });
  tick(2);
  send({ type: "direction", dir: 0 });
  send({ type: "input", text: "look" });
  send({ type: "edit", text: "loo" });
  tick(2);

  // An edge exit to room 2 — journal marks it, history anchors it.
  send({ type: "debugWrite", id: 1, flags: [[200, 1]] });
  tick(4);
  assert.equal(ctx.engine!.vars[0], 2);

  // The LCG roll — replay must reproduce v60 exactly.
  send({ type: "debugWrite", id: 2, flags: [[202, 1]] });
  tick(3);
  const rolled = ctx.engine!.vars[60];
  assert.ok(rolled! >= 1 && rolled! <= 250);

  // A suspended prompt and its host answer; the resumed pass rooms to 3.
  send({ type: "debugWrite", id: 3, flags: [[201, 1]] });
  tick(3);
  const request = h.control.find((m) => m.type === "hostRequest" && m.op === "getnum");
  assert.ok(request && request.type === "hostRequest");
  send({ type: "hostAnswer", id: request.id, response: "7" });
  tick(4);
  assert.equal(ctx.engine!.vars[0], 3);
  assert.equal(ctx.engine!.vars[3], 12, "5 + the answered 7");

  // A pause still polls — the recorded tick (one per host poll) advances,
  // which is how the pause's duration stays in the stream — but no cycle
  // or sound tick runs.
  send({ type: "pause", paused: true });
  const frozenCycle = ctx.cycle.cycleCount;
  tick(3);
  assert.equal(ctx.cycle.cycleCount, frozenCycle, "paused host polls run no cycle");
  send({ type: "pause", paused: false });
  tick(3);

  // The quit confirmation parks on a key; an arriving Enter answers it and
  // ends the segment.
  send({ type: "debugWrite", id: 4, flags: [[203, 1]] });
  tick(8);
  assert.equal(ctx.engine!.awaitingKey, true, "the quit confirmation parked");
  send({ type: "key", code: 13 });
  tick(2);
  assert.ok(
    h.presentation.some((m) => m.type === "quit"),
    "the confirmed quit reached the host",
  );

  const segments = collectSegments(h.control);
  assert.equal(segments.length, 1);
  const segment = segments[0]!;
  assert.ok(segment.end !== undefined);
  assert.equal(segment.end.reason, "quit");

  const kinds = new Set(segment.events.map((e) => e.cause.kind));
  for (const kind of ["direction", "key", "input", "edit", "debugWrite", "answer", "end"])
    assert.ok(kinds.has(kind as never), `stream carries ${kind}`);

  assert.deepEqual(
    segment.marks.map((m) => ({ room: m.room, via: m.via })),
    [
      { room: 0, via: "boot" },
      { room: 2, via: "edge" },
      { room: 3, via: "logic" },
    ],
  );
  assert.ok(segment.anchors.length >= 2, "room entries anchored");
  assert.ok(segment.sync.length >= 2, "anchors carry sync marks");

  // The recorded boot names the exact resource set it replays onto.
  const bootFiles = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(segment.boot.files))
    bootFiles.set(
      name,
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    );
  assert.equal(segment.boot.resourceSet, resourceSetRevision({ getFiles: () => bootFiles }));

  const liveDigest = historySyncDigest(ctx.engine!);
  const replayed = replayHistorySegment(segment);
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null, "every recorded sync mark holds");
  assert.equal(replayed.applied, segment.events.length);
  assert.equal(historySyncDigest(replayed.ctx.engine!), liveDigest);
  assert.equal(
    replayed.ctx.replay.replay!.random,
    ctx.history.rng,
    "the LCG state matches live's at the same boundary",
  );
});

test("replay from a later anchor reaches the same observed state", () => {
  const h = historyHarness(historyGame(), { rngSeed: 77 });
  const { ctx, send, tick } = h;
  tick(4);
  send({ type: "debugWrite", id: 1, flags: [[200, 1]] });
  tick(4);
  send({ type: "debugWrite", id: 2, flags: [[202, 1]] });
  tick(3);
  send({ type: "debugWrite", id: 3, flags: [[201, 1]] });
  tick(3);
  const request = h.control.find((m) => m.type === "hostRequest" && m.op === "getnum");
  assert.ok(request && request.type === "hostRequest");
  send({ type: "hostAnswer", id: request.id, response: "7" });
  tick(4);
  send({ type: "flush", id: 9 });
  const liveDigest = historySyncDigest(ctx.engine!);

  const segment = collectSegments(h.control)[0]!;
  const anchorIndex = segment.anchors.length - 1;
  assert.ok(anchorIndex >= 0);
  const replayed = replayHistorySegment(segment, { anchor: anchorIndex });
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null);
  assert.equal(historySyncDigest(replayed.ctx.engine!), liveDigest);
});

/**
 * The plan's §1.3 matrix: same-tick key order, prompts (string/number), a
 * pause while a prompt is suspended, the save selector's cancel and write
 * failure paths, a write whose image a restore consumes, restart,
 * missing-room authoring declined and accepted, a live patch plus a
 * metadata patch plus a re-enter — all replayed offline to the same
 * observed state.
 */
test("the full boundary matrix replays to the same observed state", () => {
  const h = historyHarness(historyGame(), { rngSeed: 0xc0ffee, authorRooms: true });
  const { ctx, send, tick } = h;
  tick(4);

  const seen = new Set<number>();
  const awaitOp = (op: string) => {
    for (let i = 0; i < 40; i++) {
      const req = h.control.find((m) => m.type === "hostRequest" && m.op === op && !seen.has(m.id));
      if (req && req.type === "hostRequest") {
        seen.add(req.id);
        return req;
      }
      tick(1);
    }
    return assert.fail(`host request ${op} never posted`);
  };
  const answer = (op: string, response: string) => {
    send({ type: "hostAnswer", id: awaitOp(op).id, response });
  };

  // Same-tick ordering: with the parser's input line open, the keys queued
  // inside one host poll reach it in arrival order — the digest hashes the
  // row they draw on.
  send({ type: "debugWrite", id: 0, flags: [[216, 1]] });
  tick(3);
  send({ type: "key", code: 97 });
  send({ type: "key", code: 98 });
  tick(3);
  assert.equal(ctx.engine!.inputEdit, "ab", "same-tick keys kept queue order");

  // get.string suspends on a host request; the accepted reply echoes onto
  // the text surface the sync digest hashes.
  send({ type: "debugWrite", id: 1, flags: [[206, 1]] });
  answer("getstring", "KING");
  tick(3);
  assert.equal(ctx.engine!.strings[1], "KING");
  assert.equal(ctx.engine!.vars[64], 1, "the resumed pass ran past get.string");

  // A pause while the prompt is suspended: paused polls still advance the
  // recorded tick, the answer applies at its recorded position, and play
  // resumes unpaused.
  send({ type: "debugWrite", id: 2, flags: [[215, 1]] });
  const numReq = awaitOp("getnum");
  send({ type: "pause", paused: true });
  const frozenCycle = ctx.cycle.cycleCount;
  tick(3);
  assert.equal(ctx.cycle.cycleCount, frozenCycle, "paused host polls run no cycle");
  send({ type: "hostAnswer", id: numReq.id, response: "42" });
  send({ type: "pause", paused: false });
  tick(3);
  assert.equal(ctx.engine!.vars[12], 42, "the suspended answer landed through the pause");

  // The selector's write-failure path: list, select an empty slot,
  // describe, confirm, the write fails, ESC dismisses.
  send({ type: "debugWrite", id: 3, flags: [[208, 1]] });
  answer("saveList", "[]");
  send({ type: "key", code: 13 });
  answer("saveDescription", JSON.stringify({ value: "mine" }));
  send({ type: "key", code: 13 });
  answer("saveWrite", "false");
  send({ type: "key", code: 27 });
  tick(3);
  assert.equal(ctx.engine!.modalKind, null, "the failed save dismissed");
  assert.equal(ctx.engine!.vars[66], 1, "the failed write still resumed the pass");

  // A successful write: the image the selector handed the host is the file
  // restore.game consumes.
  send({ type: "debugWrite", id: 4, flags: [[209, 1]] });
  answer("saveList", "[]");
  send({ type: "key", code: 13 });
  answer("saveDescription", JSON.stringify({ value: "checkpoint" }));
  send({ type: "key", code: 13 });
  const write = awaitOp("saveWrite");
  const savedImage = String(write.context["image"]);
  send({ type: "hostAnswer", id: write.id, response: "true" });
  tick(3);
  assert.equal(ctx.engine!.vars[67], 1, "the written save resumed its pass");

  // The selector's cancel path: ESC abandons the list without a write.
  send({ type: "debugWrite", id: 5, flags: [[207, 1]] });
  answer("saveList", "[]");
  send({ type: "key", code: 27 });
  tick(3);
  assert.equal(ctx.engine!.modalKind, null);
  assert.equal(ctx.engine!.vars[65], 1);

  // Move to room 2 and mark a var the save predates, then restore the
  // room-0 image — a recorded answer carrying bytes rewinds the whole
  // interpreter.
  send({ type: "debugWrite", id: 6, flags: [[200, 1]] });
  tick(4);
  assert.equal(ctx.engine!.vars[0], 2);
  send({ type: "debugWrite", id: 7, vars: [[70, 77]] });
  send({ type: "debugWrite", id: 8, flags: [[210, 1]] });
  answer("saveList", JSON.stringify([{ slot: 1, image: savedImage }]));
  send({ type: "key", code: 13 });
  answer("restore", savedImage);
  tick(4);
  assert.equal(ctx.engine!.vars[0], 0, "the saved image restored its room");
  assert.equal(ctx.engine!.vars[70], 0, "state written after the save rewound with it");

  // A live logic patch, a metadata patch and a re-enter — each a recorded
  // boundary that moves patchGeneration onto the marks.
  send({
    type: "patch",
    kind: "logic",
    num: 12,
    payload: assembleLogic("assignn(v63,42);return;", { dictionary: new Map() }).payload,
  });
  send({ type: "debugWrite", id: 9, flags: [[214, 1]] });
  tick(3);
  assert.equal(ctx.engine!.vars[63], 42, "the patched logic ran");
  send({ type: "patchMetadata", files: { "TESTS.JSON": new Uint8Array([123, 125]) } });
  send({ type: "reenter" });
  tick(3);

  // Missing-room authoring: a declined answer keeps the room; an accepted
  // patch lands the transition and its anchor.
  send({ type: "debugWrite", id: 10, flags: [[212, 1]] });
  answer("room", "not a patch");
  tick(3);
  assert.equal(ctx.engine!.vars[0], 0, "a declined room never lands");
  // The decline prints a refusal — the open message window pauses the
  // cycle until a click dismisses it.
  assert.equal(ctx.engine!.modalKind, "print");
  send({ type: "dismissPrint" });
  tick(2);
  assert.equal(ctx.engine!.modalKind, null);
  const room9 = JSON.stringify({
    room: 9,
    resources: [
      {
        kind: "logic",
        num: 9,
        data: Array.from(
          assembleLogic(
            "if (isset(f5)) { assignn(v50,9); load.pic(v50); draw.pic(v50); show.pic(); } return;",
            { dictionary: new Map() },
          ).payload,
        ),
      },
      { kind: "picture", num: 9, data: Array.from(PICTURE_1) },
    ],
  });
  send({ type: "debugWrite", id: 11, flags: [[213, 1]] });
  answer("room", room9);
  tick(4);
  assert.equal(ctx.engine!.vars[0], 9, "the authored room landed");

  // Restart: the confirmation parks on a key; Enter restarts and the
  // fresh boot pass rooms back to 1.
  send({ type: "debugWrite", id: 12, flags: [[211, 1]] });
  tick(4);
  send({ type: "key", code: 13 });
  tick(4);
  assert.equal(ctx.engine!.vars[0], 1, "restart re-entered through f6");

  send({ type: "flush", id: 99 });
  const segments = collectSegments(h.control);
  assert.equal(segments.length, 1);
  const segment = segments[0]!;
  const kinds = new Set(segment.events.map((e) => e.cause.kind));
  for (const kind of [
    "key",
    "dismiss",
    "answer",
    "pause",
    "patch",
    "patchMeta",
    "reenter",
    "restart",
    "debugWrite",
  ])
    assert.ok(kinds.has(kind as never), `stream carries ${kind}`);

  const liveDigest = historySyncDigest(ctx.engine!);
  const replayed = replayHistorySegment(segment);
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null, "every recorded sync mark holds");
  assert.equal(historySyncDigest(replayed.ctx.engine!), liveDigest);

  // The fold path: replaying from the last anchor replays the recorded
  // patches onto the boot files before the anchor's image restores.
  const last = replayHistorySegment(segment, { anchor: segment.anchors.length - 1 });
  assert.equal(last.error, null);
  assert.equal(last.diverged, null);
  assert.equal(historySyncDigest(last.ctx.engine!), liveDigest);
});

test("a tampered stream reports its divergence at the broken mark", () => {
  const h = historyHarness(historyGame(), { rngSeed: 1 });
  const { send, tick } = h;
  tick(4);
  send({ type: "debugWrite", id: 1, flags: [[200, 1]] });
  tick(4);
  send({ type: "debugWrite", id: 2, flags: [[201, 1]] });
  tick(3);
  const request = h.control.find((m) => m.type === "hostRequest" && m.op === "getnum");
  assert.ok(request && request.type === "hostRequest");
  send({ type: "hostAnswer", id: request.id, response: "7" });
  tick(4);

  const segment = JSON.parse(JSON.stringify(collectSegments(h.control)[0])) as HistorySegment;
  // The answered 7 becomes a 9: the resumed pass scores differently.
  const answer = segment.events.find((e) => e.cause.kind === "answer");
  assert.ok(answer && answer.cause.kind === "answer");
  answer.cause.response = "9";

  const replayed = replayHistorySegment(segment);
  assert.equal(replayed.error, null);
  assert.ok(replayed.diverged !== null, "the changed answer must diverge");
});

test("un-acked batches stay under the in-flight bound and drain on acks", () => {
  const h = historyHarness(historyGame(), { rngSeed: 3 }, { autoAck: false });
  const { ctx, send, tick } = h;
  tick(4);
  const epoch = ctx.history.epoch;

  // The boot batch is already posted. Six forced batches follow: a key plus
  // a flush each, so the backlog grows past the credit without any ack.
  for (let i = 0; i < 6; i++) {
    send({ type: "key", code: 49 + (i % 9) });
    tick(1);
    send({ type: "flush", id: 100 + i });
  }
  const posted = h.control.filter((m) => m.type === "historyBatch");
  const postedIds = new Set(posted.map((m) => m.batch.batch));
  assert.equal(ctx.history.sent.length, HISTORY_INFLIGHT_MAX, "credit caps the posted set");
  assert.ok(ctx.history.queue.length > 0, "the overflow waits in the queue");
  assert.equal(postedIds.size, HISTORY_INFLIGHT_MAX, "each retained batch posted once");

  // The host commits one: the ack frees a slot and the backlog drains into it.
  const first = [...postedIds][0]!;
  send({ type: "historyAck", epoch, batch: first });
  assert.equal(ctx.history.sent.length, HISTORY_INFLIGHT_MAX, "the freed slot refilled");
  assert.equal(ctx.history.queue.length, 2, "one ack drains exactly one batch");

  // Acking everything the worker holds drains the backlog completely.
  let guard = 0;
  while (ctx.history.sent.length > 0 && guard++ < 16)
    send({ type: "historyAck", epoch, batch: ctx.history.sent[0]!.batch });
  assert.equal(ctx.history.sent.length, 0);
  assert.equal(ctx.history.queue.length, 0);
});

test("a budget overflow still posts its end marker at full credit", () => {
  const h = historyHarness(historyGame(), { rngSeed: 5 }, { autoAck: false });
  const { ctx, send, tick } = h;
  tick(4);

  // Fill the credit: the boot batch plus enough forced batches to hold every
  // in-flight slot, with more waiting in the queue.
  for (let i = 0; i < 6; i++) {
    send({ type: "key", code: 49 + (i % 9) });
    tick(1);
    send({ type: "flush", id: 100 + i });
  }
  assert.equal(ctx.history.sent.length, HISTORY_INFLIGHT_MAX, "credit is full");
  const segment = ctx.history.segment;
  assert.ok(segment !== null);

  // The host still isn't acking and the backlog keeps growing — past the
  // byte budget the recorder must shed it and close the segment so the
  // stored tail stays replayable.
  ctx.history.queuedBytes = 48 * 1024 * 1024;
  send({ type: "key", code: 50 });
  tick(1);
  send({ type: "flush", id: 200 });

  const ends = h.control.filter(
    (m) => m.type === "historyBatch" && m.batch.end?.reason === "budget",
  );
  assert.equal(ends.length, 1, "the end marker posts even past the credit bound");
  assert.equal(ends[0]!.type === "historyBatch" ? ends[0]!.batch.segment : null, segment);
  assert.equal(ctx.history.segment, null, "the segment closed");
  assert.equal(ctx.history.resumedFrom?.segment, segment);
  assert.equal(ctx.history.resumedFrom?.seq, ctx.history.seq);
  assert.ok((ctx.history.resumedFrom?.tick ?? 0) > 0, "the resume marker survives the drop");
});

test("historyEnd closes the segment and posts its batch even at full credit", () => {
  const h = historyHarness(historyGame(), { rngSeed: 7 }, { autoAck: false });
  const { ctx, send, tick } = h;
  tick(4);
  for (let i = 0; i < 6; i++) {
    send({ type: "key", code: 49 + (i % 9) });
    tick(1);
    send({ type: "flush", id: 100 + i });
  }
  assert.equal(ctx.history.sent.length, HISTORY_INFLIGHT_MAX, "credit is full");

  send({ type: "historyEnd", id: 300 });
  const ended = h.control.filter((m) => m.type === "historyEnded");
  assert.equal(ended.length, 1, "the reply confirms the close");
  const ends = h.control.filter(
    (m) => m.type === "historyBatch" && m.batch.end?.reason === "eject",
  );
  assert.equal(ends.length, 1, "the eject end batch posts past the credit bound");
  assert.equal(ctx.history.segment, null);
});

test("a jittered wall clock replays to the same observed state", () => {
  // Main-thread stutter: nine 8 ms polls then a 150 ms catch-up, repeating.
  // The burst discharges nine sound ticks inside one poll and shifts the
  // cycle-fire boundary — the virtual 1/60 s clock replays neither.
  const h = historyHarness(
    historyGame(),
    { rngSeed: 0x5eed },
    { stepMs: (n) => (n % 10 === 9 ? 150 : 8) },
  );
  const { ctx, send, tick } = h;
  send({ type: "debugWrite", id: 1, vars: [[10, 2]] });
  tick(60);
  send({ type: "debugWrite", id: 2, flags: [[200, 1]] });
  tick(60);
  send({ type: "key", code: 65 });
  tick(10);
  send({ type: "flush", id: 9 });
  const liveDigest = historySyncDigest(ctx.engine!);

  const segment = collectSegments(h.control)[0]!;
  // The tape carried the observation: the stutter shows up as bursts that
  // are not the virtual clock's uniform one-sound-tick-per-poll.
  assert.ok(
    segment.clock !== undefined &&
      segment.clock.some((r) => r.sound !== 1) &&
      segment.clock.some((r) => r.cycle),
    "the clock lane recorded the real discharge and fire pattern",
  );
  const replayed = replayHistorySegment(segment);
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null, "a jittered tape must not diverge");
  assert.equal(historySyncDigest(replayed.ctx.engine!), liveDigest);

  // The lane is load-bearing: replaying the same tape with it stripped —
  // the pre-lane virtual derivation — diverges at a sync mark.
  const torn = { ...segment };
  delete torn.clock;
  const without = replayHistorySegment(torn);
  assert.equal(without.error, null);
  assert.ok(without.diverged !== null, "the same tape without its clock lane must diverge");
});

test("a suspended-tab gap in the host polls replays to the same observed state", () => {
  // A background tab's polls stall for a second, then resume — the gap's
  // elapsed time must not leak into the replayed clock observations.
  let gap = false;
  const h = historyHarness(
    historyGame(),
    { rngSeed: 0x5eed },
    { stepMs: () => (gap ? ((gap = false), 1000) : 1000 / 60) },
  );
  const { ctx, send, tick } = h;
  tick(9);
  send({ type: "debugWrite", id: 1, flags: [[200, 1]] });
  tick(4);
  gap = true;
  tick(1); // one poll carrying a whole second of elapsed wall time
  tick(4);
  send({ type: "key", code: 65 });
  tick(9);
  send({ type: "flush", id: 9 });
  const liveDigest = historySyncDigest(ctx.engine!);

  const segment = collectSegments(h.control)[0]!;
  const replayed = replayHistorySegment(segment);
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null, "a gapped tape must not diverge");
  assert.equal(historySyncDigest(replayed.ctx.engine!), liveDigest);
});

test("a fresh worker never reuses another session's persisted identity", async () => {
  // Two independent sessions of the same game — the reload/resume case.
  // Their segment ids must differ end-to-end, and the persisted committer
  // must fold both tapes without one deduping the other's batches.
  const first = historyHarness(historyGame(), { rngSeed: 0xaa });
  first.tick(4);
  first.send({ type: "debugWrite", id: 0, flags: [[200, 1]] });
  first.tick(4);
  first.send({ type: "key", code: 65 });
  first.tick(3);

  const second = historyHarness(historyGame(), { rngSeed: 0xbb });
  second.tick(4);
  // The second session is longer and different — dedup must not fold it.
  second.send({ type: "debugWrite", id: 0, flags: [[200, 1]] });
  second.tick(4);
  second.send({ type: "input", text: "look" });
  second.tick(2);
  second.send({ type: "debugWrite", id: 1, flags: [[202, 1]] });
  second.tick(4);
  second.send({ type: "pause", paused: true });

  const segmentsA = collectSegments(first.control);
  const segmentsB = collectSegments(second.control);
  const idsA = new Set(segmentsA.map((s) => s.id));
  const idsB = new Set(segmentsB.map((s) => s.id));
  assert.ok(idsA.size > 0 && idsB.size > 0);
  for (const id of idsB) assert.ok(!idsA.has(id), `${id} must be unique per session`);

  // Both sessions persist under one storage key and replay separately.
  const key = "tape-session-identity";
  for (const message of first.control)
    if (message.type === "historyBatch")
      assert.equal(await appendHistoryBatch(key, message.batch, "2.936"), true);
  for (const message of second.control)
    if (message.type === "historyBatch")
      assert.equal(await appendHistoryBatch(key, message.batch, "2.936"), true);

  const stored = await loadGameHistory(key);
  assert.ok(stored !== null);
  assert.equal(stored.segments.length, segmentsA.length + segmentsB.length);

  const replayA = replayHistorySegment(stored.segments.find((s) => idsA.has(s.id))!);
  assert.equal(replayA.diverged, null);
  assert.equal(historySyncDigest(replayA.ctx.engine!), historySyncDigest(first.ctx.engine!));
  const replayB = replayHistorySegment(stored.segments.find((s) => idsB.has(s.id))!);
  assert.equal(replayB.diverged, null);
  assert.equal(historySyncDigest(replayB.ctx.engine!), historySyncDigest(second.ctx.engine!));
});

test("session ids stay distinct when the platform has no crypto", () => {
  // The CodeQL-flagged path: crypto.getRandomValues is absent (embedded or
  // locked-down contexts), so the clock/counter mix must still mint unique
  // segment ids — even for two fresh workers booted in the same instant.
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    const first = historyHarness(historyGame(), { rngSeed: 1 });
    const second = historyHarness(historyGame(), { rngSeed: 1 });
    first.tick(2);
    second.tick(2);
    const ids = [
      ...collectSegments(first.control).map((s) => s.id),
      ...collectSegments(second.control).map((s) => s.id),
    ];
    assert.equal(new Set(ids).size, ids.length, `colliding session ids: ${ids.join(",")}`);
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
  }
});

test("a failed commit's batch resends on its own schedule and on retry", () => {
  const h = historyHarness(historyGame(), { rngSeed: 3 }, { autoAck: false });
  const { ctx, send, tick } = h;
  tick(4);
  const epoch = ctx.history.epoch;

  send({ type: "key", code: 65 });
  tick(1);
  send({ type: "flush", id: 50 });
  const sent = ctx.history.sent.map((b) => b.batch);
  assert.ok(sent.length >= 2, "the boot batch and the flushed batch are owed acks");

  // The backoff timer is armed — running it reposts the OLDEST owed batch
  // and rearms at double the delay, without touching the credit count.
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0]!.ms, 4_000);
  const before = h.control.filter((m) => m.type === "historyBatch").length;
  h.fireTimer();
  const reposts = h.control.filter((m) => m.type === "historyBatch").slice(before);
  assert.equal(reposts.length, 1);
  assert.equal(reposts[0]!.batch.batch, sent[0]);
  assert.equal(ctx.history.sent.length, sent.length, "a resend spends no new credit");
  assert.equal(h.timers.length, 1, "the backoff rearmed");
  assert.equal(h.timers[0]!.ms, 8_000, "the delay doubles");

  // The player's retry does the same immediately, restarting the short delay.
  h.fireTimer();
  send({ type: "historyRetry" });
  assert.equal(h.timers[0]!.ms, 4_000, "retry restarts the backoff");

  // Once the host commits, the ack frees credit and the timer disarms.
  let guard = 0;
  while (ctx.history.sent.length > 0 && guard++ < 16)
    send({ type: "historyAck", epoch, batch: ctx.history.sent[0]!.batch });
  assert.equal(h.timers.length, 0, "nothing left to resend");
});
