/**
 * The host half of the always-visible transport: mark stepping is relative
 * to the viewed position on the flattened axis — a mark under the current
 * position is "current", so next must pass it — and Resume-from-here's swap
 * is staged: the departing session only joins the kept-branch list once the
 * worker acknowledges the take. Interrupted swaps never ask the player to
 * vote; provable ones settle from tape evidence on the next open.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { reactive } from "vue";
import { useHistoryView, freshHistoryView } from "../src/useHistoryView.ts";
import {
  HISTORY_FORMAT_VERSION,
  type HistoryBatch,
  type HistoryBoot,
  type HistoryRecording,
  type HistorySegment,
} from "../../src/agent/history.ts";
import {
  commitStagedOriginal,
  importGameHistory,
  loadRetainedBranches,
  loadTapeOutline,
  stageRetainedOriginal,
} from "../src/historyStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId, testRevision } from "./identity.ts";
import type { EngineState } from "../src/useEngineTypes.ts";
import type { BootedGame } from "../src/gameTypes.ts";
import type { WorkerInbound } from "../src/workerProtocol.ts";

const RECORDS = installIndexedDbFixture();

const BOOT: HistoryBoot = {
  files: { "VOL.0": "eA==" },
  dictionary: [],
  authorRooms: false,
  rng: 7,
  soundDevice: 1,
  resourceSet: "rev-1",
  requestSerial: 0,
};

function segment(
  id: string,
  marks: [number, number, number][],
  end?: { seq: number; tick: number; cycle: number; reason: "resume" | "boot" },
): HistorySegment {
  return {
    id,
    boot: BOOT,
    anchors: [],
    events: [],
    marks: marks.map(([seq, tick, room]) => ({
      seq,
      tick,
      cycle: tick,
      room,
      via: "edge",
    })),
    sync: [],
    ...(end !== undefined ? { end } : {}),
  };
}

/** Two marks share tick 4 in segment 0; segment 1 starts a new run. */
const RECORDING: HistoryRecording = {
  version: HISTORY_FORMAT_VERSION,
  identity: { project: testProjectId("history-view"), revision: testRevision("history-view") },
  profile: "2.936",
  resourceSet: "rev-1",
  startedAt: 0,
  segments: [
    segment("sX.1", [
      [1, 4, 2],
      [5, 4, 3],
      [9, 8, 5],
    ]),
    segment("sX.2", [[2, 1, 4]]),
  ],
};

interface SeekQuery {
  segment: number;
  tick: number;
}

/** The departing session's snapshot — stamped into the kept record at retain. */
const SESSION_SNAPSHOT: Record<string, unknown> = {
  authoring: { version: 1, bindings: {}, world: { rooms: {}, facts: {}, quests: {} } },
  sources: { logics: [], pictures: [], views: [], sounds: [] },
};
/** The tape's last authoring checkpoint — what a take installs. */
const TAKE_SNAPSHOT: Record<string, unknown> = { plan: "the tape's checkpoint" };
const TAKEN_BOOT: HistoryBoot = { ...BOOT, rng: 55, resourceSet: "rev-taken" };

function makeHarness(opts?: {
  takeOk?: () => boolean;
  noSession?: boolean;
  /** The restore ack's revision — defaults to the sent boot's. */
  restoreRevision?: string;
  /** adoptSession throws this — the install leg of the swap failed. */
  adoptError?: string;
  /** historyRetain rejects with this — the retain leg of the swap failed. */
  retainError?: string;
  seqAt?: (segment: number, tick: number) => number;
  /** Query types whose replies are held until `release(type, reply)` runs. */
  defer?: string[];
  startError?: string;
}) {
  const state = reactive({
    phase: "running",
    powerUp: { busy: false },
    walkthrough: { active: false, status: "idle", tick: 0 },
    historyView: freshHistoryView(),
  }) as unknown as EngineState;
  const game = { installed: false, projectId: "view-test" } as BootedGame;
  const seeks: SeekQuery[] = [];
  const takes: Record<string, unknown>[] = [];
  const inbound: WorkerInbound[] = [];
  const resumes: string[] = [];
  const pauses: string[] = [];
  const held = new Map<string, ((reply: unknown) => void)[]>();
  const release = (type: string, reply: unknown): void => {
    for (const resolve of held.get(type) ?? []) resolve(reply);
    held.delete(type);
  };
  /** Wait until a deferred query of this type is actually in flight. */
  const waitHeld = async (type: string): Promise<void> => {
    for (let i = 0; i < 100 && !held.get(type)?.length; i++)
      await new Promise((r) => setTimeout(r, 0));
    if (!held.get(type)?.length) throw new Error(`${type} never arrived`);
  };
  const seqAt = opts?.seqAt ?? ((_s: number, t: number) => t);
  // The session-side leg of a swap: the fake AgentSession tracks its
  // adoption hold; the fake adoptSession records each install.
  const sessionState = { hold: null as string | null };
  const adoptions: { boot: HistoryBoot; snapshot: unknown }[] = [];
  const fakeSession = {
    holdAdoption: (reason: string) => {
      sessionState.hold = reason;
    },
    releaseAdoption: () => {
      sessionState.hold = null;
    },
    snapshotAuthoring: () => SESSION_SNAPSHOT,
  };
  const view = useHistoryView({
    state,
    getWorker: () => ({ postMessage: (m: WorkerInbound) => inbound.push(m) }) as unknown as Worker,
    getBootedGame: () => game,
    pauseEngine: (owner: string) => {
      pauses.push(owner);
    },
    resumeEngine: (owner: string) => {
      resumes.push(owner);
    },
    getSession: () => (opts?.noSession ? null : (fakeSession as never)),
    adoptSession: async (_game: BootedGame, boot: HistoryBoot, snapshot: unknown) => {
      if (opts?.adoptError) throw new Error(opts.adoptError);
      adoptions.push({ boot, snapshot });
      sessionState.hold = null;
    },
    drainHistoryCommits: () =>
      opts?.defer?.includes("drain")
        ? new Promise<void>((resolve) => {
            const list = held.get("drain") ?? [];
            list.push(() => resolve());
            held.set("drain", list);
          })
        : Promise.resolve(),
    highlightRoom: () => {},
    logAgent: () => {},
    query: (async (type: string, extra?: Record<string, unknown>) => {
      if (opts?.defer?.includes(type))
        return new Promise((resolve) => {
          const list = held.get(type) ?? [];
          list.push(resolve);
          held.set(type, list);
        });
      if (type === "state") return {};
      if (type === "historyViewStart" || type === "historyViewSeek") {
        const segment = Number(extra?.["segment"] ?? 0);
        const tick = Number(extra?.["tick"] ?? 0);
        if (type === "historyViewSeek") seeks.push({ segment, tick });
        return {
          type: "historyView",
          id: 0,
          final: true,
          generation: 7,
          segment,
          tick,
          seq: seqAt(segment, tick),
          cycle: tick,
          room: 0,
          score: 0,
          modal: null,
          canResume: true,
          diverged: null,
          error: type === "historyViewStart" ? (opts?.startError ?? null) : null,
        };
      }
      if (type === "historyRetain") {
        if (opts?.retainError) {
          const error = opts.retainError;
          delete opts.retainError;
          throw new Error(error);
        }
        return {
          type: "historyRetained",
          id: 0,
          boot: { ...BOOT, rng: 42 },
          from: { segment: "sX.2", seq: 9, tick: 9 },
        };
      }
      if (type === "historyViewTake") {
        takes.push(extra as Record<string, unknown>);
        const ok = opts?.takeOk?.() ?? true;
        return {
          type: "historyTaken",
          id: 0,
          ok,
          ...(ok ? { boot: TAKEN_BOOT, session: TAKE_SNAPSHOT } : {}),
        };
      }
      if (type === "historyViewRestore") {
        const sent = extra?.["boot"] as HistoryBoot | undefined;
        return {
          type: "historyViewRestored",
          id: 0,
          ok: true,
          resourceSet: opts?.restoreRevision ?? sent?.resourceSet,
        };
      }
      throw new Error(`unexpected query ${type}`);
    }) as never,
  });
  return {
    state,
    view,
    seeks,
    takes,
    inbound,
    resumes,
    pauses,
    release,
    waitHeld,
    sessionState,
    adoptions,
  };
}

/** A batch the worker would post while playing — drives the live axis. */
function batch(segment: string, ticks: number[]): HistoryBatch {
  return {
    segment,
    batch: 1,
    seqStart: 0,
    seqEnd: ticks.length,
    events: ticks.map((tick, i) => ({
      seq: i,
      tick,
      cycle: tick,
      cause: { kind: "key", code: 65 },
    })),
    marks: [],
    sync: [],
  };
}

test("mark stepping advances relative to the viewed position", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const seqAt = (segment: number, tick: number): number => {
    // The drive lands on the last mark at-or-before the target tick.
    const marks = RECORDING.segments[segment]!.marks.filter((m) => m.tick <= tick);
    return marks.length ? marks[marks.length - 1]!.seq : 0;
  };
  const { state, view, seeks } = makeHarness({ seqAt });
  await view.openHistory({ segment: 0, tick: 3 });
  const v = state.historyView;
  assert.equal(v.active, true);
  assert.deepEqual(
    v.marks.map((m) => [m.segment, m.tick, m.seq]),
    [
      [0, 4, 1],
      [0, 4, 5],
      [0, 8, 9],
      [1, 1, 2],
    ],
  );

  // Sitting at (0,3): forward lands on tick 4 — the first mark position.
  await view.stepMark(1);
  assert.deepEqual(seeks.at(-1), { segment: 0, tick: 4 });
  // The drive now reports tick 4. Forward must PASS the position — the two
  // marks sharing tick 4 are the current position, not the next one.
  await view.stepMark(1);
  assert.deepEqual(seeks.at(-1), { segment: 0, tick: 8 });
  // Segment boundary: forward crosses into segment 1.
  await view.stepMark(1);
  assert.deepEqual(seeks.at(-1), { segment: 1, tick: 1 });
  // End of tape: forward stays on the last mark.
  await view.stepMark(1);
  assert.deepEqual(seeks.at(-1), { segment: 1, tick: 1 });

  // Backward crosses the boundary the other way, then walks marks back.
  await view.stepMark(-1);
  assert.deepEqual(seeks.at(-1), { segment: 0, tick: 8 });
  await view.stepMark(-1);
  assert.deepEqual(seeks.at(-1), { segment: 0, tick: 4 });
  // Before the first mark position: backward stays on it.
  await view.stepMark(-1);
  assert.deepEqual(seeks.at(-1), { segment: 0, tick: 4 });
});

test("Pause before any recorded batch parks under the transport and resumes clean", async () => {
  const { state, view, pauses, resumes } = makeHarness();
  const v = state.historyView;
  view.pauseAtLive();
  assert.equal(v.parked, true);
  assert.deepEqual(pauses, ["transport"]);

  view.resumeLive();
  assert.equal(v.parked, false);
  assert.deepEqual(resumes, ["transport"]);
  // Resume at LIVE is not a swap — nothing was staged or kept.
  assert.deepEqual(await loadRetainedBranches("view-test"), []);
  const outline = await loadTapeOutline("view-test");
  assert.equal(outline?.pending ?? 0, 0);
});

test("the live axis tracks batches and a scrub into the tape parks then opens the view", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, seeks, pauses } = makeHarness();
  const v = state.historyView;
  const model = view.transport;

  // Live play: the newest batch moves the LIVE endpoint; the position pins
  // to the tape's right end without any tape load.
  view.observeBatch(batch("sX.1", [2, 4, 6, 8]));
  assert.equal(model.totalTicks, 8);
  assert.equal(model.tick, 8, "the live position is the newest moment");
  assert.equal(model.percent, 100);

  // A click into the middle of the tape pauses live play and opens the view
  // at the same position the gesture meant.
  await view.dispatchSeek(4);
  assert.equal(v.parked, true, "the transport holds the live pause");
  assert.equal(v.active, true, `the view opened — error: ${v.error}`);
  assert.deepEqual(seeks.at(-1), { segment: 0, tick: 4 });
  assert.ok(pauses.includes("transport") && pauses.includes("history"));
});

test("LIVE restores the parked session still paused; Resume continues it", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, resumes } = makeHarness();
  const v = state.historyView;
  const model = view.transport;

  await view.openHistory({ segment: 0, tick: 8 });
  assert.equal(v.active, true);
  assert.equal(model.live?.here, false, "the surface is the tape, not live");

  // The LIVE endpoint brings back the parked surface — still paused.
  view.goLive();
  assert.equal(v.active, false);
  assert.equal(v.parked, true, "LIVE leaves the session parked");
  assert.equal(model.live?.here, true);
  assert.equal(model.play.label, "Resume");

  // Resume at LIVE releases only the transport hold — no swap, no branch.
  view.resumeLive();
  assert.equal(v.parked, false);
  assert.deepEqual(resumes, ["history", "transport"]);
  assert.deepEqual(await loadRetainedBranches(key), []);
});

test("Resume from here keeps the departing session as a branch — no confirmation", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  // An earlier rewind already kept one session.
  await stageRetainedOriginal(key, {
    id: "b-old",
    boot: { ...BOOT, rng: 11 },
    from: { segment: "sX.1", seq: 3, tick: 6 },
    retainedAt: 1,
  });
  await commitStagedOriginal(key, "b-old");

  let takeOk = false;
  const { state, view } = makeHarness({ takeOk: () => takeOk });
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;
  assert.equal(v.branches, 1, "the kept session counts as a branch");

  // First press swaps immediately — no "Replace the kept session?" vote.
  await view.resumeFromHere();
  assert.equal(v.active, true, "a refused take leaves the view open");
  assert.match(v.error, /failed/i);
  assert.equal((await loadRetainedBranches(key)).length, 1, "the kept session survived");

  takeOk = true;
  await view.resumeFromHere();
  assert.equal(v.active, false, `the adopted session went live — error: ${v.error}`);
  const branches = await loadRetainedBranches(key);
  assert.equal(branches.length, 2, "both rewinds are kept");
  assert.equal(branches[1]!.boot.rng, 42, "the departing session joined the list");
  assert.equal(v.branches, 2);
});

test("an acknowledged take promotes the staged session to a branch", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, takes } = makeHarness();
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;
  await view.resumeFromHere();
  assert.equal(v.active, false, `the adopted session went live — error: ${v.error}`);
  const branches = await loadRetainedBranches(key);
  assert.equal(branches.length, 1);
  assert.equal(branches[0]!.boot.rng, 42, "the departing session's boot was staged then promoted");
  assert.equal(v.branches, 1);
  // The take names the settled position the host confirmed plus the view
  // session's serial — the worker refuses a take that no longer matches.
  assert.deepEqual(takes, [{ segment: 0, tick: 8, seq: 8, generation: 7 }]);
});

test("a take acknowledged but never promoted stays pending — no player vote", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  // Fail exactly the promotion write: the take's query handler arms it —
  // the stage has already landed, the worker is about to acknowledge.
  const { state, view, resumes, pauses } = makeHarness({
    takeOk: () => {
      const put = RECORDS.set.bind(RECORDS);
      let armed = true;
      RECORDS.set = ((k: IDBValidKey, v: unknown) => {
        if (armed) {
          armed = false;
          RECORDS.set = put;
          throw new Error("injected put failure");
        }
        return put(k, v);
      }) as typeof RECORDS.set;
      return true;
    },
  });
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;

  await view.resumeFromHere();
  // The worker adopted — the transport must NOT keep posing as a view of
  // history: it closes, parks the now-live adopted session, and shows the
  // quiet pending status rather than a Keep it / Let it go vote.
  assert.equal(v.active, false, "the adopted session went live");
  assert.equal(v.parked, true, "the surface returns parked — Resume releases it");
  assert.deepEqual(resumes, ["history"], "the view's hold released");
  assert.ok(pauses.includes("transport"), "the parked surface is the transport's hold");
  assert.equal(v.pendingSwaps, 1);
  assert.match(v.error, /could not be saved/i);
  // The staged candidate stayed durable — the departing session's only copy.
  assert.equal((await loadRetainedBranches(key)).length, 0, "nothing promoted yet");
  const outline = await loadTapeOutline(key);
  assert.equal(outline?.pending, 1, "the candidate stays preserved, unsettled");
});

test("a retain failure before adoption releases the authoring hold", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, takes, sessionState } = makeHarness({
    retainError: "the worker's retain request timed out",
  });
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;

  await view.resumeFromHere();
  // The adoption was never asked — the hold must not survive a definite
  // pre-adoption failure, or every later turn stays blocked forever.
  assert.equal(sessionState.hold, null, "the adoption hold released");
  assert.match(v.error, /timed out/);
  assert.deepEqual(takes, [], "no adoption was requested");
  assert.equal(v.active, true, "the view stays open — the session never left it");

  // The next attempt works normally: the hold is not wedged.
  await view.resumeFromHere();
  assert.equal(sessionState.hold, null);
});

test("a failed stage write releases the hold and asks the worker nothing", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, takes, sessionState } = makeHarness();
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;

  // Fail the staged candidate's first record write — a definite failure
  // before any adoption, so the hold must release.
  const put = RECORDS.set.bind(RECORDS);
  let armed = true;
  RECORDS.set = ((k: IDBValidKey, value: unknown) => {
    if (armed) {
      armed = false;
      RECORDS.set = put;
      throw new Error("injected stage failure");
    }
    return put(k, value);
  }) as typeof RECORDS.set;

  await view.resumeFromHere();
  assert.equal(sessionState.hold, null, "the adoption hold released");
  assert.match(v.error, /injected stage failure/);
  assert.deepEqual(takes, [], "no adoption was requested");
});

test("a staged candidate the tape proves adopted settles into a branch on the next open", async () => {
  const key = "view-test";
  // The departing segment ended with the "resume" stamp only adoption
  // writes — the staged candidate is owed a branch slot.
  const adopted: HistoryRecording = {
    ...RECORDING,
    segments: [
      RECORDING.segments[0]!,
      { ...RECORDING.segments[1]!, end: { seq: 9, tick: 9, cycle: 9, reason: "resume" } },
    ],
  };
  await importGameHistory(key, { recording: adopted }, RECORDING.identity);
  await stageRetainedOriginal(key, {
    id: "s-owed",
    boot: { ...BOOT, rng: 77 },
    from: { segment: "sX.2", seq: 9, tick: 9 },
    retainedAt: 3,
  });

  const { state, view } = makeHarness();
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;
  assert.equal(v.pendingSwaps, 0, "the provable swap settled itself");
  const branches = await loadRetainedBranches(key);
  assert.equal(branches.length, 1, "the owed candidate became a branch");
  assert.equal(branches[0]!.boot.rng, 77);
});

test("a staged candidate the tape cannot settle stays quiet and blocks nothing", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  // An earlier swap left a staged candidate whose departing segment is
  // still open and unidentified — the tape cannot prove either outcome.
  await stageRetainedOriginal(key, {
    id: "s-open",
    boot: { ...BOOT, rng: 77 },
    from: { segment: "sGone.1", seq: 1, tick: 2 },
    retainedAt: 3,
  });
  const { state, view } = makeHarness();
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;
  assert.equal(v.pendingSwaps, 1, "the unsettled swap surfaces quietly");

  // The next rewind proceeds anyway — the ambiguous candidate is preserved
  // beside it, never overwritten and never voted on.
  await view.resumeFromHere();
  assert.equal(v.active, false, `the swap ran — error: ${v.error}`);
  const branches = await loadRetainedBranches(key);
  assert.equal(branches.length, 1, "the new departing session was kept");
  assert.equal(branches[0]!.boot.rng, 42);
  const outline = await loadTapeOutline(key);
  assert.equal(outline?.pending, 1, "the ambiguous candidate stayed put");
});

test("closing during the start query drops the late reply and releases exactly its pause", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, inbound, resumes, release, waitHeld } = makeHarness({
    defer: ["historyViewStart"],
  });
  const v = state.historyView;

  const opening = view.openHistory();
  await waitHeld("historyViewStart");
  assert.equal(v.loading, true, "the open is in flight");

  // Esc during the open: the transport closes and its pause owner releases.
  view.closeHistory();
  assert.equal(v.loading, false);
  assert.deepEqual(resumes, ["history"]);
  assert.equal(
    inbound.filter((m) => m.type === "historyViewEnd").length,
    1,
    "the close already told the worker to drop any scratch session",
  );

  // The start reply lands after the close: it must not reactivate the view,
  // and the worker gets another end for the scratch session it just opened.
  release("historyViewStart", {
    type: "historyView",
    id: 0,
    final: true,
    generation: 7,
    segment: 1,
    tick: 1,
    seq: 2,
    cycle: 1,
    room: 4,
    score: 0,
    modal: null,
    canResume: true,
    diverged: null,
    error: null,
  });
  await opening;
  assert.equal(v.active, false, "the late reply does not reactivate the view");
  assert.equal(v.tick, 0, "no position state leaked into the closed view");
  assert.equal(v.error, "");
  assert.equal(
    inbound.filter((m) => m.type === "historyViewEnd").length,
    2,
    "the stale-confirmed view is torn down worker-side",
  );
  assert.deepEqual(resumes, ["history"], "the pause released exactly once");
});

test("closing during the commit drain abandons the open before any worker traffic", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, inbound, resumes, release, waitHeld } = makeHarness({
    defer: ["drain"],
  });
  const v = state.historyView;

  const opening = view.openHistory();
  await waitHeld("drain");
  assert.equal(v.loading, true);

  // Esc while the tape is still loading: the start query is never sent.
  view.closeHistory();
  release("drain", undefined);
  await opening;
  assert.equal(v.active, false);
  assert.equal(v.loading, false);
  assert.equal(v.error, "");
  assert.deepEqual(resumes, ["history"]);
  assert.equal(
    inbound.filter((m) => m.type === "historyViewEnd").length,
    1,
    "the close's end covers a view the worker never opened",
  );
});

test("a seek requested while the tape opens lands once the view confirms", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, seeks, release, waitHeld } = makeHarness({
    defer: ["historyViewStart"],
  });
  const v = state.historyView;

  view.observeBatch(batch("sX.1", [2, 4, 6, 8]));
  void view.dispatchSeek(4);
  await waitHeld("historyViewStart");
  assert.equal(v.loading, true);
  // A newer request during the open replaces the earlier one.
  void view.dispatchSeek(6);
  release("historyViewStart", {
    type: "historyView",
    id: 0,
    final: true,
    generation: 7,
    segment: 1,
    tick: 1,
    seq: 2,
    cycle: 1,
    room: 4,
    score: 0,
    modal: null,
    canResume: true,
    diverged: null,
    error: null,
  });
  for (let i = 0; i < 50 && seeks.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(v.active, true);
  assert.deepEqual(seeks, [{ segment: 0, tick: 6 }], "only the newest request sought");
});

test("resetting during the start query abandons the open entirely", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, inbound, release, waitHeld } = makeHarness({
    defer: ["historyViewStart"],
  });
  const v = state.historyView;

  const opening = view.openHistory();
  await waitHeld("historyViewStart");
  // A worker replacement mid-open: the reset path invalidates the session.
  view.resetHistoryView();
  release("historyViewStart", {
    type: "historyView",
    id: 0,
    final: true,
    generation: 7,
    segment: 0,
    tick: 8,
    seq: 9,
    cycle: 8,
    room: 5,
    score: 0,
    modal: null,
    canResume: true,
    diverged: null,
    error: null,
  });
  await opening;
  assert.equal(v.active, false);
  assert.equal(v.loading, false);
  assert.equal(v.error, "");
  assert.equal(
    inbound.filter((m) => m.type === "historyViewEnd").length,
    1,
    "the superseded start's scratch session is dropped",
  );
});

test("a failed start leaves the game parked at LIVE with the error on the bar", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, inbound, resumes } = makeHarness({
    startError: "anchor 3 resource set does not match the folded stream",
  });
  const v = state.historyView;
  view.observeBatch(batch("sX.1", [2, 4, 6, 8]));
  await view.dispatchSeek(4);
  assert.equal(v.active, false);
  assert.match(v.error, /resource set/);
  assert.equal(v.parked, true, "the live game stays parked — LIVE is still there");
  assert.deepEqual(resumes, ["history"], "the open's own hold released");
  assert.equal(
    inbound.filter((m) => m.type === "historyViewEnd").length,
    1,
    "the worker-side view is torn down",
  );
});

test("a seek answer landing after close writes nothing back", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, release, waitHeld } = makeHarness({ defer: ["historyViewSeek"] });
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;
  assert.equal(v.active, true);

  const seeking = view.seekTo(0, 4);
  await waitHeld("historyViewSeek");
  assert.equal(v.seeking, true);
  view.closeHistory();
  assert.equal(v.active, false);

  release("historyViewSeek", {
    type: "historyView",
    id: 0,
    final: true,
    generation: 7,
    segment: 0,
    tick: 4,
    seq: 5,
    cycle: 4,
    room: 3,
    score: 0,
    modal: null,
    canResume: true,
    diverged: null,
    error: null,
  });
  await seeking;
  assert.equal(v.active, false, "the dead view stays dead");
  assert.equal(v.tick, 8, "the late answer never moved the closed view's position");
  assert.equal(v.error, "", "no error resurrects the transport");
});

test("Resume from here installs the tape's checkpoint and keeps the departing session's state", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, adoptions, sessionState } = makeHarness();
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;

  await view.resumeFromHere();
  assert.equal(v.active, false, `the adopted session went live — error: ${v.error}`);
  assert.equal(v.error, "");

  // The session leg installed the boot the worker adopted plus the tape's
  // last authoring checkpoint — not the departing session's future state.
  assert.equal(adoptions.length, 1);
  assert.equal(adoptions[0]!.boot.resourceSet, "rev-taken");
  assert.equal(adoptions[0]!.snapshot, TAKE_SNAPSHOT);
  assert.equal(sessionState.hold, null, "a landed adoption releases the hold");

  // The departing session's own snapshot went into the kept branch — a
  // later Undo rewind restores exactly this state.
  const branches = await loadRetainedBranches(key);
  assert.deepEqual(branches[0]?.session, SESSION_SNAPSHOT);
});

test("a failed authoring install keeps the adoption hold and ends the view", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const { state, view, adoptions, sessionState } = makeHarness({
    adoptError: "the recorded authoring checkpoint is malformed",
  });
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;

  await view.resumeFromHere();
  assert.equal(v.active, false, "the worker adopted — the view does not keep posing as live");
  assert.equal(v.pendingSwaps, 1);
  assert.match(v.error, /could not be installed/i);
  assert.equal(adoptions.length, 0, "nothing installed");
  assert.ok(
    sessionState.hold !== null,
    "authoring stays held — no turn may run on a foreign revision",
  );

  // The departing session's record stayed durable for recovery.
  const outline = await loadTapeOutline(key);
  assert.equal(outline?.pending, 1);
});

test("Undo rewind installs the newest branch's session and moves it off the list", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  const keptSnapshot: Record<string, unknown> = { plan: "the kept session's state" };
  await stageRetainedOriginal(key, {
    id: "b-kept",
    boot: { ...BOOT, rng: 11, resourceSet: "rev-kept" },
    from: { segment: "sX.1", seq: 3, tick: 6 },
    retainedAt: 1,
    session: keptSnapshot,
  });
  await commitStagedOriginal(key, "b-kept");

  const { state, view, adoptions, sessionState } = makeHarness();
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;
  assert.equal(v.branches, 1);

  await view.undoRewind();
  assert.equal(v.active, false, `the kept session went live — error: ${v.error}`);
  // The install got the branch record's boot and its stored session snapshot.
  assert.equal(adoptions.at(-1)?.boot.resourceSet, "rev-kept");
  assert.deepEqual(adoptions.at(-1)?.snapshot, keptSnapshot);
  assert.equal(sessionState.hold, null);
  // The adopted branch left the list; the session it replaced joined it.
  const branches = await loadRetainedBranches(key);
  assert.equal(branches.length, 1);
  assert.equal(branches[0]!.boot.rng, 42, "the departing session took the undo slot");
  assert.equal(branches[0]!.id === "b-kept", false, "the adopted branch's slot is gone");
});

test("Undo rewind straight from live play parks the session through the swap", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  await stageRetainedOriginal(key, {
    id: "b-kept",
    boot: { ...BOOT, rng: 11, resourceSet: "rev-kept" },
    from: { segment: "sX.1", seq: 3, tick: 6 },
    retainedAt: 1,
  });
  await commitStagedOriginal(key, "b-kept");

  const { state, view, pauses, resumes, adoptions } = makeHarness();
  const v = state.historyView;
  view.observeBatch(batch("sX.1", [2, 4]));
  v.branches = 1; // the outline's count — the controller refreshes it on open
  await view.undoRewind();
  assert.equal(v.active, false);
  assert.equal(v.parked, false, "the adopted session resumed");
  assert.ok(pauses.includes("transport"), "the swap parked the live session");
  assert.ok(resumes.includes("transport"), "the landed swap released it");
  assert.equal(adoptions.at(-1)?.boot.resourceSet, "rev-kept");
});

test("a restore ack naming a different revision is an uncertain outcome — the hold stays", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING }, RECORDING.identity);
  await stageRetainedOriginal(key, {
    id: "b-kept",
    boot: { ...BOOT, rng: 11, resourceSet: "rev-kept" },
    from: { segment: "sX.1", seq: 3, tick: 6 },
    retainedAt: 1,
    session: { plan: "kept" },
  });
  await commitStagedOriginal(key, "b-kept");

  // The worker acks a revision the record never carried — corruption on the
  // way in. The swap must not install against it nor release the hold.
  const { state, view, adoptions, sessionState } = makeHarness({
    restoreRevision: "rev-other",
  });
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;

  await view.undoRewind();
  assert.equal(v.active, false, "an uncertain swap ends the view");
  assert.equal(v.pendingSwaps, 1);
  assert.match(v.error, /uncertain/i);
  assert.equal(adoptions.length, 0, "nothing installed against an unverifiable revision");
  assert.ok(sessionState.hold !== null, "the hold survives — a retrying swap releases it");
});

test("a scrub keeps lane extents and the final target while a batch lands during opening", async () => {
  await importGameHistory("view-test", { recording: RECORDING }, RECORDING.identity);
  const { view, seeks, release, waitHeld } = makeHarness({ defer: ["state"] });
  view.observeBatch(batch("sX.1", [4]));
  view.observeBatch(batch("sX.2", [4]));
  const model = view.transport;
  model.scrubDown(25);
  await waitHeld("state");
  view.observeBatch(batch("sX.1", [8]));
  assert.equal(model.totalTicks, 8, "a landing batch cannot stretch the gesture's axis");
  model.scrubMove(62.5);
  model.scrubUp(62.5);
  release("state", {});
  for (let i = 0; i < 100 && seeks.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seeks, [{ segment: 1, tick: 1 }], "the final target stays in the second lane");
});

test("an opening seek keeps its lane when stored extents differ from the live outline", async () => {
  await importGameHistory("view-test", { recording: RECORDING }, RECORDING.identity);
  const { view, seeks } = makeHarness();
  view.observeBatch(batch("sX.1", [4]));
  view.observeBatch(batch("sX.2", [4]));
  await view.dispatchSeek(6);
  assert.deepEqual(seeks, [{ segment: 1, tick: 1 }]);
});

test("history adoption cannot overlap a staged Keep without an agent session", async () => {
  await importGameHistory("view-test", { recording: RECORDING }, RECORDING.identity);
  const { state, view, takes } = makeHarness({ noSession: true });
  await view.openHistory({ segment: 0, tick: 3 });
  state.powerUp.busy = true;
  await view.resumeFromHere();
  assert.match(state.historyView.error, /current authoring operation/);
  assert.deepEqual(takes, []);
  assert.equal(
    state.powerUp.busy,
    true,
    "history must not release another operation's reservation",
  );
});

test("history holds the authoring reservation through an awaited worker adoption", async () => {
  await importGameHistory("view-test", { recording: RECORDING }, RECORDING.identity);
  const { state, view, waitHeld, release } = makeHarness({
    noSession: true,
    defer: ["historyRetain"],
  });
  await view.openHistory({ segment: 0, tick: 3 });
  const taking = view.resumeFromHere();
  await waitHeld("historyRetain");
  assert.equal(state.powerUp.busy, true);
  release("historyRetain", { boot: null });
  await taking;
  assert.equal(state.powerUp.busy, false);
});
