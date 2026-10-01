/**
 * The Logic Studio debugger workspace view model. One workspace owns one
 * isolated Test session: it freezes the complete current draft into an
 * IsolatedTestGame and mirrors the run's published identity — build, epoch,
 * stop, config and log — for the workspace components.
 *
 * Two lanes share that session. `test()` is the debugger lane: the authored
 * breakpoint/watch configuration is armed and the entry stop latches before
 * cycle one. `play()` is ordinary playtesting: the same frozen-build
 * admission, `stopOnEntry:false`, and no authored specs armed, so one click
 * runs immediately. Admission is transactional — a refused build or
 * candidate never demotes the pinned run to idle: the committed run's
 * worker, progress, sources and input stay put and the failure surfaces
 * beside them.
 *
 * Nothing here touches project storage, the live game or the DOM: the draft
 * authority, pause lease, session factory and presentation sink are all
 * injected. Debugger data comes only from the worker's own replies and the
 * captured build's verified source maps — a byte-only or phase stop reports
 * no source line, and a refused configuration is never relabeled bound.
 */
import { reactive } from "vue";
import { captureProjectBuild } from "../../../../../src/authoring/projectBuild.ts";
import {
  createDebugBreakpointPlan,
  type DebugBinding,
  type DebugBreakpointSpec,
} from "../../../../../src/runtime/debugBreakpoints.ts";
import {
  createDebugWatchpointPlan,
  type DebugWatchSpec,
  type DebugWatchTarget,
} from "../../../../../src/runtime/debugWatchpoints.ts";
import type {
  DebugBindings,
  DebugSnapshot,
  DebugValue,
} from "../../../../../src/runtime/debugExpression.ts";
import type { ProfileId } from "../../../../../src/runtime/profile.ts";
import type {
  DebugInspectSection,
  DebugResumeAction,
  DebugStepGranularity,
  PreviewLaneIdentity,
  PreviewUpdateOutcome,
  SourceBindingKind,
  WorkerInbound,
  WorkerOutbound,
} from "../../../worker/workerProtocol.ts";
import {
  createTestSession,
  TestRuntimeError,
  type PreviewStatusReport,
  type TestDebugConfig,
  type TestPauseLease,
  type TestRun,
  type TestSession,
  type TestSessionEvent,
  type TestSessionOptions,
  type TestStop,
  type TestWorkerLike,
} from "./testSession.ts";
import type { TestPrompts } from "./testHost.ts";

/** One document identity inside a frozen build. */
interface DebugDraftVersion {
  readonly key: string;
  readonly version: number;
}

/** A reference/compile finding on the built image; errors refuse the test. */
interface DebugBuildDiagnostic {
  readonly document: string;
  readonly pc?: number | undefined;
  readonly command?: string | undefined;
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

/** The captured build plus the verified source maps the debugger binds against. */
type DebugBuildCapture = ReturnType<typeof captureProjectBuild>;

/**
 * One immutable frozen candidate: the complete compiled draft plus its
 * capture (exact source maps, payload hashes, build identity). Created
 * synchronously — a draft edit after capture can never leak into it.
 */
export interface DebugTestBuild {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profile: ProfileId;
  readonly sources: Readonly<Record<string, string>>;
  readonly sourceBindings: Readonly<Record<string, { kind: SourceBindingKind; num: number }>>;
  readonly capture: DebugBuildCapture;
  /** The document versions this build pinned; staleness compares these. */
  readonly versions: readonly DebugDraftVersion[];
  readonly diagnostics: readonly DebugBuildDiagnostic[];
}

/**
 * The authority a workspace freezes from — LogicStudio's open
 * EditableProject in production, a plain record in tests.
 */
export interface DebugDraftSource {
  /** Compile the complete current draft; throws the build's own error. */
  captureTestBuild(): DebugTestBuild;
  /** The draft's live document versions — the staleness comparison side. */
  currentVersions(): readonly DebugDraftVersion[];
}

type DebugPhase = "idle" | "building" | "starting" | "running" | "stopped" | "ended";

/** One authored breakpoint and the status the run actually reported. */
interface DebugBreakpointRow {
  readonly id: string;
  readonly spec: DebugBreakpointSpec;
  /**
   * Where the spec resolved — the worker's own binding while a run is live,
   * else the same bind routine's preview against the frozen build. Null
   * before any build exists: nothing has been verified yet.
   */
  readonly binding: DebugBinding | null;
  readonly hits: number;
  readonly fault: string | null;
  /** The authored spec changed since the worker last acknowledged it. */
  readonly pending: boolean;
  /** The worker's published configuration contains this id. */
  readonly applied: boolean;
}

interface DebugWatchRow {
  readonly id: string;
  readonly spec: DebugWatchSpec;
  readonly baseline: number | boolean | null;
  readonly changes: number;
  readonly fault: string | null;
  readonly pending: boolean;
  readonly applied: boolean;
}

/** One evaluated expression, pinned to the stop that answered it. */
interface DebugEvalRow {
  readonly expression: string;
  readonly stopId: number;
  readonly value?: DebugValue | undefined;
  readonly error?: string | undefined;
}

/** A host prompt the run is blocked on. */
export interface DebugPrompt {
  readonly id: number;
  readonly kind: "number" | "string" | "describe";
  readonly prompt: string;
  readonly maxLen: number;
  readonly row: number;
  readonly col: number;
  readonly initial: string;
}

/** A resolved stop position in authored source — never fabricated. */
interface DebugSourceLocation {
  readonly key: string;
  readonly logic: number;
  readonly line: number;
  readonly column: number;
}

/** One editor gutter/line annotation for a logic document. */
export interface DebugDecoration {
  readonly line: number;
  readonly column?: number | undefined;
  readonly kind:
    "breakpoint" | "breakpoint-disabled" | "breakpoint-unbound" | "breakpoint-pending" | "stop";
}

/** A verdict for one spec edit: applied to the configuration or refused. */
export type DebugSpecVerdict =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

interface DebugWorkspaceOptions {
  readonly draft: DebugDraftSource;
  /** Parks the live game for a run's lifetime; absent = no live game. */
  readonly acquirePauseLease?: () => TestPauseLease | Promise<TestPauseLease>;
  /** Defaults to the production session (real engine worker). */
  readonly createSession?: (options: TestSessionOptions) => TestSession;
  /**
   * Spawn the run's worker; defaults to the same production engine worker
   * module the session's own default uses. The workspace wraps the factory
   * only to keep a repaint channel to the admitted run — the worker's host
   * poll suppresses frame posts while a debug stop is held, so a run that
   * only advances through resume/step would never refresh the preview.
   */
  readonly createWorker?: () => TestWorkerLike;
  /** The run's presentation stream — frames, text mirrors, sound output. */
  readonly onPresentation?: (message: WorkerOutbound) => void;
  /** A fresh run epoch admitted or the worker reset — clear the preview. */
  readonly onReset?: () => void;
  /** The session closed for good — release the run's audio instance. */
  readonly onEnded?: () => void;
  /** Reveal a source line in the editor. */
  readonly navigate?: (target: { key: string; line: number; column?: number }) => void;
  /** A run's quit() reached its end. */
  readonly onQuit?: () => void;
  /**
   * Debounce for completed draft edits before the play lane captures and
   * proposes a candidate. Collapses bursts into one latest build. The debug
   * lane never schedules. Default 150ms.
   */
  readonly previewDebounceMs?: number;
  /**
   * How long a previewUpdate waits for its ACK before the session queries
   * the lane's retained ledger — forwarded to the session unchanged.
   */
  readonly previewAckTimeoutMs?: number;
}

/**
 * The live-update truth the UI renders. "idle" is no proposal outstanding;
 * "pending" a candidate is on the wire; "waiting" a deferred attempt holds
 * the newest candidate for the next quiet boundary; "blocked" is a refused
 * or restart-required outcome with its worker reason; "indeterminate" is a
 * lost ACK the retained ledger could not name — the run is live but the
 * installed authority is unknown, so only an explicit restart is honest.
 */
interface DebugUpdateState {
  readonly status: "idle" | "pending" | "waiting" | "blocked" | "indeterminate";
  /** The worker's own reason, or the reconciliation's — never a guess. */
  readonly reason: string | null;
  /** An explicit new-worker restart resolves what live admission cannot. */
  readonly restartable: boolean;
}

const UPDATE_IDLE: DebugUpdateState = { status: "idle", reason: null, restartable: false };

/**
 * An attempt whose outcome the worker never confirmed: the request's own
 * transaction id, the lane identity it pinned, and the candidate it
 * shipped. While one exists, silence authorizes nothing — no replay, no
 * fresh mutation — only the newest draft's intent queues behind it, and
 * only worker evidence (the attempt's own result, or a fresh status
 * answer's recomputed identity) resolves it.
 */
interface UnresolvedUpdate {
  readonly id: number;
  readonly expected: PreviewLaneIdentity;
  readonly build: DebugTestBuild;
}

/**
 * The play lane's narrow surface — what a host that owns one preview across
 * sibling editors holds. `state` is the workspace's own reactive record; the
 * verbs cover Play latest, Pause, Continue, both restarts and End, plus the
 * active run's game input. Debugger-only verbs (stops, steps, inspections,
 * spec edits) stay on the full workspace.
 */
interface DebugPreviewHandle {
  /** The workspace's published run state — the same reactive object. */
  readonly state: DebugWorkspace["state"];
  hasRun(): boolean;
  run(): TestRun | null;
  /** Build the complete current draft and run it unpaused. */
  playLatest(): Promise<TestRun>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Rebuild from the current draft — latest versions, fresh save slots. */
  restartLatest(): Promise<TestRun>;
  /** Fresh worker epoch on the pinned build; its save slots survive. */
  restartBuild(): Promise<void>;
  end(): void;
  key(code: number): void;
  submitInput(text: string): void;
  click(x: number, y: number): void;
  direction(dir: number, release?: boolean): void;
}

interface PromptPending {
  readonly prompt: DebugPrompt;
  resolve(value: number | string | null): void;
}

const EVAL_LIMIT = 64;

/**
 * The empty build spec validation uses before the first test: no LOGIC, so
 * locations bind "unknown-logic" honestly while field validation — limits,
 * conditions, hit policies, log shapes — runs in full.
 */
const EMPTY_CAPTURE = captureProjectBuild({
  files: {},
  profileId: "2.936",
  sources: {},
  bindings: {},
});

/** A detached, all-empty baseline — watchpoint spec validation only. */
function emptySnapshot(): DebugSnapshot {
  return {
    vars: new Array<number>(256).fill(0),
    flags: new Array<boolean>(256).fill(false),
    strings: [],
    objects: [],
    inventory: [],
    room: 0,
    logic: null,
    pc: null,
    cycle: 0,
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Expression/debug bindings are the source bindings' value-slot subview. */
function debugBindings(
  sourceBindings: Readonly<Record<string, { kind: SourceBindingKind; num: number }>>,
): DebugBindings {
  const out: DebugBindings = {};
  for (const [name, binding] of Object.entries(sourceBindings)) {
    if (binding.kind === "variable" || binding.kind === "flag" || binding.kind === "string") {
      out[name] = { kind: binding.kind, num: binding.num };
    }
  }
  return out;
}

/** Start offset of every authored line plus an implicit end sentinel. */
function lineStarts(text: string): readonly number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) starts.push(i + 1);
  }
  return starts;
}

function lineColumnAt(starts: readonly number[], offset: number): { line: number; column: number } {
  let line = 0;
  for (let i = 1; i < starts.length; i++) {
    if (starts[i]! > offset) break;
    line = i;
  }
  return { line: line + 1, column: offset - starts[line]! + 1 };
}

/**
 * Resolve an emitted PC to an authored position in the frozen build's own
 * source map. A byte-only or phase observation has no source — null is the
 * honest answer, never a guessed line.
 */
function sourcePositionOf(
  capture: DebugBuildCapture,
  logic: number,
  pc: number,
  kind?: string,
): { line: number; column: number } | null {
  const captured = capture.logics.find((entry) => entry.num === logic);
  if (!captured || captured.authored === undefined) return null;
  const sourceMap = captured.sourceMap;
  const authoredStart = captured.authoredStart;
  if (sourceMap === undefined || authoredStart === undefined) return null;
  const candidates = sourceMap.entries.filter((entry) => pc >= entry.pc && pc < entry.endPc);
  if (candidates.length === 0) return null;
  const chosen =
    candidates
      .filter((entry) => entry.pc === pc && entry.kind === kind)
      .sort((a, b) => a.endPc - a.pc - (b.endPc - b.pc))[0] ??
    candidates
      .filter((entry) => entry.pc === pc)
      .sort((a, b) => a.endPc - a.pc - (b.endPc - b.pc))[0] ??
    candidates.sort((a, b) => a.endPc - a.pc - (b.endPc - b.pc))[0]!;
  return lineColumnAt(lineStarts(captured.authored), chosen.start - authoredStart);
}

/**
 * The pc range one authored line emits, through the same bind routine the
 * worker runs — run-to-cursor and breakpoint previews share this resolution.
 */
function bindLine(
  capture: DebugBuildCapture,
  bindings: DebugBindings,
  spec: DebugBreakpointSpec,
): DebugBinding {
  const scratch = createDebugBreakpointPlan({ build: capture, bindings });
  return scratch.configure({ revision: 1, breakpoints: [spec] }).entries[0]!.binding;
}

/**
 * The production engine worker — the same module the session's own default
 * spawns; the workspace supplies it only so the admitted worker stays
 * reachable for repaint pulls while a stop is held.
 */
function spawnEngineWorker(): TestWorkerLike {
  const worker = new Worker(new URL("../../../worker/engine.worker.ts", import.meta.url), {
    type: "module",
  });
  let handler: TestWorkerLike["onmessage"] = null;
  return {
    get onmessage() {
      return handler;
    },
    set onmessage(next) {
      handler = next;
      worker.onmessage = next ? (event) => next({ data: event.data }) : null;
    },
    postMessage(message) {
      worker.postMessage(message);
    },
    terminate() {
      worker.terminate();
    },
  };
}

export function createDebugWorkspace(options: DebugWorkspaceOptions) {
  const createSession = options.createSession ?? createTestSession;

  const state = reactive({
    phase: "idle" as DebugPhase,
    /**
     * Which lane the live run came from: "debug" latches the entry stop with
     * the authored configuration armed; "play" runs unpaused with nothing
     * armed. Null while no run exists.
     */
    runKind: null as "debug" | "play" | null,
    error: null as string | null,
    /**
     * The latest build or admission was refused — the previous run, if one
     * is live, is an older build and keeps running; the label tells it apart
     * from a draft that merely moved on.
     */
    buildFailed: false,
    /** Reference/compile findings of the last build attempt. */
    diagnostics: [] as readonly DebugBuildDiagnostic[],
    buildId: null as string | null,
    profileId: null as ProfileId | null,
    epoch: 0,
    /**
     * Workspace-minted run identity — one increment per admitted run. The
     * worker epoch restarts at 1 on every new worker, so a same-build
     * restart needs this monotonic surface to prove replacement.
     */
    runSeq: 0,
    stop: null as TestStop | null,
    /** What the engine is parked on while running: a key wait or host request. */
    waiting: null as "key" | "host" | null,
    /**
     * The draft moved on since the frozen build — the run stays pinned.
     * Always exact: a getter reads the draft's live versions. Vue renders
     * re-evaluate it when `draftTick` moves (noteDraftChanged bumps it).
     */
    get stale() {
      return draftVersionsDiffer();
    },
    /** Render invalidation for the stale getter — bumped on draft edits. */
    draftTick: 0,
    /** A set-values write changed this run — it is no longer pristine input. */
    modified: false,
    /** Step granularity for into/over/out. */
    granularity: "statement" as DebugStepGranularity,
    breakpoints: [] as readonly DebugBreakpointRow[],
    watches: [] as readonly DebugWatchRow[],
    /** Logpoint output the run produced, bounded by the session. */
    logs: [] as readonly { sequence: number; breakpoint: string; text: string }[],
    evaluations: [] as readonly DebugEvalRow[],
    /** The latest inspection, pinned to its stop; stale entries stay honest. */
    inspection: { stopId: -1, data: null as unknown },
    inspecting: false,
    inspectionError: null as string | null,
    prompt: null as DebugPrompt | null,
    /** Queued host answers waiting on the held stop. */
    answersReady: 0,
    /** Private save slots the run's selector wrote — mirrored for the chip. */
    saves: 0,
    /** The debugger's own audio hold, worker-reported. */
    audioPaused: false,
    /** A session-level configure refusal or worker error the UI surfaces. */
    configError: null as string | null,
    /** The stop's authored position — null for byte-only/phase/idle stops. */
    stopLocation: null as DebugSourceLocation | null,
    /** Resolved source text of the frozen build, for the running-source view. */
    frozenSources: {} as Readonly<Record<string, string>>,
    /**
     * The play lane's live-update state: in-flight proposals, deferred
     * retries and terminal outcomes with their real reasons. Replaced
     * wholesale — never mutated into an invented outcome.
     */
    update: UPDATE_IDLE as DebugUpdateState,
  });

  let session: TestSession | null = null;
  let unsubscribe: (() => void) | null = null;
  /** The committed run's worker — the preview's repaint channel. */
  let previewWorker: TestWorkerLike | null = null;
  /** The worker the session most recently spawned — a candidate's, until it commits. */
  let spawnedWorker: TestWorkerLike | null = null;
  /** One candidate admission at a time — a second beginRun is refused. */
  let admissionPending = false;
  /**
   * Workspace operation epoch — bumped by every admission/restart attempt
   * and by end/dispose. A resolved promise publishes only while its own
   * operation still owns the workspace.
   */
  let operationSeq = 0;
  let frozen: DebugTestBuild | null = null;
  let bindings: DebugBindings = {};
  /** Authored debugger intent — the configuration the workspace maintains. */
  const breakpointSpecs = new Map<string, DebugBreakpointSpec>();
  const watchSpecs = new Map<string, DebugWatchSpec>();
  let localRevision = 0;
  let watchSeq = 0;
  let promptSeq = 0;
  let promptPending: PromptPending | null = null;
  let disposed = false;
  const previewDebounceMs = options.previewDebounceMs ?? 150;
  /**
   * Live-update orchestration: `updateTimer` is the draft-edit debounce;
   * `updateInFlight` the single posted proposal; `updateQueued` the flag a
   * mid-flight edit sets so the settle recaptures the newest draft against
   * the identity the first attempt actually installed — superseded
   * intermediate builds are never retained.
   */
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  let updateInFlight = false;
  let updateQueued = false;
  /** Deferred attempts pace at quarter-second boundaries — bounded, cancelable. */
  const UPDATE_RETRY_PACE_MS = 250;
  let updateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The one update whose outcome stayed unproven past both deadlines, or
   * null. While set it is the lane's unresolved mutation: edits hold as
   * newest intent behind it and read-only reconciliation keeps pacing —
   * neither invents an outcome nor lets a second proposal overlap it.
   */
  let unresolvedUpdate: UnresolvedUpdate | null = null;
  /** Read-only status reconciliation paces single-flight on the same cadence. */
  let updateProbeTimer: ReturnType<typeof setTimeout> | null = null;
  let updateProbeInFlight = false;

  /**
   * Complete document-set equality: the frozen build is stale when the draft
   * gains a document, loses one, or moves any pinned version.
   */
  function draftVersionsDiffer(): boolean {
    if (!frozen) return false;
    const pinned = new Map(frozen.versions.map((v) => [v.key, v.version]));
    const current = new Map(options.draft.currentVersions().map((v) => [v.key, v.version]));
    if (pinned.size !== current.size) return true;
    for (const [key, version] of pinned) {
      if (current.get(key) !== version) return true;
    }
    return false;
  }

  /**
   * Callers bump this on every draft edit; the comparison stays
   * version-exact. A live play lane also schedules a candidate capture —
   * the debug lane is frozen and never schedules, even after Continue.
   */
  function noteDraftChanged(): void {
    state.draftTick++;
    if (updateTimer !== null) clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateTimer = null;
      if (disposed) return;
      const run = session?.run;
      if (run?.preview == null || state.runKind !== "play") return;
      void proposeLatest();
    }, previewDebounceMs);
  }

  /**
   * The deferred attempt's pace: a waiting candidate retries only at an
   * honest boundary — the run publishing "running" again (Continue, a host
   * answer landing) or a paced timer observing an unblocked running engine.
   * A stopped or host-waiting run is never re-posted: it would only defer
   * again. Every retry mints a fresh transaction id; none replays one.
   */
  function retryWaitingUpdate(): void {
    if (
      disposed ||
      updateInFlight ||
      state.update.status !== "waiting" ||
      state.runKind !== "play"
    ) {
      return;
    }
    const run = session?.run;
    if (run?.preview == null) return;
    if (run.phase === "running" && run.waiting === null) {
      if (updateRetryTimer !== null) {
        clearTimeout(updateRetryTimer);
        updateRetryTimer = null;
      }
      void proposeLatest();
    }
  }

  /** One outstanding retry timer at a time; re-arms only while waiting. */
  function scheduleUpdateRetry(delay: number): void {
    if (updateRetryTimer !== null) return;
    updateRetryTimer = setTimeout(() => {
      updateRetryTimer = null;
      retryWaitingUpdate();
      // Still waiting with nothing proposed — keep pacing; an in-flight
      // attempt's own settle re-arms if it comes back deferred too.
      if (state.update.status === "waiting" && !updateInFlight) {
        scheduleUpdateRetry(UPDATE_RETRY_PACE_MS);
      }
    }, delay);
  }

  /**
   * Capture the complete current draft — every byte and version origin
   * owned before the first await — and ship it to the live lane. One
   * proposal in flight, one queued recapture of the newest coherent draft;
   * a build that fails never reaches the wire and never demotes the run.
   */
  async function proposeLatest(): Promise<void> {
    if (disposed) return;
    const active = session;
    const run = active?.run;
    if (run?.preview == null || state.runKind !== "play") return;
    if (updateInFlight || unresolvedUpdate !== null) {
      // One mutation at a time on the lane. A proposal on the wire queues
      // the newest draft behind it; an unresolved one holds it too — the
      // workspace cannot know the lane's installed build, so nothing new
      // may post until worker evidence says which side the attempt landed.
      updateQueued = true;
      return;
    }
    let build: DebugTestBuild;
    try {
      build = options.draft.captureTestBuild();
    } catch (error) {
      state.error = `Cannot build the draft: ${reason(error)}`;
      state.buildFailed = true;
      state.update = UPDATE_IDLE;
      return;
    }
    state.diagnostics = build.diagnostics;
    const errors = build.diagnostics.filter((entry) => entry.severity === "error");
    if (errors.length > 0) {
      state.error = `Reference errors block this update: ${errors
        .map((entry) => entry.message)
        .join("; ")}`;
      state.buildFailed = true;
      state.update = UPDATE_IDLE;
      return;
    }
    updateInFlight = true;
    state.update = { status: "pending", reason: null, restartable: false };
    let verdict: Awaited<ReturnType<TestSession["previewUpdate"]>>;
    try {
      verdict = await active!.previewUpdate({
        files: build.files,
        profile: build.profile,
        sources: build.sources,
        sourceBindings: build.sourceBindings,
        buildId: build.capture.identity.buildId,
        revision: build.capture.identity.revision,
        origins: build.versions.map((v) => ({ key: v.key, version: v.version })),
      });
    } catch (error) {
      updateInFlight = false;
      if (disposed || active!.run !== run) return;
      // A lane-less or ended run refuses before the wire — surface it as a
      // blocked update rather than an invented outcome.
      state.update = { status: "blocked", reason: reason(error), restartable: true };
      return;
    }
    updateInFlight = false;
    // Ownership follows the physical run, not the operation sequence: a
    // failed or superseding admission that left this run current must not
    // discard its update. Only an actual replacement, end or disposal does.
    if (disposed || active!.run !== run) return;
    applyVerdict(verdict, build);
  }

  /** Fresh lane identity proving the attempt never installed anything. */
  function identityUntouched(
    expected: PreviewLaneIdentity,
    current: PreviewLaneIdentity | null,
  ): boolean {
    return (
      current !== null &&
      current.epoch === expected.epoch &&
      current.buildId === expected.buildId &&
      current.revision === expected.revision &&
      current.updateSerial === expected.updateSerial
    );
  }

  /**
   * Fresh lane identity proving the shipped candidate installed: its exact
   * build and verified revision at precisely the next serial on a moved
   * epoch — the only shape a commit can leave. `current` must be worker
   * evidence, never the session's cached snapshot.
   */
  function identityLanded(
    expected: PreviewLaneIdentity,
    current: PreviewLaneIdentity | null,
    build: DebugTestBuild,
  ): boolean {
    return (
      current !== null &&
      current.epoch !== expected.epoch &&
      current.buildId === build.capture.identity.buildId &&
      current.revision === build.capture.identity.revision &&
      current.updateSerial === expected.updateSerial + 1
    );
  }

  /**
   * The worker's own outcome, applied: a committed or unchanged ACK
   * publishes the candidate's exact bytes and version authority — the
   * session already adopted the lane's recomputed identity — deferred
   * keeps the newest candidate waiting for a quiet boundary; everything
   * else is the worker's own reason, not a guessed one.
   */
  function applyOutcome(outcome: PreviewUpdateOutcome, build: DebugTestBuild): void {
    switch (outcome.status) {
      case "committed":
      case "unchanged":
        publishUpdate(build);
        break;
      case "deferred":
        // Terminal for this id — the newest candidate waits for a quiet
        // boundary and retries under a fresh one.
        state.update = {
          status: "waiting",
          reason:
            outcome.reason ?? "The engine is mid-cycle; the update waits for a quiet boundary.",
          restartable: false,
        };
        scheduleUpdateRetry(UPDATE_RETRY_PACE_MS);
        break;
      case "restartRequired":
        state.update = {
          status: "blocked",
          reason: outcome.reason ?? "The update cannot preserve this run; restart to apply it.",
          restartable: true,
        };
        break;
      case "refused":
        state.update = {
          status: "blocked",
          reason: outcome.reason ?? "The update was refused.",
          restartable: true,
        };
        break;
    }
  }

  /**
   * One attempt's settlement. The worker's own result applies directly; an
   * indeterminate verdict reads the fresh lane identity the status answer
   * recomputed — `current` is null when the worker answered nothing, which
   * holds the attempt unresolved rather than guessing either way.
   */
  function applyVerdict(
    verdict: Awaited<ReturnType<TestSession["previewUpdate"]>>,
    build: DebugTestBuild,
  ): void {
    if (verdict.kind === "indeterminate") {
      const { expected, current } = verdict;
      if (identityLanded(expected, current, build)) {
        // The ACK was lost but the lane's identity proves this candidate —
        // publish its authority exactly as a witnessed commit would.
        publishUpdate(build);
      } else if (identityUntouched(expected, current)) {
        // Nothing committed: the same draft may retry under a fresh id —
        // never a replay of the lost transaction. The debounce cadence is
        // pace enough once the loss is proven.
        state.update = { status: "waiting", reason: null, restartable: false };
        scheduleUpdateRetry(previewDebounceMs);
      } else {
        // No evidence either way: hold the attempt unresolved. The newest
        // draft queues behind it; only this attempt's own late result, a
        // fresh status answer proving one side, or an explicit restart or
        // end replaces it.
        unresolvedUpdate = { id: verdict.id, expected, build };
        state.update = {
          status: "indeterminate",
          reason: "The update's outcome was lost; the run's installed build is unknown.",
          restartable: true,
        };
        scheduleUpdateProbe(UPDATE_RETRY_PACE_MS);
        return; // the queued draft stays held until the attempt resolves
      }
    } else {
      applyOutcome(verdict.outcome, build);
    }
    drainQueuedUpdate();
  }

  /** A resolved attempt drains exactly one proposal — the newest draft. */
  function drainQueuedUpdate(): void {
    if (!updateQueued || unresolvedUpdate !== null) return;
    updateQueued = false;
    void proposeLatest();
  }

  /** One outstanding probe at a time; re-arms only while still unresolved. */
  function scheduleUpdateProbe(delay: number): void {
    if (updateProbeTimer !== null) return;
    updateProbeTimer = setTimeout(() => {
      updateProbeTimer = null;
      probeUnresolvedUpdate();
    }, delay);
  }

  /**
   * Read-only reconciliation for the held attempt: ask the lane's ledger
   * for the lost transaction under a fresh query id, paced and
   * single-flight. An answer may prove the retained outcome, the landed
   * candidate or the untouched pin — silence and timeout prove nothing
   * and keep the attempt held.
   */
  function probeUnresolvedUpdate(): void {
    const attempt = unresolvedUpdate;
    const run = session?.run;
    if (disposed || attempt === null || run?.preview == null) {
      return;
    }
    if (updateProbeInFlight) {
      scheduleUpdateProbe(UPDATE_RETRY_PACE_MS);
      return;
    }
    updateProbeInFlight = true;
    session!
      .previewStatus(attempt.id)
      .then((report) => {
        updateProbeInFlight = false;
        if (disposed || unresolvedUpdate !== attempt || session?.run !== run) return;
        resolveStatusReport(attempt, report);
      })
      .catch(() => {
        updateProbeInFlight = false;
        if (unresolvedUpdate === attempt) scheduleUpdateProbe(UPDATE_RETRY_PACE_MS);
      });
  }

  /**
   * A fresh status answer about the held attempt. Only its own custody
   * resolves it: a retained outcome names the transaction's own record, a
   * recomputed identity proves landed or untouched — anything else keeps
   * the attempt indeterminate and paces the next read.
   */
  function resolveStatusReport(attempt: UnresolvedUpdate, report: PreviewStatusReport): void {
    if (report.runToken !== session?.run?.preview?.runToken) {
      scheduleUpdateProbe(UPDATE_RETRY_PACE_MS);
      return;
    }
    const retained = report.transaction;
    if (typeof retained === "object" && retained !== null && retained.id === attempt.id) {
      // The attempt's own record — apply it exactly as its lost result
      // would have applied.
      unresolvedUpdate = null;
      applyOutcome(retained.outcome, attempt.build);
      drainQueuedUpdate();
      return;
    }
    if (identityLanded(attempt.expected, report.current, attempt.build)) {
      // The ledger lost the record but the lane's recomputed identity
      // proves the candidate installed — the session repinned the same
      // proof on this query's custody, so publish its authority.
      unresolvedUpdate = null;
      publishUpdate(attempt.build);
      drainQueuedUpdate();
      return;
    }
    if (identityUntouched(attempt.expected, report.current)) {
      // Nothing committed: the newest draft may now propose under a
      // fresh id against the verified-unchanged lane.
      unresolvedUpdate = null;
      state.update = { status: "waiting", reason: null, restartable: false };
      scheduleUpdateRetry(previewDebounceMs);
      drainQueuedUpdate();
      return;
    }
    // Mismatched or absent identity proves nothing — keep holding.
    scheduleUpdateProbe(UPDATE_RETRY_PACE_MS);
  }

  /**
   * Run-over bookkeeping: a new admission or an end drops every in-flight
   * or waiting proposal — a late verdict on a dead run never resurrects it.
   */
  function clearUpdateState(): void {
    if (updateTimer !== null) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    if (updateRetryTimer !== null) {
      clearTimeout(updateRetryTimer);
      updateRetryTimer = null;
    }
    if (updateProbeTimer !== null) {
      clearTimeout(updateProbeTimer);
      updateProbeTimer = null;
    }
    updateInFlight = false;
    updateQueued = false;
    unresolvedUpdate = null;
    state.update = UPDATE_IDLE;
  }

  /**
   * A landed update republishes the pinned authority: the candidate's exact
   * build, sources, bindings and document versions replace the frozen set,
   * so the stale comparison and the running-source view read what the
   * engine actually runs — not what the draft has moved on to since.
   */
  function publishUpdate(build: DebugTestBuild): void {
    frozen = build;
    bindings = debugBindings(build.sourceBindings);
    state.frozenSources = build.sources;
    // The clear is honest only while the published capture still names the
    // current draft — a newer draft's own failure is a different
    // diagnostic and survives the incumbent's publication.
    if (!draftVersionsDiffer()) {
      state.buildFailed = false;
      state.error = null;
    }
    const run = session?.run;
    if (run) {
      state.buildId = run.buildId;
      state.epoch = run.epoch;
    }
    state.draftTick++;
    state.update = UPDATE_IDLE;
    rebuildRows();
  }

  /** One document's staleness — the stop highlight only sticks to a matching doc. */
  function isDocStale(key: string): boolean {
    if (!frozen) return false;
    const pinned = frozen.versions.find((v) => v.key === key);
    if (!pinned) return true;
    const current = options.draft.currentVersions().find((v) => v.key === key);
    return current?.version !== pinned.version;
  }

  /**
   * Selector writes resolve through host requests — no session event marks
   * their landing, so the count re-reads on the next session event or frame.
   */
  function syncSaves(): void {
    state.saves = session?.saves().length ?? 0;
  }

  /**
   * Freshly admitted run: publish its identity, lane, build and first held
   * stop. `onReset` is a reentrant boundary — a listener may end or dispose
   * the workspace inside it, so liveness is re-verified after the callback
   * and none of the new build's truth pins itself to a dead facade.
   */
  function applyRunStart(run: TestRun, kind: "debug" | "play", build: DebugTestBuild): void {
    options.onReset?.();
    if (disposed || session?.run !== run) return;
    frozen = build;
    bindings = debugBindings(build.sourceBindings);
    state.frozenSources = build.sources;
    previewWorker = spawnedWorker;
    state.runKind = kind;
    clearUpdateState();
    state.buildFailed = false;
    state.buildId = run.buildId;
    state.profileId = run.profileId as ProfileId;
    state.epoch = run.epoch;
    state.runSeq++;
    state.draftTick++;
    state.modified = false;
    state.evaluations = [];
    state.inspection = { stopId: -1, data: null };
    state.phase = run.phase === "stopped" ? "stopped" : "running";
    state.stop = run.stop;
    state.waiting = run.waiting;
    syncSaves();
    state.logs = run.log;
    state.answersReady = run.stop?.answerReady.length ?? 0;
    state.audioPaused = false;
    resolveStopLocation(run.stop);
    rebuildRows();
    // The entry stop landed inside the boot handshake where the run was not
    // yet live — retry its inspection and repaint pull now that it is.
    refreshInspection();
    pullFrame();
  }

  function rebuildRows(): void {
    const config = session?.run?.config ?? null;
    const applied = new Map((config?.breakpoints ?? []).map((e) => [e.id, e]));
    state.breakpoints = Object.freeze(
      [...breakpointSpecs.values()].map((spec) => {
        const worker = applied.get(spec.id);
        const pending = !worker || JSON.stringify(worker.spec) !== JSON.stringify(spec);
        let binding: DebugBinding | null = worker ? worker.binding : null;
        if (!worker && frozen) {
          try {
            binding = bindLine(frozen.capture, bindings, spec);
          } catch {
            binding = null;
          }
        }
        return {
          id: spec.id,
          spec,
          binding,
          hits: worker?.hits ?? 0,
          fault: worker?.fault ?? null,
          pending,
          applied: worker !== undefined,
        };
      }),
    );
    const appliedWatches = new Map((config?.watchpoints ?? []).map((e) => [e.id, e]));
    state.watches = Object.freeze(
      [...watchSpecs.values()].map((spec) => {
        const worker = appliedWatches.get(spec.id);
        return {
          id: spec.id,
          spec,
          baseline: worker?.baseline ?? null,
          changes: worker?.changes ?? 0,
          fault: worker?.fault ?? null,
          pending: !worker || JSON.stringify(worker.spec) !== JSON.stringify(spec),
          applied: worker !== undefined,
        };
      }),
    );
  }

  /** Fold a stop's reasons into the rows: breakpoint hits and watch faults. */
  function applyStopReasons(stop: TestStop): void {
    const hits = new Map<string, number>();
    const watchFaults = new Map<string, string>();
    const watchChanges = new Map<string, number>();
    for (const r of stop.reasons) {
      if (r.kind === "breakpoint") hits.set(r.id, r.hitCount);
      if (r.kind === "watch") {
        for (const change of r.changes) {
          if (change.reason === "error" && change.error) {
            watchFaults.set(change.id, change.error);
          }
          watchChanges.set(change.id, (watchChanges.get(change.id) ?? 0) + 1);
        }
      }
    }
    if (hits.size || watchFaults.size || watchChanges.size) {
      state.breakpoints = Object.freeze(
        state.breakpoints.map((row) =>
          hits.has(row.id) ? { ...row, hits: hits.get(row.id)! } : row,
        ),
      );
      state.watches = Object.freeze(
        state.watches.map((row) => {
          if (!watchFaults.has(row.id) && !watchChanges.has(row.id)) return row;
          return {
            ...row,
            fault: watchFaults.get(row.id) ?? row.fault,
            changes: row.changes + (watchChanges.get(row.id) ?? 0),
          };
        }),
      );
    }
    state.answersReady = stop.answerReady.length;
  }

  function resolveStopLocation(stop: TestStop | null): void {
    state.stopLocation = null;
    if (!stop?.location || !frozen) return;
    const location = stop.location;
    const position = sourcePositionOf(frozen.capture, location.logic, location.pc, location.kind);
    if (position) {
      state.stopLocation = {
        key: `logic:${location.logic}`,
        logic: location.logic,
        line: position.line,
        column: position.column,
      };
    }
  }

  /** Fetch the pinned inspection for the held stop; a moved-on stop drops the reply. */
  function refreshInspection(): void {
    const run = session?.run;
    const pin = run?.stop?.stopId;
    if (!run || pin === undefined) return;
    let request: Promise<unknown>;
    try {
      request = session!.inspect("all");
    } catch {
      // A stop published inside the boot handshake (stop-on-entry) is real
      // but the run is not live for commands yet — applyRunStart retries
      // once admission resolves.
      state.inspecting = false;
      return;
    }
    state.inspecting = true;
    void request
      .then((data) => {
        if (session?.run?.stop?.stopId === pin) {
          state.inspection = { stopId: pin, data };
          state.inspectionError = null;
        }
      })
      .catch((error) => {
        if (session?.run?.stop?.stopId === pin) state.inspectionError = reason(error);
      })
      .finally(() => {
        if (session?.run?.stop?.stopId === pin) state.inspecting = false;
      });
  }

  /**
   * Pull the held run's composed frame. The worker's host poll suppresses
   * frame posts while a debug stop is held, so a run that only advances
   * through resume/step publishes no frame on its own — the preview asks
   * for a repaint through the same `renderFrame` lane the live host uses.
   */
  function pullFrame(): void {
    const message: WorkerInbound = { type: "renderFrame" };
    previewWorker?.postMessage(message);
  }

  function onSessionEvent(event: TestSessionEvent): void {
    const run = event.run;
    if (session?.run !== run && event.type !== "closed" && event.type !== "error") return;
    syncSaves();
    switch (event.type) {
      case "stopped":
        state.phase = "stopped";
        state.stop = event.stop;
        state.waiting = null;
        state.epoch = event.run.epoch;
        applyStopReasons(event.stop);
        resolveStopLocation(event.stop);
        refreshInspection();
        pullFrame();
        return;
      case "running":
        state.phase = "running";
        state.stop = null;
        state.stopLocation = null;
        state.waiting = event.run.waiting;
        state.answersReady = 0;
        // The boundary a deferred candidate waits for: the run publishing
        // "running" again retries it under a fresh transaction id.
        retryWaitingUpdate();
        return;
      case "configured":
        rebuildRows();
        return;
      case "log":
        state.logs = event.run.log;
        return;
      case "previewOutcome": {
        // The attempt's own result arrived late — after reconciliation
        // already published its verdict. It resolves the held attempt on
        // real evidence; anything else changes nothing.
        const attempt = unresolvedUpdate;
        if (attempt === null || event.id !== attempt.id) return;
        unresolvedUpdate = null;
        applyOutcome(event.outcome, attempt.build);
        drainQueuedUpdate();
        return;
      }
      case "answerReady":
        if (state.stop?.stopId === event.stopId) {
          state.answersReady = state.stop.answerReady.length + 1;
        }
        return;
      case "audio":
        state.audioPaused = event.paused;
        return;
      case "reset":
        options.onReset?.();
        state.epoch = event.epoch;
        state.stop = null;
        state.stopLocation = null;
        rebuildRows();
        pullFrame();
        return;
      case "error":
        state.error = event.error;
        return;
      case "closed":
        previewWorker = null;
        clearUpdateState();
        state.phase = "ended";
        state.runKind = null;
        state.stop = null;
        state.stopLocation = null;
        state.prompt = null;
        promptPending = null;
        state.saves = 0;
        // The run is gone — its private audio closes; the next Test creates
        // a fresh instance instead of leaking this context past the end.
        options.onEnded?.();
        return;
    }
  }

  function askPrompt(
    shape: Omit<DebugPrompt, "id">,
    signal: AbortSignal,
  ): Promise<number | string | null> {
    return new Promise((resolve) => {
      const prompt: DebugPrompt = { id: ++promptSeq, ...shape };
      promptPending = { prompt, resolve };
      state.prompt = prompt;
      state.waiting = "host";
      signal.addEventListener(
        "abort",
        () => {
          if (promptPending?.prompt.id === prompt.id) {
            promptPending = null;
            state.prompt = null;
            resolve(null);
          }
        },
        { once: true },
      );
    });
  }

  function ensureSession(): TestSession {
    if (session) return session;
    const prompts: TestPrompts = {
      getNumber(req, signal) {
        return askPrompt(
          {
            kind: "number",
            prompt: req.prompt,
            maxLen: 20,
            row: req.row,
            col: req.col,
            initial: "",
          },
          signal,
        ) as Promise<number | null>;
      },
      getString(req, signal) {
        return askPrompt(
          {
            kind: "string",
            prompt: req.prompt,
            maxLen: req.maxLen,
            row: req.row,
            col: req.col,
            initial: "",
          },
          signal,
        ) as Promise<string | null>;
      },
      saveDescription(req, signal) {
        return askPrompt(
          {
            kind: "describe",
            prompt: "Save description",
            maxLen: req.maxLen,
            row: req.row,
            col: req.col,
            initial: req.initial,
          },
          signal,
        ) as Promise<string | null>;
      },
    };
    const created = createSession({
      ...(options.acquirePauseLease ? { acquirePauseLease: options.acquirePauseLease } : {}),
      ...(options.previewAckTimeoutMs !== undefined
        ? { previewAckTimeoutMs: options.previewAckTimeoutMs }
        : {}),
      prompts,
      createWorker: () => {
        const worker = (options.createWorker ?? spawnEngineWorker)();
        // A candidate's spawn is only latched here — the preview's repaint
        // channel switches to it at commit, in applyRunStart, so a refused
        // candidate never steals the live run's channel.
        spawnedWorker = worker;
        return worker;
      },
      onPresentation: (message) => {
        if (message.type === "waitingForKey") {
          const run = session?.run;
          state.waiting = message.waiting ? "key" : (run?.waiting ?? null);
        }
        // Selector writes land between waits — the steady frame stream is the
        // honest signal that the store may have moved.
        if (message.type === "frame" || message.type === "waitingForKey") syncSaves();
        if (message.type === "quit") options.onQuit?.();
        options.onPresentation?.(message);
      },
    });
    session = created;
    unsubscribe = created.on(onSessionEvent);
    return created;
  }

  /**
   * Validate the complete authored configuration locally against the
   * candidate build — before any spawn, and without touching the pinned
   * run's frozen authority.
   */
  function validateSpecs(build: DebugTestBuild): void {
    const candidateBindings = debugBindings(build.sourceBindings);
    if (breakpointSpecs.size > 0) {
      createDebugBreakpointPlan({ build: build.capture, bindings: candidateBindings }).configure({
        revision: ++localRevision,
        breakpoints: [...breakpointSpecs.values()],
      });
    }
    if (watchSpecs.size > 0) {
      createDebugWatchpointPlan({ build: build.capture, bindings: candidateBindings }).configure(
        { revision: ++localRevision, watchpoints: [...watchSpecs.values()] },
        emptySnapshot(),
      );
    }
  }

  /**
   * Push the authored configuration to the live run; the worker's published
   * statuses — never the local preview — are the authority on what armed.
   */
  async function pushConfig(): Promise<TestDebugConfig | null> {
    if (!session?.run) {
      rebuildRows();
      return null;
    }
    const config = await session.configure({
      breakpoints: [...breakpointSpecs.values()],
      watchpoints: [...watchSpecs.values()],
    });
    rebuildRows();
    return config;
  }

  function updateBreakpoint(
    id: string,
    patch: Partial<
      Pick<DebugBreakpointSpec, "enabled" | "condition" | "hit" | "log" | "mode" | "column">
    >,
  ): DebugSpecVerdict {
    const existing = breakpointSpecs.get(id);
    if (!existing) return { ok: false, error: `Unknown breakpoint ${id}.` };
    const merged: DebugBreakpointSpec = { ...existing, ...patch, id };
    try {
      createDebugBreakpointPlan({
        build: frozen?.capture ?? EMPTY_CAPTURE,
        bindings,
      }).configure({
        revision: ++localRevision,
        breakpoints: [...breakpointSpecs.values()].map((spec) => (spec.id === id ? merged : spec)),
      });
    } catch (error) {
      return { ok: false, error: reason(error) };
    }
    breakpointSpecs.set(id, merged);
    void pushConfig().catch((error) => (state.configError = reason(error)));
    rebuildRows();
    return { ok: true };
  }

  function updateWatch(
    id: string,
    patch: Partial<Pick<DebugWatchSpec, "enabled" | "condition">>,
  ): DebugSpecVerdict {
    const existing = watchSpecs.get(id);
    if (!existing) return { ok: false, error: `Unknown watchpoint ${id}.` };
    const merged: DebugWatchSpec = { ...existing, ...patch, id };
    try {
      createDebugWatchpointPlan({
        build: frozen?.capture ?? EMPTY_CAPTURE,
        bindings,
      }).configure(
        {
          revision: ++localRevision,
          watchpoints: [...watchSpecs.values()].map((spec) => (spec.id === id ? merged : spec)),
        },
        emptySnapshot(),
      );
    } catch (error) {
      return { ok: false, error: reason(error) };
    }
    watchSpecs.set(id, merged);
    void pushConfig().catch((error) => (state.configError = reason(error)));
    rebuildRows();
    return { ok: true };
  }

  /**
   * The truth a refused candidate must hand back: the still-pinned run's own
   * phase, or idle only when nothing is admitted. "Stopped" and "running"
   * read the run's published state — a refused new build never relabels a
   * live run idle and never clears its frozen sources.
   */
  function livePhase(): DebugPhase {
    const run = session?.run ?? null;
    if (run === null) return "idle";
    return run.stop === null ? "running" : "stopped";
  }

  /**
   * Settle honestly after an operation whose awaited result no longer names
   * the live run — a refused candidate, an end in the await window or a
   * supersede: republish the committed run's own phase, or idle when
   * nothing is admitted. An "ended" workspace keeps that truth.
   */
  function settleLiveTruth(): void {
    if (disposed || state.phase === "ended") return;
    state.phase = livePhase();
    if (session?.run == null) state.runKind = null;
  }

  /**
   * Build the complete current draft and admit a frozen run on it. `kind`
   * is the lane: "debug" latches the entry stop with the authored specs
   * armed; "play" boots `stopOnEntry:false` with nothing armed — ordinary
   * playtesting never waits on a debugger gesture.
   *
   * Replacement is transactional: the candidate is captured and validated
   * without touching the pinned build, sources or bindings, and the session
   * keeps the committed run — worker, progressed engine state, lease —
   * until the candidate's boot is fully acknowledged. A refusal anywhere
   * releases only the candidate, so the preview keeps running the older
   * good build and says so. Only the admitted build is ever pinned.
   */
  async function beginRun(kind: "debug" | "play"): Promise<TestRun> {
    if (disposed) throw new TestRuntimeError("the debug workspace is disposed", "closed");
    if (admissionPending) {
      throw new TestRuntimeError("a test is already starting", "refused");
    }
    admissionPending = true;
    const op = ++operationSeq;
    try {
      state.phase = "building";
      state.error = null;
      state.configError = null;
      state.buildFailed = false;
      /**
       * The refused candidate never touched the pinned run's truth — the
       * session still publishes the committed run — so restoring means
       * reporting its own phase again, unless the run was ended meanwhile.
       */
      const restore = settleLiveTruth;
      let build: DebugTestBuild;
      try {
        build = options.draft.captureTestBuild();
      } catch (error) {
        restore();
        state.error = `Cannot build the draft: ${reason(error)}`;
        state.buildFailed = true;
        throw error;
      }
      state.diagnostics = build.diagnostics;
      const errors = build.diagnostics.filter((entry) => entry.severity === "error");
      if (errors.length > 0) {
        restore();
        state.error = `Reference errors block this test: ${errors
          .map((entry) => entry.message)
          .join("; ")}`;
        state.buildFailed = true;
        throw new TestRuntimeError(state.error, "refused");
      }
      // The lane validates only the configuration it arms: Debug proves the
      // authored specs bind against the candidate build; Play carries no
      // specs, so an obsolete debug spec can never block a valid Play build.
      if (kind === "debug") {
        try {
          validateSpecs(build);
        } catch (error) {
          restore();
          state.configError = reason(error);
          throw error;
        }
      }
      state.phase = "starting";
      const active = ensureSession();
      let run: TestRun;
      try {
        run = await active.start(
          {
            files: build.files,
            profile: build.profile,
            sources: build.sources,
            sourceBindings: build.sourceBindings,
          },
          {
            breakpoints: kind === "debug" ? [...breakpointSpecs.values()] : [],
            watchpoints: kind === "debug" ? [...watchSpecs.values()] : [],
            stopOnEntry: kind === "debug",
            lane: kind === "play" ? "play-preview" : "debug",
          },
        );
      } catch (error) {
        // Refused before commit: the session kept the committed run, so the
        // preview is still the older good build — labelled, never idle.
        restore();
        state.error = reason(error);
        state.buildFailed = true;
        throw error;
      }
      /**
       * The admission resolved — but publish only while it still names this
       * operation's live run. An end/dispose landing inside the await window
       * (the boot ACK commits before the continuation resumes) already ended
       * the workspace truthfully; republishing here would resurrect a dead
       * facade. A superseded or closed run fails the identity check too.
       */
      if (disposed || op !== operationSeq || active.run !== run) {
        settleLiveTruth();
        return run;
      }
      applyRunStart(run, kind, build);
      return run;
    } finally {
      admissionPending = false;
    }
  }

  /**
   * Same-build restart shared by both lanes: a fresh worker epoch on the
   * pinned image — the session replays the options the build was admitted
   * with, so a play run stays unpaused and a debug run re-latches entry.
   */
  async function restartSameBuild(kind: "debug" | "play"): Promise<void> {
    const active = session;
    if (!active?.run || !frozen) {
      throw new TestRuntimeError("no isolated test run to restart", "closed");
    }
    if (admissionPending) {
      throw new TestRuntimeError("a test is already starting", "refused");
    }
    const op = ++operationSeq;
    state.phase = "starting";
    state.error = null;
    try {
      const run = await active.restart();
      // Same publish guard as a fresh admission: an end/dispose inside the
      // await window must not let the restart relabel a dead facade running.
      if (disposed || op !== operationSeq || active.run !== run) {
        settleLiveTruth();
        return;
      }
      applyRunStart(run, kind, frozen);
    } catch (error) {
      settleLiveTruth();
      state.error = reason(error);
      throw error;
    }
  }

  /**
   * The project-level preview surface: Play latest, Pause, Continue, the two
   * restarts and End — plus the run's game input. A host that owns one
   * preview across sibling editors holds this handle; the debugger-only
   * verbs (stops, steps, inspections, spec edits) stay on the workspace.
   */
  const previewHandle: DebugPreviewHandle = {
    state,
    hasRun: () => session?.run != null,
    run: () => session?.run ?? null,
    playLatest: () => beginRun("play"),
    pause: () => ensureSession().pause(),
    resume: () => ensureSession().resume("continue"),
    restartLatest: () => beginRun("play"),
    restartBuild: () => restartSameBuild("play"),
    end: () => {
      operationSeq++;
      clearUpdateState();
      session?.close();
      state.phase = "ended";
      state.runKind = null;
    },
    key: (code) => {
      if (session?.run?.phase === "running") session.key(code);
    },
    submitInput: (text) => {
      if (session?.run?.phase === "running") session.input(text);
    },
    click: (x, y) => {
      if (session?.run?.phase === "running") session.click(x, y);
    },
    direction: (dir, release) => {
      if (session?.run?.phase === "running") session.direction(dir, release);
    },
  };

  return {
    state,
    /** The play lane's narrow handle — the surface a sibling-nav host holds. */
    preview: previewHandle,

    /** Compile the complete current draft and start a frozen run on it. */
    async test(): Promise<TestRun> {
      return beginRun("debug");
    },

    /**
     * Ordinary playtesting: the same complete-draft admission as `test()`,
     * running immediately — `stopOnEntry:false`, and no authored breakpoints
     * or watchpoints armed, so one click plays. Debug stays the explicit
     * lane. A refused build or admission keeps the previous run.
     */
    async play(): Promise<TestRun> {
      return beginRun("play");
    },

    /**
     * Same-build restart: a fresh worker epoch on the pinned image, keeping
     * the run's lane. The run's in-session save slots survive — the draft is
     * not re-read.
     */
    async restartRun(): Promise<void> {
      await restartSameBuild(state.runKind ?? "debug");
    },

    async continueRun(): Promise<void> {
      await ensureSession().resume("continue");
    },
    async pauseRun(): Promise<void> {
      await ensureSession().pause();
    },
    /** Step granularity applies to into/over/out; cycle ignores it. */
    async step(action: Exclude<DebugResumeAction, "continue">): Promise<void> {
      await ensureSession().resume(action, action === "cycle" ? undefined : state.granularity);
    },
    async runToCursor(key: string, line: number): Promise<DebugSpecVerdict> {
      if (!frozen) return { ok: false, error: "Run a test first to freeze a build." };
      if (!key.startsWith("logic:")) {
        return { ok: false, error: "Run-to-cursor works on LOGIC source." };
      }
      if (isDocStale(key)) {
        return {
          ok: false,
          error: "The draft moved since this build; test the latest draft to run to a new line.",
        };
      }
      const logic = Number(key.slice(6));
      const spec: DebugBreakpointSpec = {
        id: "$cursor",
        enabled: true,
        logic,
        line,
        mode: "statement",
      };
      let binding: DebugBinding;
      try {
        binding = bindLine(frozen.capture, bindings, spec);
      } catch (error) {
        return { ok: false, error: reason(error) };
      }
      if (!binding.bound || binding.pcs.length === 0) {
        return { ok: false, error: `No statement binds at ${key}:${line}.` };
      }
      try {
        await ensureSession().runTo({ logic, pc: binding.pcs[0]! });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: reason(error) };
      }
    },

    /** Gutter toggle: one statement breakpoint per authored line. */
    toggleBreakpoint(at: { logic: number; line: number }): void {
      const id = `logic:${at.logic}:${at.line}`;
      if (breakpointSpecs.delete(id)) {
        void pushConfig().catch((error) => (state.configError = reason(error)));
        rebuildRows();
        return;
      }
      breakpointSpecs.set(id, {
        id,
        enabled: true,
        logic: at.logic,
        line: at.line,
        mode: "statement",
      });
      void pushConfig().catch((error) => (state.configError = reason(error)));
      rebuildRows();
    },

    /**
     * Edit one breakpoint's fields; the merged spec is fully validated
     * against the frozen build (or bare limits pre-build) before the worker
     * hears about it. A refused edit leaves the spec untouched.
     */
    updateBreakpoint,

    removeBreakpoint(id: string): void {
      if (breakpointSpecs.delete(id)) {
        void pushConfig().catch((error) => (state.configError = reason(error)));
        rebuildRows();
      }
    },

    setBreakpointEnabled(id: string, enabled: boolean): DebugSpecVerdict {
      return updateBreakpoint(id, { enabled });
    },

    addWatch(target: DebugWatchTarget, condition?: string): DebugSpecVerdict {
      const id = `watch:${++watchSeq}`;
      const spec: DebugWatchSpec = {
        id,
        enabled: true,
        target,
        ...(condition !== undefined && condition !== "" ? { condition } : {}),
      };
      try {
        createDebugWatchpointPlan({
          build: frozen?.capture ?? EMPTY_CAPTURE,
          bindings,
        }).configure(
          { revision: ++localRevision, watchpoints: [...watchSpecs.values(), spec] },
          emptySnapshot(),
        );
      } catch (error) {
        return { ok: false, error: reason(error) };
      }
      watchSpecs.set(id, spec);
      void pushConfig().catch((error) => (state.configError = reason(error)));
      rebuildRows();
      return { ok: true };
    },

    updateWatch,

    removeWatch(id: string): void {
      if (watchSpecs.delete(id)) {
        void pushConfig().catch((error) => (state.configError = reason(error)));
        rebuildRows();
      }
    },

    /** Read-only evaluation pinned to the held stop; stale stops reject. */
    async evaluate(expression: string): Promise<DebugValue> {
      const run = session?.run;
      if (!run?.stop) {
        throw new TestRuntimeError("the isolated test run is not stopped", "notStopped");
      }
      const pin = run.stop.stopId;
      try {
        const value = await session!.evaluate(expression);
        state.evaluations = Object.freeze(
          [{ expression, stopId: pin, value }, ...state.evaluations].slice(0, EVAL_LIMIT),
        );
        return value;
      } catch (error) {
        state.evaluations = Object.freeze(
          [{ expression, stopId: pin, error: reason(error) }, ...state.evaluations].slice(
            0,
            EVAL_LIMIT,
          ),
        );
        throw error;
      }
    },

    /** The pinned inspection for the held stop (objects, stack, snapshot). */
    async inspect(section: DebugInspectSection = "all"): Promise<unknown> {
      const run = session?.run;
      if (!run?.stop) {
        throw new TestRuntimeError("the isolated test run is not stopped", "notStopped");
      }
      const pin = run.stop.stopId;
      const data = await session!.inspect(section);
      if (session?.run?.stop?.stopId === pin) {
        state.inspection = { stopId: pin, data };
      }
      return data;
    },

    /**
     * An atomic write through the worker: every value validates before any
     * applies. The run is marked modified and the fresh stop identity comes
     * back — local state is never invented.
     */
    async setValues(values: {
      vars?: readonly (readonly [number, number])[];
      flags?: readonly (readonly [number, number])[];
    }): Promise<number> {
      const stopId = await ensureSession().setValues(values);
      state.modified = true;
      const run = session?.run;
      if (run?.stop && run.stop.stopId === stopId) state.stop = run.stop;
      refreshInspection();
      return stopId;
    },

    /** Reveal the held stop's authored position in the editor. */
    navigateToStop(): boolean {
      const at = state.stopLocation;
      if (!at) return false;
      options.navigate?.({ key: at.key, line: at.line, column: at.column });
      return true;
    },

    /**
     * Editor annotations for one logic document: authored breakpoints plus
     * the held stop's line — only while the document still matches the
     * frozen build. A moved-on draft never inherits the frozen highlight.
     */
    decorationsFor(key: string): readonly DebugDecoration[] {
      const out: DebugDecoration[] = [];
      const logicMatch = /^logic:(\d+)$/.exec(key);
      if (logicMatch) {
        const logic = Number(logicMatch[1]);
        for (const row of state.breakpoints) {
          if (row.spec.logic !== logic) continue;
          const line =
            row.binding?.bound === true && !row.pending && row.applied
              ? row.binding.line
              : row.spec.line;
          out.push({
            line,
            kind: !row.spec.enabled
              ? "breakpoint-disabled"
              : row.binding && !row.binding.bound
                ? "breakpoint-unbound"
                : row.pending
                  ? "breakpoint-pending"
                  : "breakpoint",
          });
        }
        const at = state.stopLocation;
        if (at && at.logic === logic && !isDocStale(key)) {
          out.push({ line: at.line, column: at.column, kind: "stop" });
        }
      }
      return out;
    },

    /** True while a session holds a live run. */
    hasRun(): boolean {
      return session?.run != null;
    },
    /** The live run facade — for status lines and saves. */
    run(): TestRun | null {
      return session?.run ?? null;
    },
    /** The frozen build under test — the running-source diff's left side. */
    frozenBuild(): DebugTestBuild | null {
      return frozen;
    },
    /** One document's frozen source, for the running-source view. */
    frozenSource(key: string): string | null {
      const logicMatch = /^logic:(\d+)$/.exec(key);
      if (!logicMatch) return null;
      return frozen?.sources[logicMatch[1]!] ?? null;
    },
    isDocStale,
    noteDraftChanged,
    saves() {
      return session?.saves() ?? [];
    },

    // ---- game input: routed only while the committed run is live and not
    // stopped — a pending candidate never receives it, and a "starting"
    // phase over a live run does not drop it ----

    key(code: number): void {
      if (session?.run?.phase === "running") session.key(code);
    },
    submitInput(text: string): void {
      if (session?.run?.phase === "running") session.input(text);
    },
    click(x: number, y: number): void {
      if (session?.run?.phase === "running") session.click(x, y);
    },
    direction(dir: number, release?: boolean): void {
      if (session?.run?.phase === "running") session.direction(dir, release);
    },

    // ---- prompts ----

    submitPrompt(text: string): void {
      const pending = promptPending;
      if (!pending) return;
      promptPending = null;
      state.prompt = null;
      if (pending.prompt.kind === "number") {
        const parsed = text.trim() === "" ? NaN : Number.parseInt(text, 10);
        pending.resolve(Number.isInteger(parsed) ? parsed & 0xff : null);
      } else {
        pending.resolve(text);
      }
    },
    cancelPrompt(): void {
      const pending = promptPending;
      if (!pending) return;
      promptPending = null;
      state.prompt = null;
      pending.resolve(null);
    },

    /** End the run: the worker dies, the lease releases, prompts abort. */
    endTest(): void {
      operationSeq++;
      clearUpdateState();
      session?.close();
      state.phase = "ended";
      state.runKind = null;
    },

    /**
     * The assistant's read-only context lines: frozen build, run identity,
     * the held stop's location and a few named values — never an authority
     * to change the draft.
     */
    contextLines(): readonly string[] {
      const lines: string[] = [];
      const run = session?.run;
      if (!run || !frozen) return Object.freeze(lines);
      lines.push(`test build ${run.buildId.slice(0, 12)} epoch ${run.epoch}`);
      lines.push(`phase ${state.phase}${state.modified ? " (modified by set-values)" : ""}`);
      if (draftVersionsDiffer()) {
        lines.push("draft changed since this test build; the frozen run stays pinned");
      }
      const stop = state.stop;
      if (stop) {
        const causes = stop.reasons.map((r) => r.kind).join(", ") || "pause";
        const at = state.stopLocation;
        lines.push(
          `stopped #${stop.stopId} at ${
            at
              ? `${at.key}:${at.line}`
              : `logic ${stop.location?.logic ?? "?"} pc ${stop.location?.pc ?? "?"}`
          } — ${causes}`,
        );
        const named = Object.entries(bindings)
          .filter(([, b]) => b.kind === "variable")
          .slice(0, 8)
          .map(([name, b]) => `${name}=v${b.num}:${stop.state.vars[b.num] ?? "?"}`);
        if (named.length) lines.push(`values ${named.join(" ")}`);
        if (stop.answerReady.length) {
          lines.push(`${stop.answerReady.length} queued host answer(s)`);
        }
      }
      return Object.freeze(lines);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      operationSeq++;
      clearUpdateState();
      promptPending?.resolve(null);
      promptPending = null;
      state.prompt = null;
      unsubscribe?.();
      unsubscribe = null;
      previewWorker = null;
      session?.close();
      session = null;
      state.phase = "ended";
      state.runKind = null;
      state.stop = null;
      state.stopLocation = null;
      frozen = null;
    },
  };
}

type DebugWorkspace = ReturnType<typeof createDebugWorkspace>;
