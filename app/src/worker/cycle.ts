import { observeSentence } from "./missedSentences.ts";
/**
 * The worker's timers: the 60 Hz host-poll interval and the sound clock
 * interval, plus the functions a logic cycle is made of. Pure functions of
 * the worker context — importable under Node.
 */
import type { Inbound, WorkerContext } from "./context.ts";

/** Poll input/modal services at display cadence; v10 separately gates logic cycles. */
export const HOST_POLL_MS = 1000 / 60;

/** Liveness observations stay responsive at slow game-selected cycle speeds. */
const CYCLE_REPORT_MS = 250;

export function createCycle(ctx: WorkerContext) {
  /**
   * Runs `run` as one worker tick entry — the single place a controlled
   * pass's completion is counted. With execution control armed the engine's
   * own completed-cycle serial is the witness: a pass that reached its
   * post-logic tail is counted here, wherever the entry came from (cycle
   * poll, host answer, queued key), exactly once; a debugger stop,
   * cooperative yield, fresh suspension or fault left the serial untouched
   * and counts nothing. Unarmed runs always return false — their scheduler
   * branch counts completion itself.
   */
  function runTickEntry(run: () => void): boolean {
    const engine = ctx.engine;
    if (!engine) return false;
    // The debugger's stop latch freezes every entry: a parked or yielded
    // pass counts zero, never reaches the tape or the unarmed completion
    // branch below.
    if (ctx.fns.debugStoppedHeld()) return false;
    const armedSerial = engine.executionControlActive ? engine.completedCycleSerial : null;
    run();
    observeSentence(
      ctx,
      undefined,
      armedSerial === null
        ? !engine.continuationPending && !engine.awaitingHostAnswer && engine.modalKind === null
        : engine.completedCycleSerial !== armedSerial,
    );
    // Whatever the entry latched — a breakpoint, a watch, a pause — is
    // reported before the next atomic operation in the outer loop, and a
    // deferred control arm lands on the boundary a completed pass left.
    ctx.fns.debugAfterEntry();
    // The serial is per engine instance; a replaced engine can never be
    // mistaken for a completion the captured serial preceded.
    if (
      ctx.engine !== engine ||
      armedSerial === null ||
      engine.completedCycleSerial === armedSerial
    )
      return false;
    finishCycle();
    return true;
  }

  function tickEngine(): boolean {
    const engine = ctx.engine;
    if (!engine) return false;
    ctx.cycle.initialLogicStarted = true;
    // A suspended interaction freezes the cycle until its answer lands — the
    // gate inside tick() is the same, but skipping here keeps the recorder's
    // operation list honest: a parked tick never runs.
    if (engine.hostInteractionPending && !engine.hostInteractionReady) return false;
    const tape = ctx.recording.recording?.tape;
    return runTickEntry(() => {
      if (tape) {
        tape.run("tick", () => engine.tick());
        // A tick that ended suspended stays one recorded operation: the resumed
        // answer and the calls it produces join the same list on the next tick.
        if (engine.awaitingHostAnswer) tape.holdTick();
      } else engine.tick();
    });
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
    // A debugger stop inside advanceClock/soundTick latches mid-batch: the
    // remaining discharge loop must not tape clocks the engine never ran —
    // the latch's own early-out is checked before each record.
    if (ctx.fns.debugStoppedHeld()) return;
    if (ctx.replay.replay === null && h.segment !== null) {
      if (h.inPoll) {
        h.pendingSound++;
      } else {
        if (h.pendingSpill === 0) h.spillTick = ctx.cycle.tickCount - h.tickBase;
        h.pendingSpill++;
      }
    }
    ctx.recording.recording?.tape.clock();
    ctx.engine?.advanceClock(1000 / ctx.engine.timing.soundHz);
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
      // The first discharge that stops execution ends the batch: the next
      // recordedClock would record a mutation the engine refused.
      if (ctx.fns.debugStoppedHeld()) break;
      recordedClock();
    }
    // Publish a sound-phase stop the batch latched.
    ctx.fns.debugAfterEntry();
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
      if (ctx.cycle.paused || ctx.fns.debugStoppedHeld()) {
        // An explicit debugger stop freezes like a pause: the clocks keep
        // their fractional carry and rebase wall time so a resume inherits
        // no backlog, and no parked pass runs.
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
      for (let i = 0; i < soundTicks; i++) {
        // A clock or sound phase can stop mid-batch — the remaining due
        // ticks and everything after them must not run in this poll.
        if (ctx.fns.debugStoppedHeld()) return false;
        recordedClock();
      }
      ctx.fns.deliverQueuedKey();
      if (
        engine.modalKind !== null ||
        engine.continuationPending ||
        engine.hostInteractionPending
      ) {
        // Under armed control a parked pass resuming here can run its
        // post-logic tail — tickEngine counted that completion and the poll
        // reports it; anything less still reports no cycle.
        const completed = tickEngine();
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
        return completed;
      }
      // The cycle clock always polls — its accumulators stay honest — but a
      // recorded lane decides whether the live poll fired.
      const polled = ctx.clocks.cycle.poll(now, engine.vars[10]!);
      if (!(obs?.cycle ?? polled)) return false;
      ctx.fns.flushDeferredMovement();
      if (engine.executionControlActive) {
        // Armed control: the poll only decides the pass may run — whether a
        // cycle completed is the engine's serial. tickEngine counted a pass
        // that reached its tail; a stop, yield or fresh suspension counts
        // nothing.
        const completed = tickEngine();
        ctx.fns.noteTransition();
        ctx.fns.flushTraceBatch();
        ctx.fns.postFrame(completed);
        return completed;
      }
      tickEngine();
      finishCycle();
      ctx.fns.postFrame(true);
      return true;
    } finally {
      ctx.history.inPoll = false;
      // Whatever the step latched — a sound/clock-phase stop mid-batch, a
      // pause racing the boundary — publishes before the caller's next
      // atomic operation; replay drives call stepHostTick directly.
      ctx.fns.debugAfterEntry();
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
        delay: ctx.engine.vars[10]!,
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
    runTickEntry,
    recordedClock,
    stopTimers,
    finishCycle,
    advanceSoundClock,
    stepHostTick,
    hostTick,
    startTimers,
  };
}
