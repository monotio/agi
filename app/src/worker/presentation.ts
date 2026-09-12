/**
 * Frame generation: the sameness cache, the recent/history rings, and the
 * frames/renderFrame handlers. Pure functions of the worker context —
 * importable under Node.
 */
import type { Engine } from "../../../src/runtime/engine.ts";
import type { Inbound, WorkerContext } from "./context.ts";

export function createPresentation(ctx: WorkerContext) {
  function postFrame(capture = false): void {
    if (!ctx.engine || ctx.replay.isSeeking) return;
    const enabled = ctx.engine.flags[9] !== 0;
    if (enabled !== ctx.presentation.lastSoundEnabled) {
      ctx.presentation.lastSoundEnabled = enabled;
      ctx.ports.presentation({ type: "soundEnabled", enabled });
    }
    const controls = ctx.engine.readControls();
    const serialized = JSON.stringify(controls);
    if (serialized !== ctx.presentation.lastControls) {
      ctx.presentation.lastControls = serialized;
      ctx.ports.presentation({ type: "controls", controls });
    }
    if (ctx.engine.inputEdit !== ctx.presentation.lastInputEdit) {
      ctx.presentation.lastInputEdit = ctx.engine.inputEdit;
      ctx.ports.presentation({ type: "inputEdit", text: ctx.presentation.lastInputEdit });
    }
    const frame = ctx.engine.getPresentation();
    if (capture) captureFrame(frame);
    const modal = ctx.engine.modalKind;
    const textCells = frame.text;
    // Armed inspector channels join the sameness check so a sprite's sub-pixel
    // or slot change still ships its fresh ownership/objects payload.
    const ownership = ctx.debug.channels.ownership ? ctx.engine.getOwnership() : null;
    const objects = ctx.debug.channels.objects ? ctx.engine.readObjects() : null;
    const picture = ctx.debug.channels.picture ? ctx.engine.getPictureSurface() : null;
    const objectsJson = objects ? JSON.stringify(objects) : "";
    // Repeated display/trace opcodes can mark text dirty without changing a cell.
    // Sending those frames floods software GPU renderers and delays user input.
    let same =
      ctx.cycle.lastInputReady === ctx.cycle.initialLogicStarted &&
      ctx.presentation.lastModal === modal &&
      ctx.presentation.lastPicRow === ctx.engine.displayBase &&
      ctx.presentation.lastTextMode === ctx.engine.textModeActive &&
      ctx.presentation.lastInputEnabled === ctx.engine.inputEnabled &&
      ctx.presentation.lastReleaseGate === ctx.engine.releaseGate &&
      objectsJson === ctx.presentation.lastObjectsJson &&
      ctx.presentation.lastText !== null;
    if (same && ctx.presentation.lastText) {
      for (let i = 0; i < textCells.length; i++) {
        if (textCells[i] !== ctx.presentation.lastText[i]) {
          same = false;
          break;
        }
      }
    }
    if (same && ctx.presentation.lastVisual) {
      for (let i = 0; i < frame.visual.length; i++) {
        if (frame.visual[i] !== ctx.presentation.lastVisual[i]) {
          same = false;
          break;
        }
      }
    } else if (!ctx.presentation.lastVisual) {
      same = false;
    }
    // The composed priority surface is part of the frame's identity: an
    // object can change depth (set.priority, horizon-relative bands) without
    // touching a visual byte, and debug views render the surface itself.
    if (same && ctx.presentation.lastPriority) {
      for (let i = 0; i < frame.priority.length; i++) {
        if (frame.priority[i] !== ctx.presentation.lastPriority[i]) {
          same = false;
          break;
        }
      }
    } else if (!ctx.presentation.lastPriority) {
      same = false;
    }
    // Optional payloads publish on presence transitions both ways, so a
    // disarmed channel never leaves a stale mirror on the host.
    if (same && (ownership === null) !== (ctx.presentation.lastOwnership === null)) {
      same = false;
    } else if (same && ownership && ctx.presentation.lastOwnership) {
      for (let i = 0; i < ownership.length; i++) {
        if (ownership[i] !== ctx.presentation.lastOwnership[i]) {
          same = false;
          break;
        }
      }
    }
    if (same && (picture === null) !== (ctx.presentation.lastPicture === null)) {
      same = false;
    } else if (same && picture && ctx.presentation.lastPicture) {
      for (let i = 0; i < picture.visual.length; i++) {
        if (
          picture.visual[i] !== ctx.presentation.lastPicture[i] ||
          picture.priority[i] !== ctx.presentation.lastPicturePriority![i]
        ) {
          same = false;
          break;
        }
      }
    }
    if (same) return;
    ctx.presentation.lastVisual = frame.visual.slice(); // retained copy, never transferred
    ctx.presentation.lastPriority = frame.priority.slice();
    ctx.presentation.lastText = textCells.slice();
    ctx.presentation.lastOwnership = ownership ? ownership.slice() : null;
    ctx.presentation.lastPicture = picture ? picture.visual.slice() : null;
    ctx.presentation.lastPicturePriority = picture ? picture.priority.slice() : null;
    ctx.presentation.lastObjectsJson = objectsJson;
    ctx.presentation.lastPicRow = ctx.engine.displayBase;
    ctx.presentation.lastTextMode = ctx.engine.textModeActive;
    ctx.presentation.lastInputEnabled = ctx.engine.inputEnabled;
    ctx.cycle.lastInputReady = ctx.cycle.initialLogicStarted;
    ctx.presentation.lastReleaseGate = ctx.engine.releaseGate;
    ctx.presentation.lastModal = modal;
    const text = textCells.slice();
    ctx.ports.presentation(
      {
        type: "frame",
        visual: frame.visual,
        priority: frame.priority,
        text,
        picRow: ctx.engine.displayBase,
        modal,
        textMode: ctx.engine.textModeActive,
        inputEnabled: ctx.engine.inputEnabled,
        inputReady: ctx.cycle.initialLogicStarted,
        holdToMove: ctx.engine.releaseGate !== 0,
        edit: ctx.engine.inputEdit,
        cycle: ctx.cycle.cycleCount,
        ...(ownership ? { ownership } : {}),
        ...(objects ? { objects } : {}),
        ...(picture ? { picVisual: picture.visual, picPriority: picture.priority } : {}),
      },
      [
        frame.visual.buffer,
        frame.priority.buffer,
        text.buffer,
        ...(ownership ? [ownership.buffer] : []),
        ...(picture ? [picture.visual.buffer, picture.priority.buffer] : []),
      ],
    );
  }

  /** Copy the same presentation into the rings before postFrame transfers its buffers. */
  function captureFrame(frame: ReturnType<Engine["getPresentation"]>): void {
    if (!ctx.engine || ctx.replay.replay !== null) return;
    ctx.presentation.recentRing.push(
      ctx.cycle.cycleCount,
      frame.visual,
      frame.priority,
      frame.text,
      ctx.engine.displayBase,
    );
    const now = ctx.ports.now();
    if (now - ctx.cycle.lastHistoryAt >= 1000) {
      ctx.cycle.lastHistoryAt = now;
      ctx.presentation.historyRing.push(
        ctx.cycle.cycleCount,
        frame.visual,
        frame.priority,
        frame.text,
        ctx.engine.displayBase,
      );
    }
  }

  /**
   * Serve a frames request. `stride` 1 reads the full-rate ring; anything
   * coarser than the full-rate ring's span falls back to the 1 Hz history.
   */
  function serveFrames(id: number, count: number, stride: number, since: number | null): void {
    const n = Math.max(1, Math.min(64, Math.floor(count)));
    const step = Math.max(1, Math.floor(stride));
    const useHistory = step * n > ctx.presentation.recentRing.capacity;
    const frames = useHistory ? [] : ctx.presentation.recentRing.take(n, step, since);
    if (useHistory) {
      // History samples are timed rather than every fixed number of logic cycles.
      // Select by their actual cycle IDs so a v10 change cannot distort stride.
      const history = ctx.presentation.historyRing.take(
        ctx.presentation.historyRing.capacity,
        1,
        since,
      );
      let nextCycle = Infinity;
      for (let i = history.length - 1; i >= 0 && frames.length < n; i--) {
        const frame = history[i]!;
        if (frame.cycle > nextCycle) continue;
        frames.push(frame);
        nextCycle = frame.cycle - step;
      }
      frames.reverse();
    }
    const transfer = frames.flatMap((f) => [f.visual.buffer, f.priority.buffer, f.text.buffer]);
    ctx.ports.control(
      { type: "frames", id, source: useHistory ? "history" : "recent", frames },
      transfer,
    );
  }

  function onRenderFrame(): void {
    if (ctx.engine) {
      ctx.replay.isSeeking = false;
      ctx.presentation.lastVisual = null;
      ctx.presentation.lastText = null;
      postFrame();
    }
  }

  function onFrames(msg: Inbound<"frames">): void {
    serveFrames(msg.id, Number(msg.count ?? 1), Number(msg.stride ?? 1), msg.since ?? null);
  }

  return { postFrame, onRenderFrame, onFrames };
}

export type PresentationModule = ReturnType<typeof createPresentation>;
