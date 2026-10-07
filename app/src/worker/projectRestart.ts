/** Deliberate candidate replacement retains the old recording segment and its delivery queue. */
import type { Engine } from "../../../src/runtime/engine.ts";
import type { WorkerContext } from "./context.ts";
import { replaceRun, type ReplacementKind, type PreparedRun } from "./runSession.ts";

export function installProjectRestart(
  ctx: WorkerContext,
  replacement: Engine,
  kind: ReplacementKind = "restart",
  state?: Partial<PreparedRun>,
): void {
  replacement.amigaRegion = ctx.run.engine!.amigaRegion;
  replaceRun(ctx, kind, {
    engine: replacement,
    admission: ctx.run.projectAdmission
      ? { ...ctx.run.projectAdmission, engine: replacement }
      : null,
    project: ctx.boot.project,
    rng: { word: 1, policy: { kind: "external" } },
    paused: false,
    ...state,
  });
}
