/**
 * The execution controller's lazy loader and inert hooks — the lightweight
 * seam the normal Play path carries. Nothing here imports the controller's
 * plans, expression evaluator or build capture: a first `debug*` command
 * pulls `debugController.ts` through one dynamic import, held in the
 * loader's promise so later commands share the flight. Messages that arrive
 * while it resolves queue in order (dispatch.ts drains them); an installed
 * table costs one flag check, and a failed load stays failed — refused
 * explicitly, never a silent retry.
 */
import type { WorkerInbound } from "./workerProtocol.ts";
import type { createDebugController } from "./debugController.ts";
import type { createPreviewAdmission } from "./previewAdmission.ts";
import { captureBlocked } from "./debuggerState.ts";
import type { Inbound, WorkerContext, WorkerFns } from "./context.ts";

type DebugControllerModule = {
  createDebugController: typeof createDebugController;
  createPreviewAdmission?: typeof createPreviewAdmission;
};

/** The loader's per-context record — lives outside `debugger`, which detach resets. */
export interface DebuggerLoaderState {
  /** Inbound messages held in arrival order while the module loads. */
  queue: WorkerInbound[];
  /** The in-flight module load; null when idle or settled. */
  loading: Promise<boolean> | null;
  /** The real function table landed — the gate then costs one flag check. */
  installed: boolean;
  /** A refused load stays refused: later commands fail fast, never retry-storm. */
  failed: boolean;
  /**
   * The dynamic import behind ensureDebugController — a fake-port test may
   * inject a rejecting or stubbed source; production leaves the real fetch.
   */
  importModule?: (() => Promise<DebugControllerModule>) | undefined;
}

export function newDebuggerLoaderState(): DebuggerLoaderState {
  return { queue: [], loading: null, installed: false, failed: false };
}

/** Commands the controller's own function table must serve. */
const CONTROLLER_COMMANDS: Record<string, true> = {
  debugAttach: true,
  debugDetach: true,
  debugConfigure: true,
  debugPause: true,
  debugResume: true,
  debugRunTo: true,
  debugInspect: true,
  debugEvaluate: true,
  debugSetValues: true,
};

/** Whether a message needs the real controller: a `debug*` command. */
export function controllerDemand(msg: WorkerInbound): boolean {
  return CONTROLLER_COMMANDS[msg.type] === true;
}

/**
 * Install the real controller's function table on this context — the
 * synchronous half of the lazy load, also driven directly by fake-port
 * unit tests that already imported the module. Once per context: the flag
 * is what lets the dispatch gate pass traffic straight through.
 */
export function installDebugController(ctx: WorkerContext, controller: Partial<WorkerFns>): void {
  Object.assign(ctx.fns, controller);
  ctx.debuggerLoader.installed = true;
}

/**
 * The one-shot lazy install: resolves true once the real table is in place,
 * false after a refused load (reported on the error channel; a `debugError`
 * per queued command follows at drain). In-flight calls share the promise;
 * post-settle calls answer from the flags alone.
 */
export function ensureDebugController(ctx: WorkerContext): Promise<boolean> {
  const loader = ctx.debuggerLoader;
  if (loader.installed) return Promise.resolve(true);
  if (loader.failed) return Promise.resolve(false);
  if (loader.loading !== null) return loader.loading;
  const load =
    loader.importModule ??
    (() =>
      // The preview admission module shares the controller's lazy boundary:
      // it exists only where a session can attach, so it rides the same
      // one-shot import rather than growing the startup graph.
      Promise.all([import("./debugController.ts"), import("./previewAdmission.ts")]).then(
        ([controller, admission]) => ({
          createDebugController: controller.createDebugController,
          createPreviewAdmission: admission.createPreviewAdmission,
        }),
      ));
  loader.loading = load()
    .then((mod) => {
      installDebugController(ctx, {
        ...mod.createDebugController(ctx),
        ...(mod.createPreviewAdmission !== undefined ? mod.createPreviewAdmission(ctx) : {}),
      });
      return true;
    })
    .catch((error: unknown) => {
      loader.failed = true;
      ctx.ports.control({
        type: "error",
        message: `the execution debugger failed to load: ${String(error instanceof Error ? error.message : error)}`,
      });
      return false;
    })
    .finally(() => {
      loader.loading = null;
    });
  return loader.loading;
}

/**
 * The function table a context serves before the controller lands — and
 * the only one a scratch history/view context ever holds. The capture,
 * stop-latch and attach checks answer straight from the engine and the
 * inert session record, so the shared tick/input/history code paths behave
 * exactly as a detached session; the nine commands answer an explicit
 * `unavailable` (dispatch gates them behind the load, so this is the
 * defense for a caller that reaches the table directly).
 */
export function createDebuggerHooks(ctx: WorkerContext): Partial<WorkerFns> {
  const unavailable = (id: number): void =>
    ctx.ports.control({
      type: "debugError",
      id,
      epoch: null,
      buildId: null,
      code: "unavailable",
      error: "the execution debugger is not loaded on this context",
    });
  return {
    onDebugAttach: (msg: Inbound<"debugAttach">) => unavailable(msg.id),
    onDebugDetach: (msg: Inbound<"debugDetach">) => unavailable(msg.id),
    onDebugConfigure: (msg: Inbound<"debugConfigure">) => unavailable(msg.id),
    onDebugPause: (msg: Inbound<"debugPause">) => unavailable(msg.id),
    onDebugResume: (msg: Inbound<"debugResume">) => unavailable(msg.id),
    onDebugRunTo: (msg: Inbound<"debugRunTo">) => unavailable(msg.id),
    onDebugInspect: (msg: Inbound<"debugInspect">) => unavailable(msg.id),
    onDebugEvaluate: (msg: Inbound<"debugEvaluate">) => unavailable(msg.id),
    onDebugSetValues: (msg: Inbound<"debugSetValues">) => unavailable(msg.id),
    /**
     * No preview lane can exist where no controller landed: an explicit
     * refused result, correlated by the request's own id and token — never
     * a silent drop, never an accidental grant.
     */
    onPreviewUpdate: (msg: Inbound<"previewUpdate">): void => {
      const runToken = typeof msg?.runToken === "string" ? msg.runToken : "";
      ctx.ports.control({
        type: "previewUpdateResult",
        id: typeof msg?.id === "number" ? msg.id : 0,
        runToken,
        status: "refused",
        expected: null,
        current: null,
        patchGeneration: ctx.run.engine?.patchGeneration ?? 0,
        reason: "this context has no play-preview lane",
      });
    },
    onPreviewStatus: (msg: Inbound<"previewUpdateStatus">): void => {
      ctx.ports.control({
        type: "previewUpdateStatus",
        id: typeof msg?.id === "number" ? msg.id : 0,
        runToken: null,
        current: null,
        transaction: null,
      });
    },
    previewSessionInstall: (): void => {
      /* A session seam only exists where the controller lives. */
    },
    debugAfterEntry: (): void => {
      /* No controller ever armed this context — nothing latches or defers. */
    },
    debugBeforeReplace: (): void => {
      /* A latch only exists under a real session — none ever installed. */
    },
    prepareDebugReplacement: () => {
      throw new Error("Open Debug before starting this launch.");
    },
    debugSessionReplaced: (): void => {
      /* An epoch only exists under a real session — none ever installed. */
    },
    /** True while an attach owns this engine session. */
    debugAttached: (): boolean => ctx.run.debugger.epoch !== 0,
    /** The engine's stop latch is held — every entry point consults this. */
    debugStoppedHeld: (): boolean =>
      ctx.run.engine !== null && ctx.run.engine.executionStopInfo !== null,
    /**
     * A resumable-boundary image (autosaveImage/recordingImage/
     * captureReplayState) cannot describe the run right now: the latch is
     * held, or an armed pass is parked or yielded mid-cycle.
     */
    debugCaptureBlocked: (): boolean => ctx.run.engine !== null && captureBlocked(ctx.run.engine),
  };
}
