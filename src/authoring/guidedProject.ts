/**
 * Guided project operations: deterministic, provider-free edits a novice can
 * drive without typing code, over the one authoritative draft/document model.
 *
 * Each `prepare*` call reads the live draft once, computes complete detached
 * document changes against the exact current source, validates the merged
 * candidate through the shared compile/reference path, and returns a prepared
 * operation holding the consulted snapshot, the issued proposal, the affected
 * keys and the source ranges a "Show code" view reveals. Nothing is written:
 * the caller shows the preview, then `apply()` runs the issuing draft's own
 * atomic apply — one transaction, one undo step; stale, foreign and replayed
 * proposals are refused by the draft itself.
 *
 * Recognition is structural. A guided edit touches a room only when its
 * room-entry ego setup, command handler or annotated rule parses into exactly
 * the shape the edit replaces; anything else refuses with the affected range,
 * leaving custom code untouched. Emitted code is ordinary AGI source —
 * `said()`, `print()`, `posn()`/`new.room()`, `load.sound()`/`sound()` — that
 * Logic Studio edits freely afterward. Guided metadata lives only in the
 * existing words/bindings/world documents and `// @rule` annotations; there is
 * no second serialized game model.
 */
import { openContainer } from "../container/container.ts";
import { AssemblerError } from "../logic/assembler.ts";
import { quoteLogicString } from "../logic/disassembler.ts";
import { matchDictionaryPhrase, parseWordsTok, type WordEntry } from "../logic/words.ts";
import { renderPicture } from "../picture/renderer.ts";
import { compilePictureSource } from "../picture/source.ts";
import { PROFILES, type AgiProfile, type ProfileId } from "../runtime/profile.ts";
import { createPictureSurface, type GameContainer } from "../types.ts";
import { buildView, parseView, type AgiView, type BuildViewInput } from "../view/view.ts";
import {
  createAuthoringState,
  validateAuthoringState,
  type AuthoringState,
  type BindingKind,
} from "./authoringState.ts";
import {
  actionsNamed,
  callArgSpan,
  flagRef,
  initBlocks,
  insertAtThenEnd,
  insertAtThenStart,
  insertBeforeFinalReturn,
  insertLinesEdit,
  isEgo,
  lineOf,
  lineRanges,
  lineStartOffset,
  linesText,
  messageDirectives,
  numRef,
  parseRoomSource,
  saidWordIds,
  spliceText,
  stmtTokens,
  testConds,
  type ParsedRoom,
  type TextEdit,
} from "./guidedSource.ts";
import {
  analyzeLogicSyntax,
  type Ref,
  type Stmt,
  type TestExpr,
  type Token,
} from "../logic/syntax.ts";
import { actionSpec, CONDITION_BY_NAME, SAID_ANY_WORD, SAID_REST } from "../logic/opcodes.ts";
import {
  compileProjectDocuments,
  ProjectDocumentCompileError,
  readBindingsDocument,
} from "./projectDocuments.ts";
import type { ProjectDraft } from "./projectDraft.ts";
import { expandProjectLogic } from "./projectLogic.ts";
import { inspectProjectReferences } from "./projectReferences.ts";
import { inspectProjectSourceDependencies } from "./projectSourceDependencies.ts";
import { allocateProjectIds } from "./resourceAllocation.ts";

// ---------- Public types ----------

export type GuidedOperationKind =
  "add-room" | "place-hero" | "respond-to-command" | "connect-door" | "play-sound";

/** What the operations need beyond their arguments: draft, kept image, profile. */
export interface GuidedContext {
  readonly draft: ProjectDraft;
  /** The kept native file image this workspace's saved baseline reflects. */
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profileId: ProfileId;
}

export type GuidedFailureCode =
  /** Malformed input values (bad coordinates, empty text, invalid ids). */
  | "invalid-input"
  /** A named resource, room, handler or document does not exist. */
  | "missing"
  /** A requested id or binding name is already taken. */
  | "occupied"
  /** The change would silently shadow or duplicate existing behavior. */
  | "conflict"
  /** The affected fragment is not a recognized shape; edit it as code. */
  | "custom-code"
  /** The affected document, or the merged result, does not compile. */
  | "uncompilable";

export interface GuidedLineRange {
  /** 1-based inclusive lines in the document's new text. */
  readonly start: number;
  readonly end: number;
}

export interface GuidedSourcePreview {
  readonly key: string;
  readonly lines: readonly GuidedLineRange[];
  /** The exact new text of those lines. */
  readonly text: string;
}

export interface GuidedChange {
  readonly key: string;
  readonly content: string | Uint8Array | null;
}

/** A prepared guided operation: reviewed preview + the issued draft proposal. */
export interface PreparedGuidedOperation {
  readonly ok: true;
  readonly kind: GuidedOperationKind;
  readonly label: string;
  /** The consulted base; the proposal is bound to it. */
  readonly snapshot: ReturnType<ProjectDraft["capture"]>;
  readonly proposal: ReturnType<ProjectDraft["propose"]>;
  /** Detached copies of the proposed document contents. */
  readonly changes: readonly GuidedChange[];
  /** Resource and auxiliary document keys this operation writes. */
  readonly affectedKeys: readonly string[];
  /** Exact new source ranges per edited document, for "Show code". */
  readonly showCode: readonly GuidedSourcePreview[];
  /** Commit through the issuing draft's atomic apply: one undoable transaction. */
  apply(): ReturnType<ProjectDraft["apply"]>;
}

/** A precise, typed reason an operation cannot be prepared. */
export interface GuidedRefusal {
  readonly ok: false;
  readonly kind: GuidedOperationKind;
  readonly label: string;
  readonly code: GuidedFailureCode;
  readonly message: string;
  /** The document and line range the refusal is about, when known. */
  readonly key?: string;
  readonly lines?: GuidedLineRange;
}

export type GuidedOutcome = PreparedGuidedOperation | GuidedRefusal;

// ---------- Internal plumbing ----------

type Bindings = AuthoringState["bindings"];
type World = AuthoringState["world"];
type Snapshot = ReturnType<ProjectDraft["capture"]>;

interface RuleBox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

const RULE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const BINDING_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const RULE_DIRECTIVE = /^\/\/\s*@(rule|end)(?=\s|$)(.*)$/;
const RULE_LABEL = /^"(?:[^"\\]|\\.)*"/;

function numBindings(bindings: Bindings): Record<string, { readonly num: number }> {
  return Object.fromEntries(
    Object.entries(bindings).map(([name, binding]) => [name, { num: binding.num }]),
  );
}

function refuse(
  kind: GuidedOperationKind,
  label: string,
  code: GuidedFailureCode,
  message: string,
  key?: string,
  lines?: GuidedLineRange,
): GuidedRefusal {
  return {
    ok: false,
    kind,
    label,
    code,
    message,
    ...(key !== undefined ? { key } : {}),
    ...(lines !== undefined ? { lines } : {}),
  };
}

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

// ---------- The consulted image ----------

/** Everything a prepare step reads, decoded once from the consulted snapshot. */
interface GuidedImage {
  readonly snapshot: Snapshot;
  readonly documents: Record<string, string | Uint8Array>;
  readonly bindings: Bindings;
  readonly world: World;
  readonly words: WordEntry[];
  readonly dictionary: ReadonlyMap<string, number>;
  readonly profile: AgiProfile;
  readonly keptContainer: GameContainer;
}

function readJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function readWordDocument(content: string | Uint8Array | undefined): WordEntry[] {
  if (content === undefined) return [];
  if (typeof content === "string") {
    const parsed = readJson(content);
    if (!Array.isArray(parsed)) throw new Error("The words document is not [word, id] pairs.");
    return parsed.map((entry) => {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Number.isInteger(entry[1]))
        throw new Error("The words document is not [word, id] pairs.");
      return { word: entry[0] as string, id: entry[1] as number };
    });
  }
  return parseWordsTok(content).map(({ word, id }) => ({ word, id }));
}

function readWorldDocument(content: string | Uint8Array | undefined): World {
  if (content === undefined) return createAuthoringState().world;
  if (typeof content !== "string") throw new Error("The world document is not JSON text.");
  return validateAuthoringState({ version: 1, bindings: {}, world: readJson(content) }).world;
}

function readBindings(content: string | Uint8Array | undefined): Bindings {
  if (content === undefined) return {};
  if (typeof content !== "string") throw new Error("The bindings document is not JSON text.");
  return readBindingsDocument(content);
}

function consult(
  ctx: GuidedContext,
  kind: GuidedOperationKind,
  label: string,
): GuidedImage | GuidedRefusal {
  const profile = PROFILES[ctx.profileId];
  if (!profile)
    return refuse(kind, label, "invalid-input", `Unknown build profile: ${ctx.profileId}`);
  const snapshot = ctx.draft.capture();
  const documents: Record<string, string | Uint8Array> = Object.create(null);
  for (const key of snapshot.keys) documents[key] = snapshot.read(key)!.content;
  let bindings: Bindings;
  let world: World;
  let words: WordEntry[];
  try {
    bindings = readBindings(documents["bindings"]);
  } catch (error) {
    return refuse(
      kind,
      label,
      "uncompilable",
      error instanceof Error ? error.message : String(error),
      "bindings",
    );
  }
  try {
    world = readWorldDocument(documents["world"]);
  } catch (error) {
    return refuse(
      kind,
      label,
      "uncompilable",
      error instanceof Error ? error.message : String(error),
      "world",
    );
  }
  try {
    words = readWordDocument(documents["words"]);
  } catch (error) {
    return refuse(
      kind,
      label,
      "uncompilable",
      error instanceof Error ? error.message : String(error),
      "words",
    );
  }
  const keptContainer = openContainer(
    new Map(Object.entries(ctx.files).map(([name, bytes]) => [name, new Uint8Array(bytes)])),
    { profile },
  );
  return {
    snapshot,
    documents,
    bindings,
    world,
    words,
    dictionary: new Map(words.map((entry) => [entry.word, entry.id])),
    profile,
    keptContainer,
  };
}

// ---------- Allocation (draft-aware, real context) ----------

/**
 * Numbers already spoken for: draft document keys, named binding reservations,
 * kept indexed resources, compiled references, and references inside in-flight
 * draft sources (scanned with the recoverable analyzer, so an unfinished room
 * cannot quietly lose an id another draft already names).
 */
function occupiedResourceIds(img: GuidedImage, kind: "logic" | "picture" | "view" | "sound") {
  const used = new Set<number>();
  const docRef = new RegExp(`^${kind}:(\\d+)$`);
  for (const key of img.snapshot.keys) {
    const match = docRef.exec(key);
    if (match) used.add(Number(match[1]));
  }
  for (const binding of Object.values(img.bindings))
    if (binding.kind === kind) used.add(binding.num);
  for (let num = 0; num < 256; num++) {
    try {
      if (img.keptContainer.getResource(kind, num)) used.add(num);
    } catch {
      used.add(num);
    }
  }
  const analysis = inspectProjectReferences({
    container: img.keptContainer,
    profile: img.profile,
    bindings: img.bindings,
  });
  for (const reference of analysis.references)
    if (reference.target.kind === kind && "num" in reference.target) used.add(reference.target.num);
  const numbers = numBindings(img.bindings);
  for (const key of img.snapshot.keys) {
    if (!key.startsWith("logic:")) continue;
    const source = img.documents[key];
    if (typeof source !== "string") continue;
    const dependencies = inspectProjectSourceDependencies({
      source,
      profile: img.profile,
      bindings: numbers,
    });
    for (const dependency of dependencies.dependencies) {
      const match = docRef.exec(dependency);
      if (match) used.add(Number(match[1]));
    }
  }
  return used;
}

function allocateResourceId(
  img: GuidedImage,
  kind: "logic" | "picture",
  requested: number | undefined,
  label: string,
  opKind: GuidedOperationKind,
): { id: number } | GuidedRefusal {
  const used = occupiedResourceIds(img, kind);
  if (requested !== undefined) {
    if (!intIn(requested, 1, 255))
      return refuse(
        opKind,
        label,
        "invalid-input",
        `${kind.toUpperCase()} id must be an integer from 1 to 255.`,
      );
    if (used.has(requested))
      return refuse(
        opKind,
        label,
        "occupied",
        `${kind.toUpperCase()} ${requested} is already a document, reservation or reference.`,
        `${kind}:${requested}`,
      );
    return { id: requested };
  }
  // New rooms number like the seeds: lowest free slot, 1..254.
  for (let candidate = 1; candidate <= 254; candidate++)
    if (!used.has(candidate)) return { id: candidate };
  return refuse(opKind, label, "occupied", `No free ${kind.toUpperCase()} ids remain.`);
}

const INDIRECT_VAR_OPS: Record<string, boolean> = {
  lindirectn: true,
  lindirectv: true,
  rindirect: true,
};
const INDIRECT_FLAG_OPS: Record<string, boolean> = {
  "set.v": true,
  "reset.v": true,
  "toggle.v": true,
  "isset.v": true,
};

interface SourceStateUse {
  readonly vars: Set<number>;
  readonly flags: Set<number>;
  readonly indirectVar: boolean;
  readonly indirectFlag: boolean;
  /** A state operand could not be classified; the free-slot proof failed. */
  readonly unprovable: boolean;
}

/**
 * Variable and flag slots a draft logic source actually uses, read through
 * the language's own operand semantics — never a spelling guess. The source
 * is expanded exactly like `compileProjectLogic` (external bindings become
 * `#define` lines that a local `#define` shadows) and parsed with the
 * recoverable strict parser, so references are resolved the way the assembler
 * resolves them: numbers, `v/f/o/m/s` sigils, and `#define` names. Each
 * operand position is then classified by the profile's opcode table —
 * `assignn(32, 7)` reserves variable 32 while the immediate `7`, a `posn`
 * coordinate, a `print(m32)` message slot, or a `v33` used as a resource
 * operand stays untouched; `%v`/`%o` reads inside message strings reserve
 * their variable. Indirect state ops keep their refusal. Whatever the strict
 * grammar could not recover (fragment operands, undeclared names, unclosed
 * calls, out-of-range indexes) marks the source unprovable, which the caller
 * turns into a precise refusal instead of a guess.
 */
function sourceStateUse(
  source: string,
  bindings: Readonly<Record<string, { readonly num: number }>>,
  profile: AgiProfile,
): SourceStateUse {
  const vars = new Set<number>();
  const flags = new Set<number>();
  let indirectVar = false;
  let indirectFlag = false;
  let unprovable = false;
  const put = (into: Set<number>, num: number) => {
    if (num <= 255) into.add(num);
    else unprovable = true;
  };
  let analysis;
  try {
    const expansion = expandProjectLogic(source, bindings, true);
    analysis = analyzeLogicSyntax(expansion.prelude + source);
  } catch {
    // Unlexable draft text: every slot is suspect.
    const all = new Set([...Array(224).keys()].map((i) => i + 32));
    return {
      vars: all,
      flags: new Set(all),
      indirectVar: true,
      indirectFlag: true,
      unprovable: true,
    };
  }
  const visitArgs = (name: string, args: readonly Ref[]) => {
    const spec = actionSpec(name, profile) ?? CONDITION_BY_NAME[name];
    if (spec === undefined) {
      // Unknown call: sigil refs still name state; positions for the rest
      // cannot be proven.
      for (const arg of args) {
        if (arg.kind === "v") vars.add(arg.index);
        else if (arg.kind === "f") flags.add(arg.index);
        else unprovable = true;
      }
      return;
    }
    // said() args are word ids/strings — emitted bytes, never state reads.
    if (spec.name === "said") return;
    if (INDIRECT_VAR_OPS[name]) indirectVar = true;
    if (INDIRECT_FLAG_OPS[name]) indirectFlag = true;
    for (const [index, arg] of args.entries()) {
      const operand = spec.operands[index];
      if (operand === "var" || operand === "flag") {
        // refByte semantics: any non-string ref emits its index/value byte.
        const into = operand === "var" ? vars : flags;
        if (arg.kind === "num") put(into, arg.value);
        else if (arg.kind === "str") unprovable = true;
        else put(into, arg.index);
      } else if (operand === undefined && (arg.kind === "v" || arg.kind === "f")) {
        // Extra args never emit (the assembler rejects the count), but a
        // sigil still names a slot.
        (arg.kind === "v" ? vars : flags).add(arg.index);
      }
    }
    // A short call that is missing a var/flag operand hides a slot the
    // author has not finished typing.
    for (let i = args.length; i < spec.operands.length; i++) {
      const operand = spec.operands[i];
      if (operand === "var" || operand === "flag") unprovable = true;
    }
  };
  const visitTest = (expr: TestExpr) => {
    if (expr.type === "cond") visitArgs(expr.name, expr.args);
    else if (expr.type === "and" || expr.type === "or") expr.parts.forEach(visitTest);
    else visitTest(expr.inner);
  };
  const visitStmts = (stmts: readonly Stmt[]) => {
    for (const stmt of stmts) {
      if (stmt.type === "action") visitArgs(stmt.name, stmt.args);
      else if (stmt.type === "if") {
        visitTest(stmt.test);
        visitStmts(stmt.then);
        if (stmt.else_) visitStmts(stmt.else_);
      }
    }
  };
  visitStmts(analysis.program);
  // %v/%o reads inside every message string (#message bodies and inline
  // "..." args alike) touch variables the operands never mention.
  for (const token of analysis.tokens) {
    if (token.type !== "string") continue;
    for (const match of token.text.matchAll(/%[vo](\d{1,3})/g)) vars.add(Number(match[1]));
  }
  if (analysis.diagnostics.length > 0)
    salvageStateUse(analysis.tokens, vars, flags, profile, () => (unprovable = true));
  return { vars, flags, indirectVar, indirectFlag, unprovable };
}

/**
 * Second pass over a source the strict parser could not fully recover:
 * operand positions inside dropped fragments still contribute known state —
 * a truncated `assignn(32,` keeps variable 32 occupied and the unclosed call
 * marks the source unprovable. Names resolve through the `#define` entries
 * the expansion produced, exactly the parser's own rule (first definition
 * wins, number values only).
 */
function salvageStateUse(
  tokens: readonly Token[],
  vars: Set<number>,
  flags: Set<number>,
  profile: AgiProfile,
  markUnprovable: () => void,
): void {
  const defines = new Map<string, number>();
  for (const [index, token] of tokens.entries()) {
    if (
      token.type === "directive" &&
      token.text === "#define" &&
      tokens[index + 1]?.type === "ident" &&
      tokens[index + 2]?.type === "number" &&
      !defines.has(tokens[index + 1]!.text)
    ) {
      const num = Number(tokens[index + 2]!.text);
      if (num <= 255) defines.set(tokens[index + 1]!.text, num);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type !== "ident") continue;
    const spec = actionSpec(token.text, profile) ?? CONDITION_BY_NAME[token.text];
    if (spec === undefined || spec.operands.length === 0) continue;
    if (tokens[i + 1]?.type !== "punct" || tokens[i + 1]!.text !== "(") continue;
    let cursor = i + 2;
    let index = 0;
    let closed = false;
    while (cursor < tokens.length) {
      let depth = 0;
      let end = cursor;
      while (end < tokens.length) {
        const t = tokens[end]!;
        if (t.type === "punct" && t.text === "(") depth++;
        else if (t.type === "punct" && t.text === ")") {
          if (depth === 0) break;
          depth--;
        } else if (t.type === "punct" && t.text === "," && depth === 0) break;
        end++;
      }
      const arg = tokens.slice(cursor, end);
      const operand = spec.operands[index];
      if (operand === "var" || operand === "flag") {
        const into = operand === "var" ? vars : flags;
        if (arg.length === 1) {
          const only = arg[0]!;
          if (only.type === "number") {
            const num = Number(only.text);
            if (num <= 255) into.add(num);
            else markUnprovable();
          } else if (only.type === "ident") {
            const sigil = /^[vfoms](\d{1,3})$/.exec(only.text);
            const num = sigil ? Number(sigil[1]) : defines.get(only.text);
            if (num !== undefined && num <= 255) into.add(num);
            else markUnprovable();
          } else markUnprovable();
        } else markUnprovable();
      }
      index++;
      if (end >= tokens.length) break;
      if (tokens[end]!.text === ")") {
        closed = true;
        i = end;
        break;
      }
      cursor = end + 1;
    }
    if (!closed) markUnprovable();
  }
}

/**
 * One fresh flag/variable number through the real allocation context: the
 * compiled image's operand scan (which itself refuses indirect access) plus
 * an operand-aware scan over draft logic sources the image cannot see.
 */
function allocateState(
  img: GuidedImage,
  label: string,
  kind: GuidedOperationKind,
  stateKind: "flag" | "variable",
  inFlight: Bindings,
): { num: number } | GuidedRefusal {
  const extra = new Set<number>();
  const numbers = numBindings(inFlight);
  for (const key of img.snapshot.keys) {
    if (!key.startsWith("logic:")) continue;
    const source = img.documents[key];
    if (typeof source !== "string") continue;
    const found = sourceStateUse(source, numbers, img.profile);
    for (const num of stateKind === "flag" ? found.flags : found.vars) extra.add(num);
    if (found.unprovable)
      return refuse(
        kind,
        label,
        "custom-code",
        `State access in ${key} cannot be proven statically; bind the ${stateKind} by hand.`,
        key,
      );
    if (stateKind === "flag" ? found.indirectFlag : found.indirectVar)
      return refuse(
        kind,
        label,
        "custom-code",
        `Draft source in ${key} uses indirect ${stateKind} access; bind the ${stateKind} by hand.`,
        key,
      );
  }
  const context = {
    container: img.keptContainer,
    profile: img.profile,
    dictionary: img.dictionary,
    bindings: inFlight,
  };
  // The allocator hands out the lowest free ids; extras from in-flight draft
  // text can only enlarge the occupied set, so widen the batch until one id
  // the draft does not already mention appears.
  let count = 1;
  while (count <= 224) {
    let ids: readonly number[];
    try {
      ids = allocateProjectIds(context, stateKind, count).ids;
    } catch (error) {
      return refuse(
        kind,
        label,
        "occupied",
        error instanceof Error ? error.message : String(error),
      );
    }
    const free = ids.find((id) => !extra.has(id));
    if (free !== undefined) return { num: free };
    count = ids.length + 1;
  }
  return refuse(kind, label, "occupied", `No free ${stateKind} ids remain.`);
}

// ---------- `// @rule` annotation scanning ----------

interface RoomRule {
  readonly id: string;
  readonly label: string;
  readonly kind: "exit" | "region";
  readonly item: string | null;
  /** 1-based line of the `@rule` directive. */
  readonly openLine: number;
  /** 1-based line of the `@end`; one past the last line when unterminated. */
  readonly closeLine: number;
  readonly terminated: boolean;
}

/** The room's annotated rules; a blocker message mirrors the document diagnostics. */
function scanRules(source: string): { rules: RoomRule[]; blocker: string | null } {
  const lines = source.split("\n");
  const rules: RoomRule[] = [];
  const seen = new Set<string>();
  let blocker: string | null = null;
  let open: Omit<RoomRule, "closeLine" | "terminated"> | null = null;
  let rejectedOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const match = RULE_DIRECTIVE.exec(lines[i]!.trim());
    if (!match) continue;
    if (match[1] === "end") {
      if (match[2]!.trim() !== "") continue;
      if (open) {
        rules.push({ ...open, closeLine: i + 1, terminated: true });
        open = null;
      } else if (rejectedOpen) {
        rejectedOpen = false;
      }
      continue;
    }
    const rest = match[2]!.trim();
    const [id = ""] = rest.split(/\s+/);
    const tail = rest.slice(id.length).trimStart();
    const quoted = RULE_LABEL.exec(tail);
    let label: unknown;
    try {
      label = quoted ? JSON.parse(quoted[0]) : undefined;
    } catch {
      label = undefined;
    }
    const fields = quoted ? tail.slice(quoted[0].length).trim().split(/\s+/) : [];
    const kindName = fields[0] ?? "";
    const itemField = fields[1];
    const item = itemField === undefined ? null : (/^item=(.*)$/.exec(itemField)?.[1] ?? null);
    const labelText = typeof label === "string" ? label : "";
    const valid =
      RULE_ID.test(id) &&
      labelText.trim() !== "" &&
      (kindName === "exit" || kindName === "region") &&
      fields.length <= 2 &&
      (item === null || RULE_ID.test(item));
    if (open !== null) {
      blocker ??= `nested rule annotation inside '${open.id}' (line ${i + 1})`;
      continue;
    }
    if (!valid) {
      rejectedOpen = true;
      continue;
    }
    if (seen.has(id)) {
      blocker ??= `duplicate rule id '${id}' (line ${i + 1})`;
      rejectedOpen = true;
      continue;
    }
    seen.add(id);
    open = { id, label: labelText, kind: kindName as "exit" | "region", item, openLine: i + 1 };
  }
  if (open !== null) {
    blocker ??= `rule '${open.id}' has no @end (line ${open.openLine})`;
    rules.push({ ...open, closeLine: lines.length + 1, terminated: false });
  }
  return { rules, blocker };
}

// ---------- Structural recognizers on the parsed program ----------

/** The top-level statement inside an annotated rule span, when exactly one. */
function statementInRule(room: ParsedRoom, rule: RoomRule): Stmt | null {
  const inSpan = room.program.filter(
    (stmt) =>
      lineOf(room.source, stmt.tok.start - room.base) > rule.openLine &&
      lineOf(room.source, stmt.end - room.base) < rule.closeLine,
  );
  return inSpan.length === 1 ? inSpan[0]! : null;
}

/**
 * The canonical door-exit shape — `if (posn(o0,…)[ && isset(F)]) { new.room(D); }` —
 * over the parsed program, with or without an annotation.
 */
function doorExitOf(stmt: Stmt): { box: RuleBox; destination: number } | null {
  if (stmt.type !== "if" || stmt.else_ !== null || stmt.then.length !== 1) return null;
  const go = stmt.then[0]!;
  if (go.type !== "action" || go.name !== "new.room" || go.args.length !== 1) return null;
  const destination = numRef(go.args[0]);
  if (destination === null || destination < 1 || destination > 255) return null;
  const terms = stmt.test.type === "and" ? stmt.test.parts : [stmt.test];
  const box = boxOf(terms[0]);
  if (!box || terms.length > 2) return null;
  if (terms.length === 2) {
    const guard = terms[1]!;
    const inner = guard.type === "not" ? guard.inner : guard;
    if (inner.type !== "cond" || inner.name !== "isset" || inner.args.length !== 1) return null;
    if ((flagRef(inner.args[0]) ?? numRef(inner.args[0])) === null) return null;
    if (guard.type === "not") return null; // a door needs the flag set, not clear
  }
  return { box, destination };
}

function boxOf(test: TestExpr | undefined): RuleBox | null {
  if (!test || test.type !== "cond" || test.name !== "posn" || test.args.length !== 5) return null;
  if (!isEgo(test.args[0])) return null;
  const x1 = numRef(test.args[1]);
  const y1 = numRef(test.args[2]);
  const x2 = numRef(test.args[3]);
  const y2 = numRef(test.args[4]);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
  return { x1, y1, x2, y2 };
}

/**
 * The canonical region shape — `if (!isset(F) && posn(o0,…)[ && Cs]) { set(F); [print(…)] }` —
 * returning the latch flag number, or null for anything else.
 */
function regionFlagOf(stmt: Stmt): number | null {
  if (stmt.type !== "if" || stmt.else_ !== null) return null;
  const [set, print, ...rest] = stmt.then;
  if (rest.length > 0 || set?.type !== "action" || set.name !== "set" || set.args.length !== 1)
    return null;
  if (print !== undefined && (print.type !== "action" || print.name !== "print")) return null;
  const flag = flagRef(set.args[0]) ?? numRef(set.args[0]);
  if (flag === null) return null;
  const terms = stmt.test.type === "and" ? stmt.test.parts : [stmt.test];
  const latch = terms[0];
  if (latch?.type !== "not" || latch.inner.type !== "cond" || latch.inner.name !== "isset")
    return null;
  const latchFlag = flagRef(latch.inner.args[0]) ?? numRef(latch.inner.args[0]);
  if (latchFlag !== flag) return null;
  if (boxOf(terms[1]!) === null) return null;
  for (const term of terms.slice(2)) {
    const inner = term.type === "not" ? term.inner : term;
    if (inner.type !== "cond" || inner.name !== "isset" || inner.args.length !== 1) return null;
    if ((flagRef(inner.args[0]) ?? numRef(inner.args[0])) === null) return null;
  }
  return flag;
}

/** A flag's source spelling: the single flag binding at its number, else fN. */
function flagText(img: GuidedImage, num: number): string {
  const names = Object.keys(img.bindings).filter(
    (name) => img.bindings[name]!.kind === "flag" && img.bindings[name]!.num === num,
  );
  return names.length === 1 ? names[0]! : `f${num}`;
}

// ---------- Room-entry ego setup ----------

type IfStmt = Stmt & { type: "if" };
type ActionStmt = Stmt & { type: "action" };

interface EgoSetup {
  readonly init: IfStmt;
  readonly setView: ActionStmt | null;
  readonly position: ActionStmt | null;
  readonly draw: ActionStmt | null;
  readonly horizon: number | "dynamic";
  readonly loadViews: readonly ActionStmt[];
  readonly setLoops: readonly ActionStmt[];
}

type EgoRecognition = { ok: true; setup: EgoSetup } | { ok: false; problem: string };

/**
 * Exactly one `if (isset(f5))` block with at most one literal ego
 * set.view/position/draw. Anything else — a missing setup, a doubled
 * statement, a computed variant — is a problem to refuse on, not to guess at.
 */
function recognizeEgoSetup(room: ParsedRoom): EgoRecognition {
  const inits = initBlocks(room.program);
  if (inits.length === 0)
    return { ok: false, problem: "the room has no `if (isset(f5))` entry block" };
  if (inits.length > 1)
    return { ok: false, problem: "the room has more than one `if (isset(f5))` entry block" };
  const init = inits[0]!;
  const body = init.then;
  const setViews = actionsNamed(body, "set.view").filter((s) => isEgo(s.args[0]));
  const positions = actionsNamed(body, "position").filter((s) => isEgo(s.args[0]));
  const draws = actionsNamed(body, "draw").filter((s) => isEgo(s.args[0]));
  if (setViews.length > 1)
    return { ok: false, problem: "the entry block sets ego's view more than once" };
  if (positions.length > 1)
    return { ok: false, problem: "the entry block positions ego more than once" };
  if (draws.length > 1) return { ok: false, problem: "the entry block draws ego more than once" };
  if (
    actionsNamed(body, "position.v").some((s) => isEgo(s.args[0])) ||
    actionsNamed(body, "set.view.v").some((s) => isEgo(s.args[0])) ||
    actionsNamed(body, "load.view.v").length > 0
  )
    return { ok: false, problem: "ego's entry setup is computed through variables" };
  const setView = setViews[0] ?? null;
  const position = positions[0] ?? null;
  const draw = draws[0] ?? null;
  const horizons = actionsNamed(body, "set.horizon");
  let horizon: number | "dynamic" = 36; // the interpreter's default
  if (horizons.length === 1) {
    const value = numRef(horizons[0]!.args[0]);
    horizon = value === null ? "dynamic" : value;
  } else if (horizons.length > 1) {
    horizon = "dynamic";
  }
  return {
    ok: true,
    setup: {
      init,
      setView,
      position,
      draw,
      horizon,
      loadViews: actionsNamed(body, "load.view"),
      setLoops: actionsNamed(body, "set.loop").filter((s) => isEgo(s.args[0])),
    },
  };
}

/** An untouched entry has no object setup, even in nested hand-written branches. */
function actorFreeEntry(stmts: readonly Stmt[], profile: AgiProfile): boolean {
  for (const stmt of stmts) {
    if (stmt.type === "if") {
      if (!actorFreeEntry(stmt.then, profile) || !actorFreeEntry(stmt.else_ ?? [], profile))
        return false;
    } else if (stmt.type === "action") {
      const spec = actionSpec(stmt.name, profile);
      if (
        spec?.operands.includes("object") ||
        [
          "animate.obj",
          "unanimate.all",
          "load.view",
          "load.view.v",
          "discard.view",
          "discard.view.v",
          "program.control",
          "player.control",
          "call",
          "call.v",
        ].includes(stmt.name)
      )
        return false;
    }
  }
  return true;
}

/** Widest/tallest cel of a parsed view: the footprint ego can occupy. */
function footprint(view: AgiView): { width: number; height: number } | null {
  let width = 0;
  let height = 0;
  for (const loop of view.loops)
    for (const cel of loop.cels) {
      width = Math.max(width, cel.width);
      height = Math.max(height, cel.height);
    }
  return width === 0 || height === 0 ? null : { width, height };
}

/** Parse a view document (JSON source or retained bytes) or the kept payload. */
function viewOf(img: GuidedImage, num: number): AgiView | null {
  const doc = img.documents[`view:${num}`];
  try {
    if (typeof doc === "string")
      return parseView(buildView(readJson(doc) as BuildViewInput, img.profile), img.profile);
    if (doc instanceof Uint8Array) return parseView(doc, img.profile);
    const payload = img.keptContainer.getResource("view", num);
    return payload ? parseView(payload, img.profile) : null;
  } catch {
    return null;
  }
}

/** The picture a recognized init draws, resolved through assignn locals. */
function roomPicture(room: ParsedRoom, init: IfStmt): number | null {
  const locals = new Map<number, number>();
  for (const stmt of actionsNamed(init.then, "assignn")) {
    const target = stmt.args[0];
    const value = numRef(stmt.args[1]);
    if (stmt.args.length === 2 && target?.kind === "v" && value !== null)
      locals.set(target.index, value);
  }
  for (const stmt of actionsNamed(init.then, "draw.pic")) {
    const arg = stmt.args[0];
    if (arg?.kind === "v") {
      const pic = locals.get(arg.index);
      if (pic !== undefined) return pic;
    }
    const literal = numRef(arg);
    if (literal !== null) return literal;
  }
  return null;
}

/** Priority surface of a picture payload, or null when it cannot render. */
function pictureSurface(img: GuidedImage, num: number): Uint8Array | null {
  try {
    let payload: Uint8Array | null = null;
    const doc = img.documents[`picture:${num}`];
    if (doc instanceof Uint8Array) payload = doc;
    else if (typeof doc === "string")
      payload = compilePictureSource(doc, { profile: img.profile }).bytes;
    else payload = img.keptContainer.getResource("picture", num);
    if (!payload) return null;
    const surface = createPictureSurface();
    renderPicture(payload, surface, { profile: img.profile });
    return surface.priority;
  } catch {
    return null;
  }
}

// ---------- Command words ----------

/** Command text → bounded lowercase dictionary tokens (the write_room spelling). */
function normalizeCommand(raw: string): string[] | null {
  const command = raw
    .toLowerCase()
    .replace(/['`\-“”‘’"]/g, "")
    .replace(/[ ,.?!();:[\]{}]+/g, " ")
    .trim();
  const tokens = command.split(" ").filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > 10) return null;
  if (tokens.some((word) => !/^[a-z][a-z0-9]*$/.test(word))) return null;
  return tokens;
}

/**
 * Resolve command tokens to retained word text, registering unknown words at
 * the next free id (from 100, skipping 0/1/9999 and every existing id).
 */
function commandWordIds(
  tokens: readonly string[],
  entries: WordEntry[],
  dictionary: Map<string, number>,
): { retained: string[]; added: WordEntry[] } | "ignored" | "exhausted" {
  const usedIds = new Set([...dictionary.values(), 0, 1, 9999]);
  let nextWord = 100;
  const added: WordEntry[] = [];
  const retained: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const match = matchDictionaryPhrase(tokens, index, dictionary);
    index += match.length;
    if (match.id === undefined) {
      while (nextWord <= 65535 && usedIds.has(nextWord)) nextWord++;
      if (nextWord > 65535) return "exhausted";
      dictionary.set(match.text, nextWord);
      usedIds.add(nextWord);
      const entry = { word: match.text, id: nextWord };
      entries.push(entry);
      added.push(entry);
      nextWord++;
    }
    if (match.id !== 0) retained.push(match.text);
  }
  if (retained.length === 0) return "ignored";
  return { retained, added };
}

// ---------- Emission helpers ----------

function bindingsDocument(bindings: Bindings): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(bindings)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, binding]) => [name, { kind: binding.kind, num: binding.num }]),
    ),
  );
}

function worldDocument(world: World): string {
  return JSON.stringify(world);
}

function wordsDocument(entries: readonly WordEntry[]): string {
  return JSON.stringify(entries.map(({ word, id }) => [word, id]));
}

function boxValid(box: RuleBox): boolean {
  return (
    intIn(box.x1, 0, 159) &&
    intIn(box.x2, 0, 159) &&
    intIn(box.y1, 0, 167) &&
    intIn(box.y2, 0, 167) &&
    box.x1 <= box.x2 &&
    box.y1 <= box.y2
  );
}

function insideBox(x: number, y: number, box: RuleBox): boolean {
  return x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2;
}

/** A free rule id below the given stem (`stem`, `stem-2`, …). */
function freeRuleId(rules: readonly RoomRule[], stem: string): string | null {
  const taken = new Set(rules.map((rule) => rule.id));
  if (!taken.has(stem)) return stem;
  for (let n = 2; n < 100; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
  return null;
}

// ---------- Preparation core ----------

interface Env extends GuidedImage {
  readonly kind: GuidedOperationKind;
  readonly label: string;
}

/**
 * Build the merged candidate (kept ∪ selected-dirty, my changes overlaid),
 * compile it through the one real document path, refuse on diagnostics the
 * change introduced, then issue the proposal bound to the consulted snapshot.
 */
function finish(
  ctx: GuidedContext,
  env: Env,
  changes: GuidedChange[],
  previews: Map<string, readonly { readonly start: number; readonly end: number }[]>,
  sourceTexts: Map<string, string>,
): GuidedOutcome {
  const changedKeys = changes.map((change) => change.key);
  // The selection carries the change's dependency closure: an in-flight view or
  // vocabulary document the new source names comes along, never the kept copy.
  const mergedBindingsDoc = changes.find((change) => change.key === "bindings");
  const mergedBindings =
    mergedBindingsDoc !== undefined
      ? readBindings(
          typeof mergedBindingsDoc.content === "string" ? mergedBindingsDoc.content : undefined,
        )
      : env.bindings;
  const dependencies: Record<string, string[]> = Object.create(null);
  for (const change of changes) {
    if (!change.key.startsWith("logic:") || typeof change.content !== "string") continue;
    dependencies[change.key] = inspectProjectSourceDependencies({
      source: change.content,
      profile: env.profile,
      bindings: numBindings(mergedBindings),
    }).dependencies;
  }
  const selection = ctx.draft.select(changedKeys, dependencies);
  const merged: Record<string, string | Uint8Array> = { ...selection.documents() };
  for (const change of changes) {
    if (change.content === null) delete merged[change.key];
    else merged[change.key] = change.content;
  }
  let compiled: ReturnType<typeof compileProjectDocuments>;
  try {
    compiled = compileProjectDocuments({
      files: ctx.files,
      profileId: ctx.profileId,
      documents: merged,
    });
  } catch (error) {
    if (error instanceof ProjectDocumentCompileError)
      return refuse(env.kind, env.label, "uncompilable", error.message, error.key);
    return refuse(
      env.kind,
      env.label,
      "uncompilable",
      error instanceof Error ? error.message : String(error),
    );
  }
  // The merged image must not leave references the change introduced dangling:
  // inspect the compiled container and refuse errors inside the touched docs.
  const container = openContainer(compiled.files(), { profile: env.profile });
  const analysis = inspectProjectReferences({
    container,
    profile: env.profile,
    bindings: mergedBindings,
  });
  const errors = analysis.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error" && changedKeys.includes(diagnostic.document),
  );
  if (errors.length > 0)
    return refuse(env.kind, env.label, "missing", errors[0]!.message, errors[0]!.document);
  const detached: GuidedChange[] = changes.map((change) => ({
    key: change.key,
    content:
      typeof change.content === "string" || change.content === null
        ? change.content
        : new Uint8Array(change.content),
  }));
  const showCode: GuidedSourcePreview[] = [];
  for (const [key, spans] of previews) {
    const text = sourceTexts.get(key);
    if (text === undefined) continue;
    const seen = new Set<string>();
    const ranges = lineRanges(text, spans).filter(
      (range) =>
        !seen.has(`${range.start}:${range.end}`) && !!seen.add(`${range.start}:${range.end}`),
    );
    showCode.push({
      key,
      lines: ranges,
      text: ranges.map((range) => linesText(text, range)).join("\n"),
    });
  }
  const proposal = ctx.draft.propose(env.snapshot, env.label, detached);
  const draft = ctx.draft;
  return {
    ok: true,
    kind: env.kind,
    label: env.label,
    snapshot: env.snapshot,
    proposal,
    changes: detached,
    affectedKeys: changedKeys,
    showCode,
    apply() {
      return draft.apply(proposal);
    },
  };
}

/** Resolve a resource reference: a number, or a binding name of the right kind. */
function resourceRef(
  env: Env,
  value: number | string,
  kind: BindingKind,
): { num: number; text: string } | GuidedRefusal {
  if (typeof value === "string") {
    const binding = env.bindings[value];
    if (!binding || binding.kind !== kind)
      return refuse(
        env.kind,
        env.label,
        "missing",
        `'${value}' needs a ${kind} binding.`,
        "bindings",
      );
    return { num: binding.num, text: value };
  }
  if (!intIn(value, 0, 255))
    return refuse(env.kind, env.label, "invalid-input", `A ${kind} id must be an integer 0..255.`);
  return { num: value, text: String(value) };
}

/** Room source from the consulted documents; refusal-carrying helper. */
function roomSourceOf(
  env: Env,
  num: number,
): { ok: true; key: string; source: string; room: ParsedRoom } | GuidedRefusal {
  const key = `logic:${num}`;
  const doc = env.documents[key];
  if (doc === undefined)
    return refuse(env.kind, env.label, "missing", `There is no room LOGIC ${num}.`, key);
  if (typeof doc !== "string")
    return refuse(
      env.kind,
      env.label,
      "custom-code",
      `LOGIC ${num} is retained native bytes with no source; edit it by hand.`,
      key,
    );
  try {
    return { ok: true, key, source: doc, room: parseRoomSource(doc, numBindings(env.bindings)) };
  } catch (error) {
    const detail =
      error instanceof AssemblerError
        ? `${error.message} (line ${error.line})`
        : error instanceof Error
          ? error.message
          : String(error);
    return refuse(
      env.kind,
      env.label,
      "uncompilable",
      `LOGIC ${num} does not parse as written: ${detail}`,
      key,
      error instanceof AssemblerError ? { start: error.line, end: error.line } : undefined,
    );
  }
}

// ---------- 1. Add room ----------

export interface GuidedAddRoomInput {
  /** Explicit resource ids; defaults allocate the lowest free id 1..254. */
  readonly logicId?: number;
  readonly pictureId?: number;
  /** Optional named bindings for the new room logic and picture. */
  readonly roomName?: string;
  readonly pictureName?: string;
  readonly title?: string;
  readonly description?: string;
  /** An existing view to place as the hero (number or view binding name). */
  readonly heroView?: number | string;
  readonly spawn?: { readonly x: number; readonly y: number; readonly horizon?: number };
}

export function prepareGuidedAddRoom(ctx: GuidedContext, input: GuidedAddRoomInput): GuidedOutcome {
  const kind: GuidedOperationKind = "add-room";
  const title = (input.title ?? "").trim();
  const label = title ? `Add room "${title}"` : "Add room";
  const consulted = consult(ctx, kind, label);
  if ("code" in consulted) return consulted;
  const env: Env = { ...consulted, kind, label };

  const logic = allocateResourceId(env, "logic", input.logicId, label, kind);
  if (!("id" in logic)) return logic;
  const picture = allocateResourceId(env, "picture", input.pictureId, label, kind);
  if (!("id" in picture)) return picture;
  const logicId = logic.id;
  const pictureId = picture.id;

  const bindings: Bindings = { ...env.bindings };
  for (const [name, bindingKind, num] of [
    [input.roomName, "logic", logicId],
    [input.pictureName, "picture", pictureId],
  ] as const) {
    if (name === undefined) continue;
    if (!BINDING_NAME.test(name))
      return refuse(
        kind,
        label,
        "invalid-input",
        `Binding name '${name}' must be a lowercase identifier of at most 64 characters.`,
      );
    const existing = bindings[name];
    if (existing && (existing.kind !== bindingKind || existing.num !== num))
      return refuse(
        kind,
        label,
        "occupied",
        `'${name}' already names ${existing.kind} ${existing.num}, not ${bindingKind} ${num}.`,
        "bindings",
      );
    bindings[name] = { kind: bindingKind, num };
  }

  let heroView: number | null = null;
  let heroRef = "";
  if (input.heroView !== undefined) {
    const ref = resourceRef(env, input.heroView, "view");
    if (!("num" in ref)) return ref;
    heroView = ref.num;
    heroRef = ref.text;
    if (env.documents[`view:${heroView}`] === undefined)
      return refuse(kind, label, "missing", `VIEW ${heroView} does not exist.`, `view:${heroView}`);
  }

  const spawn = input.spawn ?? { x: 80, y: 140 };
  if (!intIn(spawn.x, 0, 159) || !intIn(spawn.y, 0, 167) || !intIn(spawn.horizon ?? 36, 0, 166))
    return refuse(
      kind,
      label,
      "invalid-input",
      "spawn.x must be 0..159, spawn.y 0..167, spawn.horizon 0..166.",
    );
  const horizon = spawn.horizon ?? 36;

  if (heroView !== null) {
    const view = viewOf(env, heroView);
    const foot = view && footprint(view);
    if (!view || !foot)
      return refuse(
        kind,
        label,
        "missing",
        `VIEW ${heroView} has no drawable cel.`,
        `view:${heroView}`,
      );
    if (spawn.x + foot.width > 160 || spawn.y < foot.height - 1 || spawn.y <= horizon)
      return refuse(
        kind,
        label,
        "invalid-input",
        `Spawn (${spawn.x},${spawn.y}) does not fit the ${foot.width}x${foot.height} ego inside the picture and below horizon ${horizon}.`,
      );
  }

  const roomTitle = title || `Room ${logicId}`;
  if (roomTitle.length > 160)
    return refuse(kind, label, "invalid-input", "title must be at most 160 characters.");
  const description = input.description ?? "";
  if (description.length > 4000)
    return refuse(kind, label, "invalid-input", "description must be at most 4000 characters.");

  // load.pic/draw.pic read the picture number from a variable. Allocate a
  // genuinely free slot — kept native operands, variable bindings and every
  // dirty logic source all count — under a readable name so no gameplay
  // variable is silently overwritten.
  const picVarName = freeBindingName(bindings, "pic_num");
  const picVar = allocateState(env, label, kind, "variable", bindings);
  if (!("num" in picVar)) return picVar;
  bindings[picVarName] = { kind: "variable", num: picVar.num };

  const picRef = input.pictureName !== undefined ? input.pictureName : String(pictureId);
  const lines: string[] = [
    `// ${roomTitle} — an empty room. The f5 block runs once on room entry: draw`,
    `// the picture${heroView !== null ? ", place ego, then hand control to the player" : ""}.`,
    `if (isset(f5)) {`,
    `  assignn(${picVarName}, ${picRef});`,
    `  load.pic(${picVarName});`,
    `  draw.pic(${picVarName});`,
    `  show.pic();`,
  ];
  if (heroView !== null) {
    lines.push(
      `  set.horizon(${horizon});`,
      `  animate.obj(o0);`,
      `  load.view(${heroRef});`,
      `  set.view(o0, ${heroRef});`,
    );
    const view = viewOf(env, heroView)!;
    if (view.loops.length > 2) lines.push(`  set.loop(o0, 2);`);
    lines.push(`  position(o0, ${spawn.x}, ${spawn.y});`, `  draw(o0);`, `  player.control();`);
  }
  lines.push(`  accept.input();`, `}`, `return;`, ``);
  const roomSource = lines.join("\n");
  const picSource = `# ${roomTitle} — an empty picture. Draw on it or replace it.\nend\n`;

  const world: World = JSON.parse(JSON.stringify(env.world)) as World;
  const planned = world.rooms[String(logicId)];
  world.rooms[String(logicId)] = {
    title: roomTitle,
    description,
    exits: planned?.exits ?? {},
  };

  const changes: GuidedChange[] = [
    { key: `logic:${logicId}`, content: roomSource },
    { key: `picture:${pictureId}`, content: picSource },
    { key: "world", content: worldDocument(world) },
  ];
  if (bindingsDocument(bindings) !== bindingsDocument(env.bindings))
    changes.push({ key: "bindings", content: bindingsDocument(bindings) });

  return finish(
    ctx,
    env,
    changes,
    new Map([
      [`logic:${logicId}`, [{ start: 0, end: roomSource.length }]],
      [`picture:${pictureId}`, [{ start: 0, end: picSource.length }]],
    ]),
    new Map([
      [`logic:${logicId}`, roomSource],
      [`picture:${pictureId}`, picSource],
    ]),
  );
}

// ---------- 2. Place hero ----------

export interface GuidedPlaceHeroInput {
  /** The room LOGIC number whose entry block places ego. */
  readonly room: number;
  /** A new existing view (number or view binding name); omit to keep it. */
  readonly view?: number | string;
  readonly x?: number;
  readonly y?: number;
}

export function prepareGuidedPlaceHero(
  ctx: GuidedContext,
  input: GuidedPlaceHeroInput,
): GuidedOutcome {
  const kind: GuidedOperationKind = "place-hero";
  const label = "Place hero";
  const consulted = consult(ctx, kind, label);
  if ("code" in consulted) return consulted;
  const env: Env = { ...consulted, kind, label };

  if (!intIn(input.room, 1, 255))
    return refuse(kind, label, "invalid-input", "room must be a LOGIC id 1..255.");
  if (input.view === undefined && input.x === undefined && input.y === undefined)
    return refuse(kind, label, "invalid-input", "Nothing to change: give a view or a position.");

  const found = roomSourceOf(env, input.room);
  if (!found.ok) return found;
  const { key, source, room } = found;
  const recognized = recognizeEgoSetup(room);
  if (!recognized.ok)
    return refuse(
      kind,
      label,
      "custom-code",
      `This room's entry is custom code: ${recognized.problem}.`,
      key,
    );
  const setup = recognized.setup;
  const install = actorFreeEntry(room.program, env.profile);
  if (install && (input.view === undefined || input.x === undefined || input.y === undefined))
    return refuse(
      kind,
      label,
      "custom-code",
      "Choose a VIEW and a position to install the hero.",
      key,
    );

  const edits: TextEdit[] = [];
  let viewNum: number | null = numRef(setup.setView?.args[1]);
  const oldView = viewNum;

  if (input.view !== undefined) {
    const ref = resourceRef(env, input.view, "view");
    if (!("num" in ref)) return ref;
    if (env.documents[`view:${ref.num}`] === undefined)
      return refuse(kind, label, "missing", `VIEW ${ref.num} does not exist.`, `view:${ref.num}`);
    if (!install && (!setup.setView || oldView === null))
      return refuse(
        kind,
        label,
        "custom-code",
        "The entry block does not name ego's view with a literal; edit it by hand.",
        key,
      );
    const loads = setup.loadViews.filter(
      (stmt) => stmt.args.length === 1 && numRef(stmt.args[0]) === oldView,
    );
    if (!install && loads.length === 0)
      return refuse(
        kind,
        label,
        "custom-code",
        `The entry block never loads view ${oldView} literally; edit it by hand.`,
        key,
      );
    const view = viewOf(env, ref.num);
    if (
      !view ||
      !footprint(view) ||
      (install &&
        !view.loops.some((loop) =>
          loop.cels.some((cel) => cel.pixels.some((pixel) => pixel !== cel.transparentColor)),
        ))
    )
      return refuse(
        kind,
        label,
        "missing",
        `VIEW ${ref.num} has no drawable cel.`,
        `view:${ref.num}`,
      );
    for (const loop of setup.setLoops) {
      const loopNum = numRef(loop.args[1]);
      if (loopNum !== null && loopNum >= view.loops.length)
        return refuse(
          kind,
          label,
          "invalid-input",
          `VIEW ${ref.num} has ${view.loops.length} loop(s); the room asks for loop ${loopNum}.`,
          `view:${ref.num}`,
        );
    }
    if (!install) {
      const setViewSpan = callArgSpan(room, setup.setView!, 1);
      if (!setViewSpan)
        return refuse(kind, label, "custom-code", "The set.view argument is not writable.", key);
      edits.push({ ...setViewSpan, text: ref.text });
      for (const load of loads) {
        const span = callArgSpan(room, load, 0);
        if (!span)
          return refuse(kind, label, "custom-code", "The load.view argument is not writable.", key);
        edits.push({ ...span, text: ref.text });
      }
    }
    viewNum = ref.num;
  }

  let px: number | null = null;
  let py: number | null = null;
  if (input.x !== undefined || input.y !== undefined) {
    if (!install && !setup.position)
      return refuse(
        kind,
        label,
        "custom-code",
        "The entry block has no literal position(o0, x, y) to move.",
        key,
      );
    const oldX = numRef(setup.position?.args[1]);
    const oldY = numRef(setup.position?.args[2]);
    if (!install && (oldX === null || oldY === null))
      return refuse(
        kind,
        label,
        "custom-code",
        "ego's position is not written as plain numbers; edit it by hand.",
        key,
      );
    px = input.x ?? oldX;
    py = input.y ?? oldY;
    if (!intIn(px, 0, 159) || !intIn(py, 0, 167))
      return refuse(kind, label, "invalid-input", "x must be 0..159 and y 0..167.");
    if (!install) {
      const xSpan = callArgSpan(room, setup.position!, 1);
      const ySpan = callArgSpan(room, setup.position!, 2);
      if (!xSpan || !ySpan)
        return refuse(kind, label, "custom-code", "The position arguments are not writable.", key);
      edits.push({ ...xSpan, text: String(px) }, { ...ySpan, text: String(py) });
    }
  } else if (setup.position) {
    px = numRef(setup.position.args[1]);
    py = numRef(setup.position.args[2]);
  }

  if (viewNum !== null && px !== null && py !== null) {
    const view = viewOf(env, viewNum);
    const foot = view && footprint(view);
    if (foot) {
      if (px + foot.width > 160 || py < foot.height - 1)
        return refuse(
          kind,
          label,
          "invalid-input",
          `The ${foot.width}x${foot.height} ego does not fit at (${px},${py}) inside the picture.`,
        );
      if (setup.horizon !== "dynamic" && py <= setup.horizon)
        return refuse(
          kind,
          label,
          "invalid-input",
          `ego at y=${py} is not below the room's horizon ${setup.horizon}.`,
        );
      const pic = roomPicture(room, setup.init);
      if (pic !== null) {
        const surface = pictureSurface(env, pic);
        if (surface) {
          let blocked = false;
          for (let x = px; x < Math.min(px + foot.width, 160) && !blocked; x++)
            if (surface[py * 160 + x] === 0 || surface[py * 160 + x] === 1) blocked = true;
          if (blocked)
            return refuse(
              kind,
              label,
              "invalid-input",
              `ego's baseline at (${px},${py}) stands on the picture's walk barrier.`,
            );
        }
      }
    }
  }

  if (install) {
    const lines = [
      "animate.obj(o0);",
      `load.view(${viewNum});`,
      `set.view(o0, ${viewNum});`,
      `position(o0, ${px}, ${py});`,
      "draw(o0);",
      "player.control();",
    ];
    // Install before an entry message can suspend the running game.
    const wait = setup.init.then.find(
      (stmt) =>
        stmt.type === "action" &&
        ["print", "print.v", "print.at", "print.at.v", "get.num", "get.string", "pause"].includes(
          stmt.name,
        ),
    );
    let insertion: TextEdit | "shared-line";
    if (wait) {
      const start = wait.tok.start - room.base;
      const lineStart = source.lastIndexOf("\n", start - 1) + 1;
      const indent = source.slice(lineStart, start);
      insertion =
        indent.trim() === "" ? insertLinesEdit(source, lineStart, indent, lines) : "shared-line";
    } else insertion = insertAtThenEnd(room, setup.init, lines);
    if (insertion === "shared-line")
      return refuse(
        kind,
        label,
        "custom-code",
        "Put the entry block's closing brace on its own line.",
        key,
      );
    edits.push(insertion);
  }

  const result = spliceText(source, edits);
  const texts = new Map([[key, result.text]]);
  const previews = new Map([[key, result.spans]]);
  return finish(ctx, env, [{ key, content: result.text }], previews, texts);
}

// ---------- 3. Respond to command ----------

export interface GuidedRespondInput {
  readonly room: number;
  /** The phrase to answer, e.g. "wave" or "look at the sign". */
  readonly command: string;
  /** The message to print, plain text. */
  readonly response: string;
  /**
   * Rewrite an existing identical handler's reply instead of refusing.
   * Only applies when the existing handler is a plain `said() → print`.
   */
  readonly replaceExisting?: boolean;
}

/**
 * The word-id sequence a `said(...)` condition compiles to, by the
 * assembler's own operand rule: the "*" and "..." spellings always emit the
 * any-word and rest-of-line ids — even when the game's dictionary claims
 * them — so the ordinary word lookup runs only when no reserved spelling is
 * present, and still has to meet the assembler's u16 operand range. Where it
 * declines, the remaining spellings and sigil operands resolve directly:
 * "anyword"/"rol" yield the reserved ids only when the dictionary does not
 * claim them, and a v/f/o/m/s operand emits its index. Null when a quoted
 * word is not in the dictionary: that said cannot assemble, so it can
 * consume nothing.
 */
function saidSeqIds(
  cond: TestExpr & { type: "cond" },
  dictionary: ReadonlyMap<string, number>,
): number[] | null {
  const reserved = cond.args.some(
    (arg) =>
      arg.kind === "str" && (arg.text.toLowerCase() === "*" || arg.text.toLowerCase() === "..."),
  );
  const direct = reserved ? null : saidWordIds(cond, dictionary);
  if (direct !== null)
    return direct.every((id) => Number.isInteger(id) && id >= 0 && id <= 65535) ? direct : null;
  const ids: number[] = [];
  for (const arg of cond.args) {
    let id: number;
    if (arg.kind === "str") {
      const word = arg.text.toLowerCase();
      const found = dictionary.get(word);
      if (word === "*" || (word === "anyword" && found === undefined)) id = SAID_ANY_WORD;
      else if (word === "..." || (word === "rol" && found === undefined)) id = SAID_REST;
      else if (found === undefined) return null;
      else id = found;
    } else {
      id = arg.kind === "num" ? arg.value : arg.index;
    }
    if (!Number.isInteger(id) || id < 0 || id > 65535) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * Whether a said() word sequence answers a command with the given retained
 * words — the same scan the interpreter's word-sequence condition runs:
 * operand 1 matches any one retained word, and where the selected profile
 * recognizes the rest-of-line terminator a 9999 ends the pattern
 * successfully mid-input. Otherwise every retained word must be consumed
 * exactly, so a literal prefix like said("look") does not answer
 * "look north" while said(100, 1) and said(100, 9999) do.
 */
function saidSeqConsumes(
  seq: readonly number[],
  input: readonly number[],
  tailTerminator: boolean,
): boolean {
  let wi = 0;
  for (const p of seq) {
    if (p === SAID_REST && tailTerminator) return true;
    if (wi >= input.length) return false;
    if (p !== SAID_ANY_WORD && p !== input[wi]) return false;
    wi++;
  }
  return wi === input.length;
}

/** Top-level `if`s whose test mentions said(), with their resolved word sequences. */
function commandHandlers(
  room: ParsedRoom,
  dictionary: ReadonlyMap<string, number>,
): { stmt: IfStmt; seqs: number[][] }[] {
  const handlers: { stmt: IfStmt; seqs: number[][] }[] = [];
  for (const stmt of room.program) {
    if (stmt.type !== "if") continue;
    const seqs = testConds(stmt.test)
      .filter((cond) => cond.name === "said")
      .map((cond) => saidSeqIds(cond, dictionary))
      .filter((seq): seq is number[] => seq !== null);
    if (seqs.length > 0) handlers.push({ stmt, seqs });
  }
  return handlers;
}

export function prepareGuidedRespondToCommand(
  ctx: GuidedContext,
  input: GuidedRespondInput,
): GuidedOutcome {
  const kind: GuidedOperationKind = "respond-to-command";
  const label = `Respond to "${(input.command ?? "").trim() || "?"}"`;
  const consulted = consult(ctx, kind, label);
  if ("code" in consulted) return consulted;
  const env: Env = { ...consulted, kind, label };

  if (!intIn(input.room, 1, 255))
    return refuse(kind, label, "invalid-input", "room must be a LOGIC id 1..255.");
  const tokens = typeof input.command === "string" ? normalizeCommand(input.command) : null;
  if (!tokens)
    return refuse(
      kind,
      label,
      "invalid-input",
      "Command must be 1 to 10 words of lowercase letters and digits.",
    );
  const response = input.response;
  if (
    typeof response !== "string" ||
    response.trim().length === 0 ||
    response.length > 512 ||
    [...response].some((ch) => ch.codePointAt(0)! > 0xff)
  )
    return refuse(
      kind,
      label,
      "invalid-input",
      "Response must be 1 to 512 displayable characters.",
    );

  const found = roomSourceOf(env, input.room);
  if (!found.ok) return found;
  const { key, source, room } = found;

  const entries: WordEntry[] = env.words.map((entry) => ({ ...entry }));
  const dictionary = new Map(env.dictionary);
  const resolved = commandWordIds(tokens, entries, dictionary);
  if (resolved === "ignored")
    return refuse(
      kind,
      label,
      "invalid-input",
      "Every word in that command is an ignored filler word.",
    );
  if (resolved === "exhausted")
    return refuse(kind, label, "occupied", "The dictionary has no free word ids left.");
  const { retained, added } = resolved;
  const newSeq = retained.map((text) => dictionary.get(text)!);

  const handlers = commandHandlers(room, dictionary);
  const identical = handlers.filter((handler) =>
    handler.seqs.some(
      (seq) => seq.length === newSeq.length && seq.every((v, i) => v === newSeq[i]),
    ),
  );
  const shadowing = handlers.filter((handler) =>
    handler.seqs.some((seq) =>
      saidSeqConsumes(seq, newSeq, env.profile.wordSequenceTailTerminator),
    ),
  );

  const changes: GuidedChange[] = [];
  const previews = new Map<string, { start: number; end: number }[]>();
  const texts = new Map<string, string>();

  if (identical.length > 0) {
    const handler = identical[0]!;
    if (!input.replaceExisting)
      return refuse(
        kind,
        label,
        "conflict",
        `The room already answers '${retained.join(" ")}'. Choose another command or ask to replace its reply.`,
        key,
        {
          start: lineOf(source, handler.stmt.tok.start - room.base),
          end: lineOf(source, handler.stmt.end - room.base),
        },
      );
    // Replace only the plain `if (said(…)) { print(…); }` shape.
    const only = handler.stmt.then[0];
    if (
      handler.stmt.else_ !== null ||
      handler.stmt.test.type !== "cond" ||
      handler.stmt.then.length !== 1 ||
      !only ||
      only.type !== "action" ||
      only.name !== "print" ||
      only.args.length !== 1
    )
      return refuse(
        kind,
        label,
        "custom-code",
        "The existing handler for that command is not a plain said→print; edit it by hand.",
        key,
        {
          start: lineOf(source, handler.stmt.tok.start - room.base),
          end: lineOf(source, handler.stmt.end - room.base),
        },
      );
    const print = only;
    const arg = print.args[0]!;
    const quoted = quoteLogicString(response);
    let edit: TextEdit;
    if (arg.kind === "str") {
      const span = stmtTokens(room, print).find((t) => t.type === "string") ?? null;
      if (!span)
        return refuse(kind, label, "custom-code", "The reply text is not a plain string.", key);
      edit = { start: span.start - room.base, end: span.end - room.base, text: quoted };
    } else {
      const num = arg.kind === "m" ? arg.index : numRef(arg);
      if (num === null)
        return refuse(kind, label, "custom-code", "The reply is not a plain message.", key);
      const directive = messageDirectives(room).find((d) => d.num === num);
      if (!directive)
        return refuse(
          kind,
          label,
          "custom-code",
          `Message ${num} has no #message directive to rewrite; edit it by hand.`,
          key,
        );
      edit =
        directive.stringStart !== undefined
          ? { start: directive.stringStart, end: directive.end, text: quoted }
          : { start: directive.start, end: directive.end, text: `#message ${num} ${quoted}` };
    }
    const result = spliceText(source, [edit]);
    changes.push({ key, content: result.text });
    previews.set(key, [{ start: edit.start, end: edit.start + edit.text.length }]);
    texts.set(key, result.text);
    if (added.length > 0) changes.push({ key: "words", content: wordsDocument(entries) });
    return finish(ctx, env, changes, previews, texts);
  }

  if (shadowing.length > 0) {
    const handler = shadowing[0]!;
    return refuse(
      kind,
      label,
      "conflict",
      `An earlier handler would answer '${retained.join(" ")}' first; pick different words or edit the source.`,
      key,
      {
        start: lineOf(source, handler.stmt.tok.start - room.base),
        end: lineOf(source, handler.stmt.end - room.base),
      },
    );
  }

  const said = `said(${retained.map((word) => quoteLogicString(word)).join(", ")})`;
  const handlerLines = [`if (${said}) {`, `  print(${quoteLogicString(response)});`, `}`];
  const inserted = insertBeforeFinalReturn(room, handlerLines);
  if (inserted === "shared-line" || inserted === null)
    return refuse(
      kind,
      label,
      "custom-code",
      "The room's closing `return;` does not stand on its own line; edit the source first.",
      key,
    );
  const result = spliceText(source, [inserted]);
  changes.push({ key, content: result.text });
  previews.set(key, [{ start: inserted.start, end: inserted.start + inserted.text.length }]);
  texts.set(key, result.text);
  if (added.length > 0) changes.push({ key: "words", content: wordsDocument(entries) });
  return finish(ctx, env, changes, previews, texts);
}

// ---------- 4. Connect door ----------

export interface GuidedConnectDoorInput {
  readonly room: number;
  readonly destination: number;
  /** The doorway region in the source room: ego baseline inside → walk through. */
  readonly box: RuleBox;
  readonly label?: string;
  /** Rule id; defaults to `door-<destination>` (suffixed if taken). */
  readonly id?: string;
  /** A mirrored doorway in the destination, leading back. */
  readonly returnDoor?: {
    readonly box: RuleBox;
    readonly label?: string;
    readonly id?: string;
    /** Where ego stands back in this room after returning; defaults to the room's own spawn. */
    readonly arrival?: { readonly x: number; readonly y: number };
  };
  /** Where ego stands in the destination after walking through (for the return). */
  readonly arrival?: { readonly x: number; readonly y: number };
}

function doorRuleLines(id: string, labelText: string, box: RuleBox, destination: number): string[] {
  return [
    `// @rule ${id} ${JSON.stringify(labelText)} exit`,
    `if (posn(o0, ${box.x1}, ${box.y1}, ${box.x2}, ${box.y2})) {`,
    `  new.room(${destination});`,
    `}`,
    `// @end`,
  ];
}

export function prepareGuidedConnectDoor(
  ctx: GuidedContext,
  input: GuidedConnectDoorInput,
): GuidedOutcome {
  const kind: GuidedOperationKind = "connect-door";
  const label = `Connect room ${input.room} to room ${input.destination}`;
  const consulted = consult(ctx, kind, label);
  if ("code" in consulted) return consulted;
  const env: Env = { ...consulted, kind, label };

  if (!intIn(input.room, 1, 255) || !intIn(input.destination, 1, 255))
    return refuse(kind, label, "invalid-input", "room and destination must be LOGIC ids 1..255.");
  const box = input.box;
  if (!box || !boxValid(box))
    return refuse(
      kind,
      label,
      "invalid-input",
      "The doorway box needs x1<=x2 within 0..159 and y1<=y2 within 0..167.",
    );

  const srcFound = roomSourceOf(env, input.room);
  if (!srcFound.ok) return srcFound;
  const src = srcFound;
  if (env.documents[`logic:${input.destination}`] === undefined)
    return refuse(
      kind,
      label,
      "missing",
      `There is no room LOGIC ${input.destination}; add the room first.`,
      `logic:${input.destination}`,
    );

  const srcScan = scanRules(src.source);
  if (srcScan.blocker)
    return refuse(
      kind,
      label,
      "custom-code",
      `The room's rule annotations are broken (${srcScan.blocker}); edit the source first.`,
      src.key,
    );

  for (const stmt of src.room.program) {
    const door = doorExitOf(stmt);
    if (
      door &&
      door.destination === input.destination &&
      door.box.x1 === box.x1 &&
      door.box.y1 === box.y1 &&
      door.box.x2 === box.x2 &&
      door.box.y2 === box.y2
    )
      return refuse(
        kind,
        label,
        "conflict",
        `That doorway to room ${input.destination} already exists.`,
        src.key,
        {
          start: lineOf(src.source, stmt.tok.start - src.room.base),
          end: lineOf(src.source, stmt.end - src.room.base),
        },
      );
  }

  // Entering the room at its own spawn must not stand inside the doorway.
  const srcSetup = recognizeEgoSetup(src.room);
  if (srcSetup.ok && srcSetup.setup.position) {
    const sx = numRef(srcSetup.setup.position.args[1]);
    const sy = numRef(srcSetup.setup.position.args[2]);
    if (sx !== null && sy !== null && insideBox(sx, sy, box))
      return refuse(
        kind,
        label,
        "conflict",
        `The room's own spawn (${sx},${sy}) stands inside this doorway; it would retrigger on entry.`,
        src.key,
      );
  }

  const srcId = input.id ?? freeRuleId(srcScan.rules, `door-${input.destination}`);
  if (srcId === null || !RULE_ID.test(srcId))
    return refuse(
      kind,
      label,
      "occupied",
      "No free rule id is available for this doorway (or the given id is invalid).",
      src.key,
    );
  if (srcScan.rules.some((rule) => rule.id === srcId))
    return refuse(kind, label, "occupied", `Rule id '${srcId}' is already used.`, src.key);
  const srcLabel =
    (input.label ?? `To room ${input.destination}`).trim() || `To room ${input.destination}`;
  if (srcLabel.length > 80 || /[\n"]/.test(srcLabel))
    return refuse(
      kind,
      label,
      "invalid-input",
      "Door labels must be one line of up to 80 characters.",
    );

  const changes: GuidedChange[] = [];
  const previews = new Map<string, { start: number; end: number }[]>();
  const texts = new Map<string, string>();
  const srcEdits: TextEdit[] = [];

  const ruleLines = doorRuleLines(srcId, srcLabel, box, input.destination);
  const inserted = insertBeforeFinalReturn(src.room, ruleLines);
  if (inserted === "shared-line" || inserted === null)
    return refuse(
      kind,
      label,
      "custom-code",
      "The room's closing `return;` does not stand on its own line; edit the source first.",
      src.key,
    );
  srcEdits.push(inserted);

  const world: World = JSON.parse(JSON.stringify(env.world)) as World;
  const ensureRoomMeta = (num: number) =>
    (world.rooms[String(num)] ??= { title: `Room ${num}`, description: "", exits: {} });
  ensureRoomMeta(input.room).exits[srcId] = input.destination;

  if (input.returnDoor !== undefined || input.arrival !== undefined) {
    const destFound = roomSourceOf(env, input.destination);
    if (!destFound.ok) return destFound;
    const dest = destFound;
    const destScan = scanRules(dest.source);
    if (destScan.blocker)
      return refuse(
        kind,
        label,
        "custom-code",
        `The destination's rule annotations are broken (${destScan.blocker}); edit the source first.`,
        dest.key,
      );

    const edits: TextEdit[] = [];
    if (input.returnDoor !== undefined) {
      const ret = input.returnDoor;
      if (!boxValid(ret.box))
        return refuse(
          kind,
          label,
          "invalid-input",
          "The return doorway box needs x1<=x2 within 0..159 and y1<=y2 within 0..167.",
        );
      for (const stmt of dest.room.program) {
        const door = doorExitOf(stmt);
        if (
          door &&
          door.destination === input.room &&
          door.box.x1 === ret.box.x1 &&
          door.box.y1 === ret.box.y1 &&
          door.box.x2 === ret.box.x2 &&
          door.box.y2 === ret.box.y2
        )
          return refuse(
            kind,
            label,
            "conflict",
            `That doorway back to room ${input.room} already exists.`,
            dest.key,
            {
              start: lineOf(dest.source, stmt.tok.start - dest.room.base),
              end: lineOf(dest.source, stmt.end - dest.room.base),
            },
          );
      }
      const retId = ret.id ?? freeRuleId(destScan.rules, `door-${input.room}`);
      if (retId === null || !RULE_ID.test(retId))
        return refuse(
          kind,
          label,
          "occupied",
          "No free rule id is available for the return doorway.",
          dest.key,
        );
      if (destScan.rules.some((rule) => rule.id === retId))
        return refuse(kind, label, "occupied", `Rule id '${retId}' is already used.`, dest.key);
      const retLabel = (ret.label ?? `To room ${input.room}`).trim() || `To room ${input.room}`;
      if (retLabel.length > 80 || /[\n"]/.test(retLabel))
        return refuse(
          kind,
          label,
          "invalid-input",
          "Door labels must be one line of up to 80 characters.",
        );

      const retLines = doorRuleLines(retId, retLabel, ret.box, input.room);
      const retInsert = insertBeforeFinalReturn(dest.room, retLines);
      if (retInsert === "shared-line" || retInsert === null)
        return refuse(
          kind,
          label,
          "custom-code",
          "The destination's closing `return;` does not stand on its own line; edit the source first.",
          dest.key,
        );
      edits.push(retInsert);
      ensureRoomMeta(input.destination).exits[retId] = input.room;
    }

    // Arrival placement: an explicit point, or the destination's own spawn —
    // and it must not stand inside the return doorway. The override also
    // stops ego's carried direction, so walking momentum cannot drift ego
    // back into a doorway after landing.
    const destSetup = recognizeEgoSetup(dest.room);
    let arrival: { x: number; y: number } | null = null;
    if (input.arrival !== undefined) {
      if (!intIn(input.arrival.x, 0, 159) || !intIn(input.arrival.y, 0, 167))
        return refuse(kind, label, "invalid-input", "arrival x must be 0..159 and y 0..167.");
      arrival = { x: input.arrival.x, y: input.arrival.y };
    } else if (destSetup.ok && destSetup.setup.position) {
      const ax = numRef(destSetup.setup.position.args[1]);
      const ay = numRef(destSetup.setup.position.args[2]);
      if (ax !== null && ay !== null) arrival = { x: ax, y: ay };
    }
    const destSpawn = destSetup.ok && destSetup.setup.position ? destSetup.setup.position : null;
    const spawnX = destSpawn ? numRef(destSpawn.args[1]) : null;
    const spawnY = destSpawn ? numRef(destSpawn.args[2]) : null;
    const mustLand =
      input.returnDoor !== undefined ||
      (arrival !== null && (arrival.x !== spawnX || arrival.y !== spawnY));
    if (input.returnDoor !== undefined) {
      if (arrival === null)
        return refuse(
          kind,
          label,
          "invalid-input",
          "Give an arrival point, or let the destination recognize its own entry position first.",
          dest.key,
        );
      if (insideBox(arrival.x, arrival.y, input.returnDoor.box))
        return refuse(
          kind,
          label,
          "invalid-input",
          `Arrival (${arrival.x},${arrival.y}) stands inside the return doorway; ego would loop straight back.`,
          dest.key,
        );
    }
    if (mustLand && arrival !== null) {
      if (!destSetup.ok)
        return refuse(
          kind,
          label,
          "custom-code",
          `The destination's entry block is custom code (${destSetup.problem}); place the arrival point by hand.`,
          dest.key,
        );
      // Only arrivals *from this source room* land at the override point.
      const guard = insertAtThenEnd(dest.room, destSetup.setup.init, [
        `if (equaln(v1, ${input.room})) {`,
        `  position(o0, ${arrival.x}, ${arrival.y});`,
        `  assignn(v6, 0);`,
        `}`,
      ]);
      if (guard === "shared-line")
        return refuse(
          kind,
          label,
          "custom-code",
          "The destination's entry block is not a plain braced block; place the arrival by hand.",
          dest.key,
        );
      edits.push(guard);
    } else if (input.arrival !== undefined && !destSetup.ok) {
      return refuse(
        kind,
        label,
        "custom-code",
        `The destination's entry block is custom code (${destSetup.problem}); place the arrival point by hand.`,
        dest.key,
      );
    }

    // The reciprocal landing: ego stepping back through the mirror doorway
    // arrives in *this* room — outside its doorway, standing still.
    if (input.returnDoor !== undefined) {
      const ret = input.returnDoor;
      let landing: { x: number; y: number } | null = ret.arrival ?? null;
      if (landing !== null && (!intIn(landing.x, 0, 159) || !intIn(landing.y, 0, 167)))
        return refuse(
          kind,
          label,
          "invalid-input",
          "The return landing needs x 0..159 and y 0..167.",
          src.key,
        );
      if (landing === null && srcSetup.ok && srcSetup.setup.position) {
        const lx = numRef(srcSetup.setup.position.args[1]);
        const ly = numRef(srcSetup.setup.position.args[2]);
        if (lx !== null && ly !== null) landing = { x: lx, y: ly };
      }
      if (landing === null)
        return refuse(
          kind,
          label,
          "invalid-input",
          `Give returnDoor.arrival, or let room ${input.room} recognize its own entry position first.`,
          src.key,
        );
      for (const stmt of src.room.program) {
        const door = doorExitOf(stmt);
        if (door && insideBox(landing.x, landing.y, door.box))
          return refuse(
            kind,
            label,
            "conflict",
            `Return landing (${landing.x},${landing.y}) stands inside a doorway to room ${door.destination}; ego would loop straight through.`,
            src.key,
            {
              start: lineOf(src.source, stmt.tok.start - src.room.base),
              end: lineOf(src.source, stmt.end - src.room.base),
            },
          );
      }
      if (!srcSetup.ok)
        return refuse(
          kind,
          label,
          "custom-code",
          `The room's entry block is custom code (${srcSetup.problem}); place the return landing by hand.`,
          src.key,
        );
      const landingGuard = insertAtThenEnd(src.room, srcSetup.setup.init, [
        `if (equaln(v1, ${input.destination})) {`,
        `  position(o0, ${landing.x}, ${landing.y});`,
        `  assignn(v6, 0);`,
        `}`,
      ]);
      if (landingGuard === "shared-line")
        return refuse(
          kind,
          label,
          "custom-code",
          "The room's entry block is not a plain braced block; place the return landing by hand.",
          src.key,
        );
      srcEdits.push(landingGuard);
    }

    if (edits.length > 0) {
      const destResult = spliceText(dest.source, edits);
      changes.push({ key: dest.key, content: destResult.text });
      previews.set(
        dest.key,
        edits.map((e) => ({ start: e.start, end: e.start + e.text.length })),
      );
      texts.set(dest.key, destResult.text);
    }
  }

  const srcResult = spliceText(src.source, srcEdits);
  changes.push({ key: src.key, content: srcResult.text });
  previews.set(
    src.key,
    srcEdits.map((e) => ({ start: e.start, end: e.start + e.text.length })),
  );
  texts.set(src.key, srcResult.text);

  changes.push({ key: "world", content: worldDocument(world) });
  return finish(ctx, env, changes, previews, texts);
}

// ---------- 5. Play sound on event ----------

export type GuidedCueTarget =
  | { readonly type: "command"; readonly command: string }
  | { readonly type: "region"; readonly rule: string };

export interface GuidedPlaySoundInput {
  readonly room: number;
  /** An existing SOUND resource (number or sound binding name). */
  readonly sound: number | string;
  readonly on: GuidedCueTarget;
  /** Teach a new command and create its handler when it has no earlier answer. */
  readonly createCommand?: boolean;
  /** Optional message printed when the sound completes. */
  readonly completionMessage?: string;
  /** Completion flag binding name; defaults to a free `cue_done` variant. */
  readonly flag?: string;
  /** Region retrigger-guard binding name; defaults to a free `cue_started` variant. */
  readonly startFlag?: string;
}

function freeBindingName(bindings: Bindings, stem: string): string {
  if (!bindings[stem]) return stem;
  for (let n = 2; n < 100; n++) if (!bindings[`${stem}_${n}`]) return `${stem}_${n}`;
  return stem;
}

export function prepareGuidedPlaySound(
  ctx: GuidedContext,
  input: GuidedPlaySoundInput,
): GuidedOutcome {
  const kind: GuidedOperationKind = "play-sound";
  const label = "Play a sound";
  const consulted = consult(ctx, kind, label);
  if ("code" in consulted) return consulted;
  const env: Env = { ...consulted, kind, label };

  if (!intIn(input.room, 1, 255))
    return refuse(kind, label, "invalid-input", "room must be a LOGIC id 1..255.");
  const found = roomSourceOf(env, input.room);
  if (!found.ok) return found;
  const { key, source, room } = found;

  const ref = resourceRef(env, input.sound, "sound");
  if (!("num" in ref)) return ref;
  if (env.documents[`sound:${ref.num}`] === undefined)
    return refuse(kind, label, "missing", `SOUND ${ref.num} does not exist.`, `sound:${ref.num}`);

  const message = input.completionMessage;
  if (
    message !== undefined &&
    (typeof message !== "string" ||
      message.trim().length === 0 ||
      message.length > 512 ||
      [...message].some((ch) => ch.codePointAt(0)! > 0xff))
  )
    return refuse(
      kind,
      label,
      "invalid-input",
      "completionMessage must be 1 to 512 displayable characters.",
    );

  const bindings: Bindings = { ...env.bindings };
  const needFlag = (name: string | undefined, stem: string) => {
    const chosen = name ?? freeBindingName(bindings, stem);
    if (!BINDING_NAME.test(chosen))
      return refuse(
        kind,
        label,
        "invalid-input",
        `Flag name '${chosen}' must be a lowercase identifier of at most 64 characters.`,
      );
    const existing = bindings[chosen];
    if (existing && existing.kind !== "flag")
      return refuse(
        kind,
        label,
        "occupied",
        `'${chosen}' already names ${existing.kind} ${existing.num}, not a flag.`,
        "bindings",
      );
    if (existing) return { num: existing.num, name: chosen };
    const allocated = allocateState(env, label, kind, "flag", bindings);
    if (!("num" in allocated)) return allocated;
    bindings[chosen] = { kind: "flag", num: allocated.num };
    return { num: allocated.num, name: chosen };
  };

  const done = needFlag(input.flag, "cue_done");
  if (!("num" in done)) return done;
  if (done.num < 32)
    return refuse(
      kind,
      label,
      "invalid-input",
      `f${done.num} is interpreter-owned (flags 0..31); pick a completion flag at 32 or above.`,
      "bindings",
    );

  const edits: TextEdit[] = [];

  const entries = env.words.map((entry) => ({ ...entry }));
  const dictionary = new Map(env.dictionary);
  let newCommand: string[] = [];

  if (input.on.type === "command") {
    const tokens = typeof input.on.command === "string" ? normalizeCommand(input.on.command) : null;
    if (!tokens)
      return refuse(kind, label, "invalid-input", "The cue command must be 1 to 10 simple words.");
    if (input.createCommand) {
      const resolved = commandWordIds(tokens, entries, dictionary);
      if (resolved === "ignored")
        return refuse(kind, label, "invalid-input", "Type a sentence with a word the game keeps.");
      if (resolved === "exhausted")
        return refuse(kind, label, "occupied", "The dictionary has no free word ids left.");
    }
    const seq: number[] = [];
    const retainedWords: string[] = [];
    for (let index = 0; index < tokens.length;) {
      const match = matchDictionaryPhrase(tokens, index, dictionary);
      index += match.length;
      if (match.id === undefined)
        return refuse(
          kind,
          label,
          "missing",
          `The room's dictionary does not know '${match.text}'.`,
          "words",
        );
      if (match.id !== 0) {
        seq.push(match.id);
        retainedWords.push(match.text);
      }
    }
    if (seq.length === 0)
      return refuse(kind, label, "invalid-input", "The cue command is only filler words.");
    const handlers = commandHandlers(room, dictionary);
    const matches = handlers.filter((handler) =>
      handler.seqs.some((s) => s.length === seq.length && s.every((v, i) => v === seq[i])),
    );
    if (matches.length === 0 && !input.createCommand)
      return refuse(
        kind,
        label,
        "missing",
        `No handler in this room answers '${tokens.join(" ")}'.`,
        key,
      );
    if (matches.length > 1)
      return refuse(
        kind,
        label,
        "custom-code",
        `More than one handler answers '${tokens.join(" ")}'; pick one by hand.`,
        key,
      );
    if (matches.length === 0) {
      if (
        handlers.some((handler) =>
          handler.seqs.some((pattern) =>
            saidSeqConsumes(pattern, seq, env.profile.wordSequenceTailTerminator),
          ),
        )
      )
        return refuse(
          kind,
          label,
          "conflict",
          "An earlier answer uses that sentence. Choose another sentence or edit its LOGIC.",
          key,
        );
      newCommand = [
        `if (said(${retainedWords.map(quoteLogicString).join(", ")})) {`,
        `  load.sound(${ref.text});`,
        `  sound(${ref.text}, ${done.name});`,
        `}`,
      ];
    } else {
      const handler = matches[0]!.stmt;
      if (actionsNamed(handler.then, "sound").length > 0)
        return refuse(
          kind,
          label,
          "conflict",
          `The handler for '${tokens.join(" ")}' already plays a sound; one cue owns the channel.`,
          key,
          {
            start: lineOf(source, handler.tok.start - room.base),
            end: lineOf(source, handler.end - room.base),
          },
        );
      // The cue starts before any modal print window in the handler opens.
      const trigger = insertAtThenStart(room, handler, [
        `load.sound(${ref.text});`,
        `sound(${ref.text}, ${done.name});`,
      ]);
      if (trigger === "shared-line")
        return refuse(
          kind,
          label,
          "custom-code",
          "The handler's body is not a plain braced block; place the cue by hand.",
          key,
        );
      edits.push(trigger);
    }
  } else {
    const wanted = input.on.rule;
    const scan = scanRules(source);
    if (scan.blocker)
      return refuse(
        kind,
        label,
        "custom-code",
        `The room's rule annotations are broken (${scan.blocker}); edit the source first.`,
        key,
      );
    const rule = scan.rules.find((r) => r.id === wanted);
    if (!rule)
      return refuse(kind, label, "missing", `There is no annotated rule '${wanted}'.`, key);
    if (!rule.terminated)
      return refuse(kind, label, "custom-code", `Rule '${wanted}' has no @end.`, key, {
        start: rule.openLine,
        end: rule.closeLine,
      });
    if (rule.kind !== "region")
      return refuse(
        kind,
        label,
        "invalid-input",
        `Rule '${wanted}' is an exit, not a region.`,
        key,
        { start: rule.openLine, end: rule.closeLine },
      );
    const stmt = statementInRule(room, rule);
    const flag = stmt === null ? null : regionFlagOf(stmt);
    if (flag === null)
      return refuse(
        kind,
        label,
        "custom-code",
        `Rule '${wanted}' is not a recognized region; bind the cue by hand.`,
        key,
        { start: rule.openLine, end: rule.closeLine },
      );
    const started = needFlag(input.startFlag, "cue_started");
    if (!("num" in started)) return started;
    if (started.num < 32)
      return refuse(
        kind,
        label,
        "invalid-input",
        `f${started.num} is interpreter-owned (flags 0..31); pick a started guard at 32 or above.`,
        "bindings",
      );
    const ruleRange = { start: rule.openLine, end: rule.closeLine };
    // Numeric identities decide: sound() clears its completion flag when the
    // cue starts, and reset() clears it on completion. If that flag is also
    // the started guard or the region's latch, clearing re-arms them and the
    // cue restarts forever — or, guarding with the latch itself, never fires.
    if (done.num === started.num)
      return refuse(
        kind,
        label,
        "conflict",
        `Completion flag and started guard are both f${done.num}; clearing the completion flag on start would re-arm the guard and restart the cue every cycle.`,
        key,
        ruleRange,
      );
    if (done.num === flag)
      return refuse(
        kind,
        label,
        "conflict",
        `The completion flag is the region's own latch (f${flag}); clearing it would re-arm the once-only region.`,
        key,
        ruleRange,
      );
    if (started.num === flag)
      return refuse(
        kind,
        label,
        "conflict",
        `The started guard is the region's own latch (f${flag}); guarded by its own setter the cue could never fire.`,
        key,
        ruleRange,
      );
    const flagText_ = flagText(env, flag);
    edits.push(
      insertLinesEdit(source, lineStartOffset(source, rule.closeLine + 1), "", [
        `if (isset(${flagText_}) && !isset(${started.name})) {`,
        `  set(${started.name});`,
        `  load.sound(${ref.text});`,
        `  sound(${ref.text}, ${done.name});`,
        `}`,
      ]),
    );
  }

  const completion = [
    ...newCommand,
    `if (isset(${done.name})) {`,
    ...(message !== undefined ? [`  print(${quoteLogicString(message)});`] : []),
    `  reset(${done.name});`,
    `}`,
  ];
  const completionEdit = insertBeforeFinalReturn(room, completion);
  if (completionEdit === "shared-line" || completionEdit === null)
    return refuse(
      kind,
      label,
      "custom-code",
      "The room's closing `return;` does not stand on its own line; edit the source first.",
      key,
    );
  edits.push(completionEdit);

  const result = spliceText(source, edits);
  const changes: GuidedChange[] = [{ key, content: result.text }];
  if (entries.length !== env.words.length)
    changes.push({ key: "words", content: wordsDocument(entries) });
  if (bindingsDocument(bindings) !== bindingsDocument(env.bindings))
    changes.push({ key: "bindings", content: bindingsDocument(bindings) });
  const previews = new Map([
    [key, edits.map((e) => ({ start: e.start, end: e.start + e.text.length }))],
  ]);
  const texts = new Map([[key, result.text]]);
  return finish(ctx, env, changes, previews, texts);
}
