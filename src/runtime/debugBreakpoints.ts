import type { captureProjectBuild } from "../authoring/projectBuild.ts";
import type { LogicSourceEntry } from "../logic/assembler.ts";
import {
  compileDebugExpression,
  DebugExpressionError,
  type CompiledDebugExpression,
  type DebugBindings,
  type DebugSnapshot,
  type DebugValue,
} from "./debugExpression.ts";
import type { ExecutionBoundary } from "./engine.ts";

export class DebugBreakpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DebugBreakpointError";
  }
}

/**
 * Application work ceilings for one plan, not interpreter format limits. They
 * bound hostile configurations so validation and matching stay cheap.
 */
export const DEBUG_BREAKPOINT_LIMITS = {
  breakpoints: 512,
  idLength: 128,
  hitCount: 1_000_000,
  logSegments: 16,
  logLiteral: 1024,
  logExpression: 1024,
  logOutput: 2048,
} as const;

export interface DebugHitPolicy {
  readonly kind: "equal" | "atLeast" | "every";
  readonly count: number;
}

export interface DebugLogLiteralSegment {
  readonly type: "literal";
  readonly text: string;
}

export interface DebugLogExpressionSegment {
  readonly type: "expression";
  readonly source: string;
}

export type DebugLogSegment = DebugLogLiteralSegment | DebugLogExpressionSegment;

export interface DebugLogpoint {
  readonly segments: readonly DebugLogSegment[];
}

/** Caller-facing breakpoint configuration for one source location. */
export interface DebugBreakpointSpec {
  readonly id: string;
  readonly enabled: boolean;
  readonly logic: number;
  /** 1-based line in the authored LOGIC source. */
  readonly line: number;
  /** Optional 1-based UTF-16 column inside the authored line. */
  readonly column?: number;
  readonly mode: "statement" | "predicate";
  readonly condition?: string;
  readonly hit?: DebugHitPolicy;
  readonly log?: DebugLogpoint;
}

export interface DebugBreakpointConfig {
  readonly revision: number;
  readonly breakpoints: readonly DebugBreakpointSpec[];
}

export type DebugUnboundReason =
  | "unknown-logic"
  | "no-source"
  | "no-source-map"
  | "line-out-of-range"
  | "non-executable-line"
  | "no-statement-at-position";

export type DebugBoundKind = "action" | "return" | "goto" | "if" | "predicate";

export interface DebugEmittedLocation {
  readonly kind: DebugBoundKind;
  readonly pc: number;
  readonly endPc: number;
}

export type DebugBinding =
  | {
      readonly bound: true;
      readonly logic: number;
      /** Resolved 1-based authored line and UTF-16 column of the statement. */
      readonly line: number;
      readonly column: number;
      readonly kind: DebugBoundKind;
      readonly statementId: number;
      /** Distinct emitted PCs for the bound source statement, ascending. */
      readonly pcs: readonly number[];
      readonly locations: readonly DebugEmittedLocation[];
    }
  | { readonly bound: false; readonly reason: DebugUnboundReason };

export interface DebugBreakpointStatus {
  readonly id: string;
  readonly spec: DebugBreakpointSpec;
  readonly binding: DebugBinding;
  readonly hits: number;
  /** Runtime fault message while the entry is run-disabled, else null. */
  readonly fault: string | null;
}

export interface DebugConfigureResult {
  readonly revision: number;
  readonly entries: readonly DebugBreakpointStatus[];
}

export interface DebugStop {
  readonly id: string;
  readonly reason: "hit" | "error";
  readonly hitCount: number;
  readonly error?: string;
}

export interface DebugLogEvent {
  readonly id: string;
  readonly hitCount: number;
  readonly text: string;
  readonly truncated: boolean;
}

export interface DebugBoundaryOutcome {
  /** True when this exact boundary sequence was already reported once. */
  readonly repeat: boolean;
  readonly stops: readonly DebugStop[];
  readonly logs: readonly DebugLogEvent[];
}

type CapturedBuild = ReturnType<typeof captureProjectBuild>;

export interface DebugBreakpointPlan {
  /** Identity of the single captured build every binding was resolved against. */
  readonly identity: CapturedBuild["identity"];
  /** The currently published configuration revision. */
  readonly revision: number;
  /** Atomically validate and publish a full configuration replacement. */
  configure(config: DebugBreakpointConfig): DebugConfigureResult;
  /** Process one reported occurrence; never touches the engine. */
  atBoundary(boundary: ExecutionBoundary, snapshot: DebugSnapshot): DebugBoundaryOutcome;
  /** A frozen snapshot of the live configuration and run counters. */
  status(): readonly DebugBreakpointStatus[];
}

interface NormalHit {
  readonly kind: DebugHitPolicy["kind"];
  readonly count: number;
}

interface NormalSegment {
  readonly type: DebugLogSegment["type"];
  readonly text: string;
  readonly compiled: CompiledDebugExpression | null;
}

interface NormalSpec {
  readonly id: string;
  readonly enabled: boolean;
  readonly logic: number;
  readonly line: number;
  readonly column: number | null;
  readonly mode: "statement" | "predicate";
  readonly condition: string | null;
  readonly compiledCondition: CompiledDebugExpression | null;
  readonly hit: NormalHit | null;
  readonly log: readonly NormalSegment[] | null;
  /** Canonical identity used to preserve run state across republication. */
  readonly signature: string;
}

interface RuntimeEntry {
  readonly spec: NormalSpec;
  readonly binding: DebugBinding;
  hits: number;
  fault: string | null;
}

function fail(message: string): never {
  throw new DebugBreakpointError(message);
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

function compileCondition(source: unknown, bindings: DebugBindings): CompiledDebugExpression {
  if (typeof source !== "string" || source.length === 0) {
    fail("breakpoint condition must be a non-empty string");
  }
  try {
    const compiled = compileDebugExpression(source, bindings);
    if (compiled.type !== "boolean") {
      fail("breakpoint condition must evaluate to boolean");
    }
    return compiled;
  } catch (error) {
    if (error instanceof DebugBreakpointError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid breakpoint condition: ${detail}`);
  }
}

function compileLogExpression(source: unknown, bindings: DebugBindings): CompiledDebugExpression {
  if (typeof source !== "string" || source.length === 0) {
    fail("log expression must be a non-empty string");
  }
  if (source.length > DEBUG_BREAKPOINT_LIMITS.logExpression) {
    fail(`log expression exceeds ${DEBUG_BREAKPOINT_LIMITS.logExpression} characters`);
  }
  try {
    return compileDebugExpression(source, bindings);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`invalid log expression: ${detail}`);
  }
}

function normalizeSegment(raw: unknown, bindings: DebugBindings): NormalSegment {
  if (!isObject(raw)) fail("log segments must be objects");
  if (raw["type"] === "literal") {
    const text = raw["text"];
    if (typeof text !== "string") fail("literal log segment needs a string text");
    if (text.length > DEBUG_BREAKPOINT_LIMITS.logLiteral) {
      fail(`literal log segment exceeds ${DEBUG_BREAKPOINT_LIMITS.logLiteral} characters`);
    }
    return { type: "literal", text, compiled: null };
  }
  if (raw["type"] === "expression") {
    const source = raw["source"];
    const compiled = compileLogExpression(source, bindings);
    return { type: "expression", text: String(source), compiled };
  }
  fail('log segment type must be "literal" or "expression"');
}

/** Validate one entry completely; runs before any publication so a bad entry discards the whole update. */
function normalizeSpec(raw: unknown, bindings: DebugBindings): NormalSpec {
  if (!isObject(raw)) fail("breakpoint entries must be objects");
  const id = raw["id"];
  if (typeof id !== "string" || id.length === 0 || id.length > DEBUG_BREAKPOINT_LIMITS.idLength) {
    fail(`breakpoint id must be a string of 1..${DEBUG_BREAKPOINT_LIMITS.idLength} characters`);
  }
  const enabled = raw["enabled"];
  if (typeof enabled !== "boolean") fail(`breakpoint ${id}: enabled must be boolean`);
  const logic = requireInt(raw["logic"], `breakpoint ${id}: logic`, 0, 255);
  const line = requireInt(raw["line"], `breakpoint ${id}: line`, 1, Number.MAX_SAFE_INTEGER);
  let column: number | null = null;
  if (raw["column"] !== undefined) {
    column = requireInt(raw["column"], `breakpoint ${id}: column`, 1, Number.MAX_SAFE_INTEGER);
  }
  const mode = raw["mode"];
  if (mode !== "statement" && mode !== "predicate") {
    fail(`breakpoint ${id}: mode must be "statement" or "predicate"`);
  }
  let condition: string | null = null;
  let compiledCondition: CompiledDebugExpression | null = null;
  if (raw["condition"] !== undefined) {
    condition = String(raw["condition"]);
    compiledCondition = compileCondition(raw["condition"], bindings);
  }
  let hit: NormalHit | null = null;
  if (raw["hit"] !== undefined) {
    const rawHit = raw["hit"];
    if (!isObject(rawHit)) fail(`breakpoint ${id}: hit policy must be an object`);
    const kind = rawHit["kind"];
    if (kind !== "equal" && kind !== "atLeast" && kind !== "every") {
      fail(`breakpoint ${id}: hit policy kind must be equal, atLeast or every`);
    }
    const count = requireInt(
      rawHit["count"],
      `breakpoint ${id}: hit count`,
      1,
      DEBUG_BREAKPOINT_LIMITS.hitCount,
    );
    hit = { kind, count };
  }
  let log: readonly NormalSegment[] | null = null;
  if (raw["log"] !== undefined) {
    const rawLog = raw["log"];
    if (!isObject(rawLog) || !Array.isArray(rawLog["segments"])) {
      fail(`breakpoint ${id}: log needs a segments array`);
    }
    const segments = rawLog["segments"] as readonly unknown[];
    if (segments.length === 0 || segments.length > DEBUG_BREAKPOINT_LIMITS.logSegments) {
      fail(`breakpoint ${id}: log needs 1..${DEBUG_BREAKPOINT_LIMITS.logSegments} segments`);
    }
    log = segments.map((segment) => normalizeSegment(segment, bindings));
  }
  const signature = JSON.stringify([
    enabled,
    logic,
    line,
    column,
    mode,
    condition,
    hit ? [hit.kind, hit.count] : null,
    log ? log.map((segment) => [segment.type, segment.text]) : null,
  ]);
  return {
    id,
    enabled,
    logic,
    line,
    column,
    mode,
    condition,
    compiledCondition,
    hit,
    log,
    signature,
  };
}

/** Start offset of every authored line plus a sentinel at the end. */
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

const STATEMENT_KINDS = new Set(["action", "return", "goto", "if"]);

/** Resolve a configured location against this exact build's verified map. Never slides. */
function bind(build: CapturedBuild, spec: NormalSpec): DebugBinding {
  const logic = build.logics.find((entry) => entry.num === spec.logic);
  if (!logic) return { bound: false, reason: "unknown-logic" };
  if (logic.authored === undefined) return { bound: false, reason: "no-source" };
  if (logic.sourceMap === undefined || logic.authoredStart === undefined) {
    return { bound: false, reason: "no-source-map" };
  }
  const starts = lineStarts(logic.authored);
  if (spec.line > starts.length) return { bound: false, reason: "line-out-of-range" };
  const lineStart = starts[spec.line - 1]!;
  let lineEnd = spec.line < starts.length ? starts[spec.line]! : logic.authored.length;
  // The terminator is not part of the line: a CRLF costs no editor columns.
  if (lineEnd > lineStart && logic.authored.charCodeAt(lineEnd - 1) === 0x0a) lineEnd--;
  if (lineEnd > lineStart && logic.authored.charCodeAt(lineEnd - 1) === 0x0d) lineEnd--;
  const wanted = spec.mode === "predicate" ? "predicate" : null;
  const candidates: { entry: LogicSourceEntry; start: number; end: number }[] = [];
  for (const entry of logic.sourceMap.entries) {
    const allowed = wanted ? entry.kind === wanted : STATEMENT_KINDS.has(entry.kind);
    if (!allowed) continue;
    const start = entry.start - logic.authoredStart;
    const end = entry.end - logic.authoredStart;
    if (start >= lineStart && start < lineEnd) candidates.push({ entry, start, end });
  }
  if (candidates.length === 0) return { bound: false, reason: "non-executable-line" };
  const pos = spec.column !== null ? lineStart + spec.column - 1 : lineStart;
  // A column past the line's own end cannot reach a statement merely
  // spanning this line from an earlier one.
  if (pos >= lineEnd) return { bound: false, reason: "no-statement-at-position" };
  // A position inside several spans takes the innermost (latest-starting) one.
  let chosen = candidates
    .filter((candidate) => candidate.start <= pos && pos < candidate.end)
    .sort((a, b) => b.start - a.start)[0];
  if (!chosen) {
    const nextStart = Math.min(
      ...candidates
        .filter((candidate) => candidate.start > pos)
        .map((candidate) => candidate.start),
    );
    chosen = candidates
      .filter((candidate) => candidate.start === nextStart)
      .sort((a, b) => a.entry.statementId - b.entry.statementId)[0];
  }
  if (!chosen) return { bound: false, reason: "no-statement-at-position" };
  // Lowering may emit one source span several times; keep every distinct PC.
  const group = candidates.filter(
    (candidate) =>
      candidate.entry.kind === chosen!.entry.kind &&
      candidate.start === chosen!.start &&
      candidate.end === chosen!.end,
  );
  const locations = group
    .map((candidate) =>
      Object.freeze({
        kind: candidate.entry.kind as DebugBoundKind,
        pc: candidate.entry.pc,
        endPc: candidate.entry.endPc,
      }),
    )
    .sort((a, b) => a.pc - b.pc);
  const { line, column } = lineColumnAt(starts, chosen.start);
  return {
    bound: true,
    logic: spec.logic,
    line,
    column,
    kind: chosen.entry.kind as DebugBoundKind,
    statementId: chosen.entry.statementId,
    pcs: Object.freeze([...new Set(locations.map((location) => location.pc))]),
    locations: Object.freeze(locations),
  };
}

function hitPasses(policy: NormalHit | null, hits: number): boolean {
  if (!policy) return true;
  if (policy.kind === "equal") return hits === policy.count;
  if (policy.kind === "atLeast") return hits >= policy.count;
  return hits % policy.count === 0;
}

function renderValue(value: DebugValue): string {
  return typeof value === "string" ? value : String(value);
}

function freezeOutcome(outcome: {
  repeat: boolean;
  stops: DebugStop[];
  logs: DebugLogEvent[];
}): DebugBoundaryOutcome {
  for (const stop of outcome.stops) Object.freeze(stop);
  for (const log of outcome.logs) Object.freeze(log);
  return Object.freeze({
    repeat: outcome.repeat,
    stops: Object.freeze(outcome.stops),
    logs: Object.freeze(outcome.logs),
  });
}

const REPEAT_OUTCOME: DebugBoundaryOutcome = freezeOutcome({ repeat: true, stops: [], logs: [] });

/**
 * One run's breakpoint plan over a single captured build. Pure and detached:
 * it never touches an Engine, mutates state only internally, and hands every
 * result out frozen. A new run creates a new plan, which resets counters.
 */
export function createDebugBreakpointPlan(input: {
  readonly build: CapturedBuild;
  readonly bindings?: DebugBindings;
}): DebugBreakpointPlan {
  const build = input.build;
  // Deep-copy the named bindings so later caller edits cannot rewrite this run.
  const bindings: DebugBindings = Object.fromEntries(
    Object.entries(input.bindings ?? {}).map(([name, binding]) => [
      name,
      { kind: binding.kind, num: binding.num },
    ]),
  );
  const identity = Object.freeze({ ...build.identity });
  let revision = 0;
  let entries: RuntimeEntry[] = [];
  // Sequence 0 is never a real boundary; equal sequences are the same occurrence.
  let lastSequence = 0;

  function publicSpec(spec: NormalSpec): DebugBreakpointSpec {
    const out: {
      id: string;
      enabled: boolean;
      logic: number;
      line: number;
      mode: "statement" | "predicate";
      column?: number;
      condition?: string;
      hit?: DebugHitPolicy;
      log?: DebugLogpoint;
    } = {
      id: spec.id,
      enabled: spec.enabled,
      logic: spec.logic,
      line: spec.line,
      mode: spec.mode,
    };
    if (spec.column !== null) out.column = spec.column;
    if (spec.condition !== null) out.condition = spec.condition;
    if (spec.hit) out.hit = Object.freeze({ kind: spec.hit.kind, count: spec.hit.count });
    if (spec.log) {
      out.log = Object.freeze({
        segments: Object.freeze(
          spec.log.map((segment) =>
            Object.freeze(
              segment.type === "literal"
                ? { type: "literal" as const, text: segment.text }
                : { type: "expression" as const, source: segment.text },
            ),
          ),
        ),
      });
    }
    return Object.freeze(out);
  }

  function statusEntries(): readonly DebugBreakpointStatus[] {
    return Object.freeze(
      entries.map((entry) =>
        Object.freeze({
          id: entry.spec.id,
          spec: publicSpec(entry.spec),
          binding: entry.binding,
          hits: entry.hits,
          fault: entry.fault,
        }),
      ),
    );
  }

  function configure(config: DebugBreakpointConfig): DebugConfigureResult {
    if (!isObject(config)) fail("configuration must be an object");
    const nextRevision = config["revision"];
    if (
      typeof nextRevision !== "number" ||
      !Number.isSafeInteger(nextRevision) ||
      nextRevision <= revision
    ) {
      fail(`configuration revision must be a safe integer greater than ${revision}`);
    }
    const list = config["breakpoints"];
    if (!Array.isArray(list)) fail("configuration breakpoints must be an array");
    if (list.length > DEBUG_BREAKPOINT_LIMITS.breakpoints) {
      fail(`configuration exceeds ${DEBUG_BREAKPOINT_LIMITS.breakpoints} breakpoints`);
    }
    // Validate the entire replacement before publishing anything.
    const specs = (list as readonly unknown[]).map((spec) => normalizeSpec(spec, bindings));
    const ids = new Set<string>();
    for (const spec of specs) {
      if (ids.has(spec.id)) fail(`duplicate breakpoint id '${spec.id}'`);
      ids.add(spec.id);
    }
    const previous = new Map(entries.map((entry) => [entry.spec.id, entry]));
    entries = specs.map((spec) => {
      const prior = previous.get(spec.id);
      const kept = prior && prior.spec.signature === spec.signature ? prior : null;
      return {
        spec,
        binding: Object.freeze(bind(build, spec)),
        hits: kept ? kept.hits : 0,
        fault: kept ? kept.fault : null,
      };
    });
    revision = nextRevision;
    return Object.freeze({ revision, entries: statusEntries() });
  }

  function atBoundary(boundary: ExecutionBoundary, snapshot: DebugSnapshot): DebugBoundaryOutcome {
    if (!isObject(boundary)) fail("boundary must be an object");
    if (!Number.isSafeInteger(boundary.sequence) || boundary.sequence < 1) {
      fail("boundary sequence must be a positive safe integer");
    }
    if (boundary.sequence === lastSequence) return REPEAT_OUTCOME;
    if (boundary.sequence < lastSequence) {
      fail(`stale boundary sequence ${boundary.sequence}; last processed is ${lastSequence}`);
    }
    lastSequence = boundary.sequence;
    const stops: DebugStop[] = [];
    const logs: DebugLogEvent[] = [];
    for (const entry of entries) {
      if (!entry.spec.enabled || entry.fault !== null || !entry.binding.bound) continue;
      const binding = entry.binding;
      if (
        binding.logic !== boundary.logic ||
        binding.kind !== boundary.kind ||
        !binding.pcs.includes(boundary.pc)
      ) {
        continue;
      }
      // An encounter counts before any policy or condition decision.
      entry.hits += 1;
      if (!hitPasses(entry.spec.hit, entry.hits)) continue;
      if (entry.spec.compiledCondition) {
        let passes: boolean;
        try {
          passes = entry.spec.compiledCondition.evaluate(snapshot) === true;
        } catch (error) {
          const message = error instanceof DebugExpressionError ? error.message : String(error);
          entry.fault = message;
          stops.push({ id: entry.spec.id, reason: "error", hitCount: entry.hits, error: message });
          continue;
        }
        if (!passes) continue;
      }
      if (entry.spec.log) {
        let text = "";
        try {
          for (const segment of entry.spec.log) {
            text += segment.compiled
              ? renderValue(segment.compiled.evaluate(snapshot))
              : segment.text;
          }
        } catch (error) {
          const message = error instanceof DebugExpressionError ? error.message : String(error);
          entry.fault = message;
          stops.push({ id: entry.spec.id, reason: "error", hitCount: entry.hits, error: message });
          continue;
        }
        const truncated = text.length > DEBUG_BREAKPOINT_LIMITS.logOutput;
        logs.push({
          id: entry.spec.id,
          hitCount: entry.hits,
          text: truncated ? text.slice(0, DEBUG_BREAKPOINT_LIMITS.logOutput) : text,
          truncated,
        });
      } else {
        stops.push({ id: entry.spec.id, reason: "hit", hitCount: entry.hits });
      }
    }
    return freezeOutcome({ repeat: false, stops, logs });
  }

  return Object.freeze({
    identity,
    get revision() {
      return revision;
    },
    configure,
    atBoundary,
    status: statusEntries,
  });
}
