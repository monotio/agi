/**
 * The worker's execution controller: one attach/detach owner of the live
 * engine's gate and observer, serving the reliable `debug*` control
 * protocol. It holds session epoch + build identity, the breakpoint/
 * watchpoint/step plans, the host answers a stop parks, and the audio hold
 * a stop raises. Every entry point that may run the engine — poll, sound
 * tick, host answer, replay/history drive, reenter, playHere — reaches it
 * through runTickEntry/recordedClock, which end on debugAfterEntry so a
 * latched stop publishes exactly once at the boundary that produced it.
 * Pure functions of the worker context — importable under Node.
 */
import { captureProjectBuild } from "../../../src/authoring/projectBuild.ts";
import {
  compileDebugExpression,
  type DebugBindings,
  type DebugSnapshot,
} from "../../../src/runtime/debugExpression.ts";
import {
  createDebugBreakpointPlan,
  type DebugBreakpointStatus,
} from "../../../src/runtime/debugBreakpoints.ts";
import { createDebugStepPlan } from "../../../src/runtime/debugStep.ts";
import {
  createDebugWatchpointPlan,
  type DebugWatchCause,
  type DebugWatchStatus,
} from "../../../src/runtime/debugWatchpoints.ts";
import type { Engine, ExecutionBoundary } from "../../../src/runtime/engine.ts";
import type {
  ExecutionCause,
  ExecutionObservation,
} from "../../../src/runtime/executionObservation.ts";
import type {
  DebugErrorCode,
  DebugInspectSection,
  DebugStepGranularity,
  DebugStopReason,
} from "./workerProtocol.ts";
import type { Inbound, WorkerContext } from "./context.ts";
import {
  captureBlocked,
  debugPlanSnapshot,
  newDebuggerState,
  type DebuggerState,
  type PreviewPreparedSession,
} from "./debuggerState.ts";

type CapturedBuild = ReturnType<typeof captureProjectBuild>;

export function createDebugController(ctx: WorkerContext) {
  let stopAtEntry = false;
  const control = ctx.ports.control;
  /**
   * A detach that could not unarm (parked mid-cycle) leaves the gate and
   * observer installed on an engine with no session: the callbacks are inert
   * once epoch 0 reads them, but `executionControlActive` stays true and
   * would keep blocking boundary captures. The flag survives the session
   * reset; debugAfterEntry retries the disarm at the next clean boundary.
   */
  let orphanDisarm = false;

  /**
   * The run serial this session bound — `engine.runResetSerial` captured at
   * attach and at every session rebind. An accepted restart.game resets in
   * place: the Engine object survives while the run it executes does not,
   * so the instance equality check cannot see the replacement. The serial
   * is the same-instance witness the gate, observer and entry boundary
   * compare before attributing anything to the session's run.
   */
  let boundResetSerial = -1;

  /**
   * The engine accepts control changes only at a completed-cycle boundary.
   * cycleCursor and executionFault have no public accessor, so callers still
   * guard the install calls with try/catch — a false-positive here defers.
   */
  function boundaryClear(engine: Engine): boolean {
    return (
      engine.executionStopInfo === null &&
      !engine.continuationPending &&
      !engine.hostInteractionPending &&
      !engine.executionYieldPending
    );
  }

  /**
   * Reconcile the installed gate/observer with the session: an attached
   * session keeps control permanently armed, installed at a completed-cycle
   * boundary or deferred to the next entry. The engine refuses control
   * changes at a non-boundary — the deferred flag retries through
   * debugAfterEntry.
   */
  function syncControlArming(engine: Engine): void {
    const d = ctx.run.debugger;
    if (d.epoch === 0 || engine !== d.engine || d.installed) return;
    if (boundaryClear(engine)) {
      try {
        install(engine);
      } catch {
        d.armDeferred = true;
      }
    } else {
      d.armDeferred = true;
    }
  }

  function install(engine: Engine): void {
    engine.setExecutionGate(gate);
    engine.setExecutionObserver(observer);
    const d = ctx.run.debugger;
    d.installed = true;
    d.armDeferred = false;
    // A fresh arm supersedes any disarm still owed to a previous session.
    orphanDisarm = false;
  }

  function uninstall(engine: Engine): void {
    engine.setExecutionGate(null);
    engine.setExecutionObserver(null);
    ctx.run.debugger.installed = false;
  }

  /**
   * Detached snapshot for plan observation; rich only when a condition/log
   * can read it. `location` names the LOGIC boundary the evaluated context
   * belongs to — the gate's actual boundary, an instruction observation's
   * cause boundary — while a phase context, an idle engine and baselines
   * pass null (or inherit the latched stop's resume point) rather than
   * blaming a statement that did not produce the write.
   */
  function planSnapshot(
    engine: Engine,
    location: { logic: number; pc: number } | null = engine.executionStopInfo?.location ?? null,
    rich = ctx.run.debugger.richSnapshot,
  ): DebugSnapshot {
    return debugPlanSnapshot(engine, ctx.run.cycle.cycleCount, location, rich);
  }

  /** Map an authoritative engine cause onto the watch plan's cause domain. */
  function watchCause(cause: ExecutionCause): DebugWatchCause {
    if (cause.type === "phase") return { kind: cause.phase };
    if (cause.type === "wait")
      throw new Error("Watch observations require a completed instruction or phase.");
    const boundary = cause.boundary;
    const top = boundary.frames.at(-1);
    const out: {
      kind: "action" | "predicate";
      location: { logic: number; pc: number };
      invocationId?: number;
    } = {
      kind: boundary.kind === "predicate" ? "predicate" : "action",
      location: { logic: boundary.logic, pc: boundary.pc },
    };
    if (top !== undefined) out.invocationId = top.invocationId;
    return out;
  }

  /** The shared gate: run-to, then breakpoint bindings, then a non-cycle step. */
  function gate(boundary: ExecutionBoundary): boolean {
    const d = ctx.run.debugger;
    const engine = ctx.run.engine;
    if (d.epoch === 0 || !d.installed || engine === null) return false;
    // The run restarted in place inside this entry: the outgoing epoch's
    // plans must not stop or account the reset's pass. The reset is
    // published at the entry boundary (debugAfterEntry); the rebound plans
    // resume observing under the new epoch from the next boundary on.
    if (engine !== d.engine || engine.runResetSerial !== boundResetSerial) return false;
    let stop = stopAtEntry;
    if (stopAtEntry) {
      stopAtEntry = false;
      d.pendingReasons.push({ kind: "runTo" });
    }
    if (d.runTo !== null && boundary.logic === d.runTo.logic && boundary.pc === d.runTo.pc) {
      d.runTo = null;
      d.pendingReasons.push({ kind: "runTo" });
      stop = true;
    }
    if (d.breakpointPlan !== null && d.breakpointSpecs.length > 0) {
      const outcome = d.breakpointPlan.atBoundary(boundary, planSnapshot(engine, boundary));
      for (const hit of outcome.stops) {
        d.pendingReasons.push({
          kind: "breakpoint",
          id: hit.id,
          hitCount: hit.hitCount,
          ...(hit.error !== undefined ? { error: hit.error } : {}),
        });
        stop = true;
      }
      for (const log of outcome.logs) {
        control({
          type: "debugLog",
          epoch: d.epoch,
          sequence: boundary.sequence,
          breakpoint: log.id,
          text: log.text,
        });
      }
    }
    if (d.step !== null && d.step.mode !== "cycle") {
      const verdict = d.step.plan.atBoundary(boundary);
      if (verdict !== null) {
        d.pendingReasons.push({
          kind: "step",
          mode: d.step.mode,
          ...(verdict === "unwind" ? { unwind: true } : {}),
        });
        d.step = null;
        stop = true;
      }
    }
    return stop;
  }

  /** The shared observer: watchpoints on every operation, cycle-step at cycle-end. */
  function observer(observation: ExecutionObservation): boolean {
    const d = ctx.run.debugger;
    const engine = ctx.run.engine;
    if (d.epoch === 0 || !d.installed || engine === null) return false;
    // Same in-place reset as the gate: stale-epoch watch baselines and step
    // plans never observe the new run's pass.
    if (engine !== d.engine || engine.runResetSerial !== boundResetSerial) return false;
    let stop = false;
    if (d.watchpointPlan !== null && d.watchpointSpecs.length > 0) {
      const outcome = d.watchpointPlan.observe(
        planSnapshot(
          engine,
          // A completed LOGIC operation's cause names the instruction that
          // wrote; a pure phase has none and must not borrow one.
          observation.cause.type === "instruction" ? observation.cause.boundary : null,
        ),
        {
          sequence: observation.sequence,
          cause: watchCause(observation.cause),
        },
      );
      if (!outcome.repeat && outcome.changes.length > 0) {
        d.pendingReasons.push({ kind: "watch", changes: outcome.changes });
        stop = true;
      }
    }
    if (
      d.step !== null &&
      d.step.mode === "cycle" &&
      observation.cause.type === "phase" &&
      observation.cause.phase === "cycle-end"
    ) {
      if (d.step.plan.atCycleEnd() !== null) {
        d.pendingReasons.push({ kind: "step", mode: "cycle" });
        d.step = null;
        stop = true;
      }
    }
    return stop;
  }

  function postError(
    id: number,
    code: DebugErrorCode,
    error: string,
    epoch?: number | null,
    buildId?: string | null,
  ): void {
    const d = ctx.run.debugger;
    control({
      type: "debugError",
      id,
      epoch: epoch === undefined ? (d.epoch === 0 ? null : d.epoch) : epoch,
      buildId: buildId === undefined ? d.buildId : buildId,
      code,
      error,
    });
  }

  function postAck(id: number): void {
    const d = ctx.run.debugger;
    control({ type: "debugAck", id, epoch: d.epoch, buildId: d.buildId! });
  }

  /** The pinned stop's published snapshot — always the full detached view. */
  function pinStop(engine: Engine): number {
    const d = ctx.run.debugger;
    const stopId = ++d.stopSerial;
    d.stopId = stopId;
    // The pinned snapshot is the full detached view of the latched stop:
    // rich state plus the stop's own resume point (null for a phase/idle
    // stop — never a fabricated instruction).
    d.snapshot = planSnapshot(engine, engine.executionStopInfo!.location, true);
    d.inspected = { state: engine.readState(), objects: engine.readObjects() };
    return stopId;
  }

  function postStopped(reasons: readonly DebugStopReason[]): void {
    const d = ctx.run.debugger;
    const engine = ctx.run.engine!;
    const info = engine.executionStopInfo!;
    control({
      type: "debugStopped",
      epoch: d.epoch,
      buildId: d.buildId!,
      stopId: d.stopId!,
      boundarySeq: info.location?.sequence ?? null,
      cause: info.cause,
      location: info.location,
      wait: info.wait,
      reasons,
      state: d.inspected!.state,
      answerReady: d.queuedAnswers.map((answer) => answer.id),
    });
  }

  /**
   * Publish the latched stop once — the reliable `debugStopped` event with a
   * fresh session serial, the authoritative engine cause, the parked resume
   * point (null for a phase-only or idle stop), and the audio hold.
   */
  function publishStop(): void {
    const d = ctx.run.debugger;
    const engine = ctx.run.engine;
    if (engine === null || d.epoch === 0 || engine !== d.engine) return;
    const info = engine.executionStopInfo;
    if (info === null || info.stopId === d.publishedEngineStop) return;
    d.publishedEngineStop = info.stopId;
    const reasons = d.pendingReasons.splice(0);
    if (reasons.length === 0) reasons.push({ kind: "pause" });
    pinStop(engine);
    if (!d.audioHold) {
      d.audioHold = true;
      control({ type: "debugAudio", epoch: d.epoch, paused: true });
    }
    postStopped(reasons);
  }

  /**
   * Post-entry hook every engine-driving path ends on: lands a deferred
   * arm/disarm at the first completed-cycle boundary, heals a silent engine
   * replacement, then publishes any stop the entry latched. Called from
   * runTickEntry and the clock lane so a stop inside advanceClock/soundTick
   * reports before the next atomic operation in the same outer loop.
   */
  function debugAfterEntry(): void {
    const engine = ctx.run.engine;
    if (engine === null) return;
    const d = ctx.run.debugger;
    if (d.epoch === 0) {
      // No session — but a detach may still owe this engine its disarm.
      if (orphanDisarm) {
        try {
          engine.setExecutionGate(null);
          engine.setExecutionObserver(null);
          orphanDisarm = false;
        } catch {
          /* not a clean boundary yet — the next entry retries */
        }
      }
      return;
    }
    if (engine !== d.engine || engine.runResetSerial !== boundResetSerial) {
      // The owner was replaced without a sessionReplaced call, or an
      // accepted restart.game reset the run inside the same engine — the
      // same identity replacement, healed lazily at the entry boundary.
      debugSessionReplaced();
      if (ctx.run.debugger.epoch === 0) return;
    }
    const session = ctx.run.debugger;
    if (session.armDeferred && boundaryClear(engine)) {
      // The cursor/fault states boundaryClear cannot see still refuse: keep
      // the deferred flag and retry after the next entry.
      try {
        install(engine);
      } catch {
        /* still not a completed-cycle boundary */
      }
    }
    publishStop();
  }

  function releaseAudio(): void {
    const d = ctx.run.debugger;
    if (!d.audioHold) return;
    d.audioHold = false;
    control({ type: "debugAudio", epoch: d.epoch, paused: false });
  }

  /**
   * A command that replaces or mutates the run while the latch is held must
   * release it first: engine asserts refuse patch/restore/reenter under a
   * stop. Queued answers belong to the outgoing identity and are dropped —
   * the parked interaction they answered is abandoned by the replacement.
   */
  function debugBeforeReplace(): void {
    stopAtEntry = false;
    const d = ctx.run.debugger;
    if (d.epoch === 0) return;
    const engine = d.engine;
    if (engine !== null && engine === ctx.run.engine && engine.executionStopInfo !== null) {
      try {
        engine.resumeExecution();
      } catch {
        /* a faulted engine's latch is unreachable — replacement proceeds. */
      }
    }
    d.publishedEngineStop = -1;
    d.stopId = null;
    d.snapshot = null;
    d.inspected = null;
    d.step = null;
    d.runTo = null;
    d.pendingReasons = [];
    d.queuedAnswers = [];
    releaseAudio();
  }

  /**
   * The run's identity changed — a fresh engine booted, resources were
   * patched, an image restored, a history boot adopted. Mint a new epoch,
   * recapture and verify the build, rebind the plans, and report the reset;
   * every request, stop, snapshot and queued answer the old epoch issued is
   * now stale. A build that cannot reproduce the session's sources ends the
   * session instead of binding breakpoints against unverifiable bytes.
   */
  function debugSessionReplaced(stopAtFirstInstruction = false): void {
    const d = ctx.run.debugger;
    if (d.epoch === 0) return;
    debugBeforeReplace();
    const engine = ctx.run.engine;
    if (engine === null) {
      detachInternal("closed");
      return;
    }
    // A replay or viewed-history run is tape-driven — not attachable. The
    // session ends rather than binding breakpoints to a scratch engine.
    if (ctx.replay.replay !== null || ctx.view.recording !== null) {
      detachInternal("replaced");
      return;
    }
    if (d.engine !== engine) d.installed = false;
    d.engine = engine;
    boundResetSerial = engine.runResetSerial;
    d.epoch = ++d.epochCounter;
    let breakpoints: readonly DebugBreakpointStatus[];
    let watchpoints: readonly DebugWatchStatus[];
    try {
      d.build = captureBuild(engine, d.sources, d.sourceBindings ?? d.bindings);
      d.buildId = d.build.identity.buildId;
      d.breakpointPlan = createDebugBreakpointPlan({ build: d.build, bindings: d.bindings });
      d.watchpointPlan = createDebugWatchpointPlan({ build: d.build, bindings: d.bindings });
      breakpoints = d.breakpointPlan.configure({
        revision: 1,
        breakpoints: d.breakpointSpecs,
      }).entries;
      watchpoints = d.watchpointPlan.configure(
        { revision: 1, watchpoints: d.watchpointSpecs },
        planSnapshot(engine),
      ).entries;
    } catch (error) {
      detachInternal(`replaced: ${String(error instanceof Error ? error.message : error)}`);
      return;
    }
    refreshRichSnapshot();
    syncControlArming(engine);
    stopAtEntry = stopAtFirstInstruction;
    control({
      type: "debugSessionReset",
      epoch: d.epoch,
      buildId: d.buildId,
      breakpoints,
      watchpoints,
    });
  }

  /**
   * The detached build over the live image. `identityBindings` is the
   * complete name→number map the capture verifies and the identity is hashed
   * under — the caller's full source binding map when it shipped one, else
   * the expression bindings alone.
   */
  function captureBuild(
    engine: Engine,
    sources: Record<string, string>,
    identityBindings: Readonly<Record<string, { readonly num: number }>>,
  ): CapturedBuild {
    const files: Record<string, Uint8Array> = {};
    for (const [name, bytes] of engine.containerFiles) files[name] = bytes.slice();
    if (ctx.boot.authoredWords) files["WORDS.TOK"] = ctx.boot.authoredWords.slice();
    return captureProjectBuild({
      files,
      profileId: engine.profile.id,
      sources,
      bindings: Object.fromEntries(
        Object.entries(identityBindings).map(([name, b]) => [name, { num: b.num }]),
      ),
    });
  }

  function refreshRichSnapshot(): void {
    const d = ctx.run.debugger;
    d.richSnapshot =
      d.breakpointSpecs.some((s) => s.condition !== undefined || s.log !== undefined) ||
      d.watchpointSpecs.some((s) => s.condition !== undefined);
  }

  /** Deliver every queued host answer in order; a re-stop parks the rest. */
  function drainQueuedAnswers(): void {
    const d = ctx.run.debugger;
    while (d.queuedAnswers.length > 0 && ctx.run.engine?.executionStopInfo === null) {
      const answer = d.queuedAnswers.shift()!;
      ctx.fns.onHostAnswer({
        type: "hostAnswer",
        generation: answer.generation,
        id: answer.id,
        response: answer.response,
      });
    }
  }

  /** Release the latch and run: the shared half of resume/runTo. */
  function releaseAndRun(): void {
    const engine = ctx.run.engine;
    if (engine === null) return;
    if (engine.executionStopInfo !== null) engine.resumeExecution();
    releaseAudio();
    drainQueuedAnswers();
    ctx.fns.tickEngine();
    debugAfterEntry();
  }

  function detachInternal(reason: string): void {
    const d = ctx.run.debugger;
    const epoch = d.epoch;
    const buildId = d.buildId;
    const engine = d.engine;
    if (engine !== null && engine === ctx.run.engine) {
      try {
        if (engine.executionStopInfo !== null) engine.resumeExecution();
      } catch {
        /* the latch on a faulted engine is not releasable. */
      }
      if (d.installed) {
        try {
          uninstall(engine);
        } catch {
          // The session state resets below; the retry outlives it.
          d.installed = false;
          orphanDisarm = true;
        }
      }
    }
    releaseAudio();
    const hiatus = d.hiatus;
    const epochCounter = d.epochCounter;
    ctx.run.debugger = newDebuggerState();
    ctx.run.debugger.epochCounter = epochCounter;
    boundResetSerial = -1;
    if (hiatus) {
      // Normal recording restarts at the next representable boundary.
      ctx.fns.historyResume();
    }
    control({ type: "debugDetached", epoch, buildId: buildId ?? "", reason });
  }

  // ---------- inbound command handlers ----------

  function onDebugAttach(msg: Inbound<"debugAttach">): void {
    const engine = ctx.run.engine;
    if (engine === null) {
      postError(msg.id, "noEngine", "No game is running.", 0, null);
      return;
    }
    // A replay or viewed history session is a scratch run — not attachable.
    if (ctx.replay.replay !== null || ctx.view.recording !== null) {
      postError(msg.id, "unavailable", "The debugger attaches to the live session only.", 0, null);
      return;
    }
    const bindings: DebugBindings = {};
    for (const [name, binding] of Object.entries(msg.bindings ?? {})) {
      if (
        typeof binding !== "object" ||
        binding === null ||
        (binding.kind !== "variable" && binding.kind !== "flag" && binding.kind !== "string") ||
        !Number.isInteger(binding.num) ||
        binding.num < 0 ||
        binding.num > 255
      ) {
        postError(
          msg.id,
          "invalidRequest",
          `binding '${name}' needs { kind: variable|flag|string, num: 0..255 }`,
          0,
          null,
        );
        return;
      }
      bindings[name] = { kind: binding.kind, num: binding.num };
    }
    // The complete authored map, when the caller ships one: every kind is
    // admitted (resource names included), and `bindings` must be its exact
    // flag/variable/string subview — a name that disagrees or is missing is
    // a wire inconsistency, not a partial adoption.
    let sourceBindings: DebuggerState["sourceBindings"] = null;
    if (msg.sourceBindings !== undefined) {
      const complete: NonNullable<DebuggerState["sourceBindings"]> = {};
      for (const [name, binding] of Object.entries(msg.sourceBindings)) {
        if (
          typeof binding !== "object" ||
          binding === null ||
          (binding.kind !== "logic" &&
            binding.kind !== "picture" &&
            binding.kind !== "view" &&
            binding.kind !== "sound" &&
            binding.kind !== "flag" &&
            binding.kind !== "variable" &&
            binding.kind !== "string") ||
          !Number.isInteger(binding.num) ||
          binding.num < 0 ||
          binding.num > 255
        ) {
          postError(
            msg.id,
            "invalidRequest",
            `source binding '${name}' needs { kind: logic|picture|view|sound|flag|variable|string, num: 0..255 }`,
            0,
            null,
          );
          return;
        }
        complete[name] = { kind: binding.kind, num: binding.num };
      }
      for (const [name, binding] of Object.entries(bindings)) {
        const authored = complete[name];
        if (
          authored === undefined ||
          authored.kind !== binding.kind ||
          authored.num !== binding.num
        ) {
          postError(
            msg.id,
            "invalidRequest",
            `expression binding '${name}' is missing from the source bindings or disagrees`,
            0,
            null,
          );
          return;
        }
      }
      for (const [name, binding] of Object.entries(complete)) {
        if (
          (binding.kind === "variable" || binding.kind === "flag" || binding.kind === "string") &&
          bindings[name] === undefined
        ) {
          postError(
            msg.id,
            "invalidRequest",
            `source binding '${name}' is a value slot but has no expression binding`,
            0,
            null,
          );
          return;
        }
      }
      sourceBindings = complete;
    }
    // Verify the request's own sources against the live bytes under THIS
    // request's bindings — an attached session names its variables in the
    // source it ships. The capture precedes any session mutation: a
    // failed attach is a clean refusal and cannot leave half-authoritative
    // state behind.
    const sources = { ...(msg.sources ?? {}) };
    let build: CapturedBuild;
    try {
      build = captureBuild(engine, sources, sourceBindings ?? bindings);
    } catch (error) {
      postError(
        msg.id,
        "invalidRequest",
        `build capture failed: ${String(error instanceof Error ? error.message : error)}`,
        0,
        null,
      );
      return;
    }
    // Supersession is explicit: the old session ends only once the
    // replacement's build is verified.
    if (ctx.run.debugger.epoch !== 0) detachInternal("superseded");
    const d = ctx.run.debugger;
    d.engine = engine;
    boundResetSerial = engine.runResetSerial;
    d.epoch = ++d.epochCounter;
    d.buildId = build.identity.buildId;
    d.build = build;
    d.sources = sources;
    d.bindings = bindings;
    d.sourceBindings = sourceBindings;
    d.breakpointPlan = createDebugBreakpointPlan({ build, bindings });
    d.watchpointPlan = createDebugWatchpointPlan({ build, bindings });
    // Normal recording takes a hiatus: the open segment closes with the
    // "debugger" reason and the stored-test tape taints — the observed span
    // is honest about not being normal play, and no partial tick is written.
    // The flag records whether anything was actually recording: a detach
    // must not fabricate a resume for a session that was never live.
    d.hiatus = ctx.history.segment !== null || ctx.history.resumePending;
    ctx.fns.historyEnd("debugger");
    const rec = ctx.run.recording.recording;
    if (rec !== null && rec.tainted === null)
      rec.tainted = "The debugger interrupted the recording.";
    syncControlArming(engine);
    control({
      type: "debugAttached",
      id: msg.id,
      epoch: d.epoch,
      buildId: d.buildId!,
    });
  }

  function onDebugDetach(msg: Inbound<"debugDetach">): void {
    const d = ctx.run.debugger;
    if (d.epoch === 0 || msg.epoch !== d.epoch) {
      postError(msg.id, "staleEpoch", "the debugger session is not attached", msg.epoch, null);
      return;
    }
    const epoch = d.epoch;
    const buildId = d.buildId!;
    detachInternal("requested");
    control({ type: "debugAck", id: msg.id, epoch, buildId });
  }

  function onDebugConfigure(msg: Inbound<"debugConfigure">): void {
    const d = ctx.run.debugger;
    if (d.epoch === 0 || d.breakpointPlan === null || d.watchpointPlan === null) {
      postError(msg.id, "notAttached", "the debugger is not attached", msg.epoch, null);
      return;
    }
    if (msg.epoch !== d.epoch) {
      postError(msg.id, "staleEpoch", "epoch does not match the attached session", msg.epoch);
      return;
    }
    if (!Number.isSafeInteger(msg.revision) || msg.revision <= d.configRevision) {
      postError(
        msg.id,
        "staleRevision",
        `revision must be an integer greater than ${d.configRevision}`,
      );
      return;
    }
    const engine = ctx.run.engine;
    if (engine === null) {
      postError(msg.id, "noEngine", "No game is running.");
      return;
    }
    const breakpoints = msg.breakpoints ?? d.breakpointSpecs;
    const watchpoints = msg.watchpoints ?? d.watchpointSpecs;
    // Whole-configuration atomicity: validate BOTH candidate domains on
    // ephemeral plans first — a failure in either leaves both live plans,
    // their run state (hits, baselines, faults, dedup) and the published
    // revision untouched. The live configure runs only after the whole
    // candidate validates, and the plan's signature matching preserves
    // the run state of unchanged entries.
    const bpProbe = createDebugBreakpointPlan({ build: d.build!, bindings: d.bindings });
    const wpProbe = createDebugWatchpointPlan({ build: d.build!, bindings: d.bindings });
    try {
      bpProbe.configure({ revision: 1, breakpoints });
      wpProbe.configure({ revision: 1, watchpoints }, planSnapshot(engine));
    } catch (error) {
      postError(msg.id, "invalidConfig", String(error instanceof Error ? error.message : error));
      return;
    }
    const bpEntries = d.breakpointPlan.configure({
      revision: d.breakpointPlan.revision + 1,
      breakpoints,
    }).entries;
    const wpEntries = d.watchpointPlan.configure(
      { revision: d.watchpointPlan.revision + 1, watchpoints },
      planSnapshot(engine),
    ).entries;
    d.breakpointSpecs = [...breakpoints];
    d.watchpointSpecs = [...watchpoints];
    d.configRevision = msg.revision;
    refreshRichSnapshot();
    // Control follows the session: the gate stays armed for the new plans.
    syncControlArming(engine);
    control({
      type: "debugConfigured",
      id: msg.id,
      epoch: d.epoch,
      buildId: d.buildId!,
      revision: msg.revision,
      breakpoints: bpEntries,
      watchpoints: wpEntries,
    });
  }

  function onDebugPause(msg: Inbound<"debugPause">): void {
    const d = ctx.run.debugger;
    if (d.epoch === 0) {
      postError(msg.id, "notAttached", "the debugger is not attached", msg.epoch, null);
      return;
    }
    if (msg.epoch !== d.epoch) {
      postError(msg.id, "staleEpoch", "epoch does not match the attached session", msg.epoch);
      return;
    }
    const engine = ctx.run.engine;
    if (engine === null) {
      postError(msg.id, "noEngine", "No game is running.");
      return;
    }
    engine.pauseExecution();
    publishStop();
    postAck(msg.id);
  }

  /** Validate the named stop is the published one and the latch is held. */
  function requireStopped(msg: { id: number; epoch: number; stopId: number }): boolean {
    const d = ctx.run.debugger;
    const engine = ctx.run.engine;
    if (d.epoch === 0) {
      postError(msg.id, "notAttached", "the debugger is not attached", msg.epoch, null);
      return false;
    }
    if (msg.epoch !== d.epoch) {
      postError(msg.id, "staleEpoch", "epoch does not match the attached session", msg.epoch);
      return false;
    }
    if (engine === null || engine.executionStopInfo === null) {
      postError(msg.id, "notStopped", "execution is not stopped");
      return false;
    }
    if (d.stopId === null || msg.stopId !== d.stopId) {
      postError(msg.id, "staleStop", "stop id does not name the published stop");
      return false;
    }
    return true;
  }

  function onDebugResume(msg: Inbound<"debugResume">): void {
    if (!requireStopped(msg)) return;
    const d = ctx.run.debugger;
    const engine = ctx.run.engine!;
    const granularity: DebugStepGranularity = msg.granularity ?? "statement";
    switch (msg.action) {
      case "continue":
        break;
      case "into":
      case "over":
      case "out":
      case "cycle":
        try {
          d.step = {
            mode: msg.action,
            plan: createDebugStepPlan({
              origin: engine.executionStopInfo!.location,
              mode: msg.action,
              granularity,
              build: d.build!,
            }),
          };
        } catch (error) {
          postError(
            msg.id,
            "invalidRequest",
            String(error instanceof Error ? error.message : error),
          );
          return;
        }
        break;
      default:
        postError(msg.id, "invalidRequest", `unknown resume action '${String(msg.action)}'`);
        return;
    }
    d.runTo = null;
    postAck(msg.id);
    releaseAndRun();
  }

  function onDebugRunTo(msg: Inbound<"debugRunTo">): void {
    if (!requireStopped(msg)) return;
    const d = ctx.run.debugger;
    const location = msg.location;
    if (
      location === null ||
      typeof location !== "object" ||
      !Number.isInteger(location.logic) ||
      location.logic < 0 ||
      location.logic > 255 ||
      !Number.isInteger(location.pc) ||
      location.pc < 0
    ) {
      postError(msg.id, "invalidRequest", "runTo needs an integer logic 0..255 and pc >= 0");
      return;
    }
    d.step = null;
    d.runTo = { logic: location.logic, pc: location.pc };
    postAck(msg.id);
    releaseAndRun();
  }

  function onDebugInspect(msg: Inbound<"debugInspect">): void {
    if (!requireStopped(msg)) return;
    const d = ctx.run.debugger;
    const engine = ctx.run.engine!;
    const section: DebugInspectSection = msg.section ?? "all";
    const info = engine.executionStopInfo!;
    let data: unknown;
    switch (section) {
      case "state":
        data = d.inspected?.state ?? null;
        break;
      case "objects":
        data = d.inspected?.objects ?? [];
        break;
      case "stack":
        data = {
          cause: info.cause,
          location: info.location,
          wait: info.wait,
          frames: info.location?.frames ?? [],
        };
        break;
      case "strings":
        data = { strings: d.snapshot?.strings ?? [] };
        break;
      case "parser": {
        const state = d.inspected?.state;
        data = {
          parsedWords: state?.parsedWords ?? [],
          parsedWordTexts: state?.parsedWordTexts ?? [],
          parserCount: state?.parserCount ?? 0,
          lastInputLine: state?.lastInputLine ?? "",
          inputEnabled: state?.inputEnabled ?? false,
        };
        break;
      }
      case "all":
      default:
        data = {
          cause: info.cause,
          location: info.location,
          wait: info.wait,
          state: d.inspected?.state ?? null,
          objects: d.inspected?.objects ?? [],
          snapshot: d.snapshot,
        };
        break;
    }
    control({
      type: "debugInspection",
      id: msg.id,
      epoch: d.epoch,
      buildId: d.buildId!,
      stopId: d.stopId!,
      section,
      data,
    });
  }

  function onDebugEvaluate(msg: Inbound<"debugEvaluate">): void {
    if (!requireStopped(msg)) return;
    const d = ctx.run.debugger;
    let compiled;
    try {
      compiled = compileDebugExpression(String(msg.expression), d.bindings);
    } catch (error) {
      postError(
        msg.id,
        "invalidExpression",
        String(error instanceof Error ? error.message : error),
      );
      return;
    }
    try {
      const value = compiled.evaluate(d.snapshot!);
      control({
        type: "debugEvaluation",
        id: msg.id,
        epoch: d.epoch,
        buildId: d.buildId!,
        stopId: d.stopId!,
        ok: true,
        value,
      });
    } catch (error) {
      control({
        type: "debugEvaluation",
        id: msg.id,
        epoch: d.epoch,
        buildId: d.buildId!,
        stopId: d.stopId!,
        ok: false,
        error: String(error instanceof Error ? error.message : error),
      });
    }
  }

  /**
   * The play-preview lane's prevalidated install: a committed update's
   * captured build, sources and already-rebound plans land by bounded
   * assignment only, with a source-reset event for MAIN workspace consumers.
   * A fresh session epoch retires every command, stop snapshot and queued
   * answer minted under the old source identity.
   */
  function prepareDebugReplacement(
    engine: Engine,
    authority?: Pick<PreviewPreparedSession, "sources" | "sourceBindings" | "bindings">,
  ): PreviewPreparedSession {
    const d = ctx.run.debugger;
    if (!d.epoch) throw new Error("Open Debug before starting this launch.");
    const sources = authority?.sources ?? d.sources;
    const sourceBindings = authority?.sourceBindings ?? d.sourceBindings;
    const bindings = authority?.bindings ?? d.bindings;
    const build = captureBuild(engine, sources, sourceBindings ?? bindings);
    const breakpointPlan = createDebugBreakpointPlan({ build, bindings });
    breakpointPlan.configure({ revision: 1, breakpoints: d.breakpointSpecs });
    const watchpointPlan = createDebugWatchpointPlan({ build, bindings });
    watchpointPlan.configure(
      { revision: 1, watchpoints: d.watchpointSpecs },
      debugPlanSnapshot(engine, ctx.run.cycle.cycleCount, null, d.richSnapshot),
    );
    // Arming itself must succeed while the detached room entry is still unexecuted.
    engine.setExecutionGate(() => false);
    engine.setExecutionGate(null);
    return { build, sources, sourceBindings, bindings, breakpointPlan, watchpointPlan };
  }

  function previewSessionInstall(prepared: PreviewPreparedSession): void {
    const d = ctx.run.debugger;
    const lane = ctx.run.projectAdmission;
    if (lane === null || lane.engine !== ctx.run.engine || d.epoch === 0) return;
    d.epoch = ++d.epochCounter;
    d.build = prepared.build;
    d.buildId = prepared.build.identity.buildId;
    d.sources = prepared.sources;
    d.sourceBindings = prepared.sourceBindings;
    d.bindings = prepared.bindings;
    d.breakpointPlan = prepared.breakpointPlan;
    d.watchpointPlan = prepared.watchpointPlan;
    refreshRichSnapshot();
    control({
      type: "debugSessionReset",
      epoch: d.epoch,
      buildId: d.buildId,
      breakpoints: d.breakpointPlan.status(),
      watchpoints: d.watchpointPlan.status(),
      sources: { ...d.sources },
    });
  }

  function onDebugSetValues(msg: Inbound<"debugSetValues">): void {
    if (!requireStopped(msg)) return;
    const d = ctx.run.debugger;
    const engine = ctx.run.engine!;
    const vars = msg.vars ?? [];
    const flags = msg.flags ?? [];
    // Validate the whole transaction before any write — a malformed pair
    // leaves every slot untouched.
    for (const pair of vars) {
      if (
        !Array.isArray(pair) ||
        !Number.isInteger(pair[0]) ||
        pair[0]! < 0 ||
        pair[0]! > 255 ||
        !Number.isInteger(pair[1]) ||
        pair[1]! < 0 ||
        pair[1]! > 255
      ) {
        postError(
          msg.id,
          "invalidRequest",
          `variable write ${JSON.stringify(pair)} is not [slot, byte]`,
        );
        return;
      }
      // v0 is the room: a raw assignment skips every transition invariant
      // (ego placement, resource replay reset, controller clears). Room
      // navigation needs the semantic launch, not a value write.
      if (pair[0] === 0) {
        postError(msg.id, "invalidRequest", "v0 is the room; launch the room semantically");
        return;
      }
    }
    for (const pair of flags) {
      if (
        !Array.isArray(pair) ||
        !Number.isInteger(pair[0]) ||
        pair[0]! < 0 ||
        pair[0]! > 255 ||
        (pair[1] !== 0 && pair[1] !== 1)
      ) {
        postError(
          msg.id,
          "invalidRequest",
          `flag write ${JSON.stringify(pair)} is not [slot, 0|1]`,
        );
        return;
      }
    }
    for (const pair of vars) engine.vars[pair[0]!] = pair[1]!;
    for (const pair of flags) engine.flags[pair[0]!] = pair[1]!;
    d.modified = true;
    ctx.fns.captureStateDiffs();
    // Reprime the watch baseline so a debugger write is the new admitted
    // value rather than a change the plan reports back.
    if (d.watchpointPlan !== null && d.watchpointSpecs.length > 0) {
      try {
        const plan = createDebugWatchpointPlan({ build: d.build!, bindings: d.bindings });
        plan.configure({ revision: 1, watchpoints: d.watchpointSpecs }, planSnapshot(engine));
        d.watchpointPlan = plan;
      } catch {
        /* stored specs validated at their own configure; a re-prime keeps state. */
      }
    }
    // Publish a fresh stop identity: the old snapshot is stale and any
    // reference to it must read the mutated run.
    pinStop(engine);
    postStopped([{ kind: "mutated" }]);
    control({
      type: "debugSetValuesAck",
      id: msg.id,
      epoch: d.epoch,
      buildId: d.buildId!,
      stopId: d.stopId!,
    });
  }

  return {
    onDebugAttach,
    onDebugDetach,
    onDebugConfigure,
    onDebugPause,
    onDebugResume,
    onDebugRunTo,
    onDebugInspect,
    onDebugEvaluate,
    onDebugSetValues,
    previewSessionInstall,
    prepareDebugReplacement,
    debugAfterEntry,
    debugBeforeReplace,
    debugSessionReplaced,
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
