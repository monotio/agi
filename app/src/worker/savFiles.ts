/**
 * Worker-side original .SAV import/export handlers.
 * Loaded dynamically from dispatch.ts so savFile.ts stays off the worker startup bundle.
 */
import type { Engine } from "../../../src/runtime/engine.ts";
import { exportOriginalSav, importOriginalSav } from "../../../src/runtime/savFile.ts";
import type { WorkerContext, Inbound } from "./context.ts";
import { configureSessionTiming } from "./session.ts";

/** Maximum original save file bytes accepted before decoding (authentic AGI saves are ~2–20 KB). */
export const MAX_ORIGINAL_SAV_BYTES = 256 * 1024;

function checkSavPreconditions(ctx: WorkerContext, mode: "export" | "import"): string | null {
  const engine = ctx.run.engine;
  if (!engine) return "Start a game before using save files.";
  if (engine.profile.id === "2.001")
    return "PC booter 2.001 saves to floppy disk sectors; it has no standalone .SAV file.";
  if (ctx.replay.replay !== null || ctx.view.recording !== null || ctx.view.drive !== null)
    return "Return to live play before using save files.";
  if (ctx.fns.debugCaptureBlocked())
    return "Resume or detach the debugger before using save files.";
  if (
    ctx.run.hostRequests.hostRequestOutstanding !== null ||
    engine.hostInteractionPending ||
    engine.continuationPending ||
    engine.roomEntryPending ||
    engine.modalOpen ||
    engine.textModeActive
  )
    return "Finish the open game interaction before using save files.";
  if (engine.readLeanState().terminated) return "Start the game again before using save files.";
  if (engine.coldStart) return "Wait for the first room to draw before using save files.";
  if (mode === "import") {
    if (!ctx.run.owner.active)
      return "This game is open in another tab. Take back control in this tab before importing a save.";
    if (ctx.run.progress.mode !== "play") return "Switch to Play before importing a save file.";
  }
  return null;
}

export function handleExportSav(
  ctx: WorkerContext,
  msg: Inbound<"exportSav">,
  generation = ctx.run.generation,
  engine: Engine | null = ctx.run.engine,
): void {
  if (ctx.run.generation !== generation || ctx.run.engine !== engine) {
    ctx.ports.control({
      type: "savExported",
      id: msg.id,
      bytes: null,
      error: "The running game changed before the save could be exported. Try again.",
    });
    return;
  }
  const initialError = checkSavPreconditions(ctx, "export");
  if (initialError || !engine) {
    ctx.ports.control({
      type: "savExported",
      id: msg.id,
      bytes: null,
      error: initialError ?? "Start a game before using save files.",
    });
    return;
  }
  try {
    const bytes = exportOriginalSav(engine, msg.description);
    ctx.ports.control({ type: "savExported", id: msg.id, bytes }, [bytes.buffer]);
  } catch (error) {
    ctx.ports.control({
      type: "savExported",
      id: msg.id,
      bytes: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleImportSav(
  ctx: WorkerContext,
  msg: Inbound<"importSav">,
  generation = ctx.run.generation,
  engine: Engine | null = ctx.run.engine,
): void {
  if (ctx.run.generation !== generation || ctx.run.engine !== engine) {
    ctx.ports.control({
      type: "savImported",
      id: msg.id,
      ok: false,
      error: "The running game changed before the save could be imported. Try again.",
    });
    return;
  }
  const rawBytes = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes);
  if (rawBytes.byteLength === 0) {
    ctx.ports.control({
      type: "savImported",
      id: msg.id,
      ok: false,
      error: "That file is empty. Choose an original AGI save file.",
    });
    return;
  }
  if (rawBytes.byteLength > MAX_ORIGINAL_SAV_BYTES) {
    ctx.ports.control({
      type: "savImported",
      id: msg.id,
      ok: false,
      error: "That file is larger than 256 KB. Choose an original AGI save file.",
    });
    return;
  }
  const initialError = checkSavPreconditions(ctx, "import");
  if (initialError || !engine) {
    ctx.ports.control({
      type: "savImported",
      id: msg.id,
      ok: false,
      error: initialError ?? "Start a game before using save files.",
    });
    return;
  }
  try {
    importOriginalSav(engine, rawBytes);
    // Post-import state reconciliation runs only after importOriginalSav succeeds,
    // so any validation refusal leaves the running game and history untouched.
    ctx.fns.historyEnd("resume");
    ctx.history.pendingSound = 0;
    ctx.history.pendingSpill = 0;
    if (ctx.run.recording.recording) {
      ctx.run.recording.recording.tainted = "the game was restored mid-recording";
    }
    ctx.run.input.keyQueue.length = 0;
    ctx.run.input.deferredMovement.length = 0;
    ctx.run.input.inputBuffer.length = 0;
    ctx.run.input.clickQueue.length = 0;
    ctx.run.input.sentence = null;
    ctx.fns.applyTraceChannel();
    ctx.run.hostRequests.pendingReenter = false;
    ctx.fns.setKeyWaiting(false);
    ctx.run.cycle.pendingClock = null;
    const now = ctx.ports.now();
    ctx.run.clocks.cycle.reset(now);
    ctx.run.clocks.sound.reset(now);
    configureSessionTiming(ctx);
    ctx.fns.captureStateDiffs();
    ctx.fns.debugSessionReplaced();
    ctx.fns.historyResume();
    ctx.fns.markRestore();
    ctx.fns.noteTransition();
    ctx.run.presentation.lastVisual = null;
    ctx.fns.postFrame(true);
    ctx.fns.autosave(true);
    ctx.ports.control({
      type: "savImported",
      id: msg.id,
      ok: true,
      room: engine.vars[0] ?? 0,
    });
  } catch (error) {
    ctx.ports.control({
      type: "savImported",
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
