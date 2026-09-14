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

installIndexedDbFixture();

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

function makeHarness(opts?: {
  takeOk?: () => boolean;
  seqAt?: (segment: number, tick: number) => number;
}) {
  const state = reactive({
    phase: "running",
    walkthrough: { active: false, status: "idle", tick: 0 },
    historyView: freshHistoryView(),
  }) as unknown as EngineState;
  const game = { installed: false, projectId: "view-test" } as BootedGame;
  const seeks: SeekQuery[] = [];
  const inbound: WorkerInbound[] = [];
  const seqAt = opts?.seqAt ?? ((_s: number, t: number) => t);
  const view = useHistoryView({
    state,
    getWorker: () => ({ postMessage: (m: WorkerInbound) => inbound.push(m) }) as unknown as Worker,
    getBootedGame: () => game,
    pauseEngine: () => {},
    resumeEngine: () => {},
    drainHistoryCommits: async () => {},
    highlightRoom: () => {},
    logAgent: () => {},
    query: (async (type: string, extra?: Record<string, unknown>) => {
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
          error: null,
        };
      }
      if (type === "historyRetain")
        return {
          type: "historyRetained",
          id: 0,
          boot: { ...BOOT, rng: 42 },
          from: { segment: "sX.2", seq: 9, tick: 9 },
        };
      if (type === "historyViewTake")
        return { type: "historyTaken", id: 0, ok: opts?.takeOk?.() ?? true };
      if (type === "historyViewRestore") return { type: "historyViewRestored", id: 0, ok: true };
      throw new Error(`unexpected query ${type}`);
    }) as never,
  });
  return { state, view, seeks, inbound };
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
