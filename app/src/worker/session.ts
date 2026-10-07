import { CycleClock } from "../../../src/runtime/cycleClock.ts";
import { SoundClock } from "./soundClock.ts";
import type { WorkerContext } from "./context.ts";

/** End the tape owned by a departing live engine without changing its successor's state. */
export function resetRecording(ctx: WorkerContext): void {
  if (ctx.run.recording.recording !== null) ctx.ports.control({ type: "recordingReset" });
  ctx.run.recording.recording = null;
}

/** Move both host clocks with the session interpreter. */
export function configureSessionTiming(ctx: WorkerContext): void {
  const timing = ctx.run.engine?.timing;
  if (!timing) return;
  ctx.boot.amigaRegion = ctx.run.engine!.amigaRegion;
  if (ctx.run.clocks.sound.hz !== timing.soundHz)
    ctx.run.clocks.sound = new SoundClock(ctx.ports.now(), timing.soundHz);
  if (ctx.run.clocks.cycle.incrementMs !== timing.timerIncrementMs)
    ctx.run.clocks.cycle = new CycleClock(ctx.ports.now(), timing.timerIncrementMs);
}
