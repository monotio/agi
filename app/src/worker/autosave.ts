/**
 * The autosave snapshot and the flush/checkpoint messages around it. Pure
 * functions of the worker context — importable under Node.
 */
import { createProgressPreview, isBlackFrame } from "../saves/progressPreview.ts";
import { bytesToBase64 } from "../project/bytes.ts";
import { computeResourceRevision } from "../../../src/authoring/resourceRevision.ts";
import type { WorkerPresentation } from "./workerProtocol.ts";
import type { Inbound, WorkerContext } from "./context.ts";

/**
 * Autosave cadence. Five seconds is the
 * cheapest interval that is still invisible: one snapshot is a serialize() of
 * a few kilobytes plus a base64 pass, well under a millisecond, and the
 * usual maximum a player can lose to a browser reload is
 * five seconds of walking. Tightening it further buys nothing a player would
 * notice. Hiding the page requests a checkpoint; closing can interrupt storage.
 */
export const AUTOSAVE_INTERVAL_MS = 5_000;

export function createAutosave(ctx: WorkerContext) {
  /**
   * Take an autosave if this cycle boundary allows one and post it to the host.
   *
   * The engine refuses the snapshot while a live host request owns the answer
   * (a prompt, the save/restore selector, a confirmation), while a text screen
   * owns the surface, while an f15 window stays up with no parked pass, or
   * before a room has drawn; a parked window or key wait serializes into the
   * image's continuation instead. The worker adds the cheap
   * gate on top: an image is encoded only when the interpreter actually
   * advanced since the last one, so a parked or idle game costs nothing.
   */
  function autosave(force: boolean): boolean {
    if (!ctx.engine || ctx.previewVisitEngine === ctx.engine) return false;
    if (!force && ctx.cycle.cycleCount === ctx.autosave.lastAutosaveCycle) return false;
    // A debugger-parked or armed mid-pass engine has no resumable boundary:
    // the engine would throw on capture, so the last good image is kept.
    if (ctx.fns.debugCaptureBlocked()) return false;
    // A game that quit has ended: its image would resume a stopped
    // interpreter. The autosave taken before the quit stays the one to continue.
    if (ctx.engine.readLeanState().terminated) return false;
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
    const files = Object.fromEntries(ctx.engine.containerFiles);
    if (ctx.boot.authoredWords) files["WORDS.TOK"] = ctx.boot.authoredWords;
    const msg: Extract<WorkerPresentation, { type: "autosave" }> = {
      type: "autosave",
      image: bytesToBase64(image),
      revision: computeResourceRevision(files),
      menus: ctx.engine.readMenuState(),
      cycle: ctx.cycle.cycleCount,
      room: ctx.engine.vars[0]!,
    };
    try {
      const presentation = ctx.engine.getPresentation();
      const frame = {
        visual: presentation.visual,
        text: presentation.text,
        picRow: ctx.engine.displayBase,
      };
      // A black screen leaves the card's previous picture in place.
      if (!isBlackFrame(frame)) msg.preview = createProgressPreview(frame);
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
    // The autosave cadence is the history anchor cadence — same boundary.
    ctx.fns.historyAnchor("autosave");
    return true;
  }

  function onCheckpoint(msg: Inbound<"checkpoint">): void {
    // The paused interpreter's resumable image — the candidate preview's
    // restore point. null outside a resumable cycle boundary, including a
    // debugger-parked or armed mid-pass engine. The pre-check cannot see a
    // private cycle cursor, so a capture refusal lands as null too.
    let image: Uint8Array | null = null;
    if (ctx.engine && !ctx.fns.debugCaptureBlocked()) {
      try {
        image = ctx.engine.autosaveImage();
      } catch {
        image = null;
      }
    }
    ctx.ports.control({ type: "checkpoint", id: msg.id, image });
  }

  function onFlush(msg: Inbound<"flush">): void {
    // The page is going away (hidden / pagehide / an HMR reload). The
    // autosave is posted first, so a host that awaits the acknowledgement
    // can await browser storage before resolving this request.
    const taken = autosave(true);
    ctx.fns.historyFlush();
    ctx.ports.control({
      type: "flushed",
      id: msg.id,
      taken,
      cycle: ctx.cycle.cycleCount,
    });
  }

  return { autosave, onCheckpoint, onFlush };
}
