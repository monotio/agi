/**
 * Player-action recording for stored game tests: the recording state, the
 * recordEvent sink, and the start/stop/cancel handlers. Pure functions of
 * the worker context — importable under Node.
 */
import { OperationRecorder } from "../../../src/agent/recordedReplay.ts";
import type { RecordedEvent } from "../gameRecording.ts";
import { bytesToBase64 } from "../bytes.ts";
import type { Inbound, WorkerContext } from "./context.ts";

export function createRecording(ctx: WorkerContext) {
  function recordEvent(event: RecordedEvent): void {
    if (!ctx.recording.recording) return;
    if (ctx.recording.recording.events.length >= 5000) {
      ctx.recording.recording.tainted =
        "Recording reached its action limit; record a shorter scenario.";
      return;
    }
    ctx.recording.recording.events.push(event);
  }

  function onStartRecording(msg: Inbound<"startRecording">): void {
    if (!ctx.engine) {
      ctx.ports.control({
        type: "recordingStarted",
        id: msg.id,
        ok: false,
        error: "No game is running.",
      });
      return;
    }
    // The same safe-boundary gates an autosave uses: a suspended host
    // request, a text screen or the pre-first-room gap cannot resume; a
    // parked window or key wait records with its continuation.
    const hostImage = ctx.engine.recordingImage();
    if (!hostImage) {
      ctx.ports.control({
        type: "recordingStarted",
        id: msg.id,
        ok: false,
        error: "Recording needs a quiet moment: answer the open prompt and let the room draw.",
      });
      return;
    }
    ctx.recording.recording = {
      tape: new OperationRecorder(),
      events: [],
      printed: [],
      tainted: null,
      usedGetnum: false,
    };
    ctx.ports.control({
      type: "recordingStarted",
      id: msg.id,
      ok: true,
      image: bytesToBase64(hostImage),
      replayState: ctx.engine.captureReplayState(),
      cycle: ctx.cycle.cycleCount,
      state: ctx.engine.readState(),
    });
  }

  function onStopRecording(msg: Inbound<"stopRecording">): void {
    const taken = ctx.recording.recording;
    ctx.recording.recording = null;
    ctx.ports.control({
      type: "recordingStopped",
      id: msg.id,
      operations: taken?.tape.operations ?? [],
      events: taken?.events ?? [],
      printed: taken?.printed ?? [],
      tainted: taken?.tainted ?? taken?.tape.error ?? null,
      usedGetnum: false,
      cycle: ctx.cycle.cycleCount,
      state: ctx.engine ? ctx.engine.readState() : null,
    });
  }

  function onCancelRecording(): void {
    ctx.recording.recording = null;
  }

  return { recordEvent, onStartRecording, onStopRecording, onCancelRecording };
}

export type RecordingModule = ReturnType<typeof createRecording>;
