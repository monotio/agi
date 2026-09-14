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
    if (ctx.cycle.paused) {
      ctx.clocks.cycle.poll(now, ctx.engine.vars[10]!, true);
      return;
    }
    advanceSoundClock();
    ctx.fns.deliverQueuedKey();
    if (
      ctx.engine.modalKind !== null ||
      ctx.engine.continuationPending ||
      ctx.engine.hostInteractionPending
    ) {
      tickEngine();
      ctx.fns.noteTransition();
      ctx.fns.flushTraceBatch();
      ctx.fns.postFrame();
      if (ctx.hostRequests.pendingReenter && !ctx.engine.hostInteractionPending) {
        // The suspended re-entered room has landed (or been declined).
        ctx.hostRequests.pendingReenter = false;
        // A landed re-enter already consumed its cause; a declined one
        // must not leave it armed for the next real transition.
        ctx.journal.pendingCause = null;
        ctx.fns.noteTransition();
        ctx.fns.postFrame(true);
      }
    } else if (ctx.clocks.cycle.poll(now, ctx.engine.vars[10]!)) {
      ctx.fns.flushDeferredMovement();
      tickEngine();
      finishCycle();
      ctx.fns.postFrame(true);
    }
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
    ctx.ports.control({ type: "paused", paused: ctx.cycle.paused });
  }

  return {
    onPause,
    tickEngine,
    recordedClock,
    stopTimers,
    finishCycle,
    advanceSoundClock,
    hostTick,
    startTimers,
  };
}

export type CycleModule = ReturnType<typeof createCycle>;
