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
import type {
  DebugResumeAction,
  DebugStopReason,
  PreviewUpdateOutcome,
  SourceBindingKind,
} from "./workerProtocol.ts";

type CapturedBuild = ReturnType<typeof captureProjectBuild>;
type StepPlan = ReturnType<typeof createDebugStepPlan>;

/**
 * The play-preview lane granted by a `frozenTest.lane: "play-preview"`
 * boot: the worker-side authority the `previewUpdate` protocol pins. It is
 * bound to the physical run — the engine instance and run serial — not to
 * one debugger session, so it is carried across detach/re-attach and dies
 * only with the boot's run. `epoch`/`buildId`/`sources`/`bindings` name the
 * installed source authority; `updateSerial` and the bounded result ledger
 * give the update protocol its monotonic dedupe authority.
 */
export interface PreviewLaneState {
  /** The engine instance the lane was minted for — a fresh boot ends it. */
  readonly engine: Engine;
  /** Physical-run token minted by the lane-granting boot; requests must echo it. */
  readonly runToken: string;
  /** Source-authority epoch — bumps on every installed source/build identity. */
  epoch: number;
  /** Verified build identity of the installed source image. */
  buildId: string;
  /** Lane update serial — bumps on committed and source-only installs. */
  updateSerial: number;
  /**
   * Highest transaction id ever admitted; a later request at or below it is
   * refused rather than fresh, and a status query for it reports
   * "unavailable" — bounded retention cannot tell an evicted outcome from
   * an id that never ran. Starts at -1 so id 0 can be a first request.
   */
  highWater: number;
  /** Installed source authority, retained even while no session is attached. */
  sources: Record<string, string>;
  /** The complete authored binding map the installed build is captured under. */
  sourceBindings: Record<string, { kind: SourceBindingKind; num: number }> | null;
  /** The expression-evaluator subview of sourceBindings. */
  bindings: DebugBindings;
  /** Bounded correlated terminal results keyed by transaction id. */
  results: Map<number, { digest: string; outcome: PreviewUpdateOutcome }>;
}

/** The lane's physical-run token: opaque, per boot, unguessable off-channel. */
export function mintPreviewRunToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let token = "";
  for (const byte of bytes) token += byte.toString(16).padStart(2, "0");
  return token;
}

export function newPreviewLane(runToken: string, engine: Engine): PreviewLaneState {
  return {
    engine,
    runToken,
    epoch: 0,
    buildId: "",
    updateSerial: 0,
    highWater: -1,
    sources: {},
    sourceBindings: null,
    bindings: {},
    results: new Map(),
  };
}

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
  /** Install/uninstall awaiting the next completed-cycle boundary. */
  armDeferred: boolean;
  unarmDeferred: boolean;
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
  /**
   * The play-preview lane this run was booted with, or null on every other
   * context. Carried across session detach/re-attach (the token names the
   * physical run, not the session); cleared by a fresh boot.
   */
  preview: PreviewLaneState | null;
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
    unarmDeferred: false,
    hiatus: false,
    audioHold: false,
    richSnapshot: false,
    queuedAnswers: [],
    modified: false,
    preview: null,
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
