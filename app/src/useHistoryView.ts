/**
 * The host half of history viewing. "Look back" pauses the live session,
 * seals the recording's tail, loads the stored tape, and opens a view
 * session in the worker: a scratch engine replays it while the transport
 * scrubs. The live engine stays parked and untouched — its only traffic is
 * the pause already recorded.
 *
 * Resume here keeps the departing session as the retained original before
 * the worker adopts the viewed state; Back to before swaps them back.
 * Exactly one retained original exists per game.
 */
import {
  commitStagedOriginal,
  loadGameHistory,
  loadHistoryBookmarks,
  loadRetainedOriginal,
  saveHistoryBookmark,
  stageRetainedOriginal,
  type HistoryBookmark,
} from "./historyStorage.ts";
import { gameStorageKey, type BootedGame } from "./gameTypes.ts";
import type { HistoryRecording, HistorySegment } from "../../src/agent/history.ts";
import type { WorkerControl, WorkerInbound, WorkerQueryFn } from "./workerProtocol.ts";
import type { EngineState, HistoryViewUiState } from "./useEngineTypes.ts";
import type { LogAgentFn } from "./useInputController.ts";

export interface HistoryViewMark {
  /** Index into the recording's segment list. */
  segment: number;
  tick: number;
  seq: number;
  room: number | null;
  kind: "room" | "restart" | "remix" | "prompt" | "bookmark";
  label: string;
}

export type HistoryViewReport = Extract<WorkerControl, { type: "historyView" }>;

export function freshHistoryView(): HistoryViewUiState {
  return {
    active: false,
    loading: false,
    seeking: false,
    playing: false,
    scrubbing: false,
    speed: 1,
    segment: 0,
    segmentCount: 0,
    tick: 0,
    seq: 0,
    room: 0,
    score: 0,
    totalTicks: 0,
    marks: [],
    canResume: false,
    retained: false,
    confirmReplace: false,
    dropped: 0,
    diverged: null,
    error: "",
  };
}

export interface HistoryViewDeps {
  readonly state: EngineState;
  readonly getWorker: () => Worker | null;
  readonly query: WorkerQueryFn;
  readonly getBootedGame: () => BootedGame | null;
  readonly pauseEngine: (owner: string) => void;
  readonly resumeEngine: (owner: string) => void;
  /** Every queued history batch is durable; awaited before the tape loads. */
  readonly drainHistoryCommits: () => Promise<void>;
  /** Map highlight when the user picks a mark that names a room. */
  readonly highlightRoom: (room: number) => void;
  readonly logAgent: LogAgentFn;
}

/** The recorded extent of a segment — end, last event, mark, or sync mark. */
function segmentExtent(seg: HistorySegment): number {
  return Math.max(
    seg.end?.tick ?? 0,
    seg.events.length ? seg.events[seg.events.length - 1]!.tick : 0,
    seg.marks.length ? seg.marks[seg.marks.length - 1]!.tick : 0,
    seg.sync.length ? seg.sync[seg.sync.length - 1]!.tick : 0,
  );
}

const VIA_LABELS: Record<string, string> = {
  boot: "Started here",
  edge: "Walked",
  logic: "Moved",
  restore: "Restored a save",
  restart: "Restarted",
  reenter: "Re-entered after a remix",
  jump: "Arrived",
};

function roomMarkLabel(room: number, via: string, edge?: string): string {
  const lead = VIA_LABELS[via] ?? "Arrived";
  const how =
    via === "edge" && edge ? `through the ${edge} edge` : via === "logic" ? "by the game" : "";
  return `${lead} — room ${room}${how ? ` ${how}` : ""}`;
}

/** The transport's mark lane: room entries, remixes, prompts, bookmarks. */
function buildMarks(recording: HistoryRecording, bookmarks: HistoryBookmark[]): HistoryViewMark[] {
  const marks: HistoryViewMark[] = [];
  recording.segments.forEach((seg, si) => {
    for (const m of seg.marks) {
      marks.push({
        segment: si,
        tick: m.tick,
        seq: m.seq,
        room: m.room,
        kind: m.via === "restart" ? "restart" : "room",
        label: roomMarkLabel(m.room, m.via, m.edge),
      });
    }
    for (const e of seg.events) {
      const c = e.cause;
      if (c.kind === "patch" || c.kind === "patchMeta")
        marks.push({
          segment: si,
          tick: e.tick,
          seq: e.seq,
          room: null,
          kind: "remix",
          label: "A remix landed",
        });
      else if (c.kind === "answer") {
        if (c.op === "room")
          marks.push({
            segment: si,
            tick: e.tick,
            seq: e.seq,
            room: c.room ?? null,
            kind: "room",
            label: "A room was authored",
          });
        else if (c.op === "getnum" || c.op === "getstring" || c.op === "saveDescription")
          marks.push({
            segment: si,
            tick: e.tick,
            seq: e.seq,
            room: null,
            kind: "prompt",
            label: "A prompt was answered",
          });
        else if (c.op === "restore")
          marks.push({
            segment: si,
            tick: e.tick,
            seq: e.seq,
            room: null,
            kind: "prompt",
            label: "A save was restored",
          });
        else if (c.op === "saveWrite")
          marks.push({
            segment: si,
            tick: e.tick,
            seq: e.seq,
            room: null,
            kind: "prompt",
            label: "A save was written",
          });
      }
    }
  });
  for (const b of bookmarks) {
    const si = recording.segments.findIndex((s) => s.id === b.segment);
    if (si >= 0)
      marks.push({
        segment: si,
        tick: b.tick,
        seq: b.seq,
        room: null,
        kind: "bookmark",
        label: b.label,
      });
  }
  marks.sort((a, b) => a.segment - b.segment || a.tick - b.tick || a.seq - b.seq);
  return marks;
}

export function useHistoryView(deps: HistoryViewDeps) {
  let recording: HistoryRecording | null = null;
  let bookmarks: HistoryBookmark[] = [];
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let seekSerial = 0;

  const view = () => deps.state.historyView;

  /** A worker replacement ends the view session — called from reset paths. */
  function resetHistoryView(): void {
    stopWatch();
    recording = null;
    bookmarks = [];
    Object.assign(view(), freshHistoryView());
  }

  function applyReport(msg: HistoryViewReport): void {
    if (msg.superseded) return;
    const v = view();
    v.segment = msg.segment;
    v.tick = msg.tick;
    v.seq = msg.seq;
    v.room = msg.room;
    v.score = msg.score;
    v.canResume = msg.canResume;
    v.diverged = msg.diverged ? { tick: msg.diverged.at.tick, detail: msg.diverged.detail } : null;
    if (msg.error !== null) v.error = msg.error;
    const seg = recording?.segments[msg.segment];
    if (seg) v.totalTicks = segmentExtent(seg);
  }

  function stopWatch(): void {
    view().playing = false;
    if (watchTimer !== null) {
      clearTimeout(watchTimer);
      watchTimer = null;
    }
  }

  /**
   * Pause the live session, seal the recorded tail, load the tape, and open
   * the worker's view session — at the recorded end (the present) unless a
   * target is given (a map visit's jump).
   */
  async function openHistory(at?: { segment: number; tick: number }): Promise<void> {
    const v = view();
    if (v.active || v.loading) return;
    if (deps.state.phase !== "running" || deps.state.walkthrough.active) return;
    v.loading = true;
    v.error = "";
    deps.pauseEngine("history");
    try {
      // Ordering barrier: the worker posts every queued batch before the
      // state reply arrives, so the commits are all in flight here.
      await deps.query("state", {}, 10_000);
      await deps.drainHistoryCommits();
      const game = deps.getBootedGame();
      if (!game) throw new Error("no game is running");
      const key = gameStorageKey(game);
      recording = await loadGameHistory(key);
      bookmarks = await loadHistoryBookmarks(key);
      const retained = await loadRetainedOriginal(key);
      v.retained = retained !== null;
      v.dropped = recording?.dropped ?? 0;
      if (recording === null || recording.segments.length === 0) {
        v.error = "Nothing is recorded yet — play a little first.";
        return;
      }
      v.marks = buildMarks(recording, bookmarks);
      v.segmentCount = recording.segments.length;
      const segIdx = Math.min(
        Math.max(at?.segment ?? recording.segments.length - 1, 0),
        recording.segments.length - 1,
      );
      const seg = recording.segments[segIdx]!;
      v.totalTicks = segmentExtent(seg);
      const target = Math.min(Math.max(at?.tick ?? v.totalTicks, 0), v.totalTicks);
      const reply = await deps.query(
        "historyViewStart",
        { recording, segment: segIdx, tick: target },
        120_000,
      );
      if (reply.error !== null) {
        v.error = reply.error;
        return;
      }
      v.active = true;
      applyReport(reply);
      deps.logAgent("log", `history: viewing segment ${seg.id}`);
    } catch (error) {
      v.error = error instanceof Error ? error.message : String(error);
    } finally {
      v.loading = false;
      if (!v.active) deps.resumeEngine("history");
    }
  }

  /** Back to live: discard the scratch session and unpause what we parked. */
  function closeHistory(): void {
    const v = view();
    if (!v.active && !v.loading) return;
    stopWatch();
    deps.getWorker()?.postMessage({ type: "historyViewEnd" } satisfies WorkerInbound);
    v.active = false;
    v.loading = false;
    v.seeking = false;
    v.scrubbing = false;
    v.confirmReplace = false;
    deps.resumeEngine("history");
  }

  /** Scrub to a recorded position; a newer seek supersedes one in flight. */
  async function seekTo(segment: number, tick: number): Promise<void> {
    const v = view();
    if (!v.active || recording === null) return;
    const seg = recording.segments[segment];
    if (seg === undefined) return;
    tick = Math.max(0, Math.min(tick, segmentExtent(seg)));
    stopWatch();
    v.error = "";
    v.confirmReplace = false;
    v.seeking = true;
    const mine = ++seekSerial;
    try {
      const reply = await deps.query("historyViewSeek", { segment, tick }, 120_000);
      applyReport(reply);
    } catch (error) {
      if (mine === seekSerial) v.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (mine === seekSerial) v.seeking = false;
    }
  }

  /**
   * Step to the next mark in `dir` (+1/-1) on the sorted mark lane. The
   * viewed position is (segment, tick): a seek lands at tick granularity,
   * so marks sharing a tick are indistinguishable — the comparison is
   * strict so the mark under the viewed point is "current", never "next".
   */
  async function stepMark(dir: 1 | -1): Promise<void> {
    const v = view();
    const marks = v.marks;
    if (!v.active || marks.length === 0) return;
    const after = (m: HistoryViewMark): boolean =>
      m.segment > v.segment || (m.segment === v.segment && m.tick > v.tick);
    const before = (m: HistoryViewMark): boolean =>
      m.segment < v.segment || (m.segment === v.segment && m.tick < v.tick);
    let idx: number;
    if (dir > 0) {
      idx = marks.findIndex(after);
      if (idx < 0) idx = marks.length - 1;
    } else {
      idx = -1;
      for (let i = marks.length - 1; i >= 0; i--)
        if (before(marks[i]!)) {
          idx = i;
          break;
        }
      if (idx < 0) idx = 0;
    }
    const mark = marks[idx]!;
    await seekTo(mark.segment, mark.tick);
    if (mark.room !== null) deps.highlightRoom(mark.room);
  }

  /** Cancel a long seek: a superseding no-op seek to the current position. */
  function cancelSeek(): void {
    const v = view();
    if (v.seeking) void seekTo(v.segment, v.tick);
  }

  async function watchStep(): Promise<void> {
    const v = view();
    if (!v.playing || !v.active || recording === null) return;
    const seg = recording.segments[v.segment];
    const extent = seg ? segmentExtent(seg) : v.totalTicks;
    if (v.tick >= extent) {
      // Roll into the next recorded segment, or stop at the tape's end.
      if (v.segment + 1 < v.segmentCount) {
        try {
          const reply = await deps.query(
            "historyViewSeek",
            { segment: v.segment + 1, tick: 0 },
            60_000,
          );
          applyReport(reply);
        } catch {
          v.playing = false;
          return;
        }
      } else {
        v.playing = false;
        return;
      }
    }
    const ticks = Math.max(1, Math.round(6 * v.speed));
    try {
      const reply = await deps.query("historyViewAdvance", { ticks }, 30_000);
      applyReport(reply);
      if (reply.diverged !== null || reply.error !== null) {
        v.playing = false;
        return;
      }
    } catch {
      v.playing = false;
      return;
    }
    watchTimer = setTimeout(() => void watchStep(), 100);
  }

  function playHistory(): void {
    const v = view();
    if (!v.active || v.playing) return;
    v.playing = true;
    void watchStep();
  }

  function pauseHistory(): void {
    stopWatch();
  }

  function setHistorySpeed(speed: number): void {
    view().speed = speed;
  }

  /** The viewed moment becomes the live session; the parked one is retained. */
  async function resumeHere(): Promise<void> {
    const v = view();
    if (!v.active || !v.canResume || v.diverged !== null) return;
    const game = deps.getBootedGame();
    if (!game || recording === null) return;
    const key = gameStorageKey(game);
    // Taking control while a session is kept would replace it — the
    // transport shows the confirming label; this second press proceeds.
    if (v.retained && !v.confirmReplace) {
      v.confirmReplace = true;
      return;
    }
    v.confirmReplace = false;
    v.error = "";
    stopWatch();
    try {
      // The departing live session is staged first — the kept original is
      // replaced only after the worker acknowledges the adoption, so a
      // failed or uncertain swap never costs the retained session.
      const departing = await deps.query("historyRetain", {}, 10_000);
      if (departing.boot === null) {
        v.error = "The paused session can't be kept — a game prompt is still open.";
        return;
      }
      await stageRetainedOriginal(key, {
        boot: departing.boot,
        from: departing.from,
        retainedAt: Date.now(),
      });
      const taken = await deps.query("historyViewTake", {}, 15_000);
      if (!taken.ok) {
        v.error = taken.message ?? "Resume here failed.";
        return;
      }
      await commitStagedOriginal(key);
      v.active = false;
      v.retained = true;
      // The worker adopted the viewed state still parked; release the pause
      // the transport held so the session runs live again.
      deps.resumeEngine("history");
      deps.logAgent("log", `history: resumed from ${v.segment}:${v.tick}`);
    } catch (error) {
      v.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** Back out of a pending replacement confirmation. */
  function cancelReplace(): void {
    view().confirmReplace = false;
  }

  /** Swap back: the retained original resumes; the current session is kept. */
  async function backToBefore(): Promise<void> {
    const v = view();
    if (!v.active) return;
    const game = deps.getBootedGame();
    if (!game) return;
    const key = gameStorageKey(game);
    const retained = await loadRetainedOriginal(key);
    if (retained === null) {
      v.error = "No earlier session is kept.";
      return;
    }
    v.error = "";
    stopWatch();
    try {
      const departing = await deps.query("historyRetain", {}, 10_000);
      if (departing.boot === null) {
        v.error = "This session can't be kept — a game prompt is still open.";
        return;
      }
      // Stage the departing session; the retained slot is rewritten only
      // after the worker acknowledges it adopted the original.
      await stageRetainedOriginal(key, {
        boot: departing.boot,
        from: departing.from,
        retainedAt: Date.now(),
      });
      const restored = await deps.query(
        "historyViewRestore",
        { boot: retained.boot, from: retained.from },
        15_000,
      );
      if (!restored.ok) {
        v.error = restored.message ?? "Back to before failed.";
        return;
      }
      await commitStagedOriginal(key);
      v.active = false;
      v.retained = true;
      deps.resumeEngine("history");
      deps.logAgent("log", "history: back to the retained session");
    } catch (error) {
      v.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** Pin the viewed position as a named mark on the tape. */
  async function addBookmark(label = "Bookmark"): Promise<void> {
    const v = view();
    const game = deps.getBootedGame();
    const seg = recording?.segments[v.segment];
    if (!v.active || !game || !seg) return;
    const bookmark: HistoryBookmark = {
      segment: seg.id,
      seq: v.seq,
      tick: v.tick,
      label,
      at: Date.now(),
    };
    bookmarks = [...bookmarks, bookmark];
    v.marks = buildMarks(recording!, bookmarks);
    await saveHistoryBookmark(gameStorageKey(game), bookmark);
  }

  /** A map visit's jump target: open the transport if needed, then seek. */
  async function jumpToVisit(target: { segment: string; tick: number }): Promise<void> {
    if (deps.state.walkthrough.active) return;
    if (!view().active) await openHistory();
    if (!view().active || recording === null) return;
    const idx = recording.segments.findIndex((s) => s.id === target.segment);
    if (idx < 0) {
      view().error = "That visit's tape is no longer kept.";
      return;
    }
    await seekTo(idx, target.tick);
  }

  /** A selected mark names a room — highlight it when the map is open. */
  function highlightMark(mark: HistoryViewMark): void {
    if (mark.room !== null) deps.highlightRoom(mark.room);
  }

  return {
    resetHistoryView,
    openHistory,
    closeHistory,
    seekTo,
    stepMark,
    cancelSeek,
    playHistory,
    pauseHistory,
    setHistorySpeed,
    resumeHere,
    cancelReplace,
    backToBefore,
    addBookmark,
    jumpToVisit,
    highlightMark,
    applyReport,
  };
}

export type HistoryViewController = ReturnType<typeof useHistoryView>;
