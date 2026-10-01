/** Isolated test previews adapt project admission to their attached debugger plans. */
import { createProjectAdmission, projectAdmissionIdentity } from "./projectAdmission.ts";
import { createDebugBreakpointPlan } from "../../../src/runtime/debugBreakpoints.ts";
import { createDebugWatchpointPlan } from "../../../src/runtime/debugWatchpoints.ts";
import { debugPlanSnapshot, type PreviewPreparedSession } from "./debuggerState.ts";
import type { WorkerContext } from "./context.ts";

export function previewLaneIdentity(ctx: WorkerContext) {
  return projectAdmissionIdentity(ctx, ctx.debugger.preview);
}

export function createPreviewAdmission(ctx: WorkerContext) {
  return createProjectAdmission(ctx, {
    lane: () => ctx.debugger.preview,
    legacyPreview: true,
    prepareSession(candidate) {
      const d = ctx.debugger;
      const engine = ctx.engine;
      if (d.epoch === 0 || engine === null || d.engine !== engine) return null;
      const breakpointPlan = createDebugBreakpointPlan({
        build: candidate.build,
        bindings: candidate.bindings,
      });
      breakpointPlan.configure({ revision: 1, breakpoints: d.breakpointSpecs });
      const watchpointPlan = createDebugWatchpointPlan({
        build: candidate.build,
        bindings: candidate.bindings,
      });
      watchpointPlan.configure(
        { revision: 1, watchpoints: d.watchpointSpecs },
        debugPlanSnapshot(
          engine,
          ctx.cycle.cycleCount,
          engine.executionStopInfo?.location ?? null,
          d.richSnapshot,
        ),
      );
      const prepared: PreviewPreparedSession = { ...candidate, breakpointPlan, watchpointPlan };
      return () => {
        ctx.fns.previewSessionInstall(prepared);
        return ctx.debugger.epoch;
      };
    },
  });
}
