import { numberedLabel, type NumberedLabelContext } from "../../../../src/logic/numberedLabels.ts";
import { DEFAULT_V2_PROFILE, type AgiProfile } from "../../../../src/runtime/profile.ts";
import { expandProjectLogic } from "../../../../src/authoring/projectLogic.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import { parseLogicSyntax, type TestExpr, type Stmt } from "../../../../src/logic/syntax.ts";
import {
  quoteLogicString,
  disassembleLogic,
  disassembleLogicWarnings,
} from "../../../../src/logic/disassembler.ts";
import { parseSentence } from "../../../../src/runtime/parser.ts";
import type { ProjectChange, ProjectContent } from "../../../../src/authoring/projectContent.ts";

export type WordRows = readonly (readonly [string, number])[];
interface Use {
  logic: number;
  line: number;
}
/** Keep each LOGIC label once, with independently navigable source lines. */
export function formatMeaningUses(uses: readonly Use[], context: NumberedLabelContext = {}) {
  const locations: { logic: number; label: string; lines: number[] }[] = [];
  for (const use of uses) {
    let location = locations.find((entry) => entry.logic === use.logic);
    if (!location) {
      location = { logic: use.logic, label: "", lines: [] };
      locations.push(location);
    }
    if (!location.lines.includes(use.line)) location.lines.push(use.line);
  }
  for (const location of locations) {
    location.lines.sort((a, b) => a - b);
    location.label = `${numberedLabel("logic", location.logic, context, "row")} ${location.lines.length === 1 ? "line" : "lines"}`;
  }
  return { count: `${uses.length} ${uses.length === 1 ? "use" : "uses"}`, locations };
}
interface MeaningUse extends Use {
  words: string[];
}
export interface SentenceOutcome extends Use {
  message: string;
  conditional: boolean;
  condition: string;
}
function logicSource(
  content: ProjectContent,
  dictionary: ReadonlyMap<string, number>,
  profile: AgiProfile,
): string {
  if (typeof content === "string") return content;
  const warnings = disassembleLogicWarnings(content, { dictionary, profile });
  if (warnings.length)
    throw new Error("This LOGIC has unreadable instructions. Repair it before changing meanings.");
  return disassembleLogic(content, { dictionary, profile });
}
function projectSyntax(source: string, documents: Readonly<Record<string, ProjectContent>>) {
  const bindings = documents["bindings"];
  const expanded = expandProjectLogic(
    source,
    readBindingsDocument(typeof bindings === "string" ? bindings : "{}"),
  );
  return {
    ...parseLogicSyntax(expanded.prelude + source),
    offset: expanded.authoredStart,
    lines: expanded.generated.length,
  };
}
function saidIds(
  test: Extract<TestExpr, { type: "cond" }>,
  dictionary: ReadonlyMap<string, number>,
): number[] {
  return test.args.map((arg) =>
    arg.kind === "str"
      ? arg.text === "..."
        ? 9999
        : (dictionary.get(arg.text.toLowerCase()) ?? -1)
      : arg.kind === "num"
        ? arg.value
        : -1,
  );
}
function conditions(test: TestExpr): Extract<TestExpr, { type: "cond" }>[] {
  if (test.type === "cond") return [test];
  if (test.type === "not" || test.type === "group") return conditions(test.inner);
  return test.parts.flatMap(conditions);
}
function visit(
  program: readonly Stmt[],
  fn: (statement: Extract<Stmt, { type: "if" }>) => void,
): void {
  for (const stmt of program)
    if (stmt.type === "if") {
      fn(stmt);
      visit(stmt.then, fn);
      visit(stmt.else_ ?? [], fn);
    }
}
export function meaningUses(
  words: WordRows,
  documents: Readonly<Record<string, ProjectContent>>,
  profile: AgiProfile = DEFAULT_V2_PROFILE,
): Record<string, MeaningUse[]> {
  const uses: Record<string, MeaningUse[]> = {};
  const dictionary = new Map(words);
  for (const [key, content] of Object.entries(documents)) {
    if (!key.startsWith("logic:")) continue;
    try {
      const source = logicSource(content, dictionary, profile);
      const syntax = projectSyntax(source, documents);
      visit(syntax.program, (stmt) => {
        for (const cond of conditions(stmt.test).filter((cond) => cond.name === "said")) {
          for (const id of new Set(saidIds(cond, dictionary)))
            (uses[String(id)] ??= []).push({
              logic: Number(key.split(":")[1]),
              line: cond.tok.line - syntax.lines,
              words: cond.args.flatMap((arg) =>
                arg.kind === "str" && dictionary.get(arg.text.toLowerCase()) === id
                  ? [arg.text.toLowerCase()]
                  : [],
              ),
            });
        }
      });
    } catch {
      /* Invalid source stays editable; valid resources still have uses. */
    }
  }
  return uses;
}
function matches(pattern: number[], words: number[], count: number, profile: AgiProfile): boolean {
  if (count === 0) return false;
  let index = 0;
  for (const id of pattern) {
    if (id === 9999 && profile.wordSequenceTailTerminator) return true;
    if (index >= words.length || (id !== 1 && id !== words[index])) return false;
    index++;
  }
  return index === words.length && count === words.length;
}
type Truth = boolean | "state";
interface ParseState {
  consumed: Truth;
  ready: Truth;
}
function evaluate(
  test: TestExpr,
  dictionary: ReadonlyMap<string, number>,
  words: number[],
  count: number,
  state: ParseState,
  potential: boolean,
  profile: AgiProfile,
): Truth {
  if (test.type === "cond") {
    if (test.name === "said") {
      if (
        state.consumed === true ||
        state.ready === false ||
        !matches(saidIds(test, dictionary), words, count, profile)
      )
        return false;
      const result = state.consumed === "state" || state.ready === "state" ? "state" : true;
      state.consumed = potential ? "state" : true;
      return result;
    }
    if (test.name === "isset" && test.args[0]?.kind === "f") {
      if (test.args[0].index === 2) return state.ready;
      if (test.args[0].index === 4) return state.consumed;
    }
    return "state";
  }
  if (test.type === "group")
    return evaluate(test.inner, dictionary, words, count, state, potential, profile);
  if (test.type === "not") {
    const value = evaluate(test.inner, dictionary, words, count, state, potential, profile);
    return value === "state" ? value : !value;
  }
  let uncertain = potential;
  let value: Truth = test.type === "and";
  for (const part of test.parts) {
    const next = evaluate(part, dictionary, words, count, state, uncertain, profile);
    if (test.type === "and" && next === false) return false;
    if (test.type === "or" && next === true) return true;
    if (next === "state") {
      value = "state";
      uncertain = true;
    }
  }
  return value;
}
/** Static response candidates; runtime guards and unresolved control flow remain conditional. */
export function sentenceOutcomes(
  line: string,
  entries: WordRows,
  documents: Readonly<Record<string, ProjectContent>>,
  room: number,
  profile: AgiProfile = DEFAULT_V2_PROFILE,
): SentenceOutcome[] {
  const dictionary = new Map(entries);
  const parsed = parseSentence(line, dictionary);
  const result: SentenceOutcome[] = [];
  const state: ParseState = { consumed: false, ready: parsed.count > 0 };
  const running = new Set<number>();
  let roomCalled = false;
  let uncertain = false;
  function logicResponses(logic: number, guard: Truth = true, labels: string[] = []): void {
    const content = documents[`logic:${logic}`];
    if (content === undefined) return;
    if (running.has(logic)) {
      uncertain = true;
      return;
    }
    try {
      const source = logicSource(content, dictionary, profile);
      const syntax = projectSyntax(source, documents);
      running.add(logic);
      function walk(
        program: readonly Stmt[],
        branch: Truth,
        response: Use | undefined,
        guards: string[],
      ): boolean {
        for (const stmt of program) {
          if (stmt.type === "goto" || stmt.type === "label") uncertain = true;
          if (stmt.type === "return") return branch === true;
          if (stmt.type === "if") {
            const before = state.consumed;
            const value = evaluate(
              stmt.test,
              dictionary,
              parsed.words,
              parsed.count,
              state,
              branch === "state",
              profile,
            );
            const said =
              before !== true
                ? conditions(stmt.test).find(
                    (cond) =>
                      cond.name === "said" &&
                      matches(saidIds(cond, dictionary), parsed.words, parsed.count, profile),
                  )
                : undefined;
            const site = said ? { logic, line: said.tok.line - syntax.lines } : response;
            const condition = source
              .slice(
                stmt.tok.start - syntax.offset + 2,
                source.indexOf("{", stmt.tok.start - syntax.offset),
              )
              .trim()
              .replace(/^\(|\)$/g, "");
            const conditional = branch === "state" || value === "state" || uncertain;
            const nestedGuards = value === "state" ? [...guards, condition] : guards;
            if (value !== false && branch !== false) {
              const start = result.length;
              const returned = walk(stmt.then, conditional ? "state" : true, site, nestedGuards);
              if (
                said &&
                !result
                  .slice(start)
                  .some((outcome) => outcome.logic === site!.logic && outcome.line === site!.line)
              )
                result.push({
                  ...site!,
                  message: "",
                  conditional,
                  condition: nestedGuards.join(" and "),
                });
              if (returned) return true;
            }
            if (value !== true && stmt.else_ && branch !== false) {
              if (
                walk(
                  stmt.else_,
                  value === false && branch === true ? true : "state",
                  response,
                  guards,
                )
              )
                return true;
            }
          } else if (stmt.type === "action") {
            if (response && ["print", "display", "print.at"].includes(stmt.name)) {
              const arg = stmt.args[stmt.name === "display" ? 2 : 0];
              const message =
                arg?.kind === "str"
                  ? arg.text
                  : arg?.kind === "m"
                    ? (syntax.explicitMessages.get(arg.index) ?? "")
                    : arg?.kind === "num"
                      ? (syntax.explicitMessages.get(arg.value) ?? "")
                      : "";
              result.push({
                ...response,
                message,
                conditional: branch === "state" || uncertain,
                condition: guards.join(" and "),
              });
            }
            if (
              (stmt.name === "call.v" && stmt.args[0]?.kind === "v" && stmt.args[0].index === 0) ||
              (stmt.name === "call" && stmt.args[0]?.kind === "num" && stmt.args[0].value === room)
            ) {
              roomCalled = true;
              logicResponses(room, branch, guards);
            } else if (["parse", "call", "call.v", "new.room", "new.room.v"].includes(stmt.name))
              uncertain = true;
            const arg = stmt.args[0];
            if (
              ["set", "reset", "toggle"].includes(stmt.name) &&
              arg?.kind === "f" &&
              [2, 4].includes(arg.index)
            ) {
              const next: Truth =
                branch === "state" || stmt.name === "toggle" ? "state" : stmt.name === "set";
              if (arg.index === 2) state.ready = next;
              else state.consumed = next;
            }
          }
        }
        return false;
      }
      walk(syntax.program, guard, undefined, labels);
    } catch {
      uncertain = true;
      if (parsed.count > 0)
        result.push({ logic, line: 1, message: "", conditional: true, condition: "" });
    } finally {
      running.delete(logic);
    }
  }
  logicResponses(0);
  if (!roomCalled && room !== 0) logicResponses(room);
  return result;
}

/** Preserve group identity and rewrite every affected said operand in one session proposal. */
export function changeMeaning(
  entries: WordRows,
  documents: Readonly<Record<string, ProjectContent>>,
  move: { from: number; to: number; word?: string },
  profile: AgiProfile = DEFAULT_V2_PROFILE,
): ProjectChange[] {
  if (move.from === 1 || move.from === 9999 || move.to === 1 || move.to === 9999)
    throw new Error("Reserved meanings have fixed parser roles.");
  const remaining = entries.filter(([word, id]) => id === move.from && word !== move.word);
  const merge = move.word === undefined || remaining.length === 0;
  const next = entries.map(
    ([word, id]) =>
      [word, id === move.from && (merge || word === move.word) ? move.to : id] as [string, number],
  );
  const target = merge ? next.find(([, id]) => id === move.to)?.[0] : remaining[0]?.[0];
  if (!target) throw new Error("Choose a meaning with a word.");
  const changes: ProjectChange[] = [{ key: "words", content: JSON.stringify(next) }];
  const dictionary = new Map(entries);
  for (const [key, content] of Object.entries(documents)) {
    if (!key.startsWith("logic:")) continue;
    const source = logicSource(content, dictionary, profile);
    const syntax = projectSyntax(source, documents);
    const edits: { start: number; end: number; text: string }[] = [];
    visit(syntax.program, (stmt) => {
      for (const cond of conditions(stmt.test).filter((cond) => cond.name === "said")) {
        const ids = saidIds(cond, dictionary);
        const start = syntax.tokens.findIndex((token) => token.start === cond.tok.start);
        const operands = syntax.tokens
          .slice(start + 2)
          .filter(
            (token) =>
              token.start < (cond.end ?? source.length) &&
              ["string", "number", "ident"].includes(token.type),
          );
        cond.args.forEach((arg, index) => {
          if (
            ids[index] !== move.from ||
            (!merge && (arg.kind !== "str" || arg.text.toLowerCase() !== move.word))
          )
            return;
          const token = operands[index];
          if (token)
            edits.push({
              start: token.start - syntax.offset,
              end: token.end - syntax.offset,
              text: quoteLogicString(target),
            });
        });
      }
    });
    let updated = source;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
    if (updated !== source) changes.push({ key, content: updated });
  }
  return changes;
}

export function removeMeaningWord(
  entries: WordRows,
  documents: Readonly<Record<string, ProjectContent>>,
  word: string,
  profile: AgiProfile = DEFAULT_V2_PROFILE,
): ProjectChange[] {
  const id = entries.find(([text]) => text === word)?.[1];
  if (id === undefined) return [];
  const remaining = entries.filter(([text, group]) => group === id && text !== word);
  if (!remaining.length && meaningUses(entries, documents, profile)[String(id)]?.length)
    throw new Error("Move this meaning to another row to keep its LOGIC responses.");
  const rewrites = remaining.length
    ? changeMeaning(entries, documents, { from: id, to: id, word }, profile)
    : [];
  return [
    { key: "words", content: JSON.stringify(entries.filter(([text]) => text !== word)) },
    ...rewrites.filter((change) => change.key !== "words"),
  ];
}
