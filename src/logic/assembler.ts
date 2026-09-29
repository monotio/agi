/**
 * AGI logic assembler: source text -> real logic resource bytecode.
 *
 * This is the primary tool the authoring agent uses. Errors are precise
 * (line:col) because they feed the agent's retry loop.
 *
 * Source syntax (classic AGI flavor, tightened):
 *
 *   #message 1 "You are standing in a clearing."
 *   #define  fDoorOpen 42
 *
 *   start:
 *   if (isset(f5) && !isset(fDoorOpen)) {
 *     print(1);
 *     print("inline text auto-allocated as a message");
 *     goto done;
 *   } else {
 *     if (said("open", "door") || said("unlock", "door")) {
 *       set(fDoorOpen);
 *     }
 *   }
 *   done:
 *   return;
 *
 * Tests support !, &&, || and parentheses. Any boolean shape is accepted:
 * the compiler normalizes to CNF (AND of OR-clauses), which is what the AGI
 * condition-list bytecode encodes (0xfc OR-groups, 0xfd NOT per predicate).
 *
 * ONE-TERM OR GROUPS. Parentheses around a *single* literal are not redundant:
 * they ask for the 0xfc markers around that one predicate, which real Sierra
 * logics contain and which must survive a disassemble/re-assemble round trip.
 * So `if ((isset(f1)))` emits `ff fc 07 01 fc ff`, while `if (isset(f1))`
 * emits `ff 07 01 ff`. The rule is narrow on purpose: it applies only when the
 * parenthesized expression is one condition (optionally negated) and that
 * group survives normalization as a whole conjunct. Parentheses around
 * anything longer keep their ordinary grouping meaning, and a group that ends
 * up merged into a longer OR clause simply unwraps — the markers the clause
 * already needs are the same ones.
 *
 * LABELS may appear at any nesting depth, including inside an if/else block,
 * and `goto` reaches any of them; a label emits no bytes, it only names the
 * byte offset it sits at. Label names are one flat namespace per logic, so
 * duplicates are an error wherever they are.
 *
 * MESSAGE TEXT is a byte string, one source character per byte. The lexer
 * understands the C escapes \n, \r, \\ and \" plus \xNN for any other byte;
 * a raw newline inside a literal is still an error. `#message N "text"`
 * defines message N; `#message N` with no text declares slot N ABSENT (a zero
 * offset in the table), which is distinct from `#message N ""`, an empty but
 * present message that still costs a terminator byte.
 *
 * said() words resolve through the caller-supplied dictionary (word -> id).
 * "*" is the any-one-word wildcard (id 1), "..." the rest-of-line terminator
 * (id 0x270f). AGI Studio's spellings of the two, "anyword" and "rol", are
 * accepted as well unless the game's own dictionary defines those words.
 *
 * Variable/flag/object/message/string refs accept v5 / f5 / o5 / m5 / s5
 * tokens or plain numbers. Immediate operands are plain numbers or #defines.
 */

import {
  actionSpec,
  CONDITION_BY_NAME,
  GOTO,
  IF,
  NOT,
  OR,
  RETURN,
  SAID_ANY_WORD,
  SAID_REST,
} from "./opcodes.ts";
import { buildLogicResource } from "./resource.ts";
import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";
import {
  AssemblerError,
  MAX_DEPTH,
  parseLogicSyntax,
  type Ref,
  type Stmt,
  type TestExpr,
  type Token,
} from "./syntax.ts";

export { AssemblerError };

export interface LogicSourceEntry {
  readonly emissionId: number;
  readonly statementId: number;
  readonly kind: "action" | "return" | "goto" | "if" | "predicate" | "generated-jump";
  /** Half-open offsets into the exact input source, in UTF-16 code units. */
  readonly start: number;
  readonly end: number;
  /** Half-open byte offsets into code, excluding resource/message framing. */
  readonly pc: number;
  readonly endPc: number;
}

export interface LogicSourceMap {
  readonly version: 1;
  /** Exact compiler input, including any caller-supplied prelude. */
  readonly source: string;
  readonly profileId: string;
  readonly codeLength: number;
  readonly entries: readonly LogicSourceEntry[];
}

export interface AssembleDiagnostic {
  readonly code: "condition-effects";
  readonly message: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly col: number;
}

// Application work ceilings, not interpreter format limits. Bound both parsing
// and strict lowering before allocating expanded condition trees.
const MAX_LOWERING_WORK = 100_000;
const MAX_CLAUSE_UNITS = 16_384;

export interface AssembleOptions {
  /** Capture origins for this exact input; never implicitly bind to a live run. */
  readonly sourceMap?: boolean;
  /** Instruction vocabulary and widths; defaults to AGI 2.936. */
  readonly profile?: AgiProfile;
  /** Lowercase word -> dictionary id, for said() resolution. */
  readonly dictionary: ReadonlyMap<string, number>;
}

export interface AssembleResult {
  /** Complete logic resource payload (framing + encrypted messages). */
  readonly payload: Uint8Array;
  /** Just the bytecode section. */
  readonly code: Uint8Array;
  /** 1-based message table (index 0 unused placeholder; `null` = absent slot). */
  readonly messages: readonly (string | null)[];
  readonly diagnostics: readonly AssembleDiagnostic[];
  readonly sourceMap?: LogicSourceMap;
}

// ---------- Test normalization to CNF ----------

class LoweringBudget {
  private remaining = MAX_LOWERING_WORK;
  private tok: Token;

  constructor(tok: Token) {
    this.tok = tok;
  }

  locate(tok: Token): void {
    this.tok = tok;
  }

  charge(units = 1, depth = 0): void {
    if (depth > MAX_DEPTH || units > this.remaining) {
      throw new AssemblerError(
        "condition lowering work limit exceeded",
        this.tok.line,
        this.tok.col,
      );
    }
    this.remaining -= units;
  }
}

function nnf(t: TestExpr, negate: boolean, budget: LoweringBudget, depth = 0): TestExpr {
  budget.charge(1, depth);
  switch (t.type) {
    case "cond":
      return negate ? { type: "not", inner: t } : t;
    case "not":
      return nnf(t.inner, !negate, budget, depth + 1);
    case "and":
      return negate
        ? { type: "or", parts: t.parts.map((p) => nnf(p, true, budget, depth + 1)) }
        : { type: "and", parts: t.parts.map((p) => nnf(p, false, budget, depth + 1)) };
    case "or":
      return negate
        ? { type: "and", parts: t.parts.map((p) => nnf(p, true, budget, depth + 1)) }
        : { type: "or", parts: t.parts.map((p) => nnf(p, false, budget, depth + 1)) };
    case "group":
      // A group only ever wraps a literal, so negation stays inside it.
      return { type: "group", inner: nnf(t.inner, negate, budget, depth + 1) };
  }
}

/** Distribute OR over AND until the root is an AND of clauses of ORs of literals. */
function distribute(t: TestExpr, budget: LoweringBudget, depth = 0): TestExpr {
  budget.charge(1, depth);
  if (t.type !== "or") {
    if (t.type === "and")
      return { type: "and", parts: t.parts.map((part) => distribute(part, budget, depth + 1)) };
    return t;
  }
  const parts = t.parts.map((part) => distribute(part, budget, depth + 1));
  const andIdx = parts.findIndex((p) => p.type === "and");
  if (andIdx === -1) return { type: "or", parts };
  const andPart = parts[andIdx] as { type: "and"; parts: TestExpr[] };
  const rest = parts.filter((_, i) => i !== andIdx);
  // (A && B) || rest  =>  (A || rest) && (B || rest)
  budget.charge(andPart.parts.length * (rest.length + 1), depth);
  return distribute(
    {
      type: "and",
      parts: andPart.parts.map((p) => ({ type: "or", parts: [p, ...rest] })),
    },
    budget,
    depth + 1,
  );
}

interface Literal {
  readonly cond: Extract<TestExpr, { type: "cond" }>;
  readonly negated: boolean;
}

/** One CNF conjunct. `group` asks for the 0xfc markers around its literals. */
interface Clause {
  readonly lits: Literal[];
  readonly group: boolean;
}

function literalOf(expr: TestExpr): Literal {
  if (expr.type === "group") return literalOf(expr.inner);
  if (expr.type === "not" && expr.inner.type === "cond") {
    return { cond: expr.inner, negated: true };
  }
  if (expr.type === "cond") return { cond: expr, negated: false };
  throw new AssemblerError("internal: non-literal in CNF clause", 0, 0);
}

function toClauses(test: TestExpr, tok: Token, budget: LoweringBudget): Clause[] {
  budget.locate(tok);
  const normalized = distribute(nnf(test, false, budget), budget);
  const clauses: Clause[] = [];
  let units = 0;
  const append = (part: TestExpr): void => {
    budget.charge();
    if (part.type === "and") {
      for (const child of part.parts) append(child);
      return;
    }
    const lits: Literal[] = [];
    const collect = (expr: TestExpr): void => {
      budget.charge();
      if (expr.type === "or") {
        for (const child of expr.parts) collect(child);
      } else {
        if (++units > MAX_CLAUSE_UNITS) {
          throw new AssemblerError("condition clause/literal limit exceeded", tok.line, tok.col);
        }
        lits.push(literalOf(expr));
      }
    };
    collect(part);
    if (++units > MAX_CLAUSE_UNITS) {
      throw new AssemblerError("condition clause/literal limit exceeded", tok.line, tok.col);
    }
    clauses.push({ lits, group: part.type === "group" || lits.length > 1 });
  };
  append(normalized);
  return clauses;
}

// ---------- Emitter ----------

class Emitter {
  private buf: number[] = [];
  readonly entries: LogicSourceEntry[] = [];
  readonly diagnostics: AssembleDiagnostic[] = [];
  readonly lowering: LoweringBudget;
  private readonly mapping: boolean;
  private location: Token;

  constructor(mapping: boolean, location: Token) {
    this.mapping = mapping;
    this.location = location;
    this.lowering = new LoweringBudget(location);
  }

  locate(tok: Token): void {
    this.location = tok;
  }

  record(
    kind: LogicSourceEntry["kind"],
    stmt: Stmt,
    pc: number,
    endPc: number,
    origin: { tok: Token; end?: number } = stmt,
  ): void {
    if (!this.mapping) return;
    this.entries.push({
      emissionId: this.entries.length,
      statementId: stmt.statementId,
      kind,
      start: origin.tok.start,
      end: origin.end ?? origin.tok.end,
      pc,
      endPc,
    });
  }

  checkCapacity(count: number): void {
    // Even a LOGIC without messages needs five framing bytes in its u16 record.
    if (this.buf.length + count > 65530) {
      throw new AssemblerError(
        "logic code length limit exceeded",
        this.location.line,
        this.location.col,
      );
    }
  }
  private readonly fixups: { at: number; label: string; tok: Token }[] = [];
  readonly labelPos = new Map<string, number>();

  get position(): number {
    return this.buf.length;
  }

  byte(b: number): void {
    this.checkCapacity(1);
    this.buf.push(b & 0xff);
  }

  /** Signed 16-bit little-endian displacement; patched later or written now. */
  s16(value: number): void {
    if (value < -32768 || value > 32767) {
      throw new AssemblerError(
        "jump displacement out of s16 range (logic too large)",
        this.location.line,
        this.location.col,
      );
    }
    this.checkCapacity(2);
    this.buf.push(value & 0xff, (value >> 8) & 0xff);
  }

  patchS16(at: number, value: number): void {
    if (value < -32768 || value > 32767) {
      throw new AssemblerError(
        "jump displacement out of s16 range (logic too large)",
        this.location.line,
        this.location.col,
      );
    }
    this.buf[at] = value & 0xff;
    this.buf[at + 1] = (value >> 8) & 0xff;
  }

  markLabel(name: string): void {
    this.labelPos.set(name, this.position);
  }

  emitGoto(label: string, tok: Token): void {
    this.byte(GOTO);
    this.fixups.push({ at: this.position, label, tok });
    this.s16(0);
  }

  resolveFixups(): void {
    for (const f of this.fixups) {
      const target = this.labelPos.get(f.label);
      if (target === undefined) {
        throw new AssemblerError(`goto of undefined label '${f.label}'`, f.tok.line, f.tok.col);
      }
      // Delta is relative to the position immediately after the 2 delta bytes.
      this.patchS16(f.at, target - (f.at + 2));
    }
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

// ---------- Condition/action validation & emission ----------

function refByte(ref: Ref, allowString: false, tok: Token, what: string): number {
  if (ref.kind === "str") {
    throw new AssemblerError(`string not allowed as ${what} operand`, tok.line, tok.col);
  }
  if (ref.kind === "num" && ref.value > 255) {
    const at = ref.tok ?? tok;
    throw new AssemblerError(`byte value out of range 0..255 in ${what}`, at.line, at.col);
  }
  return ref.kind === "num" ? ref.value : ref.index;
}

function emitCondition(
  e: Emitter,
  lit: Literal,
  dictionary: ReadonlyMap<string, number>,
  profile: AgiProfile,
): void {
  const spec = CONDITION_BY_NAME[lit.cond.name];
  if (!spec) {
    throw new AssemblerError(
      `unknown condition '${lit.cond.name}' (known: ${[...Object.keys(CONDITION_BY_NAME)].join(", ")})`,
      lit.cond.tok.line,
      lit.cond.tok.col,
    );
  }
  // The IIgs evaluator admits 0x13, but the slot overruns its handler table
  // (docs/fidelity.md "Apple IIgs interpreter"): no condition exists there.
  if (
    spec.code > profile.maxCondition ||
    (spec.code === 0x13 && profile.condition0x13 === "wild-dispatch")
  ) {
    throw new AssemblerError(
      `condition '${spec.name}' is not available in profile ${profile.id}`,
      lit.cond.tok.line,
      lit.cond.tok.col,
    );
  }
  if (spec.name === "said") {
    if (lit.cond.args.length > 255) {
      throw new AssemblerError(
        "said() supports at most 255 words",
        lit.cond.tok.line,
        lit.cond.tok.col,
      );
    }
    if (lit.cond.args.length === 0) {
      throw new AssemblerError(
        "said() needs at least one word",
        lit.cond.tok.line,
        lit.cond.tok.col,
      );
    }
    if (lit.negated) e.byte(NOT);
    e.byte(spec.code);
    e.byte(lit.cond.args.length);
    for (const arg of lit.cond.args) {
      let id: number;
      if (arg.kind === "str") {
        const w = arg.text.toLowerCase();
        const found = dictionary.get(w);
        if (w === "*" || (w === "anyword" && found === undefined)) id = SAID_ANY_WORD;
        else if (w === "..." || (w === "rol" && found === undefined)) id = SAID_REST;
        else {
          if (found === undefined) {
            throw new AssemblerError(
              `word '${arg.text}' is not in the dictionary`,
              lit.cond.tok.line,
              lit.cond.tok.col,
            );
          }
          id = found;
        }
      } else {
        id = arg.kind === "num" ? arg.value : arg.index;
      }
      if (!Number.isInteger(id) || id < 0 || id > 65535) {
        throw new AssemblerError(
          "said dictionary id must be 0..65535",
          lit.cond.tok.line,
          lit.cond.tok.col,
        );
      }
      e.byte(id & 0xff);
      e.byte((id >> 8) & 0xff);
    }
    return;
  }
  if (lit.cond.args.length !== spec.operands.length) {
    throw new AssemblerError(
      `condition '${spec.name}' takes ${spec.operands.length} operand(s), got ${lit.cond.args.length}`,
      lit.cond.tok.line,
      lit.cond.tok.col,
    );
  }
  if (lit.negated) e.byte(NOT);
  e.byte(spec.code);
  for (const arg of lit.cond.args) {
    e.byte(refByte(arg, false, lit.cond.tok, `condition '${spec.name}'`));
  }
}

function emitTest(
  e: Emitter,
  stmt: Extract<Stmt, { type: "if" }>,
  dictionary: ReadonlyMap<string, number>,
  profile: AgiProfile,
): void {
  const clauses = toClauses(stmt.test, stmt.tok, e.lowering);
  const literals = clauses.flatMap((clause) => clause.lits);
  const minimumAfter: number[] = [];
  let minimum = Infinity;
  for (let i = literals.length - 1; i >= 0; i--) {
    minimumAfter[i] = minimum;
    minimum = Math.min(minimum, literals[i]!.cond.tok.start);
  }
  const counts = new Map<number, number>();
  for (const { cond } of literals)
    counts.set(cond.tok.start, (counts.get(cond.tok.start) ?? 0) + 1);
  const warned = new Set<number>();
  let maximumBefore = -1;
  for (let i = 0; i < literals.length; i++) {
    const { cond } = literals[i]!;
    const at = cond.tok.start;
    if (
      (cond.name === "said" || cond.name === "have.key") &&
      ((counts.get(at) ?? 0) > 1 || maximumBefore > at || minimumAfter[i]! < at) &&
      !warned.has(at) &&
      e.diagnostics.length < 200
    ) {
      warned.add(at);
      e.diagnostics.push({
        code: "condition-effects",
        start: at,
        end: cond.end ?? cond.tok.end,
        line: cond.tok.line,
        col: cond.tok.col,
        message:
          "Condition lowering repeats or reorders this stateful test; emitted AGI order is preserved.",
      });
    }
    maximumBefore = Math.max(maximumBefore, at);
  }
  e.byte(IF);
  for (const clause of clauses) {
    if (clause.group) e.byte(OR);
    for (const lit of clause.lits) {
      const pc = e.position;
      e.locate(lit.cond.tok);
      emitCondition(e, lit, dictionary, profile);
      e.record("predicate", stmt, pc, e.position, lit.cond);
    }
    if (clause.group) e.byte(OR);
  }
  e.locate(stmt.tok);
  e.byte(IF);
}

// ---------- Messages ----------

class MessageTable {
  private readonly byNumber = new Map<number, string | null>();
  private readonly inlineNumbers = new Map<string, number>();
  private nextInline: number;

  constructor(explicit: Map<number, string | null>) {
    for (const [n, text] of explicit) this.byNumber.set(n, text);
    this.nextInline = explicit.size === 0 ? 1 : Math.max(...explicit.keys()) + 1;
  }

  /** Message number for an inline string literal; identical text dedupes. */
  intern(text: string, tok: Token): number {
    const existing = this.inlineNumbers.get(text);
    if (existing !== undefined) return existing;
    for (const [n, t] of this.byNumber) if (t === text) return n;
    if (this.nextInline > 255) {
      throw new AssemblerError("message table full (255 messages)", tok.line, tok.col);
    }
    const n = this.nextInline++;
    this.byNumber.set(n, text);
    this.inlineNumbers.set(text, n);
    return n;
  }

  resolve(ref: Ref, tok: Token): number {
    if (ref.kind === "str") return this.intern(ref.text, tok);
    const n = ref.kind === "num" ? ref.value : ref.index;
    if (n === 0)
      throw new AssemblerError("message numbers are 1-based (m0 invalid)", tok.line, tok.col);
    if (n > 255) throw new AssemblerError("byte value out of range 0..255", tok.line, tok.col);
    return n;
  }

  /**
   * 1-based array; index 0 is an unused placeholder. A number no directive or
   * inline string claimed is `null`: an absent slot, not an empty message.
   */
  finalize(): readonly (string | null)[] {
    const max = this.byNumber.size === 0 ? 0 : Math.max(...this.byNumber.keys());
    const out: (string | null)[] = [""];
    for (let n = 1; n <= max; n++) out.push(this.byNumber.get(n) ?? null);
    return out;
  }
}

// ---------- Statement emission ----------

function emitStmt(
  e: Emitter,
  stmt: Stmt,
  messages: MessageTable,
  dictionary: ReadonlyMap<string, number>,
  profile: AgiProfile,
): void {
  e.locate(stmt.tok);
  const pc = e.position;
  switch (stmt.type) {
    case "return":
      e.byte(RETURN);
      e.record("return", stmt, pc, e.position);
      return;
    case "label":
      // Emits nothing; it just names the current byte offset for goto.
      e.markLabel(stmt.name);
      return;
    case "goto":
      e.emitGoto(stmt.label, stmt.tok);
      e.record("goto", stmt, pc, e.position);
      return;
    case "if": {
      emitTest(e, stmt, dictionary, profile);
      const falseDeltaAt = e.position;
      e.s16(0);
      e.record("if", stmt, pc, e.position);
      for (const s of stmt.then) emitStmt(e, s, messages, dictionary, profile);
      if (stmt.else_ !== null) {
        const endGotoFixup = e.position;
        e.locate(stmt.tok);
        e.byte(GOTO);
        e.s16(0);
        e.record("generated-jump", stmt, endGotoFixup, e.position);
        // False path: skip the 2-byte goto+delta... i.e. land after the goto's delta.
        e.patchS16(falseDeltaAt, e.position - (falseDeltaAt + 2));
        for (const s of stmt.else_) emitStmt(e, s, messages, dictionary, profile);
        e.patchS16(endGotoFixup + 1, e.position - (endGotoFixup + 3));
      } else {
        e.patchS16(falseDeltaAt, e.position - (falseDeltaAt + 2));
      }
      return;
    }
    case "action": {
      const spec = actionSpec(stmt.name, profile);
      if (!spec) {
        throw new AssemblerError(
          `unknown action '${stmt.name}' or action not available in profile ${profile.id} (check spelling and the selected profile)`,
          stmt.tok.line,
          stmt.tok.col,
        );
      }
      if (stmt.args.length !== spec.operands.length) {
        throw new AssemblerError(
          `action '${spec.name}' takes ${spec.operands.length} operand(s), got ${stmt.args.length}`,
          stmt.tok.line,
          stmt.tok.col,
        );
      }
      e.byte(spec.code);
      spec.operands.forEach((kind, i) => {
        const arg = stmt.args[i]!;
        if (kind === "message") {
          e.byte(messages.resolve(arg, stmt.tok));
        } else {
          e.byte(refByte(arg, false, stmt.tok, `action '${spec.name}'`));
        }
      });
      e.record("action", stmt, pc, e.position);
      return;
    }
  }
}

// ---------- Public entry ----------

export function assembleLogic(source: string, opts: AssembleOptions): AssembleResult {
  const { tokens, program, explicitMessages } = parseLogicSyntax(source);

  const messages = new MessageTable(explicitMessages);
  const e = new Emitter(opts.sourceMap === true, tokens[0]!);
  for (const stmt of program)
    emitStmt(e, stmt, messages, opts.dictionary, opts.profile ?? DEFAULT_V2_PROFILE);
  e.resolveFixups();

  const code = e.bytes();
  const messageList = messages.finalize();
  // finalize() returns 1-based with placeholder at 0; resource builder wants 1..N.
  let payload: Uint8Array;
  try {
    payload = buildLogicResource(code, messageList.slice(1));
  } catch (error) {
    const at = tokens.find((token) => token.type === "string") ?? tokens[0]!;
    throw new AssemblerError(
      error instanceof Error ? error.message : String(error),
      at.line,
      at.col,
    );
  }
  const result: AssembleResult = {
    payload,
    code,
    messages: messageList,
    diagnostics: e.diagnostics,
  };
  if (!opts.sourceMap) return result;
  return {
    ...result,
    sourceMap: {
      version: 1,
      source,
      profileId: (opts.profile ?? DEFAULT_V2_PROFILE).id,
      codeLength: code.length,
      entries: e.entries
        .sort((a, b) => a.pc - b.pc)
        .map((entry, emissionId) => ({ ...entry, emissionId })),
    },
  };
}
