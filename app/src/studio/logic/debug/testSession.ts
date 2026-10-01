/**
 * The Studio's isolated Test session: one browser worker running the real
 * engine under the frozen-test admission policy. The session owns worker
 * lifecycle, run/epoch identity, debugger command traffic and the ephemeral
 * host adapter (see testHost.ts). Nothing here touches project storage —
 * the run's saves, answers and events belong to the run and die with it.
 *
 * A run is an identity-bearing generation: replacing it terminates its
 * worker, rejects its in-flight commands, aborts its open prompts and
 * drops every late message the old worker still posts. The injected pause
 * lease parks the live game for the run's lifetime and is released exactly
 * once — a fulfillment that lands after the run died releases itself.
 *
 * `start()` is transactional: the candidate acquires only its own lease and
 * worker while the committed run keeps progressing — engine state, input,
 * frames, audio and its park. The swap happens exactly once, on the
 * candidate's acknowledged boot (verified attach, matching build, `booted`),
 * and the replaced run is torn down only afterward. Any refusal or teardown
 * before that commit releases the candidate's resources alone. `restart()`
 * is the explicit destructive gesture: it ends the committed run first.
 */
import { captureProjectBuild } from "../../../../../src/authoring/projectBuild.ts";
import { parseWordsTok } from "../../../../../src/logic/words.ts";
import type { ProfileId } from "../../../../../src/runtime/profile.ts";
import type {
  ExecutionCause,
  ExecutionWaitKind,
} from "../../../../../src/runtime/executionObservation.ts";
import type {
  DebugBreakpointSpec,
  DebugBreakpointStatus,
} from "../../../../../src/runtime/debugBreakpoints.ts";
import type {
  DebugWatchSpec,
  DebugWatchStatus,
} from "../../../../../src/runtime/debugWatchpoints.ts";
import type { DebugValue } from "../../../../../src/runtime/debugExpression.ts";
import type { EngineStateReport, ExecutionBoundary } from "../../../../../src/runtime/engine.ts";
import type {
  DebugErrorCode,
  DebugResumeAction,
  DebugStepGranularity,
  DebugStopReason,
  FrozenTestBoot,
  PreviewLaneIdentity,
  PreviewUpdateCandidateMessage,
  PreviewUpdateOutcome,
  SourceBindingKind,
  WorkerInbound,
  WorkerOutbound,
} from "../../../worker/workerProtocol.ts";
import {
  createTestHost,
  type TestHost,
  type TestHostRequest,
  type TestPrompts,
  type TestSaveSlot,
} from "./testHost.ts";

/** A failure the session raises itself or relays from the worker. */
export class TestRuntimeError extends Error {
  readonly code: "refused" | "replaced" | "closed" | "notStopped" | "worker";
  readonly debugCode?: DebugErrorCode;
  constructor(
    message: string,
    code: "refused" | "replaced" | "closed" | "notStopped" | "worker" = "worker",
    debugCode?: DebugErrorCode,
  ) {
    super(message);
    this.name = "TestRuntimeError";
    this.code = code;
    if (debugCode !== undefined) this.debugCode = debugCode;
  }
}

/** The surface a browser `Worker` already satisfies. */
export interface TestWorkerLike {
  onmessage: ((event: { data: WorkerOutbound }) => void) | null;
  postMessage(message: WorkerInbound): void;
  terminate(): void;
}

/**
 * One immutable build the session can run. Every field is cloned at
 * `start()` before the first await — later edits to the caller's draft
 * cannot leak into an admitted run.
 */
export interface IsolatedTestGame {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profile: ProfileId;
  readonly sources: Readonly<Record<string, string>>;
  readonly sourceBindings: Readonly<Record<string, { kind: SourceBindingKind; num: number }>>;
}

export interface TestStartOptions {
  readonly breakpoints?: readonly DebugBreakpointSpec[];
  readonly watchpoints?: readonly DebugWatchSpec[];
  /** Latch the pre-first-cycle entry stop (default true). */
  readonly stopOnEntry?: boolean;
  /**
   * The lane this run serves. Absent or "debug" is the frozen test session.
   * "play-preview" is ordinary playtesting that also owns same-Engine live
   * update authority — the worker grants it in `debugAttached.preview` and
   * the session publishes it on `run.preview`. `stopOnEntry:false` alone
   * never grants it; the flag travels only on an explicit lane request and
   * survives a same-build restart through the frozen options.
   */
  readonly lane?: "debug" | "play-preview";
}

/**
 * The update authority a play-preview boot granted: the physical run's
 * token plus the identity tuple every `previewUpdate` pins its `expected`
 * claim against. All of it is the worker's own report — the session adopts
 * the `current` identity every result and status answer recomputes.
 */
type PreviewGrant = PreviewLaneIdentity & { readonly runToken: string };

/** One previewUpdate attempt's settlement as the session observed it. */
type PreviewUpdateVerdict =
  | {
      /** The worker answered the request itself — its outcome is fact. */
      readonly kind: "settled";
      readonly id: number;
      readonly outcome: PreviewUpdateOutcome;
    }
  | {
      /**
       * The ACK never arrived and the retained ledger could not name the
       * transaction: the lane's `current` identity is the only truth. When
       * it still equals `expected`, nothing committed; when it proves the
       * candidate's identity, the commit landed unacknowledged; anything
       * else is genuinely unknown — restart is the honest resolution.
       */
      readonly kind: "indeterminate";
      readonly id: number;
      readonly expected: PreviewLaneIdentity;
      readonly current: PreviewLaneIdentity | null;
    };

/** The read-only answer a `previewUpdateStatus` query returns. */
export interface PreviewStatusReport {
  readonly runToken: string | null;
  readonly current: PreviewLaneIdentity | null;
  readonly transaction:
    | { readonly id: number; readonly outcome: PreviewUpdateOutcome }
    | "unavailable"
    | "unknown"
    | null;
}

/**
 * The run's last published debugger configuration: the revision plus the
 * resolved breakpoint/watchpoint statuses the worker actually reported —
 * binding outcomes, hit counts and faults included, never reconstructed
 * here. Detached and frozen at publication; replaced wholesale on every
 * `debugConfigured`/`debugSessionReset`.
 */
export interface TestDebugConfig {
  readonly revision: number;
  readonly breakpoints: readonly DebugBreakpointStatus[];
  readonly watchpoints: readonly DebugWatchStatus[];
}

/** One logpoint emission, stamped with the boundary sequence that produced it. */
export interface TestLogEntry {
  readonly sequence: number;
  readonly breakpoint: string;
  readonly text: string;
}

/** The published stop — the worker's `debugStopped` payload, detached. */
export interface TestStop {
  readonly stopId: number;
  readonly boundarySeq: number | null;
  readonly cause: ExecutionCause;
  readonly location: ExecutionBoundary | null;
  readonly wait: ExecutionWaitKind | null;
  readonly reasons: readonly DebugStopReason[];
  readonly state: EngineStateReport;
  readonly answerReady: readonly number[];
}

/** One admitted run's live identity. Field reads reflect the current record. */
export interface TestRun {
  readonly epoch: number;
  readonly buildId: string;
  readonly profileId: string;
  /** "stopped" while the debug latch holds a published stop. */
  readonly phase: "running" | "stopped";
  /** The latest published stop — replaced wholesale, never mutated. */
  readonly stop: TestStop | null;
  /** What the engine is parked on: a raw key wait or a host request. */
  readonly waiting: "key" | "host" | null;
  /** The effective debugger configuration — the worker's own statuses. */
  readonly config: TestDebugConfig;
  /** Logpoint output this run produced, bounded (oldest dropped). */
  readonly log: readonly TestLogEntry[];
  /**
   * The play-preview lane grant, or null when this run holds no update
   * authority. Its identity fields are the last reconciled truth — every
   * result and status answer the worker recomputes replaces them.
   */
  readonly preview: PreviewGrant | null;
}

export type TestSessionEvent =
  | { type: "stopped"; run: TestRun; stop: TestStop }
  | { type: "running"; run: TestRun }
  | {
      /** A configure reply landed — `config` is the worker's resolved state. */
      type: "configured";
      run: TestRun;
      config: TestDebugConfig;
    }
  | { type: "log"; run: TestRun; entry: TestLogEntry }
  | {
      /**
       * A queued host answer arrived while this stop is held — `id`/`op`
       * name which outstanding request it belongs to. It applies on resume.
       */
      type: "answerReady";
      run: TestRun;
      stopId: number;
      id: number;
      op: string;
    }
  | {
      /** The debugger's audio hold changed for this epoch — `paused` is the worker's own state. */
      type: "audio";
      run: TestRun;
      epoch: number;
      paused: boolean;
    }
  | {
      /**
       * A previewUpdate's own result arrived after its verdict already
       * settled through reconciliation — the late-correlated settlement,
       * carrying the worker's outcome for whoever still holds the attempt.
       */
      type: "previewOutcome";
      run: TestRun;
      id: number;
      outcome: PreviewUpdateOutcome;
    }
  | { type: "reset"; run: TestRun; epoch: number }
  | { type: "error"; run: TestRun | null; error: string }
  | { type: "closed"; run: TestRun | null };

/** The opaque live-game pause lease the host injects. */
export interface TestPauseLease {
  release(): void;
}

/**
 * The browser default: the same production module worker the Play path
 * spawns — real dispatch, real engine, no test-only substitute.
 */
function spawnEngineWorker(): TestWorkerLike {
  const worker = new Worker(new URL("../../../worker/engine.worker.ts", import.meta.url), {
    type: "module",
  });
  // Bridge the DOM MessageEvent handler shape onto the narrow test surface.
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

export interface TestSessionOptions {
  /** Spawn the run's worker; defaults to the real engine worker module. */
  createWorker?(): TestWorkerLike;
  /** Parks the live game while a run exists; may resolve asynchronously. */
  acquirePauseLease?(): TestPauseLease | Promise<TestPauseLease>;
  /** UI prompt callbacks for the run's host requests; absent = cancel/empty. */
  prompts?: TestPrompts;
  /** The run's presentation stream (frames, sound, text mirrors). */
  onPresentation?(message: WorkerOutbound): void;
  /**
   * How long a previewUpdate waits for its ACK before the session queries
   * `previewUpdateStatus` on the same physical run. A lost ACK never kills
   * the worker — the verdict reconciles through the lane's retained ledger
   * or reports indeterminate. Default 1500ms.
   */
  previewAckTimeoutMs?: number;
}

export interface TestSession {
  /** The live run's facade, or null while nothing is admitted. */
  readonly run: TestRun | null;
  start(game: IsolatedTestGame, options?: TestStartOptions): Promise<TestRun>;
  /** Same pinned build, fresh worker; the build's save slots survive. */
  restart(): Promise<TestRun>;
  close(): void;
  pause(): Promise<void>;
  resume(action?: DebugResumeAction, granularity?: DebugStepGranularity): Promise<void>;
  runTo(location: { logic: number; pc: number }): Promise<void>;
  evaluate(expression: string): Promise<DebugValue>;
  inspect(section?: "stack" | "state" | "objects" | "parser" | "strings" | "all"): Promise<unknown>;
  setValues(values: {
    vars?: readonly (readonly [number, number])[];
    flags?: readonly (readonly [number, number])[];
  }): Promise<number>;
  configure(config: {
    breakpoints?: readonly DebugBreakpointSpec[];
    watchpoints?: readonly DebugWatchSpec[];
  }): Promise<TestDebugConfig>;
  /**
   * Propose one complete candidate to the live run's play-preview lane. The
   * promise settles with the worker's terminal outcome, or `indeterminate`
   * when its ACK was lost and reconciliation could not name the transaction.
   * Lane-less runs refuse before anything is posted.
   */
  previewUpdate(candidate: PreviewUpdateCandidateMessage): Promise<PreviewUpdateVerdict>;
  /**
   * Read-only reconciliation on the live lane: its recomputed identity, and
   * a named transaction's retained outcome when `transactionId` is given.
   */
  previewStatus(transactionId?: number): Promise<PreviewStatusReport>;
  key(code: number): void;
  input(text: string): void;
  click(x: number, y: number): void;
  direction(dir: number, release?: boolean): void;
  /** The ephemeral store's slots — never durable, never shared. */
  saves(): readonly TestSaveSlot[];
  on(listener: (event: TestSessionEvent) => void): () => void;
}

interface FrozenGame {
  readonly buildId: string;
  /** The pinned build's own verified resource revision — custody proof. */
  readonly revision: string;
  readonly profileId: ProfileId;
  readonly files: Record<string, Uint8Array>;
  readonly words: [string, number][];
  readonly sources: Record<string, string>;
  readonly sourceBindings: Record<string, { kind: SourceBindingKind; num: number }>;
  readonly bindings: Record<string, { kind: "variable" | "flag" | "string"; num: number }>;
}

interface FrozenOptions {
  readonly breakpoints: readonly DebugBreakpointSpec[];
  readonly watchpoints: readonly DebugWatchSpec[];
  readonly stopOnEntry: boolean;
  /** The lane the run was booted for — replayed verbatim on a restart. */
  readonly lane: "debug" | "play-preview";
}

/** The reply types a pending debugger command may settle with. */
type DebugReplyType =
  "debugAck" | "debugConfigured" | "debugEvaluation" | "debugInspection" | "debugSetValuesAck";

/** Every reply type allowed to settle a pending command's id. */
type PendingReplyType = DebugReplyType | "previewUpdateResult" | "previewUpdateStatus";

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** The only reply type allowed to settle this command's id. */
  expect: PendingReplyType;
  /** The preview-ack watchdog; cleared on settle or teardown. */
  timer?: ReturnType<typeof setTimeout>;
  /** A status query reconciling this earlier transaction's verdict. */
  previewFor?: number;
  /** The transaction id a plain status query named — custody for repin. */
  statusQueryFor?: number;
  /**
   * The attempt's verdict already published through reconciliation — a
   * result arriving now settles as a late-correlated event instead.
   */
  verdictPublished?: boolean;
}

/** The start promise — correlated by the admission id, not a typed reply. */
interface PendingAdmission {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isDebugReply(msg: WorkerOutbound): boolean {
  switch (msg.type) {
    case "debugAck":
    case "debugConfigured":
    case "debugEvaluation":
    case "debugInspection":
    case "debugSetValuesAck":
      return true;
    default:
      return false;
  }
}

interface LeaseRecord {
  handle: TestPauseLease | null;
  released: boolean;
}

/**
 * One issued previewUpdate's retained record: the identity the request
 * pinned plus the verified candidate build, so a late or reconciled
 * `committed` outcome can repoint the restart target and save namespace
 * without asking the caller again. Bounded per run.
 */
interface PreviewAttempt {
  readonly expected: PreviewLaneIdentity;
  readonly frozen: FrozenGame;
}

interface RunRecord {
  worker: TestWorkerLike | null;
  facade: TestRun;
  game: FrozenGame;
  options: FrozenOptions;
  /**
   * The play-preview lane grant from `debugAttached.preview`, or null when
   * the run holds no update authority. Replaced wholesale on every adopted
   * `current` identity — never fabricated locally.
   */
  preview: PreviewGrant | null;
  /** Issued update attempts retained for late-ACK commit bookkeeping. */
  previewAttempts: Map<number, PreviewAttempt>;
  epoch: number;
  admissionId: number;
  configRevision: number;
  config: TestDebugConfig;
  logs: readonly TestLogEntry[];
  ready: boolean;
  attached: boolean;
  stop: TestStop | null;
  keyWaiting: boolean;
  lease: LeaseRecord;
  dead: boolean;
  pending: Map<number, PendingCommand>;
  hostPending: Map<number, AbortController>;
  admission: PendingAdmission | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Log retention per run: enough for a debug pane, bounded against a chatty logpoint. */
const LOG_LIMIT = 256;

const EMPTY_CONFIG: TestDebugConfig = deepFreeze({
  revision: 0,
  breakpoints: [],
  watchpoints: [],
});

/**
 * Publish the worker's resolved configuration as the run's observation:
 * structured-cloned so neither the worker's own status arrays nor a
 * caller's mutation can rewrite what was published.
 */
function captureConfig(
  revision: number,
  breakpoints: readonly DebugBreakpointStatus[],
  watchpoints: readonly DebugWatchStatus[],
): TestDebugConfig {
  return deepFreeze(structuredClone({ revision, breakpoints, watchpoints }));
}

/**
 * The worker's stop payload becomes the run's pinned observation: freeze
 * the whole graph once at publication so no caller, listener or stale
 * worker alias can rewrite the stored stop or another consumer's view of
 * it. A typed array would be a mutable hole — none ride this wire payload.
 */
function deepFreeze<T>(value: T): T {
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    if (ArrayBuffer.isView(node)) return;
    for (const key of Object.keys(node)) {
      walk((node as Record<string, unknown>)[key]);
    }
    Object.freeze(node);
  };
  walk(value);
  return value;
}

/**
 * Synchronously clone and verify the build input: owned file bytes, owned
 * documents, and the exact source/binding capture the worker verifies
 * again. Any inconsistency throws before a worker or lease exists.
 */
function freezeGame(input: IsolatedTestGame): FrozenGame {
  const files: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(input.files)) {
    files[name] = new Uint8Array(bytes);
  }
  const sources: Record<string, string> = {};
  for (const [key, source] of Object.entries(input.sources)) {
    if (typeof source !== "string") {
      throw new TestRuntimeError(`isolated test: source ${key} is not text`, "refused");
    }
    sources[key] = source;
  }
  const sourceBindings: FrozenGame["sourceBindings"] = {};
  const bindings: FrozenGame["bindings"] = {};
  for (const [name, binding] of Object.entries(input.sourceBindings)) {
    if (!isRecord(binding) || typeof binding.kind !== "string") {
      throw new TestRuntimeError(`isolated test: invalid binding ${name}`, "refused");
    }
    sourceBindings[name] = { kind: binding.kind as SourceBindingKind, num: binding.num };
    if (binding.kind === "variable" || binding.kind === "flag" || binding.kind === "string") {
      bindings[name] = { kind: binding.kind, num: binding.num };
    }
  }
  let captured;
  try {
    captured = captureProjectBuild({
      files,
      profileId: input.profile,
      sources,
      bindings: Object.fromEntries(
        Object.entries(sourceBindings).map(([name, b]) => [name, { num: b.num }]),
      ),
    });
  } catch (error) {
    throw new TestRuntimeError(`isolated test build refused: ${String(error)}`, "refused");
  }
  const playable: Record<string, Uint8Array> = {};
  for (const [name, bytes] of captured.files()) playable[name] = bytes;
  const wordsFile = playable["WORDS.TOK"];
  return {
    buildId: captured.identity.buildId,
    revision: captured.identity.revision,
    profileId: captured.identity.profileId,
    files: playable,
    words: wordsFile ? parseWordsTok(wordsFile).map(({ word, id }) => [word, id]) : [],
    sources,
    sourceBindings,
    bindings,
  };
}

/**
 * Capture the caller's debugger plan as owned plain data: specs carry
 * nested `hit`, `log.segments` and `target` objects whose caller aliases
 * must not outlive the first await — the park lease, worker factory and
 * same-build restart all re-read this snapshot. Specs are protocol data, so
 * a structural clone detaches them whole and refuses functions outright.
 */
function freezeOptions(options: TestStartOptions): FrozenOptions {
  let breakpoints: readonly DebugBreakpointSpec[];
  let watchpoints: readonly DebugWatchSpec[];
  try {
    breakpoints = structuredClone(options.breakpoints ?? []);
    watchpoints = structuredClone(options.watchpoints ?? []);
  } catch (error) {
    throw new TestRuntimeError(`isolated test options refused: ${String(error)}`, "refused");
  }
  return {
    breakpoints,
    watchpoints,
    stopOnEntry: options.stopOnEntry !== false,
    lane: options.lane === "play-preview" ? "play-preview" : "debug",
  };
}

export function createTestSession(options: TestSessionOptions = {}): TestSession {
  const createWorker = options.createWorker ?? spawnEngineWorker;
  const host: TestHost = createTestHost(options.prompts);
  const previewTimeoutMs = options.previewAckTimeoutMs ?? 1500;
  const listeners = new Set<(event: TestSessionEvent) => void>();
  let nextId = 1;
  let current: RunRecord | null = null;
  /**
   * A successor mid-admission. It owns only its own lease and worker until
   * the worker's boot handshake commits it; the committed run keeps every
   * authority — input, presentation, the published identity — meanwhile.
   */
  let candidate: RunRecord | null = null;
  // The build identity the ephemeral store belongs to; the store survives
  // only a same-build restart.
  let storeBuild: string | null = null;
  let lastGame: FrozenGame | null = null;
  let lastOptions: FrozenOptions | null = null;

  function emit(event: TestSessionEvent): void {
    for (const listener of [...listeners]) {
      // A throwing observer must not break run bookkeeping or leak a park.
      try {
        listener(event);
      } catch {
        // Listener faults stay with the listener.
      }
    }
  }

  /**
   * Run-scoped truth publishes only for the committed run: a candidate's
   * records update so its facade is complete at commit, but its stops,
   * resets, errors and audio holds never reach listeners while the old run
   * still owns the published identity.
   */
  function publish(run: RunRecord, event: TestSessionEvent): void {
    if (run !== current || run.dead) return;
    emit(event);
  }

  /** The run a worker message or reentrant callback may still act on. */
  function isTracked(run: RunRecord): boolean {
    return run === current || run === candidate;
  }

  function releaseLease(run: RunRecord): void {
    if (run.lease.released) return;
    run.lease.released = true;
    run.lease.handle?.release();
  }

  /** Native promises and structural thenables both gate the park. */
  function isThenable(value: unknown): value is PromiseLike<TestPauseLease> {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { then?: unknown }).then === "function"
    );
  }

  /**
   * The park is a barrier: the worker is created and booted only after the
   * lease resolves. A run torn down while its park is still pending never
   * spawns a worker — its admission already settled — and the late
   * fulfillment releases itself instead of parking for a dead run.
   */
  function parkThenBoot(run: RunRecord, parked: PromiseLike<TestPauseLease>): void {
    void Promise.resolve(parked).then(
      (lease) => {
        if (run.dead || run.lease.released) {
          lease.release();
          return;
        }
        run.lease.handle = lease;
        bootWorker(run);
      },
      (error) => {
        if (run.dead) return;
        const admission = run.admission;
        run.admission = null;
        teardown(run, "ended");
        admission?.reject(
          new TestRuntimeError(`isolated test pause lease refused: ${String(error)}`, "refused"),
        );
        publish(run, {
          type: "error",
          run: run.facade,
          error: `pause lease failed: ${String(error)}`,
        });
      },
    );
  }

  /** Settle the admission with a refusal and tear the run down. */
  function failAdmission(run: RunRecord, message: string): void {
    const admission = run.admission;
    run.admission = null;
    teardown(run, "ended");
    admission?.reject(new TestRuntimeError(message, "refused"));
  }

  /** Terminate the worker and fail everything the run still has open. */
  function teardown(run: RunRecord, reason: "replaced" | "closed" | "ended"): void {
    if (run.dead) return;
    run.dead = true;
    if (current === run) current = null;
    if (candidate === run) candidate = null;
    // "ended" is an internal teardown reason — the worker or its lease
    // failed — so callers see the honest "worker" code, not a closed door.
    const code = reason === "ended" ? "worker" : reason;
    const error = new TestRuntimeError(`the isolated test run was ${reason}`, code);
    run.admission?.reject(error);
    for (const pending of run.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(error);
    }
    run.pending.clear();
    run.previewAttempts.clear();
    for (const controller of run.hostPending.values()) controller.abort();
    run.hostPending.clear();
    const worker = run.worker;
    if (worker) {
      worker.onmessage = null;
      worker.terminate();
    }
    releaseLease(run);
  }

  /** Store and publish the worker's resolved config; returns the snapshot. */
  function publishConfig(
    run: RunRecord,
    msg: {
      revision: number;
      breakpoints: readonly DebugBreakpointStatus[];
      watchpoints: readonly DebugWatchStatus[];
    },
  ): TestDebugConfig {
    run.configRevision = msg.revision;
    run.config = captureConfig(msg.revision, msg.breakpoints, msg.watchpoints);
    publish(run, { type: "configured", run: run.facade, config: run.config });
    return run.config;
  }

  function onDebugReply(run: RunRecord, msg: WorkerOutbound): boolean {
    if (!("id" in msg) || typeof msg.id !== "number") return false;
    if (msg.type === "debugError") {
      const error = new TestRuntimeError(msg.error, "worker", msg.code);
      if (run.admission && msg.id === run.admissionId) {
        const admission = run.admission;
        run.admission = null;
        teardown(run, "ended");
        admission.reject(error);
      } else {
        const pending = run.pending.get(msg.id);
        if (pending) {
          run.pending.delete(msg.id);
          pending.reject(error);
        } else {
          publish(run, { type: "error", run: run.facade, error: msg.error });
        }
      }
      return true;
    }
    // Only a debugger reply may settle a pending command. Native control
    // traffic (hostRequest, interactionCancelled, query replies) mints ids
    // in its own space — a colliding id must not consume an unrelated
    // pending entry or settle its promise.
    if (!isDebugReply(msg)) return false;
    if (msg.id === run.admissionId) {
      // Admission replies under the boot id: the configure publishes the
      // session's first resolved config; the pause ack is consumed. Any
      // other reply type under that id is protocol noise — consumed, not
      // presentation.
      if (msg.type === "debugConfigured") {
        publishConfig(run, msg);
        return true;
      }
      return true;
    }
    const pending = run.pending.get(msg.id);
    // A reply for an unknown id is stale or duplicated — consumed here,
    // and it is certainly not presentation for the canvas.
    if (!pending) return true;
    run.pending.delete(msg.id);
    if (msg.type !== pending.expect) {
      pending.reject(
        new TestRuntimeError(
          `unexpected ${msg.type} response where ${pending.expect} was owed`,
          "worker",
        ),
      );
      return true;
    }
    switch (msg.type) {
      case "debugAck":
        pending.resolve(undefined);
        return true;
      case "debugConfigured":
        pending.resolve(publishConfig(run, msg));
        return true;
      case "debugEvaluation":
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(new TestRuntimeError(msg.error ?? "evaluation failed"));
        return true;
      case "debugInspection":
        pending.resolve(msg.data);
        return true;
      case "debugSetValuesAck":
        if (run.stop && run.stop.stopId !== msg.stopId) {
          run.stop = deepFreeze({ ...run.stop, stopId: msg.stopId });
        }
        pending.resolve(msg.stopId);
        return true;
    }
    return false;
  }

  /**
   * The lane's own lane-identity snapshot — the tuple a request pins its
   * `expected` against, or null while the run holds no update authority.
   */
  function laneIdentityOf(run: RunRecord): PreviewLaneIdentity | null {
    const lane = run.preview;
    if (lane === null) return null;
    return {
      epoch: lane.epoch,
      buildId: lane.buildId,
      revision: lane.revision,
      updateSerial: lane.updateSerial,
    };
  }

  /**
   * The lane's two monotonic marks: `updateSerial` bumps on every installed
   * commit and `epoch` moves on every install or re-pin — both mint forward
   * only. A reported snapshot with either behind the adopted identity is
   * strictly older evidence: it may still settle its own attempt, but it
   * can never demote the newer proven authority it precedes.
   */
  function staleLaneSnapshot(run: RunRecord, next: PreviewLaneIdentity): boolean {
    const lane = run.preview;
    return lane !== null && (next.updateSerial < lane.updateSerial || next.epoch < lane.epoch);
  }

  /**
   * Adopt the worker-recomputed lane identity — the only authority on what
   * is actually installed — while it is not older than the identity already
   * adopted. `previewSessionInstall` mints a fresh session epoch on commit,
   * so the run's epoch follows the lane while attached.
   */
  function reconcilePreviewIdentity(run: RunRecord, next: PreviewLaneIdentity | null): void {
    if (next === null || run.preview === null || staleLaneSnapshot(run, next)) return;
    run.preview = { runToken: run.preview.runToken, ...next };
    if (run.attached) run.epoch = next.epoch;
  }

  /**
   * Whether the adopted lane identity still names this retained attempt's
   * own install: precisely the next serial past the identity it pinned,
   * under the candidate's verified build and revision. A newer commit or a
   * re-pin to another build supersedes it; a same-build commit keeps its
   * own serial and still proves itself.
   */
  function attemptIsInstalled(run: RunRecord, attempt: PreviewAttempt): boolean {
    const lane = run.preview;
    return (
      lane !== null &&
      lane.updateSerial === attempt.expected.updateSerial + 1 &&
      lane.buildId === attempt.frozen.buildId &&
      lane.revision === attempt.frozen.revision
    );
  }

  /**
   * Every previewUpdateResult — however late — is fact about this physical
   * run, but settling an attempt is separate from adopting authority: the
   * outcome's own identity snapshot reconciles only while it is not older
   * than the adopted one, and a committed attempt repoints the pinned
   * build, the restart target and the ephemeral save namespace only while
   * the lane still proves that attempt's install is the live authority. A
   * superseded commit settles its attempt and nothing else — the newer
   * build is never demoted and its saves are never cleared, even
   * transiently.
   */
  function settlePreviewOutcome(run: RunRecord, id: number, outcome: PreviewUpdateOutcome): void {
    reconcilePreviewIdentity(run, outcome.current);
    if (outcome.status !== "committed") return;
    const attempt = run.previewAttempts.get(id);
    if (attempt === undefined) return; // ledger aged out — identity still adopted
    if (!attemptIsInstalled(run, attempt)) return;
    adoptCommittedAttempt(run, attempt);
  }

  /**
   * Repoint the pinned build, the restart target and the ephemeral save
   * namespace to a retained attempt whose install worker evidence proved.
   */
  function adoptCommittedAttempt(run: RunRecord, attempt: PreviewAttempt): void {
    run.game = attempt.frozen;
    lastGame = attempt.frozen;
    lastOptions = run.options;
    if (storeBuild !== attempt.frozen.buildId) {
      host.clear();
      storeBuild = attempt.frozen.buildId;
    }
  }

  /**
   * Whether the lane's freshly recomputed identity is itself proof that
   * this retained attempt committed: the same physical run's token, the
   * candidate's exact build and verified revision, and precisely the
   * update serial its own install left. Anything weaker — a ledger label
   * alone, or an echo of the pinned `expected` — proves nothing.
   */
  function landedByIdentity(
    run: RunRecord,
    attempt: PreviewAttempt,
    runToken: string | null,
    current: PreviewLaneIdentity | null,
  ): boolean {
    return (
      run.preview !== null &&
      runToken === run.preview.runToken &&
      current !== null &&
      current.epoch !== attempt.expected.epoch &&
      current.buildId === attempt.frozen.buildId &&
      current.revision === attempt.frozen.revision &&
      current.updateSerial === attempt.expected.updateSerial + 1
    );
  }

  /**
   * The ACK watchdog: a previewUpdate whose result never arrived queries
   * the lane's retained ledger under a fresh id on the same physical run —
   * never a replay, never a worker replacement.
   */
  function onPreviewAckTimeout(run: RunRecord, id: number): void {
    const pending = run.pending.get(id);
    if (!pending || pending.expect !== "previewUpdateResult" || run.dead || !isTracked(run)) {
      return;
    }
    const sid = nextId++;
    const statusPending: PendingCommand = {
      resolve: pending.resolve,
      reject: pending.reject,
      expect: "previewUpdateStatus",
      previewFor: id,
    };
    statusPending.timer = setTimeout(() => {
      if (!run.pending.delete(sid)) return;
      const attempt = run.previewAttempts.get(id);
      // The worker produced no status answer at all: `current` reports no
      // fresh evidence — the session's cached lane snapshot can never pose
      // as one. The attempt's own pending survives so a late result still
      // owns its outcome; `verdictPublished` marks the verdict delivered.
      pending.verdictPublished = true;
      pending.resolve({
        kind: "indeterminate",
        id,
        expected: attempt?.expected ??
          laneIdentityOf(run) ?? {
            epoch: run.epoch,
            buildId: run.game.buildId,
            revision: "",
            updateSerial: -1,
          },
        current: null,
      });
    }, previewTimeoutMs);
    run.pending.set(sid, statusPending);
    run.worker?.postMessage({
      type: "previewUpdateStatus",
      id: sid,
      transactionId: id,
    } satisfies WorkerInbound);
  }

  function onMessage(run: RunRecord, msg: WorkerOutbound): void {
    if (run.dead || !isTracked(run)) return; // stale worker output
    if (onDebugReply(run, msg)) return;
    switch (msg.type) {
      case "debugAttached": {
        if (msg.id !== run.admissionId) return; // foreign attach traffic
        if (msg.buildId !== run.game.buildId) {
          const admission = run.admission;
          run.admission = null;
          teardown(run, "ended");
          admission?.reject(
            new TestRuntimeError(
              `isolated test worker reported build ${msg.buildId}, expected ${run.game.buildId}`,
              "refused",
            ),
          );
          return;
        }
        if (run.options.lane === "play-preview" && msg.preview === undefined) {
          // The boot asked for update authority and the worker granted none
          // — the lane cannot be fabricated, so the run refuses admission.
          failAdmission(run, "isolated test worker granted no play-preview lane");
          return;
        }
        run.epoch = msg.epoch;
        run.attached = true;
        if (msg.preview !== undefined) {
          run.preview = {
            runToken: msg.preview.runToken,
            epoch: msg.preview.epoch,
            buildId: msg.preview.buildId,
            revision: msg.preview.revision,
            updateSerial: msg.preview.updateSerial,
          };
        }
        return;
      }
      case "previewUpdateResult": {
        // Custody: the result must echo this run's live lane token — a
        // foreign or stale token settles nothing here.
        if (run.preview === null || msg.runToken !== run.preview.runToken) return;
        // A result is fact about this physical run — reconcile the identity
        // even when the pending entry already settled (a lost ACK that came
        // home late still owns its commit's bookkeeping).
        settlePreviewOutcome(run, msg.id, msg);
        const pending = run.pending.get(msg.id);
        if (pending && pending.expect === "previewUpdateResult") {
          run.pending.delete(msg.id);
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          if (pending.verdictPublished) {
            // The verdict already published through reconciliation; the
            // worker's own outcome arrives late — publish the settlement
            // so whoever holds the unresolved attempt resolves it on real
            // evidence rather than silence.
            publish(run, {
              type: "previewOutcome",
              run: run.facade,
              id: msg.id,
              outcome: msg,
            });
          } else {
            pending.resolve({ kind: "settled", id: msg.id, outcome: msg });
          }
        }
        return;
      }
      case "previewUpdateStatus": {
        const pending = run.pending.get(msg.id);
        if (!pending || pending.expect !== "previewUpdateStatus") return;
        run.pending.delete(msg.id);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        const forId = pending.previewFor;
        const queriedId = forId ?? pending.statusQueryFor;
        const transaction = msg.transaction;
        // Custody: only this physical run's own lane answer may move
        // authority — a foreign-token answer, or a retained record the
        // query never named, still resolves its read truthfully but
        // settles nothing.
        const laneAnswer = run.preview !== null && msg.runToken === run.preview.runToken;
        const retained =
          laneAnswer &&
          transaction !== null &&
          transaction !== "unavailable" &&
          transaction !== "unknown" &&
          (queriedId === undefined || transaction.id === queriedId)
            ? transaction
            : null;
        if (retained !== null) {
          // The retained outcome is the transaction's own record — apply
          // it exactly as the lost result would have applied. Settlement
          // stays the attempt's bookkeeping: a superseded commit cannot
          // demote the newer authority the lane has since proven.
          settlePreviewOutcome(run, retained.id, retained.outcome);
        } else if (
          laneAnswer &&
          queriedId !== undefined &&
          msg.current !== null &&
          !staleLaneSnapshot(run, msg.current)
        ) {
          // The ledger cannot name the attempt — but the answer's freshly
          // recomputed identity may itself prove the retained candidate
          // landed. The proof is only as fresh as the answer carrying it:
          // a recomputation from before a newer commit repins nothing.
          // Under that attempt's own custody the proof repins the build
          // and restart target; anything weaker changes nothing.
          const attempt = run.previewAttempts.get(queriedId);
          if (attempt !== undefined && landedByIdentity(run, attempt, msg.runToken, msg.current)) {
            adoptCommittedAttempt(run, attempt);
          }
        }
        // The answer's own recomputed identity is the freshest truth it
        // carries — adopt it last so a retained outcome's older snapshot
        // never wins. One computed before a newer commit adopts nothing.
        if (laneAnswer) reconcilePreviewIdentity(run, msg.current);
        if (forId === undefined) {
          pending.resolve({
            runToken: msg.runToken,
            current: msg.current,
            transaction: msg.transaction,
          });
          return;
        }
        const attempt = run.previewAttempts.get(forId);
        const origin = run.pending.get(forId);
        if (origin !== undefined) origin.verdictPublished = true;
        if (retained !== null) {
          pending.resolve({ kind: "settled", id: forId, outcome: retained.outcome });
        } else {
          // "unavailable"/"unknown" assert nothing: not committed, not
          // refused, not rolled back — the caller reads `current` itself.
          pending.resolve({
            kind: "indeterminate",
            id: forId,
            expected: attempt?.expected ??
              laneIdentityOf(run) ?? {
                epoch: run.epoch,
                buildId: run.game.buildId,
                revision: "",
                updateSerial: -1,
              },
            current: msg.current,
          });
        }
        return;
      }
      case "debugStopped":
        run.stop = deepFreeze({
          stopId: msg.stopId,
          boundarySeq: msg.boundarySeq,
          cause: msg.cause,
          location: msg.location,
          wait: msg.wait,
          reasons: msg.reasons,
          state: msg.state,
          answerReady: msg.answerReady,
        });
        publish(run, { type: "stopped", run: run.facade, stop: run.stop });
        return;
      case "debugSessionReset":
        // A restore or engine replacement minted a fresh epoch; prior stop
        // identities are void and pending commands have been refused. The
        // worker echoes the plans' rebound statuses — the obsolete config
        // observation is replaced with them under the same revision.
        run.epoch = msg.epoch;
        run.stop = null;
        // A restore/replacement re-pins the lane's epoch and build
        // worker-side; the next update's `expected` must name it.
        if (run.preview !== null) {
          run.preview = { ...run.preview, epoch: msg.epoch, buildId: msg.buildId };
        }
        run.config = captureConfig(run.configRevision, msg.breakpoints, msg.watchpoints);
        publish(run, { type: "reset", run: run.facade, epoch: msg.epoch });
        return;
      case "debugDetached":
        publish(run, {
          type: "error",
          run: run.facade,
          error: `debugger detached: ${msg.reason}`,
        });
        return;
      case "booted":
        if (run.admission) {
          const admission = run.admission;
          if (!run.attached) {
            run.admission = null;
            teardown(run, "ended");
            admission.reject(
              new TestRuntimeError("isolated test booted without the debugger attached", "refused"),
            );
            return;
          }
          run.ready = true;
          run.admission = null;
          // The single swap: the acknowledged candidate publishes its
          // identity, and only then does the replaced run tear down.
          commit(run);
          admission.resolve(run.facade);
        }
        return;
      case "error":
        if (run.admission) {
          const admission = run.admission;
          run.admission = null;
          teardown(run, "ended");
          admission.reject(
            new TestRuntimeError(`isolated test refused: ${msg.message}`, "refused"),
          );
          return;
        }
        publish(run, { type: "error", run: run.facade, error: msg.message });
        return;
      case "hostRequest": {
        if (!run.ready) return; // host traffic outside a live run is dropped
        const controller = new AbortController();
        run.hostPending.set(msg.id, controller);
        const request: TestHostRequest = { id: msg.id, op: msg.op, context: msg.context };
        host
          .handle(request, controller.signal)
          .then((response) => {
            // A dead or superseded request never answers: the signal fired
            // and the entry was already dropped.
            if (!run.hostPending.delete(msg.id)) return;
            if (run.dead || current !== run) return;
            run.worker?.postMessage({
              type: "hostAnswer",
              id: msg.id,
              response,
            } satisfies WorkerInbound);
          })
          .catch(() => {
            run.hostPending.delete(msg.id);
          });
        return;
      }
      case "interactionCancelled": {
        const controller = run.hostPending.get(msg.id);
        if (controller) {
          run.hostPending.delete(msg.id);
          controller.abort();
        }
        return;
      }
      case "waitingForKey":
        run.keyWaiting = msg.waiting;
        // The candidate records its own wait state but owns no canvas yet.
        if (run === current) options.onPresentation?.(msg);
        return;
      case "autosave":
      case "historyBatch":
        // A frozen run records and persists nothing; both are disabled
        // worker-side, so arrival means a misbehaving worker. Dropped.
        return;
      case "debugAnswerReady":
        // A queued host answer only matters while the stop it names is the
        // current one — a stale stop or epoch already abandoned the wait.
        if (msg.epoch === run.epoch && run.stop?.stopId === msg.stopId) {
          publish(run, {
            type: "answerReady",
            run: run.facade,
            stopId: msg.stopId,
            id: msg.id,
            op: msg.op,
          });
        }
        return;
      case "debugLog": {
        if (msg.epoch !== run.epoch) return;
        const entry: TestLogEntry = Object.freeze({
          sequence: msg.sequence,
          breakpoint: msg.breakpoint,
          text: msg.text,
        });
        const next = run.logs.concat(entry);
        if (next.length > LOG_LIMIT) next.splice(0, next.length - LOG_LIMIT);
        run.logs = Object.freeze(next);
        publish(run, { type: "log", run: run.facade, entry });
        return;
      }
      case "debugAudio":
        // The audio hold is epoch-scoped worker state, not a GUI timer.
        if (msg.epoch !== run.epoch) return;
        publish(run, { type: "audio", run: run.facade, epoch: msg.epoch, paused: msg.paused });
        // A listener that tore the run down inside the event must not let
        // this message reach a dead run's presentation consumer.
        if (run.dead || current !== run) return;
        options.onPresentation?.(msg);
        return;
      default:
        // Frames, sound and text mirrors belong to the committed run alone.
        if (run === current) options.onPresentation?.(msg);
        return;
    }
  }

  function admit(game: FrozenGame, opts: FrozenOptions): Promise<TestRun> {
    const run: RunRecord = {
      worker: null,
      facade: null as unknown as TestRun,
      game,
      options: opts,
      preview: null,
      previewAttempts: new Map(),
      epoch: 0,
      admissionId: nextId++,
      configRevision: 0,
      config: EMPTY_CONFIG,
      logs: Object.freeze([]),
      ready: false,
      attached: false,
      stop: null,
      keyWaiting: false,
      lease: { handle: null, released: false },
      dead: false,
      pending: new Map(),
      hostPending: new Map(),
      admission: null,
    };
    run.facade = {
      get epoch() {
        return run.epoch;
      },
      get buildId() {
        return run.game.buildId;
      },
      get profileId() {
        return run.game.profileId;
      },
      get phase() {
        return run.stop === null ? "running" : "stopped";
      },
      get stop() {
        return run.stop;
      },
      get waiting() {
        return run.keyWaiting ? "key" : run.hostPending.size > 0 ? "host" : null;
      },
      get config() {
        return run.config;
      },
      get log() {
        return run.logs;
      },
      get preview() {
        return run.preview;
      },
    };
    // Latest wins between pending candidates: a superseded candidate's own
    // lease and worker release here, while the committed run — if any —
    // stays untouched until this one is acknowledged.
    if (candidate) teardown(candidate, "replaced");
    candidate = run;
    const ready = new Promise<TestRun>((resolve, reject) => {
      run.admission = { resolve: resolve as (v: unknown) => void, reject };
    });
    // The live game parks before the worker exists; a synchronous refusal
    // throws with nothing running and the unawaited admission settles dead.
    let parked: TestPauseLease | PromiseLike<TestPauseLease> | undefined;
    try {
      parked = options.acquirePauseLease?.();
    } catch (error) {
      run.dead = true;
      run.admission = null;
      if (candidate === run) candidate = null;
      throw new TestRuntimeError(`isolated test pause lease refused: ${String(error)}`, "refused");
    }
    if (isThenable(parked)) {
      parkThenBoot(run, parked);
    } else {
      // Acquisition may reentrantly end the run (a callback that closes or
      // replaces it): the returned lease belongs to a dead run — release
      // it and never create the worker.
      if (parked && (run.dead || run.lease.released)) {
        parked.release();
      } else if (parked) {
        run.lease.handle = parked;
      }
      if (!run.dead) bootWorker(run);
    }
    return ready;
  }

  /** Create the worker, wire its port and send the frozen-test boot. */
  function bootWorker(run: RunRecord): void {
    if (run.dead) return;
    let worker: TestWorkerLike;
    try {
      worker = createWorker();
    } catch (error) {
      failAdmission(run, `isolated test worker failed: ${String(error)}`);
      return;
    }
    // The factory may have reentrantly closed or replaced this run, the
    // same ownership rule as the park lease: the worker it returned belongs
    // to a dead run — dispose it, never wire its port or post the boot.
    if (run.dead || !isTracked(run)) {
      try {
        worker.terminate();
      } catch {
        // Disposal is best-effort; the run's authority already ended.
      }
      return;
    }
    run.worker = worker;
    worker.onmessage = (event) => onMessage(run, event.data);
    const frozenTest: FrozenTestBoot = {
      id: run.admissionId,
      sources: run.game.sources,
      sourceBindings: run.game.sourceBindings,
      bindings: run.game.bindings,
      ...(run.options.breakpoints.length > 0 ? { breakpoints: [...run.options.breakpoints] } : {}),
      ...(run.options.watchpoints.length > 0 ? { watchpoints: [...run.options.watchpoints] } : {}),
      ...(run.options.stopOnEntry ? {} : { stopOnEntry: false }),
      ...(run.options.lane === "play-preview" ? { lane: "play-preview" as const } : {}),
    };
    try {
      worker.postMessage({
        type: "boot",
        files: run.game.files,
        words: run.game.words,
        profile: run.game.profileId,
        frozenTest,
      } satisfies WorkerInbound);
    } catch (error) {
      failAdmission(run, `isolated test boot failed: ${String(error)}`);
    }
  }

  /**
   * The acknowledged candidate becomes the committed run — the single swap.
   * The published identity, restart target and ephemeral store switch
   * together, and only then does the replaced run tear down: its worker,
   * in-flight commands, open prompts and park lease all end after the
   * successor already owns them.
   */
  function commit(run: RunRecord): void {
    if (candidate === run) candidate = null;
    const prior = current;
    if (prior === run) return;
    current = run;
    lastGame = run.game;
    lastOptions = run.options;
    if (storeBuild !== run.game.buildId) {
      host.clear();
      storeBuild = run.game.buildId;
    }
    if (prior) teardown(prior, "replaced");
  }

  function begin(game: IsolatedTestGame, opts: TestStartOptions = {}): Promise<TestRun> {
    const frozen = freezeGame(game); // throws before anything is touched
    const frozenOpts = freezeOptions(opts);
    // Transactional admission: the committed run is not touched here. If the
    // candidate is refused anywhere — lease, factory, attach or boot — only
    // the candidate's own resources release.
    return admit(frozen, frozenOpts);
  }

  function live(): RunRecord {
    const run = current;
    if (!run || run.dead || !run.ready) {
      throw new TestRuntimeError("no isolated test run is live", "closed");
    }
    return run;
  }

  function stoppedRun(): RunRecord {
    const run = live();
    if (run.stop === null) {
      throw new TestRuntimeError("the isolated test run is not stopped", "notStopped");
    }
    return run;
  }

  function command<T>(
    expect: DebugReplyType,
    message: (run: RunRecord, id: number) => WorkerInbound,
  ): Promise<T> {
    const run = live();
    const id = nextId++;
    const result = new Promise<T>((resolve, reject) => {
      run.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, expect });
    });
    run.worker!.postMessage(message(run, id));
    return result;
  }

  function inputAllowed(): RunRecord | null {
    const run = current;
    if (!run || run.dead || !run.ready || run.stop !== null) return null;
    return run;
  }

  /** Retained attempts per run — the late-ACK window, bounded. */
  const PREVIEW_ATTEMPT_LIMIT = 8;

  /**
   * Ship one complete candidate to the committed run's lane. The attempt's
   * bytes, identity pin and verified build are owned before the post — a
   * draft moving on underneath can never rewrite a request already staged.
   * The pending entry survives its watchdog: a reconciling status query or
   * the result itself, whichever lands last, still applies the outcome.
   */
  function previewUpdate(candidate: PreviewUpdateCandidateMessage): Promise<PreviewUpdateVerdict> {
    let run: RunRecord;
    let frozen: FrozenGame;
    let message: PreviewUpdateCandidateMessage;
    try {
      run = live();
    } catch (error) {
      return Promise.reject(error);
    }
    const lane = run.preview;
    if (lane === null) {
      return Promise.reject(new TestRuntimeError("this run has no play-preview lane", "refused"));
    }
    try {
      const files: Record<string, Uint8Array> = {};
      for (const [name, bytes] of Object.entries(candidate.files)) {
        files[name] = new Uint8Array(bytes);
      }
      const sources = { ...candidate.sources };
      const sourceBindings = Object.fromEntries(
        Object.entries(candidate.sourceBindings).map(([name, b]) => [
          name,
          { kind: b.kind, num: b.num },
        ]),
      );
      const origins = candidate.origins.map((origin) => ({
        key: origin.key,
        version: origin.version,
      }));
      // The same freeze a boot passes: malformed bytes, non-text sources or
      // an unreproducible build refuse before the wire ever sees them.
      frozen = freezeGame({
        files,
        profile: candidate.profile ?? run.game.profileId,
        sources,
        sourceBindings,
      });
      message = {
        files,
        ...(candidate.profile !== undefined ? { profile: candidate.profile } : {}),
        sources,
        sourceBindings,
        buildId: candidate.buildId,
        revision: candidate.revision,
        origins,
      };
    } catch (error) {
      return Promise.reject(error);
    }
    const expected: PreviewLaneIdentity = {
      epoch: lane.epoch,
      buildId: lane.buildId,
      revision: lane.revision,
      updateSerial: lane.updateSerial,
    };
    const id = nextId++;
    run.previewAttempts.set(id, { expected, frozen });
    while (run.previewAttempts.size > PREVIEW_ATTEMPT_LIMIT) {
      run.previewAttempts.delete(run.previewAttempts.keys().next().value!);
    }
    const verdict = new Promise<PreviewUpdateVerdict>((resolve, reject) => {
      const pending: PendingCommand = {
        resolve: resolve as (value: unknown) => void,
        reject,
        expect: "previewUpdateResult",
        timer: setTimeout(() => onPreviewAckTimeout(run, id), previewTimeoutMs),
      };
      run.pending.set(id, pending);
    });
    run.worker!.postMessage({
      type: "previewUpdate",
      id,
      runToken: lane.runToken,
      expected,
      candidate: message,
    } satisfies WorkerInbound);
    return verdict;
  }

  function previewStatus(transactionId?: number): Promise<PreviewStatusReport> {
    let run: RunRecord;
    try {
      run = live();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = nextId++;
    const report = new Promise<PreviewStatusReport>((resolve, reject) => {
      const pending: PendingCommand = {
        resolve: resolve as (value: unknown) => void,
        reject,
        expect: "previewUpdateStatus",
        ...(transactionId !== undefined ? { statusQueryFor: transactionId } : {}),
        timer: setTimeout(() => {
          if (run.pending.delete(id)) {
            reject(new TestRuntimeError("the preview status query timed out", "worker"));
          }
        }, previewTimeoutMs),
      };
      run.pending.set(id, pending);
    });
    run.worker!.postMessage({
      type: "previewUpdateStatus",
      id,
      ...(transactionId !== undefined ? { transactionId } : {}),
    } satisfies WorkerInbound);
    return report;
  }

  return {
    get run() {
      return current === null || current.dead ? null : current.facade;
    },
    start(game, opts) {
      // Input capture stays synchronous — a refusal becomes a rejection so
      // callers see a promise failure, not a thrown outlier.
      try {
        return begin(game, opts);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    restart() {
      if (!lastGame || !lastOptions) {
        return Promise.reject(new TestRuntimeError("no isolated test run to restart", "closed"));
      }
      // An explicit restart is the destructive gesture: the committed run
      // ends now and a fresh candidate on the pinned build admits. Same
      // build identity keeps its ephemeral slots.
      if (current) teardown(current, "replaced");
      return admit(lastGame, lastOptions);
    },
    close() {
      const run = current;
      if (run) teardown(run, "closed");
      // A mid-admission candidate dies with the session — its start()
      // settles "closed" and only its own resources release.
      if (candidate) teardown(candidate, "closed");
      host.clear();
      storeBuild = null;
      emit({ type: "closed", run: run ? run.facade : null });
    },
    pause() {
      return command<void>("debugAck", (run, id) => ({ type: "debugPause", id, epoch: run.epoch }));
    },
    resume(action = "continue", granularity) {
      const run = stoppedRun();
      const stopId = run.stop!.stopId;
      return command<void>("debugAck", (r, id) => ({
        type: "debugResume",
        id,
        epoch: r.epoch,
        stopId,
        action,
        ...(granularity !== undefined ? { granularity } : {}),
      })).then(() => {
        // A resume that immediately re-stopped (watchpoint, breakpoint in a
        // one-instruction loop) already replaced the published stop — only
        // clear the identity this resume released.
        if (current === run && !run.dead && run.stop?.stopId === stopId) {
          run.stop = null;
          emit({ type: "running", run: run.facade });
        }
      });
    },
    runTo(location) {
      const run = stoppedRun();
      const stopId = run.stop!.stopId;
      const target = { logic: location.logic, pc: location.pc };
      return command<void>("debugAck", (r, id) => ({
        type: "debugRunTo",
        id,
        epoch: r.epoch,
        stopId,
        location: target,
      })).then(() => {
        if (current === run && !run.dead && run.stop?.stopId === stopId) {
          run.stop = null;
          emit({ type: "running", run: run.facade });
        }
      });
    },
    evaluate(expression) {
      const run = stoppedRun();
      const stopId = run.stop!.stopId;
      return command<DebugValue>("debugEvaluation", (r, id) => ({
        type: "debugEvaluate",
        id,
        epoch: r.epoch,
        stopId,
        expression,
      }));
    },
    inspect(section = "all") {
      const run = stoppedRun();
      const stopId = run.stop!.stopId;
      return command<unknown>("debugInspection", (r, id) => ({
        type: "debugInspect",
        id,
        epoch: r.epoch,
        stopId,
        section,
      }));
    },
    setValues(values) {
      const run = stoppedRun();
      const stopId = run.stop!.stopId;
      return command<number>("debugSetValuesAck", (r, id) => ({
        type: "debugSetValues",
        id,
        epoch: r.epoch,
        stopId,
        ...(values.vars !== undefined
          ? { vars: values.vars.map(([n, v]) => [n, v] as [number, number]) }
          : {}),
        ...(values.flags !== undefined
          ? { flags: values.flags.map(([n, v]) => [n, v] as [number, number]) }
          : {}),
      }));
    },
    previewUpdate(candidate) {
      return previewUpdate(candidate);
    },
    previewStatus(transactionId) {
      return previewStatus(transactionId);
    },
    configure(config) {
      const run = live();
      const revision = run.configRevision + 1;
      // Detach the caller's specs now — an injected worker receives the
      // posted objects, so waiting for transport clone is too late.
      let breakpoints: DebugBreakpointSpec[] | undefined;
      let watchpoints: DebugWatchSpec[] | undefined;
      try {
        breakpoints =
          config.breakpoints !== undefined ? structuredClone([...config.breakpoints]) : undefined;
        watchpoints =
          config.watchpoints !== undefined ? structuredClone([...config.watchpoints]) : undefined;
      } catch (error) {
        throw new TestRuntimeError(`isolated test configure refused: ${String(error)}`, "refused");
      }
      return command<TestDebugConfig>("debugConfigured", (r, id) => ({
        type: "debugConfigure",
        id,
        epoch: r.epoch,
        revision,
        ...(breakpoints !== undefined ? { breakpoints } : {}),
        ...(watchpoints !== undefined ? { watchpoints } : {}),
      }));
    },
    key(code) {
      inputAllowed()?.worker?.postMessage({ type: "key", code } satisfies WorkerInbound);
    },
    input(text) {
      inputAllowed()?.worker?.postMessage({ type: "input", text } satisfies WorkerInbound);
    },
    click(x, y) {
      inputAllowed()?.worker?.postMessage({ type: "click", x, y } satisfies WorkerInbound);
    },
    direction(dir, release) {
      inputAllowed()?.worker?.postMessage({
        type: "direction",
        dir,
        ...(release !== undefined ? { releaseEligible: release } : {}),
      } satisfies WorkerInbound);
    },
    saves: () => host.slots(),
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
