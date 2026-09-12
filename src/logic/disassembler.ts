/**
 * AGI logic disassembler: real logic resource bytecode -> assembler source.
 *
 * The contract is ROUND-TRIP BYTE IDENTITY: for any payload the engine can
 * run, `assembleLogic(disassembleLogic(payload), { dictionary })` must
 * reproduce the same bytecode. That is what makes the output safe to hand to
 * the authoring agent as the "current source" of an installed game's logic
 * before it patches one line and re-assembles.
 *
 * Because byte identity — not prettiness — is the contract, the reconstruction
 * only ever emits shapes the assembler compiles verbatim:
 *
 *  - condition lists are emitted in clause order as `a && b && (c || !d)`,
 *    which survives the assembler's CNF normalization unchanged (an AND of
 *    OR-clauses is already in CNF, so no distribution or De Morgan runs);
 *  - a conditional block becomes `if (...) { ... }` whose then-block spans
 *    exactly the bytes the false-displacement skips;
 *  - a trailing forward `goto` at the end of a then-block becomes `else`,
 *    because that is byte-for-byte what the assembler emits for else;
 *  - every other jump becomes an explicit `goto Lxxxx;` plus a label named
 *    after the target offset, emitted at whatever nesting depth that offset
 *    falls in (the assembler accepts labels inside blocks);
 *  - an OR group holding a single predicate keeps its parentheses, which is
 *    how the source asks for the 0xfc markers around one condition;
 *  - message text is escaped C-style (\n, \r, \\, \" and \xNN for every
 *    other non-printable or high byte), so any byte survives the round trip,
 *    and an absent (zero-offset) message slot is emitted as a bare
 *    `#message N` so the table keeps its exact shape.
 *
 * The one `else` the reconstruction guesses rather than reads is dropped when
 * some jump lands on the very goto that `else` consumed — same bytes, one less
 * nesting level. Anything that genuinely cannot round-trip (an unknown opcode
 * byte, a displacement into the middle of an instruction) is emitted with a
 * `// !! ...` warning comment so nothing is silently dropped.
 */

import {
  actionSpec,
  CONDITION_BY_CODE,
  GOTO,
  IF,
  NOT,
  OR,
  RETURN,
  SAID_ANY_WORD,
  SAID_REST,
  type OperandKind,
} from "./opcodes.ts";
import { parseLogicResource } from "./resource.ts";
import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";

export interface DisassembleOptions {
  /** Instruction vocabulary and widths; defaults to AGI 2.936. */
  readonly profile?: AgiProfile;
  /**
   * The same lowercase word -> id map the assembler takes. Used in reverse to
   * render said() word ids as words; ids above 255 cannot be written as bare
   * numbers, so without a dictionary those said() calls do not round-trip.
   */
  readonly dictionary?: ReadonlyMap<string, number>;
  /** Indent unit for nested blocks. Default two spaces. */
  readonly indent?: string;
}

/** One decoded instruction in the linear byte stream. */
interface Insn {
  readonly at: number;
  readonly end: number;
  readonly kind: "return" | "goto" | "if" | "action" | "data";
  /** goto/if: byte offset the displacement is relative from, and its target. */
  readonly target: number;
  /** if: rendered condition text. */
  readonly text: string;
  /** action: opcode name and raw operand bytes, for consumers of the decode. */
  readonly name?: string;
  readonly args?: readonly number[];
}

type Node =
  | { kind: "simple"; insn: Insn }
  | { kind: "goto"; insn: Insn }
  | {
      kind: "if";
      insn: Insn;
      then: Node[];
      else_: Node[] | null;
      /** Byte offset one past the whole statement (past else, if any). */
      end: number;
      /** Offset of the goto an `else` swallowed, or -1 when there is none. */
      elseGotoAt: number;
    };

const s16 = (lo: number, hi: number): number => ((lo | (hi << 8)) << 16) >> 16;

function operandText(kind: OperandKind, value: number): string {
  switch (kind) {
    case "var":
      return `v${value}`;
    case "flag":
      return `f${value}`;
    case "object":
      return `o${value}`;
    case "message":
      return `m${value}`;
    case "string":
      return `s${value}`;
    // "imm", "item" and "resource" have no sigil in the assembler grammar.
    default:
      return String(value);
  }
}

/**
 * Text -> a string literal the assembler's lexer reads back byte for byte.
 * Everything outside printable ASCII goes out as an escape, so the source
 * stays plain ASCII whatever code page the original text was written in.
 */
function quote(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const c = text.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    // A dictionary word could in principle hold a non-byte character; \xNN
    // could not express it, and mangling it would silently change its id.
    else if (c > 0xff) out += ch;
    else if (c < 0x20 || c >= 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `"${out}"`;
}

class Disassembler {
  readonly code: Uint8Array;
  readonly profile: AgiProfile;
  readonly messages: readonly (string | null)[];
  readonly indent: string;
  readonly words: Map<number, string>;
  /** Instruction start offset -> decoded instruction. */
  readonly insns = new Map<number, Insn>();
  readonly warnings: string[] = [];
  /** `if` offsets whose `else` the current attempt wants to give up on. */
  private readonly elseRetry = new Set<number>();

  constructor(payload: Uint8Array, opts: DisassembleOptions) {
    this.profile = opts.profile ?? DEFAULT_V2_PROFILE;
    const parsed = parseLogicResource(payload);
    this.code = parsed.code;
    this.messages = parsed.messages;
    this.indent = opts.indent ?? "  ";
    this.words = new Map();
    if (opts.dictionary) {
      // First word wins so the rendering is deterministic across synonyms;
      // any synonym re-assembles to the same id, so identity is unaffected.
      for (const [word, id] of opts.dictionary) if (!this.words.has(id)) this.words.set(id, word);
    }
    this.decodeLinear();
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  private byte(at: number): number {
    const b = this.code[at];
    if (b === undefined) throw new RangeError(`logic bytecode ends mid-instruction at ${at}`);
    return b;
  }

  /**
   * Walk the whole stream once so every instruction boundary is known before
   * structure is reconstructed. A jump into a byte that is not a boundary is
   * a construct the source grammar cannot express, and must be reported.
   */
  private decodeLinear(): void {
    let pos = 0;
    while (pos < this.code.length) {
      const at = pos;
      const b = this.byte(pos);
      if (b === RETURN) {
        this.insns.set(at, { at, end: at + 1, kind: "return", target: -1, text: "return;" });
        pos = at + 1;
        continue;
      }
      if (b === GOTO) {
        const delta = s16(this.byte(at + 1), this.byte(at + 2));
        this.insns.set(at, { at, end: at + 3, kind: "goto", target: at + 3 + delta, text: "" });
        pos = at + 3;
        continue;
      }
      if (b === IF) {
        const { text, end } = this.readConditions(at + 1);
        const delta = s16(this.byte(end), this.byte(end + 1));
        this.insns.set(at, { at, end: end + 2, kind: "if", target: end + 2 + delta, text });
        pos = end + 2;
        continue;
      }
      const spec = actionSpec(b, this.profile);
      if (!spec) {
        // Unknown opcode: length unknown, so consume one byte and resync. The
        // assembler has no raw-byte escape, so this logic cannot round-trip.
        this.warn(
          `offset ${at}: unknown opcode byte 0x${b.toString(16).padStart(2, "0")} (emitted as a comment; cannot re-assemble)`,
        );
        this.insns.set(at, {
          at,
          end: at + 1,
          kind: "data",
          target: -1,
          text: `// !! raw byte 0x${b.toString(16).padStart(2, "0")} at ${at}: not an opcode in this profile`,
        });
        pos = at + 1;
        continue;
      }
      const raw = spec.operands.map((_, i) => this.byte(at + 1 + i));
      const args = spec.operands.map((kind, i) => operandText(kind, raw[i]!));
      this.insns.set(at, {
        at,
        end: at + 1 + spec.operands.length,
        kind: "action",
        target: -1,
        text: `${spec.name}(${args.join(", ")});`,
        name: spec.name,
        args: raw,
      });
      pos = at + 1 + spec.operands.length;
    }
  }

  /** Condition list starting at `at`; returns its source text and the 0xff offset + 1. */
  private readConditions(at: number): { text: string; end: number } {
    const clauses: { text: string; group: boolean; terms: number }[] = [];
    let group: string[] | null = null;
    let pos = at;
    for (;;) {
      const b = this.byte(pos);
      if (b === IF) {
        pos++;
        break;
      }
      if (b === OR) {
        pos++;
        if (group === null) {
          group = [];
        } else {
          clauses.push({ text: group.join(" || "), group: true, terms: group.length });
          group = null;
        }
        continue;
      }
      let negated = false;
      let code = b;
      if (b === NOT) {
        negated = true;
        pos++;
        code = this.byte(pos);
      }
      const literal = this.readPredicate(code, pos);
      pos = literal.end;
      const text = negated ? `!${literal.text}` : literal.text;
      if (group === null) clauses.push({ text, group: false, terms: 1 });
      else group.push(text);
    }
    if (group !== null) {
      this.warn(`offset ${pos}: unterminated OR group in condition list`);
      clauses.push({ text: group.join(" || "), group: true, terms: group.length });
    }
    // Parentheses are dropped only where they carry no bytes: a lone clause is
    // already bracketed by `if (...)`, unless it is a ONE-term group, where the
    // parentheses are exactly what asks the assembler for the 0xfc markers.
    const bare = (c: (typeof clauses)[number]): boolean =>
      !c.group || (clauses.length === 1 && c.terms > 1);
    const text = clauses.map((c) => (bare(c) ? c.text : `(${c.text})`)).join(" && ");
    return { text, end: pos };
  }

  private readPredicate(code: number, at: number): { text: string; end: number } {
    const spec = CONDITION_BY_CODE.get(code);
    if (!spec) {
      this.warn(`offset ${at}: unknown condition opcode 0x${code.toString(16).padStart(2, "0")}`);
      return { text: `false() /* !! raw 0x${code.toString(16).padStart(2, "0")} */`, end: at + 1 };
    }
    if (code > this.profile.maxCondition) {
      this.warn(
        `offset ${at}: condition ${spec.name} is not available in profile ${this.profile.id}`,
      );
    }
    if (spec.name === "said") {
      const count = this.byte(at + 1);
      const args: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = this.byte(at + 2 + i * 2) | (this.byte(at + 3 + i * 2) << 8);
        args.push(this.saidWord(id, at));
      }
      return { text: `said(${args.join(", ")})`, end: at + 2 + count * 2 };
    }
    const args = spec.operands.map((kind, i) => operandText(kind, this.byte(at + 1 + i)));
    return { text: `${spec.name}(${args.join(", ")})`, end: at + 1 + spec.operands.length };
  }

  private saidWord(id: number, at: number): string {
    if (id === SAID_ANY_WORD) return '"*"';
    if (id === SAID_REST) return '"..."';
    const word = this.words.get(id);
    if (word !== undefined) return quote(word);
    if (id <= 0xff) return String(id);
    this.warn(
      `offset ${at}: said() word id ${id} is not in the supplied dictionary and is too large to write as a number`,
    );
    return `${id} /* !! word id out of byte range */`;
  }

  /** True when `p` can start a source statement inside a block ending at `end`. */
  private boundary(p: number, end: number): boolean {
    return p === end || (p < end && this.insns.has(p));
  }

  /**
   * Reconstruct nested statements for the byte range [start, end). `owner` is
   * the `if` whose block this is (-1 at top level): when a displacement leaves
   * the block, the owner's `else` is a candidate to give up on, because an
   * `else` is the one block boundary the reconstruction chose rather than read.
   */
  private buildBlock(
    start: number,
    end: number,
    bannedElse: ReadonlySet<number>,
    owner: number,
  ): Node[] {
    const out: Node[] = [];
    let pos = start;
    while (pos < end) {
      const insn = this.insns.get(pos);
      if (insn === undefined) {
        this.warn(`offset ${pos}: block boundary falls inside an instruction`);
        break;
      }
      if (insn.kind === "if") {
        const trueStart = insn.end;
        const falseTarget = insn.target;
        if (falseTarget < trueStart || !this.boundary(falseTarget, end)) {
          if (owner !== -1 && !bannedElse.has(owner) && !this.elseRetry.has(owner)) {
            // Retrying without the owner's else widens this block; the jump
            // may well land inside it then.
            this.elseRetry.add(owner);
            return out;
          }
          this.warn(
            `offset ${pos}: conditional block skips to ${falseTarget}, which is not a statement boundary inside the enclosing block — the emitted source will not round-trip`,
          );
          const clamped = Math.min(Math.max(falseTarget, trueStart), end);
          out.push({
            kind: "if",
            insn,
            then: this.buildBlock(trueStart, clamped, bannedElse, insn.at),
            else_: null,
            end: clamped,
            elseGotoAt: -1,
          });
          pos = clamped;
          continue;
        }
        const then = this.buildBlock(trueStart, falseTarget, bannedElse, insn.at);
        const last = then[then.length - 1];
        if (
          !bannedElse.has(pos) &&
          last !== undefined &&
          last.kind === "goto" &&
          last.insn.end === falseTarget &&
          last.insn.target > falseTarget &&
          this.boundary(last.insn.target, end)
        ) {
          // Exactly the shape the assembler emits for else: the then-block
          // ends with a forward jump over the else-block.
          const elseEnd = last.insn.target;
          out.push({
            kind: "if",
            insn,
            then: then.slice(0, -1),
            else_: this.buildBlock(falseTarget, elseEnd, bannedElse, insn.at),
            end: elseEnd,
            elseGotoAt: last.insn.at,
          });
          pos = elseEnd;
          continue;
        }
        out.push({ kind: "if", insn, then, else_: null, end: falseTarget, elseGotoAt: -1 });
        pos = falseTarget;
        continue;
      }
      out.push(insn.kind === "goto" ? { kind: "goto", insn } : { kind: "simple", insn });
      pos = insn.end;
    }
    return out;
  }

  /** Offsets a `goto` still needs a top-level label for, and where else-blocks hide them. */
  private collectJumps(nodes: readonly Node[], into: Set<number>): void {
    for (const node of nodes) {
      if (node.kind === "goto") into.add(node.insn.target);
      else if (node.kind === "if") {
        this.collectJumps(node.then, into);
        if (node.else_) this.collectJumps(node.else_, into);
      }
    }
  }

  /** Offsets at which a statement is rendered, at any depth: label sites. */
  private collectStarts(nodes: readonly Node[], into: Set<number>): void {
    for (const node of nodes) {
      into.add(node.insn.at);
      if (node.kind === "if") {
        this.collectStarts(node.then, into);
        if (node.else_) this.collectStarts(node.else_, into);
      }
    }
  }

  /** Offset of each goto an `else` consumed -> the `if` that consumed it. */
  private collectElseGotos(nodes: readonly Node[], into: Map<number, number>): void {
    for (const node of nodes) {
      if (node.kind !== "if") continue;
      this.collectElseGotos(node.then, into);
      if (node.else_) {
        into.set(node.elseGotoAt, node.insn.at);
        this.collectElseGotos(node.else_, into);
      }
    }
  }

  /**
   * Build the statement tree. Labels may sit at any depth, so the only reason
   * left to give up an `else` is a jump that lands on the very goto the `else`
   * consumed: that goto is not rendered, so nothing there could carry a label.
   */
  build(): { nodes: Node[]; labels: Set<number> } {
    const bannedElse = new Set<number>();
    for (let attempt = 0; ; attempt++) {
      this.elseRetry.clear();
      const nodes = this.buildBlock(0, this.code.length, bannedElse, -1);
      if (this.elseRetry.size > 0 && attempt <= 200) {
        for (const at of this.elseRetry) bannedElse.add(at);
        continue;
      }
      const targets = new Set<number>();
      this.collectJumps(nodes, targets);
      // One past the last byte is a label site too: it is the end of the code.
      const starts = new Set<number>([this.code.length]);
      this.collectStarts(nodes, starts);
      const elseGotos = new Map<number, number>();
      this.collectElseGotos(nodes, elseGotos);
      let retry = false;
      for (const target of targets) {
        if (starts.has(target)) continue;
        const owner = elseGotos.get(target);
        if (owner !== undefined && !bannedElse.has(owner)) {
          bannedElse.add(owner);
          retry = true;
        }
      }
      if (!retry || attempt > 200) {
        for (const target of targets) {
          if (!starts.has(target)) {
            this.warn(
              `offset ${target}: jump target is not a statement boundary in the reconstructed source, so no label can be placed there — the emitted source will not round-trip`,
            );
          }
        }
        return { nodes, labels: targets };
      }
    }
  }

  render(): string {
    const { nodes, labels } = this.build();
    const lines: string[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      // Indices 0..length-1 always exist, so `undefined` here means `null`.
      const text = this.messages[i] ?? null;
      // A bare `#message N` is how the source spells an absent (zero-offset)
      // slot, which is not the same thing as an empty message.
      lines.push(text === null ? `#message ${i + 1}` : `#message ${i + 1} ${quote(text)}`);
    }
    if (lines.length > 0) lines.push("");

    const emit = (list: readonly Node[], depth: number): void => {
      const pad = this.indent.repeat(depth);
      for (const node of list) {
        if (labels.has(node.insn.at)) lines.push(`${pad}L${node.insn.at}:`);
        if (node.kind === "goto") {
          lines.push(`${pad}goto L${node.insn.target};`);
          continue;
        }
        if (node.kind === "simple") {
          lines.push(`${pad}${node.insn.text}`);
          continue;
        }
        lines.push(`${pad}if (${node.insn.text}) {`);
        emit(node.then, depth + 1);
        if (node.else_ === null) {
          lines.push(`${pad}}`);
        } else {
          lines.push(`${pad}} else {`);
          emit(node.else_, depth + 1);
          lines.push(`${pad}}`);
        }
      }
    };
    emit(nodes, 0);
    if (labels.has(this.code.length)) lines.push(`L${this.code.length}:`);

    if (this.warnings.length > 0) {
      lines.push("");
      for (const w of this.warnings) lines.push(`// !! ${w}`);
    }
    return lines.join("\n") + "\n";
  }
}

/**
 * Disassemble a logic resource payload into assembler source. The result
 * re-assembles to the same bytecode; anything that cannot is flagged with a
 * `// !! ` comment in the output (and listed by `disassembleLogicWarnings`).
 */
export function disassembleLogic(payload: Uint8Array, opts: DisassembleOptions = {}): string {
  return new Disassembler(payload, opts).render();
}

/** The round-trip warnings for a payload, without rendering the source. */
export function disassembleLogicWarnings(
  payload: Uint8Array,
  opts: DisassembleOptions = {},
): readonly string[] {
  const d = new Disassembler(payload, opts);
  d.build();
  return d.warnings;
}

/** One decoded action opcode: offset, name and raw operand bytes. */
export interface DecodedAction {
  readonly at: number;
  readonly name: string;
  readonly args: readonly number[];
}

/**
 * The linear action decode — every opcode the stream executes, without the
 * structural reconstruction. Consumers that only need "which rooms does this
 * logic name" use this instead of parsing the rendered source. Unknown opcode
 * bytes are skipped (one byte) the same way decodeLinear resyncs.
 */
export function decodeLogicActions(
  payload: Uint8Array,
  opts: DisassembleOptions = {},
): readonly DecodedAction[] {
  const d = new Disassembler(payload, opts);
  const out: DecodedAction[] = [];
  for (const insn of d.insns.values())
    if (insn.kind === "action" && insn.name !== undefined)
      out.push({ at: insn.at, name: insn.name, args: insn.args ?? [] });
  return out;
}
