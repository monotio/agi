/**
 * The host half of the history transport: mark stepping is relative to the
 * viewed (segment, tick, seq) position — a mark under the current position
 * is "current", so next must pass it — and Resume here's swap is staged:
 * the kept session is only replaced once the worker acknowledges the take.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { reactive } from "vue";
import { useHistoryView, freshHistoryView } from "../src/useHistoryView.ts";
import type { HistoryBoot, HistoryRecording, HistorySegment } from "../../src/agent/history.ts";
import {
  commitStagedOriginal,
  importGameHistory,
  loadRetainedOriginal,
  stageRetainedOriginal,
} from "../src/historyStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
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

function segment(id: string, marks: [number, number, number][]): HistorySegment {
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
  };
}

/** Two marks share tick 4 in segment 0; segment 1 starts a new run. */
const RECORDING: HistoryRecording = {
  version: 1,
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
  /** The restore ack's revision — defaults to the sent boot's. */
  restoreRevision?: string;
  /** adoptSession throws this — the install leg of the swap failed. */
  adoptError?: string;
  seqAt?: (segment: number, tick: number) => number;
  /** Query types whose replies are held until `release(type, reply)` runs. */
  defer?: string[];
  startError?: string;
}) {
  const state = reactive({
    phase: "running",
    walkthrough: { active: false, status: "idle", tick: 0 },
    historyView: freshHistoryView(),
  }) as unknown as EngineState;
  const game = { installed: false, projectId: "view-test" } as BootedGame;
  const seeks: SeekQuery[] = [];
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
    getSession: () => fakeSession as never,
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
      if (type === "historyRetain")
        return {
          type: "historyRetained",
          id: 0,
          boot: { ...BOOT, rng: 42 },
          from: { segment: "sX.2", seq: 9, tick: 9 },
        };
      if (type === "historyViewTake") {
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
    inbound,
    resumes,
    pauses,
    release,
    waitHeld,
    sessionState,
    adoptions,
  };
}

test("mark stepping advances relative to the viewed position", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
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

test("Resume here stages the departing session; only an acknowledged take replaces the kept one", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
  // An earlier session is already kept.
  const kept = {
    boot: { ...BOOT, rng: 11 },
    from: { segment: "sX.1", seq: 3, tick: 6 },
    retainedAt: 1,
  };
  await stageRetainedOriginal(key, kept);
  await commitStagedOriginal(key);
  assert.deepEqual(await loadRetainedOriginal(key), kept);

  let takeOk = false;
  const { state, view } = makeHarness({ takeOk: () => takeOk });
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;
  assert.equal(v.retained, true);

  // A kept session exists: the first press asks for confirmation, nothing moves.
  await view.resumeHere();
  assert.equal(v.confirmReplace, true);
  assert.equal(v.active, true);

  // Confirmed — but the take fails: the departing session was staged yet
  // the kept one still answers, and the error shows.
  await view.resumeHere();
  assert.equal(v.confirmReplace, false);
  assert.match(v.error, /failed/i);
  assert.equal(v.active, true, "the view stays open on a failed take");
  assert.deepEqual(await loadRetainedOriginal(key), kept, "the kept original survived");

  // Retry: re-confirm, the take succeeds — the staged departing session is
  // committed over the kept one.
  takeOk = true;
  await view.resumeHere();
  assert.equal(v.confirmReplace, true);
  await view.resumeHere();
  assert.equal(v.active, false, "the adopted session went live");
  const retained = await loadRetainedOriginal(key);
  assert.equal(retained?.boot.rng, 42, "the departing session replaced the kept one");
});

test("an acknowledged take promotes the staged session to retained", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
  const { state, view } = makeHarness();
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;
  // No retained yet — first press takes directly.
  await view.resumeHere();
  assert.equal(v.confirmReplace, false);
  assert.equal(v.active, false, `the adopted session went live — error: ${v.error}`);
  const retained = await loadRetainedOriginal(key);
  assert.equal(retained?.boot.rng, 42, "the departing session's boot was staged then committed");
  assert.equal(v.retained, true);
});

test("a take acknowledged but never promoted leaves a recoverable pending swap", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
  // Fail exactly the promotion write: the take's query handler arms it —
  // the stage has already landed, the worker is about to acknowledge.
  const { state, view, resumes } = makeHarness({
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

  await view.resumeHere();
  // The worker adopted — the transport must NOT keep posing as a view of
  // history: it closes and releases the now-live adopted session.
  assert.equal(v.active, false, "the adopted session went live");
  assert.deepEqual(resumes, ["history"], "the pause owner was released");
  assert.equal(v.pendingSwap, true);
  assert.match(v.error, /could not be saved/i);
  // The staged candidate stayed durable — the departing session's only copy.
  const recoverable = await loadRetainedOriginal(key);
  assert.equal(recoverable?.boot.rng, 42, "the staged departing session is still there");

  // The explicit finish promotes it — the swap completes.
  await view.finishPendingSwap();
  assert.equal(v.pendingSwap, false);
  assert.equal(v.retained, true);
  assert.equal(v.error, "");
  const retained = await loadRetainedOriginal(key);
  assert.equal(retained?.boot.rng, 42, "the kept session is the departed one");
});

test("a staged swap the tape cannot settle blocks the next swap for explicit resolution", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
  // An earlier swap left a staged candidate whose departing segment is
  // still open and unidentified — the tape cannot prove either outcome.
  await stageRetainedOriginal(key, {
    boot: { ...BOOT, rng: 77 },
    from: { segment: "sGone.1", seq: 1, tick: 2 },
    retainedAt: 3,
  });
  const { state, view } = makeHarness();
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;
  assert.equal(v.pendingSwap, true, "the unsettled swap surfaces");

  // The next Resume here refuses rather than overwrite the recovery copy.
  await view.resumeHere();
  assert.equal(v.active, true, "the view stays put — nothing was swapped");
  assert.match(v.error, /kept session is still being saved/i);
  const recoverable = await loadRetainedOriginal(key);
  assert.equal(recoverable?.boot.rng, 77, "the pending candidate was not overwritten");

  // Let it go: the candidate drops and the next swap proceeds normally.
  await view.dropPendingSwap();
  assert.equal(v.pendingSwap, false);
  await view.resumeHere();
  assert.equal(v.active, false, `the swap ran — error: ${v.error}`);
  const retained = await loadRetainedOriginal(key);
  assert.equal(retained?.boot.rng, 42, "the new departing session was kept");
});

test("closing during the start query drops the late reply and releases exactly its pause", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
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
  await importGameHistory(key, { recording: RECORDING });
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

test("resetting during the start query abandons the open entirely", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
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

test("a failed start releases the pause and ends the worker's half-open view", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
  const { state, view, inbound, resumes } = makeHarness({
    startError: "anchor 3 resource set does not match the folded stream",
  });
  await view.openHistory();
  const v = state.historyView;
  assert.equal(v.active, false);
  assert.match(v.error, /resource set/);
  assert.deepEqual(resumes, ["history"], "the parked session resumes");
  assert.equal(
    inbound.filter((m) => m.type === "historyViewEnd").length,
    1,
    "the worker-side view is torn down",
  );
});

test("a seek answer landing after close writes nothing back", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
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

test("Resume here installs the tape's checkpoint and keeps the departing session's state", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
  const { state, view, adoptions, sessionState } = makeHarness();
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;

  await view.resumeHere();
  assert.equal(v.active, false, `the adopted session went live — error: ${v.error}`);
  assert.equal(v.error, "");

  // The session leg installed the boot the worker adopted plus the tape's
  // last authoring checkpoint — not the departing session's future state.
  assert.equal(adoptions.length, 1);
  assert.equal(adoptions[0]!.boot.resourceSet, "rev-taken");
  assert.equal(adoptions[0]!.snapshot, TAKE_SNAPSHOT);
  assert.equal(sessionState.hold, null, "a landed adoption releases the hold");

  // The departing session's own snapshot went into the kept record — a
  // later Back to before restores exactly this state.
  const retained = await loadRetainedOriginal(key);
  assert.deepEqual(retained?.session, SESSION_SNAPSHOT);
});

test("a failed authoring install keeps the adoption hold and ends the view", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
  const { state, view, adoptions, sessionState } = makeHarness({
    adoptError: "the recorded authoring checkpoint is malformed",
  });
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;

  await view.resumeHere();
  assert.equal(v.active, false, "the worker adopted — the view does not keep posing as live");
  assert.equal(v.pendingSwap, true);
  assert.match(v.error, /could not be installed/i);
  assert.equal(adoptions.length, 0, "nothing installed");
  assert.ok(
    sessionState.hold !== null,
    "authoring stays held — no turn may run on a foreign revision",
  );

  // The departing session's record stayed durable for recovery.
  const recoverable = await loadRetainedOriginal(key);
  assert.equal(recoverable?.boot.rng, 42);
});

test("Back to before installs the kept record's session state and checks the revision", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
  const keptSnapshot: Record<string, unknown> = { plan: "the kept session's state" };
  await stageRetainedOriginal(key, {
    boot: { ...BOOT, rng: 11, resourceSet: "rev-kept" },
    from: { segment: "sX.1", seq: 3, tick: 6 },
    retainedAt: 1,
    session: keptSnapshot,
  });
  await commitStagedOriginal(key);

  const { state, view, adoptions, sessionState } = makeHarness();
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;
  assert.equal(v.retained, true);

  await view.backToBefore();
  assert.equal(v.active, false, `the kept session went live — error: ${v.error}`);
  // The install got the kept record's boot and its stored session snapshot.
  assert.equal(adoptions.at(-1)?.boot.resourceSet, "rev-kept");
  assert.deepEqual(adoptions.at(-1)?.snapshot, keptSnapshot);
  assert.equal(sessionState.hold, null);
});

test("a restore ack naming a different revision is an uncertain outcome — the hold stays", async () => {
  const key = "view-test";
  await importGameHistory(key, { recording: RECORDING });
  const keptSnapshot: Record<string, unknown> = { plan: "kept" };
  await stageRetainedOriginal(key, {
    boot: { ...BOOT, rng: 11, resourceSet: "rev-kept" },
    from: { segment: "sX.1", seq: 3, tick: 6 },
    retainedAt: 1,
    session: keptSnapshot,
  });
  await commitStagedOriginal(key);

  // The worker acks a revision the record never carried — corruption on the
  // way in. The swap must not install against it nor release the hold.
  const { state, view, adoptions, sessionState } = makeHarness({
    restoreRevision: "rev-other",
  });
  await view.openHistory({ segment: 0, tick: 8 });
  const v = state.historyView;

  await view.backToBefore();
  assert.equal(v.active, false, "an uncertain swap ends the view");
  assert.equal(v.pendingSwap, true);
  assert.match(v.error, /uncertain/i);
  assert.equal(adoptions.length, 0, "nothing installed against an unverifiable revision");
  assert.ok(sessionState.hold !== null, "the hold survives — a retrying swap releases it");
});
