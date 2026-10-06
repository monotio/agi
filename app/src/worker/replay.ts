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
import { replaceRun, detachedHost } from "./runSession.ts";

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
  ctx.run.cycle.tickCount = replay.tick;
  ctx.fns.stepHostTick((replay.tick * 1000) / (ctx.run.engine?.timing.soundHz ?? 60), obs);
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
    if (!ctx.replay.replay || !ctx.run.engine) return;
    const isFull = fullState || blocked !== null;
    const state = isFull ? ctx.run.engine.readState() : ctx.run.engine.readLeanState();
    const rows = isFull ? Array.from({ length: 25 }, (_, row) => ctx.run.engine!.textRow(row)) : [];
    const observation: ReplayObservation = {
      sessionId: ctx.replay.currentSessionId,
      revision: ++ctx.replay.replay.revision,
      tick: ctx.replay.replay.tick,
      cycle: ctx.run.cycle.cycleCount,
      blocked,
      state,
      rows,
      egoView: ctx.run.engine.screenObjects[0]!.view,
      releaseGate: ctx.run.engine.releaseGate,
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
    if (!ctx.replay.replay || !ctx.run.engine) return;
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
        if (ctx.run.engine.awaitingHostAnswer) break;
        // One sound tick per virtual poll — the walkthrough's perfect
        // region-rate clock; the cycle decision polls the clock reset to virtual
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
    if (ctx.run.engine.awaitingHostAnswer) return;
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
    if (!ctx.replay.replay || !ctx.run.engine) return;
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

  /** Stop at the current host-tick boundary and settle the interrupted advance before the pause. */
  function onReplayPause(msg: Inbound<"replayPause">): void {
    if (!ctx.replay.replay || !ctx.run.engine || msg.sessionId !== ctx.replay.currentSessionId)
      return;
    const blocked =
      ctx.run.hostRequests.hostRequestOutstanding?.op ??
      (ctx.run.input.keyWaiting ? "waitkey" : null);
    // Clearing the request invalidates every already-scheduled chunk. Its
    // caller receives the partial position and resumes the remaining tape.
    ctx.replay.isSeeking = false;
    ctx.fns.postFrame();
    if (ctx.replay.replayRequest !== null) postReplay(blocked);
    ctx.replay.replayRequest = msg.id;
    postReplay(blocked);
  }

  /**
   * Store the current replay position as a seek target. Only resumable
   * boundaries snapshot — a live host request owns the answer and a text
   * screen owns the surface — so a refused image just skips this point.
   */
  function onReplaySnapshot(msg: Inbound<"replaySnapshot">): void {
    const replay = ctx.replay.replay;
    const engine = ctx.run.engine;
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
      ctx.run.hostRequests.hostRequestOutstanding !== null ||
      ctx.fns.debugCaptureBlocked()
    )
      return;
    const image = engine.recordingImage();
    if (!image) return;
    const snapshots = ctx.replay.snapshots;
    snapshots.set(replay.tick, {
      tick: replay.tick,
      cycle: ctx.run.cycle.cycleCount,
      image,
      replay: engine.captureReplayState(),
      rng: ctx.run.rng.word,
      rngPolicy: { ...ctx.run.rng.policy },
      keyQueue: [...ctx.run.input.keyQueue],
      deferredMovement: [...ctx.run.input.deferredMovement],
      inputBuffer: [...ctx.run.input.inputBuffer],
      clickQueue: ctx.run.input.clickQueue.map(([x, y]): [number, number] => [x, y]),
      requestSerial: ctx.run.hostRequests.hostRequestSerial,
      clock: ctx.run.cycle.pendingClock ?? ctx.run.clocks.cycle.snapshot(),
      soundRemainder: ctx.run.clocks.sound.snapshot(),
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
    let snap: ReplaySnapshot | null = null;
    for (const candidate of ctx.replay.snapshots.values()) {
      if (candidate.tick <= msg.tick && (snap === null || candidate.tick > snap.tick))
        snap = candidate;
    }

    const tick = snap?.tick ?? 0;
    // Tape-driven replacements regain Create authority only after taking control.
    const facade = detachedHost(ctx);
    const replacement = new Engine(
      openContainer(
        ctx.boot.currentBootFiles,
        ctx.boot.profile ? { profile: ctx.boot.profile } : {},
      ),
      facade.host,
      ctx.boot.currentDictionary,
      {
        ...(ctx.boot.profile ? { profile: ctx.boot.profile } : {}),
        amigaRegion: ctx.boot.amigaRegion,
      },
    );
    replacement.flags[9] = 1;
    if (snap !== null) {
      replacement.restoreImage(snap.image, { preservePresentation: true });
      replacement.restoreReplayState(snap.replay);
    }
    replaceRun(ctx, "replay", {
      engine: replacement,
      admission: null,
      project: ctx.boot.project,
      paused: snap?.clock.paused ?? false,
      activate: facade.activate,
      dictionary: ctx.boot.currentDictionary,
      replay: {
        ...ctx.replay,
        currentSessionId:
          typeof msg.sessionId === "number" ? msg.sessionId : ctx.replay.currentSessionId,
        isSeeking: true,
        replayRequest: Number(msg.id),
        replay: { tick, revision: 0 },
        reseeds: [],
        reseedCursor: 0,
        historyReplay: false,
      },
      rng: {
        word: (snap?.rng ?? ctx.replay.lastReplaySeed ?? 0) & 0xffff,
        policy: structuredClone(
          snap?.rngPolicy ??
            (ctx.replay.rngVersion === 2
              ? { kind: "sequence", next: ctx.replay.lastReplaySeed! & 0xffff, cursor: 0 }
              : { kind: "external" }),
        ),
      },
      ...(snap
        ? {
            resume: {
              cycle: snap.cycle,
              tick,
              virtualNow: (tick * 1000) / replacement.timing.soundHz,
              boot: {
                requestSerial: snap.requestSerial,
                inputQueue: snap.keyQueue,
                directionQueue: snap.deferredMovement,
                inputLines: snap.inputBuffer,
                clickQueue: snap.clickQueue,
                clock: snap.clock,
                soundRemainder: snap.soundRemainder,
              },
            },
          }
        : {}),
    });
    ctx.fns.setKeyWaiting(replacement.awaitingKey);
    // The scratch engine replaced the live one — a debug session rebinds
    // against its build under a fresh epoch.
    postReplay(null);
  }

  function onResetReplay(msg: Inbound<"resetReplay">): void {
    if (!ctx.boot.currentBootFiles || !ctx.boot.currentDictionary) return;
    const seed =
      typeof msg.seed === "number"
        ? msg.seed
        : ctx.replay.lastReplaySeed !== null
          ? ctx.replay.lastReplaySeed
          : 0;
    const rngVersion = msg.rngVersion ?? ctx.replay.rngVersion;
    const facade = detachedHost(ctx);
    const replacement = new Engine(
      openContainer(
        ctx.boot.currentBootFiles,
        ctx.boot.profile ? { profile: ctx.boot.profile } : {},
      ),
      facade.host,
      ctx.boot.currentDictionary,
      {
        ...(ctx.boot.profile ? { profile: ctx.boot.profile } : {}),
        amigaRegion: ctx.boot.amigaRegion,
      },
    );
    replacement.flags[9] = 1;
    replaceRun(ctx, "replay", {
      engine: replacement,
      admission: null,
      project: ctx.boot.project,
      paused: false,
      activate: facade.activate,
      replay: {
        ...ctx.replay,
        currentSessionId:
          typeof msg.sessionId === "number" ? msg.sessionId : ctx.replay.currentSessionId,
        isSeeking: Boolean(msg.seeking),
        snapshots: new Map(),
        rngVersion,
        lastReplaySeed: seed,
        replayRequest: null,
        replay: { tick: 0, revision: 0 },
        reseeds: [],
        reseedCursor: 0,
        historyReplay: false,
      },
      rng: {
        word: seed & 0xffff,
        policy:
          rngVersion === 2
            ? { kind: "sequence", next: seed & 0xffff, cursor: 0 }
            : { kind: "external" },
      },
    });
    if (!msg.seeking) {
      ctx.fns.postFrame();
    }
    postReplay(null);
  }

  function onExitReplay(): void {
    // Taking control keeps the run's RNG word and entropy policy cursor.
    ctx.replay.replay = null;
    ctx.replay.reseeds = [];
    ctx.replay.reseedCursor = 0;
    ctx.replay.historyReplay = false;
    ctx.replay.currentSessionId = 0;
    ctx.replay.isSeeking = false;
    ctx.replay.snapshots.clear();
    ctx.fns.rebaselineJournal();
    ctx.run.cycle.paused = false;
    ctx.run.presentation.recentRing.reset();
    ctx.run.presentation.historyRing.reset();
    ctx.run.clocks.sound.reset(ctx.ports.now());
    ctx.run.clocks.cycle.reset(ctx.ports.now());
    ctx.run.cycle.lastCycleReportAt = ctx.ports.now();
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
    onReplayPause,
    onReplaySnapshot,
    onReplayRestore,
    onResetReplay,
    onExitReplay,
  };
}
