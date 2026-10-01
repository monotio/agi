import type { captureProjectBuild } from "../authoring/projectBuild.ts";
import type { ExecutionPhaseKind } from "./executionObservation.ts";
import {
  compileDebugExpression,
  DebugExpressionError,
  type CompiledDebugExpression,
  type DebugBindings,
  type DebugSnapshot,
} from "./debugExpression.ts";

export class DebugWatchpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DebugWatchpointError";
  }
}

/**
 * Application work ceilings for one plan, not interpreter format limits. They
 * bound hostile configurations so validation and observation stay cheap.
 */
export const DEBUG_WATCHPOINT_LIMITS = {
  watchpoints: 256,
  idLength: 128,
  conditionLength: 1024,
} as const;

export interface DebugWatchTarget {
  readonly kind: "variable" | "flag";
  readonly index: number;
}

/** Caller-facing watchpoint configuration for one watched slot. */
export interface DebugWatchSpec {
  readonly id: string;
  readonly enabled: boolean;
  readonly target: DebugWatchTarget;
  /**
   * Optional pure filter over the change. `old`/`new` are typed by the
   * target kind: number for a variable, boolean for a flag.
   */
  readonly condition?: string;
}

export interface DebugWatchpointConfig {
  readonly revision: number;
  readonly watchpoints: readonly DebugWatchSpec[];
}

/**
 * The causes a watch occurrence may report: the two responsible-instruction
 * kinds plus every engine phase (ExecutionPhaseKind). Phase causes carry no
 * implied instruction location — a phase names itself rather than blaming
 * the next instruction.
 */
export type DebugWatchCauseKind = "action" | "predicate" | ExecutionPhaseKind;

export interface DebugWatchLocation {
  readonly logic: number;
  readonly pc: number;
}

/**
 * Which indivisible operation produced the observed state. Action and
 * predicate causes carry the responsible instruction's location; engine
 * phases carry an optional location. The plan never infers a cause from the
 * next pre-execution boundary.
 */
export interface DebugWatchCause {
  readonly kind: DebugWatchCauseKind;
  readonly location?: DebugWatchLocation;
  readonly invocationId?: number;
}

export interface DebugWatchOccurrence {
  readonly sequence: number;
  readonly cause: DebugWatchCause;
}

export interface DebugWatchChange {
  readonly id: string;
  readonly reason: "change" | "error";
  readonly target: DebugWatchTarget;
  readonly old: number | boolean;
  readonly new: number | boolean;
  readonly error?: string;
}

export interface DebugWatchOutcome {
  /** True when this exact sequence was already admitted once. */
  readonly repeat: boolean;
  readonly sequence: number;
  /** The admitted detached cause; null on a repeat. */
  readonly cause: DebugWatchCause | null;
  readonly changes: readonly DebugWatchChange[];
}

export interface DebugWatchStatus {
  readonly id: string;
  readonly spec: DebugWatchSpec;
  /** Last admitted value of the watched slot. */
  readonly baseline: number | boolean;
  /** Slot changes seen while enabled, counted before the filter runs. */
  readonly changes: number;
  /** Runtime fault message while the entry is run-disabled, else null. */
  readonly fault: string | null;
}

export interface DebugWatchConfigureResult {
  readonly revision: number;
  readonly entries: readonly DebugWatchStatus[];
}

type CapturedBuild = ReturnType<typeof captureProjectBuild>;

export interface DebugWatchpointPlan {
  /** Identity of the single captured build this plan was created for. */
  readonly identity: CapturedBuild["identity"];
  /** The currently published configuration revision. */
  readonly revision: number;
  /**
   * Atomically validate and publish a full configuration replacement. The
   * baseline snapshot is the currently admitted detached state: new or
   * changed watches seed there, unchanged watches keep their observed
   * baseline, change count and fault.
   */
  configure(config: DebugWatchpointConfig, baseline: DebugSnapshot): DebugWatchConfigureResult;
  /**
   * Compare every enabled watched slot after one indivisible operation.
   * An occurrence is identified by sequence alone: re-reporting the same
   * sequence is an idempotent `repeat` outcome that recounts nothing, and an
   * earlier sequence is a stale-occurrence error.
   */
  observe(snapshot: DebugSnapshot, occurrence: DebugWatchOccurrence): DebugWatchOutcome;
  /** A frozen snapshot of the live configuration and run state. */
  status(): readonly DebugWatchStatus[];
}

interface NormalSpec {
  readonly id: string;
  readonly enabled: boolean;
  readonly target: DebugWatchTarget;
  readonly condition: string | null;
  readonly compiledCondition: CompiledDebugExpression | null;
  /** Canonical identity used to preserve run state across republication. */
  readonly signature: string;
}

interface RuntimeEntry {
  readonly spec: NormalSpec;
  baseline: number | boolean;
  changes: number;
  fault: string | null;
}

function fail(message: string): never {
  throw new DebugWatchpointError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireInt(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

/** Read only detached own data, without invoking an accessor or prototype lookup. */
function ownValue(record: unknown, key: string, what: string): unknown {
  if (!isObject(record)) {
    fail(`${what} is missing from the snapshot`);
  }
  const property = Object.getOwnPropertyDescriptor(record, key);
  if (property === undefined || !Object.hasOwn(property, "value")) {
    fail(`${what} must be an own snapshot data property`);
  }
  return property.value;
}

function compileCondition(
  source: unknown,
  bindings: DebugBindings,
  target: DebugWatchTarget,
): CompiledDebugExpression {
  if (typeof source !== "string" || source.length === 0) {
    fail("watchpoint condition must be a non-empty string");
  }
  if (source.length > DEBUG_WATCHPOINT_LIMITS.conditionLength) {
    fail(`watchpoint condition exceeds ${DEBUG_WATCHPOINT_LIMITS.conditionLength} characters`);
  }
  try {
    const compiled = compileDebugExpression(source, bindings, {
      watch: true,
      watchType: target.kind === "variable" ? "number" : "boolean",
    });
    if (compiled.type !== "boolean") {
      fail("watchpoint condition must evaluate to boolean");
    }
    return compiled;
  } catch (error) {
    if (error instanceof DebugWatchpointError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid watchpoint condition: ${detail}`);
  }
}

function normalizeTarget(raw: unknown, id: string): DebugWatchTarget {
  if (!isObject(raw)) fail(`watchpoint ${id}: target must be an object`);
  const kind = raw["kind"];
  if (kind !== "variable" && kind !== "flag") {
    fail(`watchpoint ${id}: target kind must be "variable" or "flag"`);
  }
  const index = requireInt(raw["index"], `watchpoint ${id}: target index`, 0, 255);
  return { kind, index };
}

/** Validate one entry completely; runs before any publication so a bad entry discards the whole update. */
function normalizeSpec(raw: unknown, bindings: DebugBindings): NormalSpec {
  if (!isObject(raw)) fail("watchpoint entries must be objects");
  const id = raw["id"];
  if (typeof id !== "string" || id.length === 0 || id.length > DEBUG_WATCHPOINT_LIMITS.idLength) {
    fail(`watchpoint id must be a string of 1..${DEBUG_WATCHPOINT_LIMITS.idLength} characters`);
  }
  const enabled = raw["enabled"];
  if (typeof enabled !== "boolean") fail(`watchpoint ${id}: enabled must be boolean`);
  const target = normalizeTarget(raw["target"], id);
  let condition: string | null = null;
  let compiledCondition: CompiledDebugExpression | null = null;
  if (raw["condition"] !== undefined) {
    condition = String(raw["condition"]);
    compiledCondition = compileCondition(raw["condition"], bindings, target);
  }
  const signature = JSON.stringify([enabled, target.kind, target.index, condition]);
  return { id, enabled, target, condition, compiledCondition, signature };
}

interface AdmittedState {
  readonly vars: readonly number[];
  readonly flags: readonly boolean[];
}

/**
 * The public snapshot's vars/flags baseline, validated in full: vars are
 * byte-valued safe integers and flags are booleans, every slot an own data
 * property — accessors are never invoked and inherited values are absent.
 * Each indexed descriptor is read once into detached admitted arrays, so
 * later comparisons never touch the caller's slots again. Nothing is
 * coerced and no byte wraps silently.
 */
function readState(snapshot: DebugSnapshot): AdmittedState {
  const vars = ownValue(snapshot, "vars", "vars");
  if (!Array.isArray(vars)) fail("vars is not a snapshot array");
  const varCount = requireInt(
    ownValue(vars, "length", "vars length"),
    "vars length",
    0,
    0xffffffff,
  );
  const admittedVars = new Array<number>(varCount);
  for (let i = 0; i < varCount; i++) {
    const value = ownValue(vars, String(i), `v${i}`);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 255) {
      fail(`v${i} is not a byte value`);
    }
    admittedVars[i] = value;
  }
  const flags = ownValue(snapshot, "flags", "flags");
  if (!Array.isArray(flags)) fail("flags is not a snapshot array");
  const flagCount = requireInt(
    ownValue(flags, "length", "flags length"),
    "flags length",
    0,
    0xffffffff,
  );
  const admittedFlags = new Array<boolean>(flagCount);
  for (let i = 0; i < flagCount; i++) {
    const value = ownValue(flags, String(i), `f${i}`);
    if (typeof value !== "boolean") fail(`f${i} is not a boolean`);
    admittedFlags[i] = value;
  }
  return { vars: admittedVars, flags: admittedFlags };
}

function slotName(target: DebugWatchTarget): string {
  return target.kind === "variable" ? `v${target.index}` : `f${target.index}`;
}

function slotValue(state: AdmittedState, target: DebugWatchTarget): number | boolean {
  const values = target.kind === "variable" ? state.vars : state.flags;
  if (target.index >= values.length) {
    fail(`${slotName(target)} is absent from the snapshot`);
  }
  return values[target.index]!;
}

// Exhaustive over ExecutionPhaseKind so a new engine phase fails typecheck
// here instead of silently failing admission at runtime.
const PHASE_CAUSE_KINDS: Readonly<Record<ExecutionPhaseKind, true>> = {
  "cycle-entry": true,
  input: true,
  "pre-logic": true,
  "host-answer": true,
  room: true,
  reset: true,
  "cycle-tail": true,
  motion: true,
  "cycle-end": true,
  clock: true,
  sound: true,
};

const CAUSE_KINDS: Readonly<Record<DebugWatchCauseKind, true>> = {
  action: true,
  predicate: true,
  ...PHASE_CAUSE_KINDS,
};

const LOCATION_KINDS: Readonly<Record<string, true>> = { action: true, predicate: true };

/** Validate and detach the caller's cause record; nothing is inferred later. */
function normalizeCause(raw: unknown): DebugWatchCause {
  if (!isObject(raw)) fail("occurrence cause must be an object");
  const kind = raw["kind"];
  if (typeof kind !== "string" || !Object.hasOwn(CAUSE_KINDS, kind)) {
    fail("occurrence cause kind is unknown");
  }
  let location: DebugWatchLocation | null = null;
  if (raw["location"] !== undefined) {
    const value = raw["location"];
    if (!isObject(value)) fail(`cause '${kind}': location must be an object`);
    location = {
      logic: requireInt(value["logic"], `cause '${kind}': logic`, 0, 255),
      pc: requireInt(value["pc"], `cause '${kind}': pc`, 0, Number.MAX_SAFE_INTEGER),
    };
  }
  if (Object.hasOwn(LOCATION_KINDS, kind) && location === null) {
    fail(`cause '${kind}' requires the responsible instruction location`);
  }
  let invocationId: number | null = null;
  if (raw["invocationId"] !== undefined) {
    invocationId = requireInt(
      raw["invocationId"],
      `cause '${kind}': invocationId`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  const cause: {
    kind: DebugWatchCauseKind;
    location?: DebugWatchLocation;
    invocationId?: number;
  } = { kind: kind as DebugWatchCauseKind };
  if (location !== null) cause.location = Object.freeze(location);
  if (invocationId !== null) cause.invocationId = invocationId;
  return Object.freeze(cause);
}

const SNAPSHOT_CONTEXT = [
  "strings",
  "objects",
  "inventory",
  "room",
  "logic",
  "pc",
  "cycle",
] as const;

/**
 * Build the evaluation view for one filter: the admitted detached slot data
 * and the caller's remaining own snapshot data, plus this change's
 * `old`/`new`. Caller getters are never invoked and the passed snapshot is
 * never extended; absent contextual fields stay absent so reads fail under
 * the usual pure-expression rules.
 */
function watchSnapshot(
  snapshot: DebugSnapshot,
  state: AdmittedState,
  oldValue: number | boolean,
  newValue: number | boolean,
): DebugSnapshot {
  const view: { -readonly [K in keyof DebugSnapshot]?: DebugSnapshot[K] } = {};
  for (const key of SNAPSHOT_CONTEXT) {
    const property = Object.getOwnPropertyDescriptor(snapshot, key);
    if (property !== undefined && Object.hasOwn(property, "value")) {
      (view as Record<string, unknown>)[key] = property.value;
    }
  }
  view.vars = state.vars;
  view.flags = state.flags;
  view.old = oldValue;
  view.new = newValue;
  return view as DebugSnapshot;
}

function freezeOutcome(
  repeat: boolean,
  sequence: number,
  cause: DebugWatchCause | null,
  changes: DebugWatchChange[],
): DebugWatchOutcome {
  for (const change of changes) Object.freeze(change);
  return Object.freeze({
    repeat,
    sequence,
    cause,
    changes: Object.freeze(changes),
  });
}

/**
 * One run's value-change watchpoint plan over a single captured build. Pure
 * and detached: it never touches an Engine, mutates state only internally,
 * and hands every result out frozen. A new run creates a new plan, which
 * resets baselines, counters and faults.
 */
export function createDebugWatchpointPlan(input: {
  readonly build: CapturedBuild;
  readonly bindings?: DebugBindings;
}): DebugWatchpointPlan {
  // Deep-copy the named bindings so later caller edits cannot rewrite this run.
  const bindings: DebugBindings = Object.fromEntries(
    Object.entries(input.bindings ?? {}).map(([name, binding]) => [
      name,
      { kind: binding.kind, num: binding.num },
    ]),
  );
  const identity = Object.freeze({ ...input.build.identity });
  let revision = 0;
  let entries: RuntimeEntry[] = [];
  // Sequence 0 is never a real occurrence; equal sequences are the same operation.
  let lastSequence = 0;

  function publicSpec(spec: NormalSpec): DebugWatchSpec {
    const out: {
      id: string;
      enabled: boolean;
      target: DebugWatchTarget;
      condition?: string;
    } = {
      id: spec.id,
      enabled: spec.enabled,
      target: Object.freeze({ kind: spec.target.kind, index: spec.target.index }),
    };
    if (spec.condition !== null) out.condition = spec.condition;
    return Object.freeze(out);
  }

  function statusEntries(): readonly DebugWatchStatus[] {
    return Object.freeze(
      entries.map((entry) =>
        Object.freeze({
          id: entry.spec.id,
          spec: publicSpec(entry.spec),
          baseline: entry.baseline,
          changes: entry.changes,
          fault: entry.fault,
        }),
      ),
    );
  }

  function configure(
    config: DebugWatchpointConfig,
    baseline: DebugSnapshot,
  ): DebugWatchConfigureResult {
    if (!isObject(config)) fail("configuration must be an object");
    const nextRevision = config["revision"];
    if (
      typeof nextRevision !== "number" ||
      !Number.isSafeInteger(nextRevision) ||
      nextRevision <= revision
    ) {
      fail(`configuration revision must be a safe integer greater than ${revision}`);
    }
    const list = config["watchpoints"];
    if (!Array.isArray(list)) fail("configuration watchpoints must be an array");
    if (list.length > DEBUG_WATCHPOINT_LIMITS.watchpoints) {
      fail(`configuration exceeds ${DEBUG_WATCHPOINT_LIMITS.watchpoints} watchpoints`);
    }
    // Validate the entire replacement and the admitted baseline before
    // publishing anything: an invalid update leaves every watch untouched.
    const specs = (list as readonly unknown[]).map((spec) => normalizeSpec(spec, bindings));
    const ids = new Set<string>();
    for (const spec of specs) {
      if (ids.has(spec.id)) fail(`duplicate watchpoint id '${spec.id}'`);
      ids.add(spec.id);
    }
    const state = readState(baseline);
    const seeds = specs.map((spec) => slotValue(state, spec.target));
    const previous = new Map(entries.map((entry) => [entry.spec.id, entry]));
    entries = specs.map((spec, i) => {
      const prior = previous.get(spec.id);
      const kept = prior && prior.spec.signature === spec.signature ? prior : null;
      return kept ?? { spec, baseline: seeds[i]!, changes: 0, fault: null };
    });
    revision = nextRevision;
    return Object.freeze({ revision, entries: statusEntries() });
  }

  function observe(snapshot: DebugSnapshot, occurrence: DebugWatchOccurrence): DebugWatchOutcome {
    if (!isObject(occurrence)) fail("occurrence must be an object");
    const sequence = occurrence["sequence"];
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      fail("occurrence sequence must be a positive safe integer");
    }
    const cause = normalizeCause(occurrence["cause"]);
    const state = readState(snapshot);
    if (sequence === lastSequence) return freezeOutcome(true, sequence, null, []);
    if (sequence < lastSequence) {
      fail(`stale occurrence sequence ${sequence}; last processed is ${lastSequence}`);
    }
    // Every slot about to be compared must be present; a missing watched
    // value rejects the whole observation before any state changes.
    for (const entry of entries) {
      if (!entry.spec.enabled || entry.fault !== null) continue;
      const values = entry.spec.target.kind === "variable" ? state.vars : state.flags;
      if (entry.spec.target.index >= values.length) {
        fail(`${slotName(entry.spec.target)} is absent from the snapshot`);
      }
    }
    lastSequence = sequence;
    const changes: DebugWatchChange[] = [];
    for (const entry of entries) {
      if (!entry.spec.enabled || entry.fault !== null) continue;
      const target = entry.spec.target;
      const values = target.kind === "variable" ? state.vars : state.flags;
      const current = values[target.index]!;
      if (current === entry.baseline) continue;
      // The baseline tracks every real change, filtered or faulting alike,
      // so the next report carries the true previous value.
      const old = entry.baseline;
      entry.baseline = current;
      entry.changes += 1;
      if (entry.spec.compiledCondition) {
        let passes: boolean;
        try {
          passes =
            entry.spec.compiledCondition.evaluate(watchSnapshot(snapshot, state, old, current)) ===
            true;
        } catch (error) {
          const message = error instanceof DebugExpressionError ? error.message : String(error);
          entry.fault = message;
          changes.push({
            id: entry.spec.id,
            reason: "error",
            target: Object.freeze({ kind: target.kind, index: target.index }),
            old,
            new: current,
            error: message,
          });
          continue;
        }
        if (passes !== true) continue;
      }
      changes.push({
        id: entry.spec.id,
        reason: "change",
        target: Object.freeze({ kind: target.kind, index: target.index }),
        old,
        new: current,
      });
    }
    return freezeOutcome(false, sequence, cause, changes);
  }

  return Object.freeze({
    identity,
    get revision() {
      return revision;
    },
    configure,
    observe,
    status: statusEntries,
  });
}
