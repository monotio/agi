/**
 * The replay drive: one virtual host poll (`replayTick`) feeds the shared
 * `stepHostTick` with a clock observation — the walkthrough's perfect
 * 60 Hz lane, or the tape's recorded lane. Two drives sit on it: the
 * live-session drive here (`createReplay`: seeded RNG, chunked advance,
 * reset/exit) and the scratch tape drive (historyDrive.ts).
 *
 * Pure functions of the worker context — importable under Node.
 */
import { Engine } from "../../../src/runtime/engine.ts";
import { openContainer } from "../../../src/container/container.ts";
import type { ReplayObservation } from "../walkthrough/replay.ts";
import type { Inbound, ReplaySnapshot, WorkerContext } from "./context.ts";
import { resetSession } from "./session.ts";

/**
 * One virtual host poll on a replay context: advance the recorded tick
 * axis and run the shared host-tick step under the given clock observation.
 * `obs` carries the recorded decision when a tape supplies one — the sound
 * ticks the live scheduler discharged on that poll and whether its cycle
 * poll fired; the walkthrough's nominal lane is a fixed one-per-poll.
 */
export function replayTick(ctx: WorkerContext, obs?: { sound?: number; cycle?: boolean }): void {
  const replay = ctx.replay.replay;
  if (replay === null) return;
  replay.tick++;
  ctx.cycle.tickCount = replay.tick;
  ctx.fns.stepHostTick((replay.tick * 1000) / 60, obs);
}

interface ReplayAdvanceOptions {
  request: number;
  session: number;
  seeking: boolean;
  renderFinal: boolean;
  fullState: boolean;
}

/**
 * Checkpoint snapshots a live replay holds for backward seeks. Past the cap
 * the set halves its density rather than evicting the early tape outright —
 * walkthroughs carry at most ~60 checkpoints, so this only binds on a
 * pathological artifact.
 */
const REPLAY_SNAPSHOT_LIMIT = 128;

export function createReplay(ctx: WorkerContext) {
  function postReplay(blocked: string | null, fullState = false): void {
    if (!ctx.replay.replay || !ctx.engine) return;
    const isFull = fullState || blocked !== null;
    const state = isFull ? ctx.engine.readState() : ctx.engine.readLeanState();
    const rows = isFull ? Array.from({ length: 25 }, (_, row) => ctx.engine!.textRow(row)) : [];
    const observation: ReplayObservation = {
      sessionId: ctx.replay.currentSessionId,
      revision: ++ctx.replay.replay.revision,
      tick: ctx.replay.replay.tick,
      cycle: ctx.cycle.cycleCount,
      blocked,
      state,
      rows,
      egoView: ctx.engine.screenObjects[0]!.view,
      releaseGate: ctx.engine.releaseGate,
    };
    ctx.ports.control({
      type: "replay",
      sessionId: ctx.replay.currentSessionId,
      id: ctx.replay.replayRequest,
      observation,
    });
    ctx.replay.replayRequest = null;
  }

  /**
   * One time-sliced chunk of a replayAdvance request; re-schedules itself on
   * a zero-delay timeout while ticks remain. A parked host wait consumes no
   * replay ticks, exactly as the blocking bridge did: its answer's delivery
   * resumes the chunk.
   */
  function advanceReplay(remaining: number, options: ReplayAdvanceOptions): void {
    if (!ctx.replay.replay || !ctx.engine) return;
    if (
      ctx.replay.replayRequest !== options.request ||
      ctx.replay.currentSessionId !== options.session
    )
      return;

    const startTime = ctx.ports.now();
    let chunkTicks = 0;
    const maxChunkTicks = options.seeking ? 2500 : 250;
    const maxChunkMs = options.seeking ? 16 : 12;
    try {
      while (remaining > 0 && chunkTicks < maxChunkTicks) {
        if (ctx.engine.awaitingHostAnswer) break;
        // One sound tick per virtual poll — the walkthrough's perfect
        // 60 Hz clock; the cycle decision polls the clock reset to virtual
        // time.
        replayTick(ctx, { sound: 1 });
        remaining--;
        chunkTicks++;
        if ((chunkTicks & 63) === 0 && ctx.ports.now() - startTime >= maxChunkMs) {
          break;
        }
      }
    } catch (e) {
      ctx.ports.control({ type: "error", id: options.request, message: String(e) });
      return;
    }

    // The runner already has its blocked observation from postReplay(op);
    // the answer's delivery posts the next one.
    if (ctx.engine.awaitingHostAnswer) return;
    if (remaining > 0) {
      setTimeout(() => advanceReplay(remaining, options), 0);
      return;
    }

    if (!options.seeking || options.renderFinal) {
      ctx.replay.isSeeking = false;
      ctx.fns.postFrame();
    }
    postReplay(null, options.fullState);
  }

  function onReplayAdvance(msg: Inbound<"replayAdvance">): void {
    if (!ctx.replay.replay || !ctx.engine) return;
    if (typeof msg.sessionId === "number") ctx.replay.currentSessionId = msg.sessionId;
    const ticks = Number(msg.ticks);
    if (!Number.isInteger(ticks) || ticks < 0 || ticks > 100_000)
      throw new Error("Replay advance requires 0..100000 virtual ticks.");
    const seeking = Boolean(msg.seeking);
    ctx.replay.isSeeking = seeking;
    ctx.replay.replayRequest = Number(msg.id);
    advanceReplay(ticks, {
      request: ctx.replay.replayRequest,
      session: ctx.replay.currentSessionId,
      seeking,
      renderFinal: Boolean(msg.renderFinal),
      fullState: Boolean(msg.fullState),
    });
  }

  /**
   * Store the current replay position as a seek target. Only resumable
   * boundaries snapshot — a live host request owns the answer and a text
   * screen owns the surface — so a refused image just skips this point.
   */
  function onReplaySnapshot(msg: Inbound<"replaySnapshot">): void {
    const replay = ctx.replay.replay;
    const engine = ctx.engine;
    if (!replay || !engine || ctx.replay.historyReplay) return;
    if (
      typeof msg.sessionId === "number" &&
      msg.sessionId !== 0 &&
      msg.sessionId !== ctx.replay.currentSessionId
    )
      return;
    // A prompt-parked boundary is not replayable: the continuation would
    // restore the parked interaction, but the host-request pairing that a
    // tape `answer` resolves against lives outside the snapshot. A
    // debugger-parked or armed mid-pass engine has no resumable boundary
    // either — recordingImage would throw.
    if (
      engine.awaitingHostAnswer ||
      ctx.hostRequests.hostRequestOutstanding !== null ||
      ctx.fns.debugCaptureBlocked()
    )
      return;
    const image = engine.recordingImage();
    if (!image) return;
    const snapshots = ctx.replay.snapshots;
    snapshots.set(replay.tick, {
      tick: replay.tick,
      cycle: ctx.cycle.cycleCount,
      image,
      replay: engine.captureReplayState(),
      rng: replay.random,
      keyQueue: [...ctx.input.keyQueue],
      deferredMovement: [...ctx.input.deferredMovement],
      inputBuffer: [...ctx.input.inputBuffer],
      clickQueue: ctx.input.clickQueue.map(([x, y]): [number, number] => [x, y]),
      requestSerial: ctx.hostRequests.hostRequestSerial,
      clock: ctx.cycle.pendingClock ?? ctx.clocks.cycle.snapshot(),
      soundRemainder: ctx.clocks.sound.snapshot(),
    });
    if (snapshots.size <= REPLAY_SNAPSHOT_LIMIT) return;
    const ticks = [...snapshots.keys()].sort((a, b) => a - b);
    for (let i = 1; i < ticks.length; i += 2) snapshots.delete(ticks[i]!);
  }

  /**
   * Rebuild the replay session at the nearest snapshot at or before the
   * requested tick — a fresh boot when none covers it. The runner follows
   * with the tape suffix, so only the gap replays. The restored position's
   * observation answers the request.
   */
  function onReplayRestore(msg: Inbound<"replayRestore">): void {
    if (!ctx.boot.currentBootFiles || !ctx.boot.currentDictionary) return;
    if (!ctx.replay.replay || ctx.replay.historyReplay || ctx.view.recording !== null) return;
    if (typeof msg.sessionId === "number") ctx.replay.currentSessionId = msg.sessionId;
    ctx.replay.isSeeking = true;
    // Supersede any advance still self-scheduling; the reply posts on this id.
    ctx.replay.replayRequest = Number(msg.id);

    let snap: ReplaySnapshot | null = null;
    for (const candidate of ctx.replay.snapshots.values()) {
      if (candidate.tick <= msg.tick && (snap === null || candidate.tick > snap.tick))
        snap = candidate;
    }

    if (ctx.engine) ctx.engine.stopSound();
    // The live segment ends here, exactly as a reset's does.
    ctx.fns.historyEnd("walkthrough");
    ctx.fns.abandonHostRequest();
    ctx.fns.setKeyWaiting(false);

    const tick = snap?.tick ?? 0;
    ctx.replay.replay = {
      tick,
      revision: 0,
      random: (snap?.rng ?? ctx.replay.lastReplaySeed ?? 0) & 0xffff,
    };
    ctx.replay.reseeds = [];
    ctx.replay.reseedCursor = 0;
    ctx.replay.historyReplay = false;
    ctx.engine = new Engine(
      openContainer(
        ctx.boot.currentBootFiles,
        ctx.boot.profile ? { profile: ctx.boot.profile } : {},
      ),
      ctx.host,
      ctx.boot.currentDictionary,
      ctx.boot.profile ? { profile: ctx.boot.profile } : undefined,
    );
    ctx.fns.armJournal();
    ctx.engine.flags[9] = 1;
    resetSession(ctx);
    if (snap !== null) {
      // The image carries the recorded presentation — re-stamping status and
      // input rows would rewrite the text ages the snapshot holds.
      ctx.engine.restoreImage(snap.image, { preservePresentation: true });
      ctx.engine.restoreReplayState(snap.replay);
      ctx.input.keyQueue = [...snap.keyQueue];
      ctx.input.deferredMovement = [...snap.deferredMovement];
      ctx.input.inputBuffer = [...snap.inputBuffer];
      ctx.input.clickQueue = snap.clickQueue.map(([x, y]): [number, number] => [x, y]);
      ctx.hostRequests.hostRequestSerial = snap.requestSerial;
      // The replay tick axis is virtual time; both clocks re-base onto it.
      const virtualNow = (tick * 1000) / 60;
      ctx.clocks.cycle.restore(snap.clock, virtualNow);
      ctx.clocks.sound.restore(virtualNow, snap.soundRemainder);
      ctx.cycle.paused = snap.clock.paused;
      ctx.cycle.tickCount = tick;
      ctx.cycle.cycleCount = snap.cycle;
      if (ctx.engine.awaitingKey) ctx.fns.setKeyWaiting(true);
    }
    // The scratch engine replaced the live one — a debug session rebinds
    // against its build under a fresh epoch.
    ctx.fns.debugSessionReplaced();
    postReplay(null);
  }

  function onResetReplay(msg: Inbound<"resetReplay">): void {
    if (!ctx.boot.currentBootFiles || !ctx.boot.currentDictionary) return;
    if (typeof msg.sessionId === "number") ctx.replay.currentSessionId = msg.sessionId;
    ctx.replay.isSeeking = Boolean(msg.seeking);
    ctx.replay.snapshots.clear();
    if (ctx.engine) ctx.engine.stopSound();
    const seed =
      typeof msg.seed === "number"
        ? msg.seed
        : ctx.replay.lastReplaySeed !== null
          ? ctx.replay.lastReplaySeed
          : 0;
    // The live segment ends here: the scratch session's traffic is never
    // recorded, and resuming starts a fresh segment marked resumed-from.
    ctx.fns.historyEnd("walkthrough");
    ctx.replay.replay = { tick: 0, revision: 0, random: seed & 0xffff };
    ctx.replay.reseeds = [];
    ctx.replay.reseedCursor = 0;
    ctx.replay.historyReplay = false;
    // A request in flight belonged to the replaced engine; its late answer
    // is dropped by the serial check and the host resolves its UI now.
    ctx.fns.abandonHostRequest();
    ctx.fns.setKeyWaiting(false);
    ctx.engine = new Engine(
      openContainer(
        ctx.boot.currentBootFiles,
        ctx.boot.profile ? { profile: ctx.boot.profile } : {},
      ),
      ctx.host,
      ctx.boot.currentDictionary,
      ctx.boot.profile ? { profile: ctx.boot.profile } : undefined,
    );
    ctx.fns.armJournal();
    ctx.engine.flags[9] = 1;
    resetSession(ctx);
    ctx.fns.debugSessionReplaced();
    if (!msg.seeking) {
      ctx.fns.postFrame();
    }
    postReplay(null);
  }

  function onExitReplay(): void {
    // The replayed engine becomes the live one: its RNG word becomes the
    // live RNG state so the resumed segment's boot records it faithfully.
    if (ctx.replay.replay) ctx.history.rng = ctx.replay.replay.random;
    ctx.replay.replay = null;
    ctx.replay.reseeds = [];
    ctx.replay.reseedCursor = 0;
    ctx.replay.historyReplay = false;
    ctx.replay.currentSessionId = 0;
    ctx.replay.isSeeking = false;
    ctx.replay.snapshots.clear();
    ctx.fns.rebaselineJournal();
    ctx.cycle.paused = false;
    ctx.presentation.recentRing.reset();
    ctx.presentation.historyRing.reset();
    ctx.clocks.sound.reset(ctx.ports.now());
    ctx.clocks.cycle.reset(ctx.ports.now());
    ctx.cycle.lastCycleReportAt = ctx.ports.now();
    ctx.fns.stopTimers();
    ctx.fns.startTimers();
    // Live play continues under a new segment marked resumed-from — the
    // original recording is never rewritten.
    ctx.fns.historyResume();
    ctx.fns.postFrame();
  }

  return {
    postReplay,
    onReplayAdvance,
    onReplaySnapshot,
    onReplayRestore,
    onResetReplay,
    onExitReplay,
  };
}
