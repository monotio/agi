/**
 * Replay drive: the seeded RNG state, the chunked replayAdvance loop, and
 * the reset/exit handlers. Pure functions of the worker context —
 * importable under Node.
 */
import { Engine } from "../../../src/runtime/engine.ts";
import { openContainer } from "../../../src/container/container.ts";
import type { ReplayObservation } from "../replay.ts";
import { resetSession, type Inbound, type WorkerContext } from "./context.ts";

interface ReplayAdvanceOptions {
  request: number;
  session: number;
  seeking: boolean;
  renderFinal: boolean;
  fullState: boolean;
}

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
        ctx.replay.replay.tick++;
        remaining--;
        chunkTicks++;
        ctx.fns.recordedClock();
        if (
          ctx.engine.modalKind !== null ||
          ctx.engine.continuationPending ||
          ctx.engine.hostInteractionPending
        )
          ctx.fns.tickEngine();
        else if (
          ctx.clocks.cycle.poll((ctx.replay.replay.tick * 1000) / 60, ctx.engine.vars[10]!)
        ) {
          ctx.fns.flushDeferredMovement();
          ctx.fns.tickEngine();
          ctx.fns.finishCycle();
        }
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

  function onResetReplay(msg: Inbound<"resetReplay">): void {
    if (!ctx.boot.currentBootFiles || !ctx.boot.currentDictionary) return;
    if (typeof msg.sessionId === "number") ctx.replay.currentSessionId = msg.sessionId;
    ctx.replay.isSeeking = Boolean(msg.seeking);
    if (ctx.engine) ctx.engine.stopSoundPlayback();
    const seed =
      typeof msg.seed === "number"
        ? msg.seed
        : ctx.replay.lastReplaySeed !== null
          ? ctx.replay.lastReplaySeed
          : 0;
    ctx.replay.replay = { tick: 0, revision: 0, random: seed >>> 0 };
    // A request in flight belonged to the replaced engine; its late answer
    // is dropped by the serial check and the host resolves its UI now.
    ctx.fns.abandonHostRequest();
    ctx.fns.setKeyWaiting(false);
    ctx.engine = new Engine(
      openContainer(ctx.boot.currentBootFiles),
      ctx.host,
      ctx.boot.currentDictionary,
    );
    ctx.engine.flags[9] = 1;
    resetSession(ctx);
    if (!msg.seeking) {
      ctx.fns.postFrame();
    }
    postReplay(null);
  }

  function onExitReplay(): void {
    ctx.replay.replay = null;
    ctx.replay.currentSessionId = 0;
    ctx.replay.isSeeking = false;
    ctx.cycle.paused = false;
    ctx.presentation.recentRing.reset();
    ctx.presentation.historyRing.reset();
    ctx.clocks.sound.reset(ctx.ports.now());
    ctx.clocks.cycle.reset(ctx.ports.now());
    ctx.cycle.lastCycleReportAt = ctx.ports.now();
    ctx.fns.stopTimers();
    ctx.fns.startTimers();
    ctx.fns.postFrame();
    ctx.ports.control({ type: "exitedReplay" });
  }

  return { postReplay, onReplayAdvance, onResetReplay, onExitReplay };
}

export type ReplayModule = ReturnType<typeof createReplay>;
