/**
 * The host half of the always-visible transport. While the game runs the
 * bar shows the live session pinned at the timeline's LIVE endpoint; the
 * recording's newest moment tracks play automatically from batch traffic —
 * no tape load. A timeline touch pauses the engine, a scrub into the tape
 * opens the view session (a scratch engine replaying while the live one
 * stays parked), and the LIVE endpoint restores the parked surface still
 * paused until Resume releases only the transport's own hold.
 *
 * Resume from here adopts the viewed moment immediately: the departing
 * session stages to durable storage before the worker is asked, then lands
 * on the bounded branch list once acknowledged — Undo rewind restores the
 * newest branch. Staged candidates an interrupted swap left behind settle
 * themselves from tape evidence; none of it asks the player to vote on a
 * storage transaction.
 */
import { reactive } from "vue";
import {
  clearStagedOriginal,
  commitStagedOriginal,
  loadGameHistory,
  loadHistoryBookmarks,
  loadRetainedBranches,
  loadTapeOutline,
  resolveStagedSwap,
  saveHistoryBookmark,
  stageRetainedOriginal,
  type HistoryBookmark,
} from "./historyStorage.ts";
import { gameStorageKey, type BootedGame } from "./gameTypes.ts";
import type {
  HistoryBatch,
  HistoryBoot,
  HistoryRecording,
  HistoryRoomMark,
  HistorySegment,
} from "../../src/agent/history.ts";
import type { AgentSession } from "./agent/agentSession.ts";
import type { WorkerControl, WorkerInbound, WorkerQueryFn } from "./workerProtocol.ts";
import type { EngineState, HistoryViewUiState } from "./useEngineTypes.ts";
import type { LogAgentFn } from "./useInputController.ts";
import {
  useTransport,
  type TransportButton,
  type TransportExtras,
  type TransportSource,
} from "./useTransport.ts";

export interface HistoryViewMark {
  /** Index into the recording's segment list (or the live outline's). */
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
    parked: false,
    seeking: false,
    playing: false,
    watching: false,
    scrubbing: false,
    speed: 1,
    segment: 0,
    generation: 0,
    segmentCount: 0,
    tick: 0,
    seq: 0,
    room: 0,
    score: 0,
    marks: [],
    canResume: false,
    branches: 0,
    pendingSwaps: 0,
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
  /** The live authoring session — held and adopted across a swap. */
  readonly getSession: () => AgentSession | null;
  /**
   * The session leg of an adoption: install the state belonging to the
   * adopted boot into the AgentSession and bring the stored project to the
   * same revision. A throw leaves the session's adoption hold set.
   */
  readonly adoptSession: (game: BootedGame, boot: HistoryBoot, snapshot: unknown) => Promise<void>;
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

/** A batch's furthest tick — the same formula the storage layer commits. */
function batchExtent(batch: HistoryBatch): number {
  return Math.max(
    batch.end?.tick ?? 0,
    batch.events.length ? batch.events[batch.events.length - 1]!.tick : 0,
    batch.marks.length ? batch.marks[batch.marks.length - 1]!.tick : 0,
    batch.sync.length ? batch.sync[batch.sync.length - 1]!.tick : 0,
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

function roomMark(m: HistoryRoomMark, segment: number): HistoryViewMark {
  return {
    segment,
    tick: m.tick,
    seq: m.seq,
    room: m.room,
    kind: m.via === "restart" ? "restart" : "room",
    label: roomMarkLabel(m.room, m.via, m.edge),
  };
}

/** The transport's mark lane: room entries, remixes, prompts, bookmarks. */
function buildMarks(recording: HistoryRecording, bookmarks: HistoryBookmark[]): HistoryViewMark[] {
  const marks: HistoryViewMark[] = [];
  recording.segments.forEach((seg, si) => {
    for (const m of seg.marks) marks.push(roomMark(m, si));
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

/**
 * One lane of the flattened timeline: a segment's extent plus its marks.
 * Live mode fills it from the manifest outline and batch traffic; the open
 * view rebuilds it from the recording itself.
 */
interface FlatSeg {
  id: string;
  extent: number;
  marks: HistoryViewMark[];
}

export function useHistoryView(deps: HistoryViewDeps) {
  let recording: HistoryRecording | null = null;
  let bookmarks: HistoryBookmark[] = [];
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let seekSerial = 0;
  /**
   * The open session's generation: close and reset invalidate every awaited
   * continuation still in flight, so a late start/seek reply can neither
   * reactivate a closed view nor act on a worker that replaced it.
   */
  let openSerial = 0;
  /**
   * The live timeline's segment lanes, built from the manifest outline and
   * the batch stream — the flattened axis the bar reads before the tape is
   * ever loaded. Reactive: every commit moves the LIVE endpoint.
   */
  const outline = reactive<FlatSeg[]>([]);
  /** The storage key the outline was last loaded for — a game switch refills. */
  let outlineKey = "";
  /**
   * The axis snapshot a scrub gesture maps against. Frozen while the
   * pointer is down so a landing batch cannot move the gesture's target.
   */
  let scrubAxis: FlatSeg[] | null = null;

  const view = () => deps.state.historyView;

  /** A worker replacement ends the view session — called from reset paths. */
  function resetHistoryView(): void {
    stopWatch();
    transport.dispose();
    recording = null;
    bookmarks = [];
    outline.length = 0;
    outlineKey = "";
    scrubAxis = null;
    pendingOpenSeek = null;
    openSerial++;
    seekSerial++;
    Object.assign(view(), freshHistoryView());
  }

  /**
   * The flatten axis for this moment: the recording's lanes while a view is
   * open, the live outline otherwise. A scrub in progress keeps its frozen
   * snapshot so its percent math does not slide under the pointer.
   */
  function axis(): FlatSeg[] {
    if (scrubAxis !== null) return scrubAxis;
    const v = view();
    if (v.active || v.loading) return axisFromRecording();
    return outline;
  }

  let recordingAxis: FlatSeg[] = [];

  function axisFromRecording(): FlatSeg[] {
    if (recording === null) return outline;
    if (recordingAxis.length === 0) {
      recordingAxis = recording.segments.map((seg, si) => ({
        id: seg.id,
        extent: segmentExtent(seg),
        marks: view().marks.filter((m) => m.segment === si),
      }));
    }
    return recordingAxis;
  }

  /** Ticks before lane `index` — the segment's origin on the flat axis. */
  function flatPrefix(index: number): number {
    const segs = axis();
    let sum = 0;
    for (let i = 0; i < index && i < segs.length; i++) sum += segs[i]!.extent;
    return sum;
  }

  function flatTotal(): number {
    return axis().reduce((sum, seg) => sum + seg.extent, 0);
  }

  /** The transport position: the viewed moment, or the tape's live end. */
  function flatPosition(): number {
    const v = view();
    if (!v.active) return flatTotal();
    return flatPrefix(v.segment) + v.tick;
  }

  /**
   * Locate a flat tick: its lane and local tick, or "live" when it lands at
   * the tape's end — the rightmost coordinate is always the parked live
   * session, never the last recorded tick.
   */
  function flatLocate(global: number): { segment: string; tick: number } | "live" {
    const segs = axis();
    const total = segs.reduce((sum, s) => sum + s.extent, 0);
    if (global >= total) return "live";
    let rest = Math.max(0, global);
    for (const seg of segs) {
      if (rest <= seg.extent) return { segment: seg.id, tick: rest };
      rest -= seg.extent;
    }
    return "live";
  }

  /**
   * Resolve a lane id to the loaded recording's segment index — the view's
   * seeks address segments by position in `recording.segments`, and the
   * live outline's order is the tape's but the id is the safe key.
   */
  function recordingIndex(id: string): number {
    return recording?.segments.findIndex((s) => s.id === id) ?? -1;
  }

  function applyReport(msg: HistoryViewReport): void {
    if (msg.superseded) return;
    // Reports belong to an open view: a late one landing after close/reset
    // must not resurrect position, error or divergence state.
    if (!view().active) return;
    const v = view();
    v.generation = msg.generation;
    v.segment = msg.segment;
    v.tick = msg.tick;
    v.seq = msg.seq;
    v.room = msg.room;
    v.score = msg.score;
    v.canResume = msg.canResume;
    v.diverged = msg.diverged ? { tick: msg.diverged.at.tick, detail: msg.diverged.detail } : null;
    if (msg.error !== null) v.error = msg.error;
  }

  function stopWatch(): void {
    view().playing = false;
    if (watchTimer !== null) {
      clearTimeout(watchTimer);
      watchTimer = null;
    }
  }

  /** Branch/pending counts plus the stored outline — one manifest read. */
  async function refreshMeta(key: string): Promise<void> {
    try {
      const meta = await loadTapeOutline(key);
      const v = view();
      if (meta === null) return;
      v.branches = meta.branches;
      v.pendingSwaps = meta.pending;
      v.dropped = meta.dropped;
      // Fill the live axis's stored lanes: segments the manifest already
      // knows take their extent and marks; lanes the batch stream observed
      // first stay — the worker's newest segment has no directory yet.
      for (const seg of meta.segments) {
        const idx = outline.findIndex((s) => s.id === seg.id);
        const marks = seg.marks.map((m, i) => roomMark(m, i));
        if (idx >= 0) {
          const lane = outline[idx]!;
          lane.extent = Math.max(lane.extent, seg.extent);
          for (const m of marks)
            if (!lane.marks.some((x) => x.tick === m.tick && x.seq === m.seq)) lane.marks.push(m);
          lane.marks.sort((a, b) => a.tick - b.tick || a.seq - b.seq);
        } else {
          outline.push({ id: seg.id, extent: seg.extent, marks });
        }
      }
      // Stored lanes belong before the live tail: re-sort by manifest order,
      // keeping segments the manifest does not know at the end.
      const order = new Map(meta.segments.map((s, i) => [s.id, i]));
      outline.sort(
        (a, b) =>
          (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      );
      outline.forEach((lane, i) => lane.marks.forEach((m) => (m.segment = i)));
    } catch {
      // A missing or unreadable manifest leaves the batch-built axis as is.
    }
  }

  /**
   * The live recording's newest moment, maintained from batch traffic alone.
   * The storage commit may still be in flight — the tape position is real
   * either way and the worker resends a refused batch until it lands.
   */
  function observeBatch(batch: HistoryBatch): void {
    const game = deps.getBootedGame();
    const key = game ? gameStorageKey(game) : "";
    if (key !== outlineKey) {
      outlineKey = key;
      outline.length = 0;
      if (key !== "") void refreshMeta(key);
    }
    let lane = outline.find((s) => s.id === batch.segment);
    if (lane === undefined) {
      lane = { id: batch.segment, extent: 0, marks: [] };
      outline.push(lane);
    }
    const index = outline.indexOf(lane);
    const extent = batchExtent(batch);
    if (extent > lane.extent) lane.extent = extent;
    for (const m of batch.marks) lane.marks.push(roomMark(m, index));
  }

  /** The transport's own live pause — released only by Resume at LIVE. */
  function pauseAtLive(): void {
    const v = view();
    if (v.parked || v.active) return;
    deps.pauseEngine("transport");
    v.parked = true;
  }

  /**
   * Resume at LIVE: release only the transport's hold. An open map, an
   * agent bubble or a game modal keeps its own — the engine runs again
   * when every owner has let go.
   */
  function resumeLive(): void {
    const v = view();
    if (!v.parked) return;
    v.parked = false;
    deps.resumeEngine("transport");
  }

  /**
   * The LIVE endpoint: an open view closes and the parked live surface
   * returns — still paused under the transport's hold. During live play a
   * press here pauses, consistently with a timeline click at the end.
   */
  function goLive(): void {
    const v = view();
    if (v.active || v.loading) {
      deps.pauseEngine("transport");
      v.parked = true;
      closeHistory();
      return;
    }
    pauseAtLive();
  }

  /** Escape/leave: the view closes and live play resumes in one step. */
  function exitHistory(): void {
    closeHistory();
    resumeLive();
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
    const mine = ++openSerial;
    deps.pauseEngine("history");
    try {
      // Ordering barrier: the worker posts every queued batch before the
      // state reply arrives, so the commits are all in flight here.
      await deps.query("state", {}, 10_000);
      await deps.drainHistoryCommits();
      const game = deps.getBootedGame();
      if (!game) throw new Error("no game is running");
      const key = gameStorageKey(game);
      const loaded = await loadGameHistory(key);
      if (mine !== openSerial) return;
      recording = loaded;
      // Swaps interrupted last time — a promotion write failed or an
      // acknowledgement was lost — settle from the tape's evidence without
      // asking; only an unprovable one stays pending, preserved and quiet.
      // The batch stream's newest segment is the worker's live tail, which
      // settles candidates the tape alone cannot judge.
      await resolveStagedSwap(key, recording, outline.at(-1)?.id ?? null);
      await refreshMeta(key);
      bookmarks = await loadHistoryBookmarks(key);
      if (mine !== openSerial) return;
      if (recording === null || recording.segments.length === 0) {
        v.error = "Nothing is recorded yet — play a little first.";
        return;
      }
      v.marks = buildMarks(recording, bookmarks);
      v.segmentCount = recording.segments.length;
      recordingAxis = recording.segments.map((seg, si) => ({
        id: seg.id,
        extent: segmentExtent(seg),
        marks: v.marks.filter((m) => m.segment === si),
      }));
      const segIdx = Math.min(
        Math.max(at?.segment ?? recording.segments.length - 1, 0),
        recording.segments.length - 1,
      );
      const seg = recording.segments[segIdx]!;
      const totalTicks = segmentExtent(seg);
      const target = Math.min(Math.max(at?.tick ?? totalTicks, 0), totalTicks);
      const reply = await deps.query(
        "historyViewStart",
        { recording, segment: segIdx, tick: target },
        120_000,
      );
      if (mine !== openSerial) {
        // The view was closed or reset while the worker opened it — tear
        // down the scratch session this reply just confirmed.
        deps.getWorker()?.postMessage({ type: "historyViewEnd" } satisfies WorkerInbound);
        return;
      }
      if (reply.error !== null) {
        // The worker's failed start already dropped its view state; the end
        // message covers an implementation that errored after opening.
        deps.getWorker()?.postMessage({ type: "historyViewEnd" } satisfies WorkerInbound);
        v.error = reply.error;
        return;
      }
      v.active = true;
      applyReport(reply);
      deps.logAgent("log", `history: viewing segment ${seg.id}`);
    } catch (error) {
      if (mine === openSerial) v.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (mine === openSerial) {
        v.loading = false;
        if (!v.active) deps.resumeEngine("history");
        // A gesture kept seeking while the tape loaded — land on its newest
        // request once the open is settled (loading false, so the dispatch
        // runs rather than re-parking itself).
        const pending = pendingOpenSeek;
        pendingOpenSeek = null;
        if (pending !== null && v.active) void dispatchSeek(pending.globalTick, pending.at);
      }
    }
  }

  /**
   * Give up the scratch session: the live surface is repainted and the
   * "history" hold releases. The transport's own hold is not touched — a
   * close that came through the LIVE endpoint stays parked.
   */
  function closeHistory(): void {
    const v = view();
    if (!v.active && !v.loading) return;
    openSerial++;
    seekSerial++;
    stopWatch();
    transport.dispose();
    deps.getWorker()?.postMessage({ type: "historyViewEnd" } satisfies WorkerInbound);
    v.active = false;
    v.loading = false;
    v.seeking = false;
    v.scrubbing = false;
    v.watching = false;
    recordingAxis = [];
    pendingOpenSeek = null;
    // The outline picks up the loaded tape's exact extents — the live axis
    // stays honest after a look back.
    if (recording !== null)
      for (const seg of recording.segments) {
        const lane = outline.find((s) => s.id === seg.id);
        const extent = segmentExtent(seg);
        if (lane === undefined) outline.push({ id: seg.id, extent, marks: [] });
        else if (extent > lane.extent) lane.extent = extent;
      }
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
    v.seeking = true;
    const mine = ++seekSerial;
    try {
      const reply = await deps.query("historyViewSeek", { segment, tick }, 120_000);
      applyReport(reply);
    } catch (error) {
      // A closed view keeps no error — extras.errors shows it whenever set,
      // so a late failure would resurrect the transport on a dead session.
      if (mine === seekSerial && v.active)
        v.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (mine === seekSerial) v.seeking = false;
    }
  }

  /**
   * The flat-axis seek the timeline dispatches. While the view is closed a
   * scrub first parks the live session, then opens the tape and lands at
   * the same absolute position the gesture meant; the tape's end is always
   * the LIVE endpoint, not the last recorded tick.
   */
  /** The newest seek asked for while the tape was still opening. */
  let pendingOpenSeek: { globalTick: number; at: ReturnType<typeof flatLocate> } | null = null;

  /**
   * The flat-axis seek the timeline dispatches. While the view is closed a
   * scrub first parks the live session, then opens the tape and lands at
   * the same absolute position the gesture meant; the tape's end is always
   * the LIVE endpoint, not the last recorded tick.
   */
  async function dispatchSeek(globalTick: number, at = flatLocate(globalTick)): Promise<void> {
    const v = view();
    const mine = ++seekSerial;
    if (v.loading) {
      // The open is in flight: keep only the newest request — the gesture's
      // final position, not every drag sample.
      pendingOpenSeek = { globalTick, at };
      return;
    }
    if (v.active) {
      if (at === "live") goLive();
      else {
        const index = recordingIndex(at.segment);
        if (index >= 0) await seekTo(index, at.tick);
      }
      return;
    }
    const emptyAxis = flatTotal() === 0;
    pauseAtLive();
    // "live" on a populated axis is the endpoint — park without opening. An
    // empty axis cannot tell LIVE from the tape: the click still opens,
    // surfacing a stored tape, an unreadable one, or nothing recorded.
    if (at === "live" && flatTotal() > 0) return;
    await openHistory();
    // A newer request consumed during the open already dispatched itself.
    if (seekSerial !== mine || !v.active) return;
    const landed = emptyAxis ? flatLocate(globalTick) : at;
    if (landed === "live") goLive();
    else {
      const index = recordingIndex(landed.segment);
      if (index >= 0) await seekTo(index, landed.tick);
    }
  }

  /**
   * Step to the next mark in `dir` (+1/-1) on the sorted mark lane. The
   * viewed position is a flat tick: a seek lands at tick granularity, so
   * marks sharing a tick are indistinguishable — the comparison is strict
   * so the mark under the viewed point is "current", never "next".
   */
  async function stepMark(dir: 1 | -1): Promise<void> {
    const v = view();
    const marks = axis().flatMap((seg) => seg.marks);
    if (marks.length === 0) return;
    const here = flatPosition();
    const flat = (m: HistoryViewMark): number => flatPrefix(m.segment) + m.tick;
    let mark: HistoryViewMark | undefined;
    if (dir > 0) mark = marks.find((m) => flat(m) > here) ?? marks[marks.length - 1];
    else {
      for (let i = marks.length - 1; i >= 0; i--)
        if (flat(marks[i]!) < here) {
          mark = marks[i];
          break;
        }
      if (mark === undefined) mark = marks[0];
    }
    if (v.active) {
      // A mark that sits on the tape's end is still a tape position — the
      // LIVE endpoint owns only the space past the last recorded tick.
      const idx = recordingIndex(axis()[mark!.segment]!.id);
      if (idx >= 0) await seekTo(idx, mark!.tick);
    } else {
      await dispatchSeek(flat(mark!));
    }
    if (mark!.room !== null) deps.highlightRoom(mark!.room);
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
    const extent = seg ? segmentExtent(seg) : 0;
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

  /**
   * The secondary Watch action: paced tape playback with the speed and
   * pause-on-dialogue controls it unhides. The primary button's meaning
   * never changes — Resume from here stays the way to take control.
   */
  function toggleWatch(): void {
    const v = view();
    if (!v.active) return;
    if (v.watching && v.playing) {
      pauseHistory();
      return;
    }
    v.watching = true;
    playHistory();
  }

  function setHistorySpeed(speed: number): void {
    view().speed = speed;
  }

  /** The Pause/Resume/Resume-from-here button's single dispatch. */
  function primaryAction(): void {
    const v = view();
    if (v.active) void resumeFromHere();
    else if (v.parked) resumeLive();
    else pauseAtLive();
  }

  /** The Space-key toggle: pause/resume live, or watch on the tape. */
  function transportToggle(): void {
    const v = view();
    if (v.active) toggleWatch();
    else if (v.parked) resumeLive();
    else pauseAtLive();
  }

  /**
   * The shared swap body: stage the departing session, ask the worker to
   * adopt, promote the staged copy to the branch list only after the
   * acknowledgement. The three failure lands differ and are handled
   * differently:
   * - a definite refusal clears the redundant stage and stays in the view;
   * - an uncertain one (lost reply) ends the view — it releases whichever
   *   session is live — and leaves the candidate for the tape to settle;
   * - an acknowledged adoption whose promotion write failed also ends the
   *   view: the swap already happened worker-side, so the transport must
   *   not keep posing as a live view. The owed candidate stays durable.
   */
  async function swapSessions(
    adoptQuery: () => Promise<{
      ok: boolean;
      message?: string | null;
      /** The state the worker adopted — the take's fresh boot, or the kept record's. */
      boot?: HistoryBoot;
      /** The authoring state belonging to those bytes, when one is on record. */
      session?: unknown;
    }>,
    verb: string,
    /** The branch this swap adopted — it leaves the undo list on commit. */
    dropBranch?: string,
  ): Promise<boolean> {
    const v = view();
    const game = deps.getBootedGame();
    if (!game) return false;
    const key = gameStorageKey(game);
    // A user close mid-swap invalidates the swap's UI writes — the staged
    // candidate stays durable and the next open's settle pass resurfaces it.
    const mine = openSerial;
    const stillMine = () => openSerial === mine;
    // The adoption transaction holds authoring until the session carries the
    // state belonging to the adopted bytes — an uncertain or failed install
    // keeps the hold rather than let a turn run against a different revision.
    const session = deps.getSession();
    session?.holdAdoption(`${verb} is adopting a session — authoring resumes when it lands.`);
    const departing = await deps.query("historyRetain", {}, 10_000);
    if (departing.boot === null) {
      session?.releaseAdoption();
      v.error = "The paused session can't be kept — a game prompt is still open.";
      return false;
    }
    const candidate = {
      id: crypto.randomUUID(),
      boot: departing.boot,
      from: departing.from,
      retainedAt: Date.now(),
      // The departing session's authoring state goes into the record — a
      // later Undo rewind reinstalls exactly this.
      ...(session ? { session: session.snapshotAuthoring() } : {}),
    };
    await stageRetainedOriginal(key, candidate);
    let reply: {
      ok: boolean;
      message?: string | null;
      boot?: HistoryBoot;
      session?: unknown;
    };
    try {
      reply = await adoptQuery();
    } catch (error) {
      // The outcome is uncertain: whichever session is live must be released
      // even when the user already closed the transport. The authoring hold
      // stays — a retry installs the adopted state and releases it.
      closeHistory();
      pauseAtLive();
      await refreshMeta(key);
      view().error = `${verb}'s outcome is uncertain (${String(error)}) — the kept session is held for recovery.`;
      return false;
    }
    if (!reply.ok) {
      session?.releaseAdoption();
      try {
        await clearStagedOriginal(key, candidate.id);
      } catch {
        await refreshMeta(key);
      }
      view().error = reply.message ?? `${verb} failed.`;
      return false;
    }
    // The session leg of the transaction: the AgentSession installs the
    // state belonging to the bytes the worker just adopted, and the stored
    // project follows to the same revision. A failure — or an ack that
    // names no adopted boot — keeps the adoption hold: recovery is a
    // retrying swap, not a silent turn against a different revision.
    if (reply.boot === undefined) {
      closeHistory();
      pauseAtLive();
      await refreshMeta(key);
      view().error = `${verb}'s reply carried no adopted state — authoring is held until the next adoption.`;
      return true;
    }
    try {
      await deps.adoptSession(game, reply.boot, reply.session);
    } catch (error) {
      closeHistory();
      pauseAtLive();
      await refreshMeta(key);
      view().error = `${verb} adopted the session, but its authoring state could not be installed (${String(error)}) — authoring is held until the next adoption.`;
      return true;
    }
    try {
      await commitStagedOriginal(key, candidate.id, dropBranch);
    } catch (error) {
      closeHistory();
      pauseAtLive();
      await refreshMeta(key);
      view().error = `The session was kept but its record could not be saved (${String(error)}) — the copy stays queued for recovery.`;
      deps.logAgent("log", `history: ${verb} adopted; the kept session's promotion is pending`);
      return true;
    }
    stopWatch();
    if (stillMine()) {
      v.active = false;
      v.watching = false;
      v.error = "";
    }
    v.parked = false;
    recordingAxis = [];
    deps.resumeEngine("history");
    deps.resumeEngine("transport");
    await refreshMeta(key);
    return true;
  }

  /** The viewed moment becomes the live session; the departing one is kept. */
  async function resumeFromHere(): Promise<void> {
    const v = view();
    if (!v.active || !v.canResume || v.diverged !== null) return;
    const game = deps.getBootedGame();
    if (!game || recording === null) return;
    v.error = "";
    stopWatch();
    try {
      const done = await swapSessions(async () => {
        const reply = await deps.query(
          "historyViewTake",
          { segment: v.segment, tick: v.tick, seq: v.seq, generation: v.generation },
          15_000,
        );
        return reply.ok
          ? {
              ok: true,
              ...(reply.boot !== undefined ? { boot: reply.boot } : {}),
              ...(reply.session !== undefined ? { session: reply.session } : {}),
            }
          : reply;
      }, "Resume from here");
      if (done) deps.logAgent("log", `history: resumed from ${v.segment}:${v.tick}`);
    } catch (error) {
      view().error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Undo rewind: the newest kept branch becomes the live session and the
   * departing one joins the list in its place. Works from the open view and
   * straight from live play — the transport parks the session for the swap
   * and releases only when the adoption lands.
   */
  async function undoRewind(): Promise<void> {
    const v = view();
    const game = deps.getBootedGame();
    if (!game) return;
    const key = gameStorageKey(game);
    const branches = await loadRetainedBranches(key);
    const branch = branches[branches.length - 1];
    if (branch === undefined) {
      v.error = "No earlier session is kept.";
      return;
    }
    v.error = "";
    stopWatch();
    if (!v.active) pauseAtLive();
    try {
      const done = await swapSessions(
        async () => {
          const reply = await deps.query(
            "historyViewRestore",
            { boot: branch.boot, from: branch.from },
            15_000,
          );
          // Both sides must name the same revision: an ack for different bytes
          // than the record sent means the stored boot did not survive.
          if (
            reply.ok &&
            reply.resourceSet !== undefined &&
            reply.resourceSet !== branch.boot.resourceSet
          )
            throw new Error("the worker acknowledged a different revision than the kept session");
          return reply.ok
            ? {
                ok: true,
                boot: branch.boot,
                ...(branch.session !== undefined ? { session: branch.session } : {}),
              }
            : reply;
        },
        "Undo rewind",
        branch.id,
      );
      if (done) deps.logAgent("log", "history: rewound to the kept session");
    } catch (error) {
      view().error = error instanceof Error ? error.message : String(error);
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
    recordingAxis = [];
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

  /**
   * The transport's source for the live recording: a flattened axis across
   * every retained segment — LIVE at the right end. Before the tape opens
   * the outline's extents and room marks supply the shape; while the view
   * is open the recording's lanes do.
   */
  const historySource: TransportSource = {
    get tick() {
      return flatPosition();
    },
    get totalTicks() {
      return flatTotal();
    },
    get seeking() {
      return view().seeking || view().loading;
    },
    get playing() {
      return view().playing;
    },
    get speed() {
      return view().speed;
    },
    get marks() {
      const segs = axis();
      const total = segs.reduce((sum, s) => sum + s.extent, 0);
      const marks: {
        key: number;
        percent: number;
        label: string;
        kind: string;
        payload: HistoryViewMark;
      }[] = [];
      let prefix = 0;
      let key = 0;
      for (const seg of segs) {
        for (const m of seg.marks) {
          marks.push({
            key: key++,
            percent: total > 0 ? ((prefix + m.tick) / total) * 100 : 0,
            label: m.label,
            kind: m.kind,
            payload: m,
          });
        }
        prefix += seg.extent;
      }
      return marks;
    },
    seekTick: (tick) => void dispatchSeek(tick),
    togglePlay: transportToggle,
    setSpeed: setHistorySpeed,
    setScrubbing: (active) => {
      view().scrubbing = active;
      // Freeze the gesture's axis: a landing batch must not move the target
      // under the pointer.
      scrubAxis = active
        ? (view().active ? axisFromRecording() : outline).map((lane) => ({
            ...lane,
            marks: lane.marks.map((mark) => ({ ...mark })),
          }))
        : null;
    },
    step: (dir) => void stepMark(dir),
    clickMark: (mark) => {
      const m = mark.payload as HistoryViewMark;
      void dispatchSeek(flatPrefix(m.segment) + m.tick);
      highlightMark(m);
    },
  };

  const historyExtras: TransportExtras = {
    get visible() {
      return deps.state.phase === "running" && !deps.state.walkthrough.active;
    },
    // The strip stays put while the tape opens — the busy state shows in
    // the readout and on the disabled controls, in the same positions.
    get controls() {
      return true;
    },
    get loadingText() {
      return undefined;
    },
    testid: "history-transport",
    timelineTestid: "history-timeline",
    timelineLabel: "Session timeline",
    fillTestid: "history-progress-fill",
    thumbTestid: "history-thumb",
    markerClass: "history-marker",
    get play() {
      const v = view();
      if (v.active)
        return {
          testid: "btn-history-resume",
          icon: "play" as const,
          label: "Resume from here",
          title: "Continue playing from this moment — the current session is kept as a branch",
          aria: "Resume from here",
          disabled: !v.canResume || v.diverged !== null || v.seeking,
          run: () => void resumeFromHere(),
        };
      if (v.parked)
        return {
          testid: "btn-transport-resume",
          icon: "play" as const,
          label: "Resume",
          title: "Resume the game where it paused (Space)",
          aria: "Resume",
          disabled: false,
          run: resumeLive,
        };
      return {
        testid: "btn-transport-pause",
        icon: "pause" as const,
        label: "Pause",
        title: "Pause the game (Space)",
        aria: "Pause",
        disabled: v.loading,
        run: pauseAtLive,
      };
    },
    get speedGroup() {
      const v = view();
      return v.active && v.watching;
    },
    get live() {
      return {
        testid: "history-live",
        get here() {
          return !view().active;
        },
        run: goLive,
      };
    },
    speedTestid: "history-speed-",
    speedActiveClass: "history-speed-btn--active",
    tooltipClass: "history-tooltip",
    speedTitle: (speed) => `Watch at ${speed}×`,
    get readout() {
      const v = view();
      if (v.loading) return "Opening the tape…";
      if (v.active) {
        const total = flatTotal();
        const pct = total > 0 ? Math.round((flatPosition() / total) * 100) : 0;
        return `Room ${v.room} · ${pct}%${v.seeking ? " · replaying…" : ""}`;
      }
      if (v.parked) return "Paused";
      return "LIVE";
    },
    posTestid: "history-pos",
    get dropped() {
      return view().dropped;
    },
    get trailing() {
      const v = view();
      const buttons: TransportButton[] = [];
      if (v.active) {
        buttons.push({
          testid: "btn-history-bookmark",
          title: "Pin this moment on the tape",
          aria: "Bookmark this moment",
          icon: "bookmark",
          run: () => void addBookmark(),
        });
        buttons.push({
          testid: "btn-history-watch",
          title: v.watching
            ? v.playing
              ? "Pause the tape"
              : "Keep watching the tape unfold"
            : "Watch the recording play out from here — taking control stays the main button",
          label: v.watching ? (v.playing ? "Pause tape" : "Resume tape") : "Watch from here",
          variant: "secondary",
          run: toggleWatch,
        });
      }
      if (v.branches > 0)
        buttons.push({
          testid: "btn-undo-rewind",
          title: "Restore the session kept by the last rewind; the current one is kept instead",
          label: "Undo rewind",
          variant: "secondary",
          run: () => void undoRewind(),
        });
      return buttons;
    },
    storyPause: undefined,
    get pending() {
      if (view().pendingSwaps === 0) return undefined;
      return {
        testid: "history-pending-swap",
        text: "A kept session is still being recovered — play continues normally.",
        buttons: [],
      };
    },
    get errors() {
      const v = view();
      const errors: { testid: string; text: string; details?: string }[] = [];
      if (v.error !== "") errors.push({ testid: "history-error", text: v.error });
      if (v.diverged !== null)
        errors.push({
          testid: "history-diverged",
          text: "This moment can't be restored — the recording stops agreeing with itself here.",
          details: v.diverged.detail,
        });
      return errors;
    },
  };

  const transport = useTransport(historySource, historyExtras);

  return {
    resetHistoryView,
    observeBatch,
    openHistory,
    closeHistory,
    exitHistory,
    pauseAtLive,
    resumeLive,
    goLive,
    seekTo,
    dispatchSeek,
    stepMark,
    cancelSeek,
    playHistory,
    pauseHistory,
    toggleWatch,
    setHistorySpeed,
    primaryAction,
    transportToggle,
    resumeFromHere,
    undoRewind,
    addBookmark,
    jumpToVisit,
    highlightMark,
    applyReport,
    transport,
  };
}

export type HistoryViewController = ReturnType<typeof useHistoryView>;
