import { CycleClock } from "../../../src/runtime/cycleClock.ts";
import { SoundClock } from "./soundClock.ts";
import type { WorkerContext } from "./context.ts";

/**
 * The session reset both boot and resetReplay share: every field the two
 * handlers cleared identically lives here. Fields they reset differently —
 * isSeeking, currentSessionId, replay, keyWaiting, hostRequestOutstanding and
 * the boot-owned settings — stay in the handlers. applyTraceChannel and
 * captureStateDiffs run last so the diff ring baselines the fresh engine.
 */
export function resetSession(ctx: WorkerContext): void {
  ctx.previewVisitEngine = null;
  ctx.previewVisitSerial++;
  ctx.imageHeroPreview = undefined;
  ctx.imagePreviewEngine = undefined;
  ctx.imagePreviewSerial = (ctx.imagePreviewSerial ?? 0) + 1;
  const now = ctx.ports.now();
  ctx.cycle.initialLogicStarted = false;
  ctx.cycle.paused = false;
  ctx.cycle.pendingClock = null;
  ctx.input.inputBuffer = [];
  ctx.input.sentence = null;
  ctx.input.keyQueue = [];
  ctx.input.clickQueue = [];
  ctx.input.deferredMovement.length = 0;
  resetRecording(ctx);
  ctx.hostRequests.pendingReenter = false;
  const p = ctx.presentation;
  p.lastVisual = null;
  p.lastPriority = null;
  p.lastText = null;
  p.lastOwnership = null;
  p.lastPreview = null;
  p.lastPicture = null;
  p.lastPicturePriority = null;
  p.lastPicRow = -1;
  p.lastTextMode = false;
  p.lastInputEnabled = false;
  p.lastReleaseGate = 0;
  p.lastModal = null;
  p.lastPatchGen = -1;
  p.lastControls = "";
  p.lastInputEdit = "";
  p.lastSoundEnabled = null;
  ctx.fns.stopTimers();
  configureSessionTiming(ctx);
  ctx.clocks.sound.reset(now);
  ctx.clocks.cycle.reset(ctx.replay.replay ? 0 : now);
  ctx.cycle.lastCycleReportAt = now;
  ctx.cycle.lastHistoryAt = now;
  ctx.cycle.tickCount = 0;
  ctx.cycle.cycleCount = 0;
  p.recentRing.reset();
  p.historyRing.reset();
  const d = ctx.debug;
  d.debugEvents.length = 0;
  d.debugEventSeq = 0;
  d.prevVars = null;
  d.prevFlags = null;
  d.traceRing.length = 0;
  d.traceSeq = 0;
  d.pendingTrace = [];
  d.traceEpoch++;
  d.traceBatch = 0;
  d.traceInFlight = 0;
  d.traceDropped = 0;
  ctx.journal.seq = 0;
  ctx.journal.lastRoom = null;
  ctx.journal.lastScore = 0;
  ctx.journal.lastCarried = [];
  ctx.journal.pendingCause = null;
  ctx.journal.pending = [];
  ctx.fns.applyTraceChannel();
  ctx.fns.captureStateDiffs();
}

/** End the tape owned by a departing live engine without changing its successor's state. */
export function resetRecording(ctx: WorkerContext): void {
  if (ctx.recording.recording !== null) ctx.ports.control({ type: "recordingReset" });
  ctx.recording.recording = null;
}

/** Move both host clocks with the session interpreter. */
export function configureSessionTiming(ctx: WorkerContext): void {
  const timing = ctx.engine?.timing;
  if (!timing) return;
  ctx.boot.amigaRegion = ctx.engine!.amigaRegion;
  if (ctx.clocks.sound.hz !== timing.soundHz)
    ctx.clocks.sound = new SoundClock(ctx.ports.now(), timing.soundHz);
  if (ctx.clocks.cycle.incrementMs !== timing.timerIncrementMs)
    ctx.clocks.cycle = new CycleClock(ctx.ports.now(), timing.timerIncrementMs);
}
