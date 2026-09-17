/**
 * The worker's timers: the 60 Hz host-poll interval and the sound clock
 * interval, plus the functions a logic cycle is made of. Pure functions of
 * the worker context — importable under Node.
 */
import type { Inbound, WorkerContext } from "./context.ts";

/** Poll input/modal services at display cadence; v10 separately gates logic cycles. */
const HOST_POLL_MS = 1000 / 60;

/** Liveness observations stay responsive at slow game-selected cycle speeds. */
const CYCLE_REPORT_MS = 250;

export function createCycle(ctx: WorkerContext) {
  function tickEngine(): void {
    if (!ctx.engine) return;
    ctx.cycle.initialLogicStarted = true;
    // A suspended interaction freezes the cycle until its answer lands — the
    // gate inside tick() is the same, but skipping here keeps the recorder's
    // operation list honest: a parked tick never runs.
    if (ctx.engine.hostInteractionPending && !ctx.engine.hostInteractionReady) return;
    if (ctx.recording.recording) {
      ctx.recording.recording.tape.run("tick", () => ctx.engine!.tick());
      // A tick that ended suspended stays one recorded operation: the resumed
      // answer and the calls it produces join the same list on the next tick.
      if (ctx.engine!.awaitingHostAnswer) ctx.recording.recording.tape.holdTick();
    } else ctx.engine.tick();
  }

  function recordedClock(): void {
    // A discharged sound tick mutates the engine immediately, so the tape
    // must order it: inside a host poll it joins that poll's clock
    // observation; outside one — the sound timer's own interval, or a
    // mid-dispatch advance before a host request suspends — it spills, and
    // the next recorded boundary emits it as a `clock` cause first. Folding
    // every discharge into the next poll's observation would let a pause or
    // input recorded in between replay ahead of a mutation it followed.
    const h = ctx.history;
    if (ctx.replay.replay === null && h.segment !== null) {
      if (h.inPoll) {
        h.pendingSound++;
      } else {
        if (h.pendingSpill === 0) h.spillTick = ctx.cycle.tickCount - h.tickBase;
        h.pendingSpill++;
      }
    }
    ctx.recording.recording?.tape.clock();
    ctx.engine?.advanceClock(1000 / 60);
    ctx.engine?.soundTick();
  }

  function stopTimers(): void {
    if (ctx.cycle.timer !== null) {
      clearInterval(ctx.cycle.timer);
      ctx.cycle.timer = null;
    }
    if (ctx.cycle.soundTimer !== null) {
      clearInterval(ctx.cycle.soundTimer);
      ctx.cycle.soundTimer = null;
    }
  }

  /** Completed interpreter cycle: count it, attribute state writes, ship trace. */
  function finishCycle(): void {
    ctx.cycle.cycleCount++;
    ctx.fns.captureStateDiffs();
    ctx.fns.noteTransition();
    ctx.fns.flushTraceBatch();
    ctx.fns.historyBoundary();
  }

  function advanceSoundClock(authoring = false): void {
    if (ctx.replay.replay && !ctx.replay.historyReplay) return;
    const frozen = authoring || ctx.cycle.paused;
    const ticks = ctx.clocks.sound.advance(ctx.ports.now(), frozen);
    for (let tick = 0; tick < ticks; tick++) {
      recordedClock();
    }
  }

  /**
   * One host poll — the timer body, the walkthrough drive's per-tick step
   * and the history drive's. `obs` carries the scheduler's recorded
   * decision when a tape supplies one (sound ticks discharged on the poll,
   * whether its cycle poll fired); live play and game-test replays derive
   * both from `now`. Each field falls back to the clock's own derivation,
   * so a lane with a torn coverage gap replays like the nominal tape.
   * The caller owns its tick axis. Returns whether a logic cycle ran —
   * the live recorder folds that into the poll's clock observation.
   */
  function stepHostTick(now: number, obs?: { sound?: number; cycle?: boolean }): boolean {
    const engine = ctx.engine;
    if (!engine) return false;
    // Discharges inside this boundary count toward its clock observation;
    // ones outside spill into the event stream in arrival order instead.
    ctx.history.inPoll = true;
    try {
      if (ctx.cycle.paused) {
        // The frozen clock still re-bases so a resume inherits no backlog;
        // stray discharges recorded under a paused poll still feed — the
        // pause landed after them on the live tick axis.
        const parked = obs?.sound ?? ctx.clocks.sound.advance(now, true);
        for (let i = 0; i < parked; i++) recordedClock();
        ctx.clocks.cycle.poll(now, engine.vars[10]!, true);
        return false;
      }
      // pause freezes the original pacing counter; ordinary modal waits do not.
      if (engine.timerPaused) ctx.clocks.cycle.freeze(now);
      else ctx.clocks.cycle.advance(now);
      // The clock always advances — its carry stays honest across the tick —
      // but a recorded lane feeds its own count, never the re-derived one.
      const discharged = ctx.clocks.sound.advance(now, false);
      const soundTicks = obs?.sound ?? discharged;
      for (let i = 0; i < soundTicks; i++) recordedClock();
      ctx.fns.deliverQueuedKey();
      if (
        engine.modalKind !== null ||
        engine.continuationPending ||
        engine.hostInteractionPending
      ) {
        tickEngine();
        ctx.fns.noteTransition();
        ctx.fns.flushTraceBatch();
        ctx.fns.postFrame();
        if (ctx.hostRequests.pendingReenter && !engine.hostInteractionPending) {
          // The suspended re-entered room has landed (or been declined).
          ctx.hostRequests.pendingReenter = false;
          // A landed re-enter already consumed its cause; a declined one
          // must not leave it armed for the next real transition.
          ctx.journal.pendingCause = null;
          ctx.fns.noteTransition();
          ctx.fns.postFrame(true);
        }
        return false;
      }
      // The cycle clock always polls — its accumulators stay honest — but a
      // recorded lane decides whether the live poll fired.
      const polled = ctx.clocks.cycle.poll(now, engine.vars[10]!);
      if (!(obs?.cycle ?? polled)) return false;
      ctx.fns.flushDeferredMovement();
      tickEngine();
      finishCycle();
      ctx.fns.postFrame(true);
      return true;
    } finally {
      ctx.history.inPoll = false;
    }
  }

  /**
   * One host-poll pass — the timer body, also driven directly by Node tests
   * with a controllable ports.now().
   */
  function hostTick(): void {
    const now = ctx.ports.now();
    if (!ctx.engine) return;
    // The recorded tick axis is the host poll, not the sound tick: a poll
    // carries as many sound ticks as elapsed wall time discharges — the
    // post-pause backlog burst replays inside this one boundary.
    ctx.cycle.tickCount++;
    const cycleFired = stepHostTick(now);
    // The poll's clock observation: the sound ticks wall time discharged
    // since the previous poll plus whether its cycle poll fired — the tape
    // records the scheduler's output, never the wall clock itself.
    ctx.fns.historyClockObs(cycleFired);
    if (now - ctx.cycle.lastCycleReportAt >= CYCLE_REPORT_MS) {
      ctx.cycle.lastCycleReportAt = now;
      const scalars = ctx.engine.readState();
      ctx.ports.presentation({
        type: "cycle",
        cycle: ctx.cycle.cycleCount,
        room: scalars.room,
        egoX: scalars.egoX,
        egoY: scalars.egoY,
      });
    }
    if (Date.now() - ctx.autosave.lastAutosaveAt >= ctx.autosave.autosaveIntervalMs)
      ctx.fns.autosave(false);
  }

  function startTimers(): void {
    if (ctx.cycle.soundTimer === null) {
      ctx.cycle.soundTimer = setInterval(() => {
        try {
          advanceSoundClock();
        } catch (error) {
          ctx.ports.control({ type: "error", message: String(error) });
          stopTimers();
        }
      }, 1000 / 60) as unknown as number;
    }
    if (ctx.cycle.timer === null) {
      ctx.cycle.timer = setInterval(() => {
        try {
          hostTick();
        } catch (e) {
          stopTimers();
          ctx.ports.control({ type: "error", message: String(e) });
        }
      }, HOST_POLL_MS) as unknown as number;
    }
  }

  function onPause(msg: Inbound<"pause">): void {
    ctx.cycle.paused = msg.paused === true;
    // An adopted session carries its recorded clock across the parked
    // interval: restoring it at adopt time would lose the accumulators to
    // the first parked poll, so it lands now — once, on release.
    if (!ctx.cycle.paused && ctx.cycle.pendingClock !== null) {
      // The snapshot's own paused flag would re-discard the accumulators on
      // the next poll — the host is releasing, so the restored clock runs.
      const { remainder, increments } = ctx.cycle.pendingClock;
      ctx.clocks.cycle.restore({ remainder, increments, paused: false }, ctx.ports.now());
      ctx.cycle.pendingClock = null;
    }
    // The ack carries the authoritative cycle counter: the heartbeat only
    // reports every CYCLE_REPORT_MS, so a pause landing between reports
    // would leave the host asserting against a stale count.
    ctx.ports.control({
      type: "paused",
      paused: ctx.cycle.paused,
      cycle: ctx.cycle.cycleCount,
    });
  }

  return {
    onPause,
    tickEngine,
    recordedClock,
    stopTimers,
    finishCycle,
    advanceSoundClock,
    stepHostTick,
    hostTick,
    startTimers,
  };
}

export type CycleModule = ReturnType<typeof createCycle>;
