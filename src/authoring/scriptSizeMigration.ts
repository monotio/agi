import { expandProjectLogic } from "./projectLogic.ts";
import { readBindingsDocument } from "./projectBindings.ts";
import { systemBindings } from "../logic/systemNames.ts";
import type { Token } from "../logic/syntax.ts";
import type { ProjectContent } from "./projectContent.ts";
import { parseLogicSyntax, type Stmt, type Ref, type TestExpr } from "../logic/syntax.ts";
import { assembleLogic } from "../logic/assembler.ts";
import { decodeLogicInsns } from "../logic/disassembler.ts";
import { openContainer } from "../container/container.ts";
import { RELEASED_LOGIC0 } from "./releasedTemplateContract.ts";

type Syntax = ReturnType<typeof parseLogicSyntax>;
function operand(ref: Ref, syntax: Syntax): unknown {
  if (ref.kind === "str") return ref.text;
  if (ref.kind === "m") return syntax.explicitMessages.get(ref.index);
  return ref.kind === "num" ? ref.value : ref.index;
}
function condition(test: TestExpr, syntax: Syntax): unknown {
  switch (test.type) {
    case "cond":
      return [test.name, ...test.args.map((ref) => operand(ref, syntax))];
    case "not":
    case "group":
      return [test.type, condition(test.inner, syntax)];
    case "and":
    case "or":
      return [test.type, ...test.parts.map((part) => condition(part, syntax))];
  }
}
function statement(stmt: Stmt, syntax: Syntax): unknown {
  switch (stmt.type) {
    case "if":
      return [
        "if",
        condition(stmt.test, syntax),
        stmt.then.map((s) => statement(s, syntax)),
        stmt.else_?.map((s) => statement(s, syntax)) ?? null,
      ];
    case "action":
      return [stmt.name, ...stmt.args.map((ref) => operand(ref, syntax))];
    case "return":
      return ["return"];
    default:
      return [stmt.type, stmt.type === "label" ? stmt.name : stmt.label];
  }
}
function same(stmt: Stmt, syntax: Syntax, expected: Stmt, reference: Syntax): boolean {
  return JSON.stringify(statement(stmt, syntax)) === JSON.stringify(statement(expected, reference));
}
function walk(program: readonly Stmt[]): Stmt[] {
  return program.flatMap((stmt) => [
    stmt,
    ...(stmt.type === "if" ? [...walk(stmt.then), ...walk(stmt.else_ ?? [])] : []),
  ]);
}
// The resolved contracts shipped in 1.0–1.2.4. Raw v/f operands and mN
// messages compare identically to their later named/inline spellings.
const reference = parseLogicSyntax(RELEASED_LOGIC0);
const releasedBoot = reference.program[0]!;
const releasedFeedback = reference.program.at(-1)!;

function safeSyntax(
  source: string,
  documents: Readonly<Record<string, ProjectContent>>,
): Syntax | null {
  try {
    const raw = documents["bindings"];
    const bindings = readBindingsDocument(typeof raw === "string" ? raw : "{}");
    const expansion = expandProjectLogic(source, bindings);
    const expanded = expansion.prelude + source;
    const builtins = systemBindings(bindings);
    const syntax = parseLogicSyntax(expanded, builtins);
    // Strict compile validates the instruction vocabulary and operands too.
    // said strings require a dictionary, so use synthetic ids solely for validation.
    const words = new Map<string, number>();
    for (const stmt of walk(syntax.program))
      if (stmt.type === "if") {
        const visit = (test: TestExpr): void => {
          if (test.type === "cond" && test.name === "said") {
            for (const arg of test.args) if (arg.kind === "str") words.set(arg.text, 1);
          } else if (test.type === "not" || test.type === "group") visit(test.inner);
          else if (test.type === "and" || test.type === "or") test.parts.forEach(visit);
        };
        visit(stmt.test);
      }
    assembleLogic(expanded, { dictionary: words, builtins });
    const offset = expansion.authoredStart;
    const lines = expansion.generated.length;
    const token = (tok: Token): Token => ({
      ...tok,
      start: tok.start - offset,
      end: tok.end - offset,
      line: tok.line - lines,
    });
    const ref = (arg: Ref): Ref => ({ ...arg, ...(arg.tok ? { tok: token(arg.tok) } : {}) });
    const test = (expr: TestExpr): TestExpr => {
      if (expr.type === "cond")
        return {
          ...expr,
          tok: token(expr.tok),
          args: expr.args.map(ref),
          ...(expr.end === undefined ? {} : { end: expr.end - offset }),
        };
      if (expr.type === "not" || expr.type === "group") return { ...expr, inner: test(expr.inner) };
      return { ...expr, parts: expr.parts.map(test) };
    };
    const stmt = (entry: Stmt): Stmt => {
      const span = { tok: token(entry.tok), end: entry.end - offset };
      if (entry.type === "action") return { ...entry, ...span, args: entry.args.map(ref) };
      if (entry.type === "if")
        return {
          ...entry,
          ...span,
          test: test(entry.test),
          then: entry.then.map(stmt),
          else_: entry.else_?.map(stmt) ?? null,
        };
      return { ...entry, ...span };
    };
    return {
      ...syntax,
      program: syntax.program.map(stmt),
    };
  } catch {
    return null;
  }
}
/** Prove the boot flag is written only by the released block, across the whole game. */
function uniqueFlagWrite(
  syntax: Syntax,
  flag: number,
  files?: Readonly<Record<string, Uint8Array>>,
): boolean {
  const statements = walk(syntax.program);
  if (statements.some((s) => s.type === "goto" || s.type === "label")) return false;
  if (
    statements.some((s) => s.type === "action" && ["set.v", "reset.v", "toggle.v"].includes(s.name))
  )
    return false;
  const writes = statements.filter(
    (s) =>
      s.type === "action" &&
      ["set", "reset", "toggle"].includes(s.name) &&
      operand(s.args[0]!, syntax) === flag,
  );
  if (writes.length !== 1) return false;
  if (files) {
    try {
      const container = openContainer(new Map(Object.entries(files)));
      for (let n = 1; n < 256; n++) {
        const payload = container.getResource("logic", n);
        if (!payload) continue;
        const insns = decodeLogicInsns(payload);
        if (
          insns.some(
            (i) =>
              i.kind === "data" ||
              (i.kind === "action" &&
                (["set.v", "reset.v", "toggle.v"].includes(i.name!) ||
                  (["set", "reset", "toggle"].includes(i.name!) && i.args?.[0] === flag))),
          )
        )
          return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}
function bootMatch(syntax: Syntax, files?: Readonly<Record<string, Uint8Array>>): Stmt | undefined {
  const matches = syntax.program.filter((s) => same(s, syntax, releasedBoot, reference));
  return matches.length === 1 && uniqueFlagWrite(syntax, 200, files) ? matches[0] : undefined;
}
interface Edit {
  start: number;
  end: number;
  text: string;
}
function patched(source: string, edits: Edit[]): string {
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
}
function feedbackEdits(stmt: Stmt): Edit[] {
  return walk([stmt]).flatMap((s) =>
    s.type === "action" && s.name === "word.to.string"
      ? [
          {
            start: s.args[1]!.tok!.start,
            end: s.args[1]!.tok!.end,
            text: String((s.args[1] as { value: number }).value - 1),
          },
        ]
      : [],
  );
}
/** Exact released blocks only; all edits share the caller's single transaction. */
export function migrateScriptSize(
  documents: Readonly<Record<string, ProjectContent>>,
  files?: Readonly<Record<string, Uint8Array>>,
): Record<string, ProjectContent> | null {
  const source = documents["logic:0"];
  if (typeof source !== "string") return null;
  const syntax = safeSyntax(source, documents);
  if (!syntax) return null;
  const edits: Edit[] = [];
  const match =
    files && hasRoomMemoryDeclaration(files) !== false ? undefined : bootMatch(syntax, files);
  if (
    match?.type === "if" &&
    !walk(syntax.program).some((s) => s.type === "action" && s.name === "script.size")
  ) {
    const at = match.then[0]!.end;
    edits.push({ start: at, end: at, text: "\n  script.size(200);" });
  }
  const fallback = syntax.program.filter((s) => same(s, syntax, releasedFeedback, reference));
  if (fallback.length === 1) edits.push(...feedbackEdits(fallback[0]!));
  return edits.length ? { ...documents, "logic:0": patched(source, edits) } : null;
}

/** Customized one-based word feedback needs the author's attention. */
export function hasCustomizedWordFeedback(
  documents: Readonly<Record<string, ProjectContent>>,
): boolean {
  const source = documents["logic:0"];
  const syntax = typeof source === "string" ? safeSyntax(source, documents) : null;
  if (!syntax || syntax.program.some((s) => same(s, syntax, releasedFeedback, reference)))
    return false;
  return walk(syntax.program).some(
    (s) =>
      s.type === "if" &&
      s.test.type === "cond" &&
      s.test.name === "equaln" &&
      operand(s.test.args[0]!, syntax) === 9 &&
      s.then.some(
        (a) =>
          a.type === "action" &&
          a.name === "word.to.string" &&
          operand(a.args[1]!, syntax) ===
            operand(s.test.type === "cond" ? s.test.args[1]! : a.args[1]!, syntax),
      ),
  );
}

/** null means the current resources cannot prove whether memory is declared. */
function hasRoomMemoryDeclaration(files: Readonly<Record<string, Uint8Array>>): boolean | null {
  try {
    const container = openContainer(new Map(Object.entries(files)));
    let declared = false;
    for (let n = 0; n < 256; n++) {
      const payload = container.getResource("logic", n);
      if (!payload) continue;
      const insns = decodeLogicInsns(payload);
      if (insns.some((i) => i.kind === "data")) return null;
      if (insns.some((i) => i.name === "script.size")) declared = true;
    }
    return declared;
  } catch {
    return null;
  }
}
