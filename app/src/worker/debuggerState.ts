/**
 * The execution-controller session record every worker context carries —
 * the inert state the entry hooks, the host-answer queue and the capture
 * checks read on the normal Play path — plus the boundary test a resumable
 * image consults. Lightweight: the plan, expression and build-capture
 * types are references only; their code loads through debugLoader.ts's
 * dynamic import on first actual debugger/Test use.
 */
import type { captureProjectBuild } from "../../../src/authoring/projectBuild.ts";
import type { DebugBindings, DebugSnapshot } from "../../../src/runtime/debugExpression.ts";
import type {
  DebugBreakpointPlan,
  DebugBreakpointSpec,
} from "../../../src/runtime/debugBreakpoints.ts";
import type { createDebugStepPlan } from "../../../src/runtime/debugStep.ts";
import type { DebugWatchpointPlan, DebugWatchSpec } from "../../../src/runtime/debugWatchpoints.ts";
import type { Engine, EngineStateReport, ScreenObjectState } from "../../../src/runtime/engine.ts";
import type { DebugResumeAction, DebugStopReason, SourceBindingKind } from "./workerProtocol.ts";

type CapturedBuild = ReturnType<typeof captureProjectBuild>;
type StepPlan = ReturnType<typeof createDebugStepPlan>;

/**
 * The fully verified, still-detached session authority a committed preview
 * update installs: captured build, sources and binding maps plus the
 * breakpoint/watchpoint plans rebuilt against them. Produced by
 * previewAdmission.ts before the engine commit; installed by the
 * controller's previewSessionInstall seam as bounded assignments only.
 */
export interface PreviewPreparedSession {
  build: CapturedBuild;
  sources: Record<string, string>;
  sourceBindings: Record<string, { kind: SourceBindingKind; num: number }> | null;
  bindings: DebugBindings;
  breakpointPlan: DebugBreakpointPlan;
  watchpointPlan: DebugWatchpointPlan;
}

/** The live execution-controller session state, owned by debugController.ts. */
export interface DebuggerState {
  /** The engine this session owns; null while detached (epoch 0). */
  engine: Engine | null;
  /** Session serial — minted on attach and again on every run replacement. */
  epoch: number;
  /** The counter epochs draw from; persists across detach within one worker. */
  epochCounter: number;
  buildId: string | null;
  build: CapturedBuild | null;
  /** The authored sources verified against the live bytes at capture. */
  sources: Record<string, string>;
  bindings: DebugBindings;
  /**
   * The complete authored name→number map when the caller shipped one
   * (resource bindings included): the build identity is captured and the
   * session rebinds under it, while `bindings` remains the expression-only
   * subview the evaluator and plans resolve. Null for callers that send
   * `bindings` alone — they capture under it unchanged.
   */
  sourceBindings: Record<string, { kind: SourceBindingKind; num: number }> | null;
  breakpointPlan: DebugBreakpointPlan | null;
  watchpointPlan: DebugWatchpointPlan | null;
  /** The caller-facing specs currently applied — re-bound on session reset. */
  breakpointSpecs: DebugBreakpointSpec[];
  watchpointSpecs: DebugWatchSpec[];
  /** Session-monotonic configuration serial the wire echoes. */
  configRevision: number;
  /** One-shot step plan armed by debugResume; dies at its stop or replacement. */
  step: { mode: DebugResumeAction; plan: StepPlan } | null;
  /** The armed run-to target; null once consumed or superseded. */
  runTo: { logic: number; pc: number } | null;
  /** Stop reasons accrued since the last published stop, in engine order. */
  pendingReasons: DebugStopReason[];
  /** Engine stopId of the last published stop — dedupes repeat publishes. */
  publishedEngineStop: number;
  /** Session stop serial: every visible stop carries a fresh wire identity. */
  stopSerial: number;
  /** The currently published stop's wire serial, null while running. */
  stopId: number | null;
  /** The pinned detached snapshot the published stop's commands read. */
  snapshot: DebugSnapshot | null;
  /** The pinned detached inspection views posted with the stop. */
  inspected: { state: EngineStateReport; objects: ScreenObjectState[] } | null;
  /** Gate + observer installed on the owned engine. */
  installed: boolean;
  /** Install awaiting the next completed-cycle boundary. */
  armDeferred: boolean;
  /** The live recording's debugger hiatus: its segment ended with "debugger". */
  hiatus: boolean;
  /** The posted `debugAudio` hold this epoch owns. */
  audioHold: boolean;
  /** Any configured condition/logpoint — per-occurrence snapshots stay lean otherwise. */
  richSnapshot: boolean;
  /** Answers accepted while stopped; each applies exactly once after release. */
  queuedAnswers: { id: number; op: string; response: string }[];
  /** debugSetValues wrote to this run. */
  modified: boolean;
}

export function newDebuggerState(): DebuggerState {
  return {
    engine: null,
    epoch: 0,
    epochCounter: 0,
    buildId: null,
    build: null,
    sources: {},
    bindings: {},
    sourceBindings: null,
    breakpointPlan: null,
    watchpointPlan: null,
    breakpointSpecs: [],
    watchpointSpecs: [],
    configRevision: 0,
    step: null,
    runTo: null,
    pendingReasons: [],
    publishedEngineStop: -1,
    stopSerial: 0,
    stopId: null,
    snapshot: null,
    inspected: null,
    installed: false,
    armDeferred: false,
    hiatus: false,
    audioHold: false,
    richSnapshot: false,
    queuedAnswers: [],
    modified: false,
  };
}

/**
 * Whether a full resume-point capture (autosaveImage/recordingImage/
 * captureReplayState) would throw right now: a latched stop always refuses,
 * and an armed parked or yielded pass cannot masquerade as a checkpoint.
 * The resume-to-next-tick gap is synchronous inside the controller, so the
 * private cursor it would catch can never be observed from the worker.
 */
export function captureBlocked(engine: Engine): boolean {
  return (
    engine.executionStopInfo !== null ||
    (engine.executionControlActive && (engine.continuationPending || engine.executionYieldPending))
  );
}

/**
 * The detached snapshot plan observation and watchpoint baselines read —
 * identical shape to the controller's planSnapshot, lifted here so the
 * preview admission prepares watchpoint baselines without the controller's
 * closure. `location` names the LOGIC boundary the context belongs to.
 */
export function debugPlanSnapshot(
  engine: Engine,
  cycle: number,
  location: { logic: number; pc: number } | null,
  rich: boolean,
): DebugSnapshot {
  return {
    vars: Array.from(engine.vars),
    flags: Array.from(engine.flags, (f) => f !== 0),
    strings: [...engine.strings],
    objects: rich
      ? engine.screenObjects.map((o) => ({
          x: o.x,
          y: o.y,
          view: o.view,
          loop: o.loop,
          cel: o.cel,
          direction: o.direction,
          priority: o.priority,
          active: o.active,
        }))
      : [],
    inventory: rich ? engine.readState().inventory : [],
    room: engine.vars[0]!,
    logic: location?.logic ?? null,
    pc: location?.pc ?? null,
    cycle,
  };
}
