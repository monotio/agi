/**
 * The autosave snapshot and the flush/checkpoint messages around it. Pure
 * functions of the worker context — importable under Node.
 */
import { createProgressPreview } from "../progressPreview.ts";
import { bytesToBase64 } from "../bytes.ts";
import type { WorkerPresentation } from "../workerProtocol.ts";
import type { Inbound, WorkerContext } from "./context.ts";

/**
 * Autosave cadence. Five seconds is the
 * cheapest interval that is still invisible: one snapshot is a serialize() of
 * a few kilobytes plus a base64 pass, well under a millisecond, and the
 * usual maximum a player can lose to a browser reload is
 * five seconds of walking. Tightening it further buys nothing a player would
 * notice; the flush on page-hide covers the tail.
 */
export const AUTOSAVE_INTERVAL_MS = 5_000;

export function createAutosave(ctx: WorkerContext) {
  /**
   * Take an autosave if this cycle boundary allows one and post it to the host.
   *
   * The engine refuses the snapshot while a live host request owns the answer
   * (a prompt, the save/restore selector, a confirmation), while a text screen
   * owns the surface, or before a room has drawn; a parked window or key wait
   * serializes into the image's continuation instead. The worker adds the cheap
   * gate on top: an image is encoded only when the interpreter actually
   * advanced since the last one, so a parked or idle game costs nothing.
   */
  function autosave(force: boolean): boolean {
    if (!ctx.engine) return false;
    if (!force && ctx.cycle.cycleCount === ctx.autosave.lastAutosaveCycle) return false;
    let image: Uint8Array | null;
    try {
      image = ctx.engine.autosaveImage();
    } catch (error) {
      ctx.ports.presentation({
        type: "log",
        text: `Autosave snapshot failed: ${String(error)}`,
      });
      return false;
    }
    if (!image) return false;
    const msg: Extract<WorkerPresentation, { type: "autosave" }> = {
      type: "autosave",
      image: bytesToBase64(image),
      menus: ctx.engine.readMenuState(),
      cycle: ctx.cycle.cycleCount,
      room: ctx.engine.vars[0]!,
    };
    try {
      const presentation = ctx.engine.getPresentation();
      msg.preview = createProgressPreview({
        visual: presentation.visual,
        text: presentation.text,
        picRow: ctx.engine.displayBase,
      });
    } catch (error) {
      ctx.ports.presentation({
        type: "log",
        text: `Autosave preview skipped: ${String(error)}`,
      });
    }
    // The patched container travels only when a patch really landed since the
    // host last saw one: a resource snapshot on every tick would cost far more
    // than the save image it accompanies.
    if (
      ctx.autosave.autosaveFiles &&
      ctx.engine.patchGeneration !== ctx.autosave.lastPatchGeneration
    ) {
      const files: Record<string, Uint8Array> = {};
      for (const [name, bytes] of ctx.engine.containerFiles) files[name] = bytes.slice();
      if (ctx.boot.authoredWords) files["WORDS.TOK"] = ctx.boot.authoredWords;
      msg.files = files;
      ctx.autosave.lastPatchGeneration = ctx.engine.patchGeneration;
    }
    ctx.ports.presentation(msg);
    ctx.autosave.lastAutosaveCycle = ctx.cycle.cycleCount;
    ctx.autosave.lastAutosaveAt = Date.now();
    return true;
  }

  function onCheckpoint(msg: Inbound<"checkpoint">): void {
    // The paused interpreter's resumable image — the candidate preview's
    // restore point. null outside a resumable cycle boundary.
    ctx.ports.control({
      type: "checkpoint",
      id: msg.id,
      image: ctx.engine ? ctx.engine.autosaveImage() : null,
    });
  }

  function onFlush(msg: Inbound<"flush">): void {
    // The page is going away (hidden / pagehide / an HMR reload). The
    // autosave is posted first, so a host that awaits the acknowledgement
    // can await browser storage before resolving this request.
    const taken = autosave(true);
    ctx.ports.control({
      type: "flushed",
      id: msg.id,
      taken,
      cycle: ctx.cycle.cycleCount,
      hasEngine: Boolean(ctx.engine),
      modal: ctx.engine ? ctx.engine.modalOpen : false,
      textMode: ctx.engine ? ctx.engine.textModeActive : false,
      pictureShown: ctx.engine ? ctx.engine.isPictureShown : false,
    });
  }

  return { autosave, onCheckpoint, onFlush };
}

export type AutosaveModule = ReturnType<typeof createAutosave>;
