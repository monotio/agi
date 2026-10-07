/**
 * Frame generation: the sameness cache, the recent/history rings, and the
 * frames/renderFrame handlers. Pure functions of the worker context —
 * importable under Node.
 */
import type { Engine } from "../../../src/runtime/engine.ts";
import type { Inbound, WorkerContext } from "./context.ts";

export function createPresentation(ctx: WorkerContext) {
  function postFrame(capture = false): void {
    if (!ctx.run.engine || ctx.replay.isSeeking) return;
    const enabled = ctx.run.engine.flags[9] !== 0;
    if (enabled !== ctx.run.presentation.lastSoundEnabled) {
      ctx.run.presentation.lastSoundEnabled = enabled;
      ctx.ports.presentation({ type: "soundEnabled", enabled });
    }
    const controls = ctx.run.engine.readControls();
    const serialized = JSON.stringify(controls);
    if (serialized !== ctx.run.presentation.lastControls) {
      ctx.run.presentation.lastControls = serialized;
      ctx.ports.presentation({ type: "controls", controls });
    }
    if (ctx.run.engine.inputEdit !== ctx.run.presentation.lastInputEdit) {
      ctx.run.presentation.lastInputEdit = ctx.run.engine.inputEdit;
      ctx.ports.presentation({ type: "inputEdit", text: ctx.run.presentation.lastInputEdit });
    }
    const frame = ctx.run.engine.getPresentation();
    if (capture) captureFrame(frame);
    if (ctx.run.engine === ctx.imagePreviewEngine)
      ctx.imageHeroPreview?.(frame, ctx.run.cycle.cycleCount);
    const modal = ctx.run.engine.modalKind;
    const textCells = frame.text;
    // Armed inspector channels join the sameness check so a sprite's sub-pixel
    // or slot change still ships its fresh ownership/objects payload.
    const ownership = ctx.run.debug.channels.ownership ? ctx.run.engine.getOwnership() : null;
    const objects = ctx.run.debug.channels.objects ? ctx.run.engine.readObjects() : null;
    const picture = ctx.run.debug.channels.picture ? ctx.run.engine.getPictureSurface() : null;
    // The show.obj preview mask is composition metadata, not an armed channel:
    // it travels with every frame while the modal is open so layered
    // renderers can give the cel its own identifiable layer.
    const preview = ctx.run.engine.getPreviewMask();
    const objectsJson = objects ? JSON.stringify(objects) : "";
    // Repeated display/trace opcodes can mark text dirty without changing a cell.
    // Sending those frames floods software GPU renderers and delays user input.
    let same =
      ctx.run.cycle.lastInputReady === ctx.run.cycle.initialLogicStarted &&
      ctx.run.presentation.lastModal === modal &&
      ctx.run.presentation.lastPicRow === ctx.run.engine.displayBase &&
      ctx.run.presentation.lastTextMode === ctx.run.engine.textModeActive &&
      ctx.run.presentation.lastInputEnabled === ctx.run.engine.inputEnabled &&
      ctx.run.presentation.lastReleaseGate === ctx.run.engine.releaseGate &&
      objectsJson === ctx.run.presentation.lastObjectsJson &&
      ctx.run.engine.patchGeneration === ctx.run.presentation.lastPatchGen &&
      ctx.run.presentation.lastText !== null;
    if (same && ctx.run.presentation.lastText) {
      for (let i = 0; i < textCells.length; i++) {
        if (textCells[i] !== ctx.run.presentation.lastText[i]) {
          same = false;
          break;
        }
      }
    }
    if (same && ctx.run.presentation.lastVisual) {
      for (let i = 0; i < frame.visual.length; i++) {
        if (frame.visual[i] !== ctx.run.presentation.lastVisual[i]) {
          same = false;
          break;
        }
      }
    } else if (!ctx.run.presentation.lastVisual) {
      same = false;
    }
    // The composed priority surface is part of the frame's identity: an
    // object can change depth (set.priority, horizon-relative bands) without
    // touching a visual byte, and debug views render the surface itself.
    if (same && ctx.run.presentation.lastPriority) {
      for (let i = 0; i < frame.priority.length; i++) {
        if (frame.priority[i] !== ctx.run.presentation.lastPriority[i]) {
          same = false;
          break;
        }
      }
    } else if (!ctx.run.presentation.lastPriority) {
      same = false;
    }
    // Optional payloads publish on presence transitions both ways, so a
    // disarmed channel never leaves a stale mirror on the host.
    if (same && (ownership === null) !== (ctx.run.presentation.lastOwnership === null)) {
      same = false;
    } else if (same && ownership && ctx.run.presentation.lastOwnership) {
      for (let i = 0; i < ownership.length; i++) {
        if (ownership[i] !== ctx.run.presentation.lastOwnership[i]) {
          same = false;
          break;
        }
      }
    }
    if (same && (preview === null) !== (ctx.run.presentation.lastPreview === null)) {
      same = false;
    } else if (same && preview && ctx.run.presentation.lastPreview) {
      for (let i = 0; i < preview.length; i++) {
        if (preview[i] !== ctx.run.presentation.lastPreview[i]) {
          same = false;
          break;
        }
      }
    }
    if (same && (picture === null) !== (ctx.run.presentation.lastPicture === null)) {
      same = false;
    } else if (same && picture && ctx.run.presentation.lastPicture) {
      for (let i = 0; i < picture.visual.length; i++) {
        if (
          picture.visual[i] !== ctx.run.presentation.lastPicture[i] ||
          picture.priority[i] !== ctx.run.presentation.lastPicturePriority![i]
        ) {
          same = false;
          break;
        }
      }
    }
    if (same) return;
    ctx.run.presentation.lastVisual = frame.visual.slice(); // retained copy, never transferred
    ctx.run.presentation.lastPriority = frame.priority.slice();
    ctx.run.presentation.lastText = textCells.slice();
    ctx.run.presentation.lastOwnership = ownership ? ownership.slice() : null;
    ctx.run.presentation.lastPreview = preview ? preview.slice() : null;
    ctx.run.presentation.lastPicture = picture ? picture.visual.slice() : null;
    ctx.run.presentation.lastPicturePriority = picture ? picture.priority.slice() : null;
    ctx.run.presentation.lastObjectsJson = objectsJson;
    ctx.run.presentation.lastPicRow = ctx.run.engine.displayBase;
    ctx.run.presentation.lastTextMode = ctx.run.engine.textModeActive;
    ctx.run.presentation.lastInputEnabled = ctx.run.engine.inputEnabled;
    ctx.run.cycle.lastInputReady = ctx.run.cycle.initialLogicStarted;
    ctx.run.presentation.lastReleaseGate = ctx.run.engine.releaseGate;
    ctx.run.presentation.lastModal = modal;
    ctx.run.presentation.lastPatchGen = ctx.run.engine.patchGeneration;
    const text = textCells.slice();
    ctx.ports.presentation(
      {
        type: "frame",
        visual: frame.visual,
        priority: frame.priority,
        text,
        picRow: ctx.run.engine.displayBase,
        modal,
        textMode: ctx.run.engine.textModeActive,
        inputEnabled: ctx.run.engine.inputEnabled,
        inputReady: ctx.run.cycle.initialLogicStarted,
        holdToMove: ctx.run.engine.releaseGate !== 0,
        edit: ctx.run.engine.inputEdit,
        cycle: ctx.run.cycle.cycleCount,
        patchGeneration: ctx.run.engine.patchGeneration,
        ...(ownership ? { ownership } : {}),
        ...(objects ? { objects } : {}),
        ...(picture ? { picVisual: picture.visual, picPriority: picture.priority } : {}),
        ...(preview ? { preview } : {}),
      },
      [
        frame.visual.buffer,
        frame.priority.buffer,
        text.buffer,
        ...(ownership ? [ownership.buffer] : []),
        ...(preview ? [preview.buffer] : []),
        ...(picture ? [picture.visual.buffer, picture.priority.buffer] : []),
      ],
    );
  }

  /** Copy the same presentation into the rings before postFrame transfers its buffers. */
  function captureFrame(frame: ReturnType<Engine["getPresentation"]>): void {
    if (!ctx.run.engine || ctx.replay.replay !== null) return;
    ctx.run.presentation.recentRing.push(
      ctx.run.cycle.cycleCount,
      frame.visual,
      frame.priority,
      frame.text,
      ctx.run.engine.displayBase,
    );
    const now = ctx.ports.now();
    if (now - ctx.run.cycle.lastHistoryAt >= 1000) {
      ctx.run.cycle.lastHistoryAt = now;
      ctx.run.presentation.historyRing.push(
        ctx.run.cycle.cycleCount,
        frame.visual,
        frame.priority,
        frame.text,
        ctx.run.engine.displayBase,
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
    const useHistory = step * n > ctx.run.presentation.recentRing.capacity;
    const frames = useHistory ? [] : ctx.run.presentation.recentRing.take(n, step, since);
    if (useHistory) {
      // History samples are timed rather than every fixed number of logic cycles.
      // Select by their actual cycle IDs so a v10 change cannot distort stride.
      const history = ctx.run.presentation.historyRing.take(
        ctx.run.presentation.historyRing.capacity,
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
    if (ctx.run.engine) {
      ctx.replay.isSeeking = false;
      ctx.run.presentation.lastVisual = null;
      ctx.run.presentation.lastText = null;
      postFrame();
    }
  }

  function onFrames(msg: Inbound<"frames">): void {
    serveFrames(msg.id, Number(msg.count ?? 1), Number(msg.stride ?? 1), msg.since ?? null);
  }

  return { postFrame, onRenderFrame, onFrames };
}
