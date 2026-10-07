/** Play previews adapt project admission to their attached debugger plans. */
import { createProjectAdmission } from "./projectAdmission.ts";
import { createDebugBreakpointPlan } from "../../../src/runtime/debugBreakpoints.ts";
import { createDebugWatchpointPlan } from "../../../src/runtime/debugWatchpoints.ts";
import { debugPlanSnapshot, type PreviewPreparedSession } from "./debuggerState.ts";
import type { WorkerContext } from "./context.ts";

export function createPreviewAdmission(ctx: WorkerContext) {
  return createProjectAdmission(ctx, {
    lane: () => ctx.run.projectAdmission,
    commitAtBoundary(commit) {
      const d = ctx.run.debugger;
      const engine = ctx.run.engine;
      if (!d.installed || engine === null || engine.executionStopInfo !== null) return commit();
      try {
        engine.setExecutionGate(null);
        engine.setExecutionObserver(null);
      } catch {
        return commit();
      }
      d.installed = false;
      d.armDeferred = true;
      try {
        return commit();
      } finally {
        ctx.fns.debugAfterEntry();
      }
    },
    prepareSession(candidate) {
      const d = ctx.run.debugger;
      const engine = ctx.run.engine;
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
          ctx.run.cycle.cycleCount,
          engine.executionStopInfo?.location ?? null,
          d.richSnapshot,
        ),
      );
      const prepared: PreviewPreparedSession = { ...candidate, breakpointPlan, watchpointPlan };
      return () => {
        ctx.fns.previewSessionInstall(prepared);
        return ctx.run.debugger.epoch;
      };
    },
  });
}
