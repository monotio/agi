/** Deliberate candidate replacement retains the old recording segment and its delivery queue. */
import type { Engine } from "../../../src/runtime/engine.ts";
import type { WorkerContext } from "./context.ts";
import { resetSession } from "./session.ts";

export function installProjectRestart(ctx: WorkerContext, replacement: Engine): void {
  const preview = ctx.previewVisitEngine === ctx.engine;
  const journal = { ...ctx.journal, pending: [] };
  ctx.fns.onHistoryViewEnd();
  ctx.fns.historyEnd("boot");
  ctx.fns.debugBeforeReplace();
  ctx.engine!.stopSound();
  if (ctx.engine!.hostInteractionPending) ctx.engine!.abortInteraction();
  ctx.fns.setKeyWaiting(false);
  ctx.fns.abandonHostRequest();
  replacement.amigaRegion = ctx.engine!.amigaRegion;
  ctx.engine = replacement;
  if (ctx.projectAdmission) ctx.projectAdmission = { ...ctx.projectAdmission, engine: replacement };
  ctx.boot.currentBootFiles = new Map(replacement.containerFiles);
  ctx.boot.profile = replacement.profile.id;
  ctx.boot.authoredWords = null;
  ctx.fns.armJournal();
  resetSession(ctx);
  Object.assign(ctx.journal, journal);
  if (preview) ctx.previewVisitEngine = replacement;
  ctx.autosave.lastAutosaveAt = ctx.ports.now();
  ctx.autosave.lastAutosaveCycle = -1;
  ctx.autosave.lastPatchGeneration = replacement.patchGeneration;
}
