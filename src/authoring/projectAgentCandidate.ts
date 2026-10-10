/**
 * Provider-free bridge between a ProjectDraft snapshot and the whole-game
 * authoring tools.
 *
 * captureAgentWorkspace freezes the draft's complete document set — authored
 * text and retained native bytes, including source that does not yet compile —
 * so an assistant can read it, offer an explicit bounded change set, or stage
 * whole-game tools inside an isolated AgentSessionState. Nothing here applies,
 * keeps, installs or contacts a provider: the only outcome is an opaque draft
 * proposal whose staleness and foreign-workspace checks remain the draft's own.
 *
 * A capture that cannot compile still offers exact document reads and the
 * repair-capable direct proposal path; whole-game tools open only over an
 * image that actually compiles, so they never silently edit a different kept
 * image while pretending to represent the broken draft.
 */
import { createAgentSessionState, type AgentSessionState } from "../agent/agentState.ts";
import { GAME_TESTS_FILE, parseGameTests } from "../agent/gameTestFormat.ts";
import { openContainer } from "../container/container.ts";
import { buildWordsTok, parseWordsTok } from "../logic/words.ts";
import { PROFILES, type AgiProfile, type ProfileId } from "../runtime/profile.ts";
import {
  isSoundDocumentEnvelopeClaim,
  readSoundDocumentSource,
  type SoundSourceBody,
} from "../sound/source.ts";
import { RESOURCE_KINDS, type ResourceKind } from "../types.ts";
import type { BuildViewInput } from "../view/view.ts";
import {
  createAuthoringState,
  validateAuthoringState,
  type AuthoringState,
} from "./authoringState.ts";
import {
  compileProjectDocuments,
  ProjectDocumentCompileError,
  readBindingsDocument,
  readMusicDocument,
  readProjectDocuments,
  type ProjectDocumentsCompile,
} from "./projectDocuments.ts";
import { checkProjectDocumentKey, type ProjectDraft } from "./projectDraft.ts";
import { inspectProjectReferences } from "./projectReferences.ts";

type DocumentContent = string | Uint8Array;

/** One explicit document edit offered for review: content, or null to delete. */
interface AgentDocumentChange {
  readonly key: string;
  readonly content: DocumentContent | null;
}

type ReferenceFinding = ReturnType<typeof inspectProjectReferences>["diagnostics"][number];
type AgentWorkspaceSnapshot = ReturnType<ProjectDraft["capture"]>;
type AgentWorkspaceProposal = ReturnType<ProjectDraft["propose"]>;

export interface AgentCandidateDiagnostic {
  /** The document a refusal or finding belongs to, or null when it has none. */
  readonly key: string | null;
  readonly severity: "error" | "warning";
  readonly message: string;
}

/**
 * A defect the captured game already had. Original releases ship directory
 * entries that point past their volumes or into other records, logics that
 * call absent logics, and bytecode the decoder cannot read (docs/testing.md,
 * "Fixture notes"); the interpreter plays them because nothing loads those
 * parts. Every defect carries forward unchanged and never refuses an edit of
 * something else.
 */
export interface AgentWorkspaceDefect {
  /** The document the defect belongs to. */
  readonly key: string;
  readonly cause: "unreadable" | "absent-target" | "unreadable-logic";
  /** The diagnostic as the reader or reference inspection worded it. */
  readonly message: string;
}

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
const KIND_NOUNS: Readonly<Record<string, [string, string]>> = {
  logic: ["LOGIC", "LOGICs"],
  picture: ["picture", "pictures"],
  view: ["view", "views"],
  sound: ["sound", "sounds"],
  words: ["word list", "word lists"],
  inventory: ["item list", "item lists"],
};

function countWord(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function documentName(key: string): string {
  const resource = RESOURCE_KEY.exec(key);
  return resource ? `${resource[1]!.toUpperCase()} ${resource[2]!}` : `the ${key} document`;
}

/**
 * Plain sentences for the person, one per group of defects: what cannot be
 * read or is missing, and that it stays as it is.
 */
export function describeWorkspaceDefects(defects: readonly AgentWorkspaceDefect[]): string[] {
  const unreadable = new Map<string, string[]>();
  const absent = new Map<string, string[]>();
  const sentences: string[] = [];
  for (const defect of defects) {
    const resource = RESOURCE_KEY.exec(defect.key);
    if (defect.cause === "unreadable") {
      const kind = resource ? resource[1]! : defect.key;
      const list = unreadable.get(kind) ?? [];
      if (resource) list.push(resource[2]!);
      unreadable.set(kind, list);
    } else if (defect.cause === "absent-target") {
      const target = /(LOGIC|PICTURE|VIEW|SOUND|Word group|Inventory item) (\d+)/.exec(
        defect.message,
      );
      const name = target ? `${target[1]} ${target[2]}` : "a part";
      const list = absent.get(name) ?? [];
      if (!list.includes(documentName(defect.key))) list.push(documentName(defect.key));
      absent.set(name, list);
    } else if (resource) {
      sentences.push(
        `${documentName(defect.key)} has code this editor cannot read, so it stays as it is.`,
      );
    } else {
      const noun = KIND_NOUNS[defect.key]?.[0] ?? `${defect.key} document`;
      sentences.push(`The ${noun} in this game cannot be read, so it stays as it is.`);
    }
  }
  for (const [kind, numbers] of unreadable) {
    const nouns = KIND_NOUNS[kind] ?? [kind, kind];
    if (numbers.length === 0) {
      sentences.push(`The ${nouns[0]} in this game cannot be read, so it stays as it is.`);
      continue;
    }
    const plural = numbers.length > 1;
    sentences.push(
      `${capitalize(countWord(numbers.length))} ${plural ? nouns[1] : nouns[0]} in this game (${listWords(numbers)}) cannot be read, so ${plural ? "they stay" : "it stays"} as ${plural ? "they are" : "it is"}.`,
    );
  }
  for (const [name, documents] of absent) {
    const plural = documents.length > 1;
    sentences.push(
      `${listWords(documents)} ${plural ? "refer" : "refers"} to ${name}, which this game does not have. That stays as it is.`,
    );
  }
  return [...new Set(sentences)];
}

/** A refused candidate operation retains document-scoped diagnostics. */
export class AgentCandidateError extends Error {
  readonly diagnostics: readonly AgentCandidateDiagnostic[];

  constructor(message: string, diagnostics: readonly AgentCandidateDiagnostic[] = []) {
    super(message);
    this.name = "AgentCandidateError";
    this.diagnostics = diagnostics;
  }
}

/**
 * A frozen, detached view of one draft capture. `base` is the exact
 * draft-issued snapshot — it is what every proposal consults, so typing after
 * the capture makes a proposal stale through the draft's own compare-and-apply.
 */
export interface AgentWorkspace {
  readonly base: AgentWorkspaceSnapshot;
  readonly profileId: ProfileId;
  /** Whether the captured documents compile under the selected profile. */
  readonly compilable: boolean;
  /** Findings from compiling the captured document set. */
  readonly diagnostics: readonly AgentCandidateDiagnostic[];
  /** Defects the captured game already had; they carry forward unchanged. */
  readonly defects: readonly AgentWorkspaceDefect[];
  /** Owned copies of the complete captured document set. */
  documents(): Readonly<Record<string, DocumentContent>>;
  /**
   * Validate a complete change set against the captured documents and return
   * an opaque draft proposal. Refuses — touching nothing — when the overlaid
   * set does not compile or leaves reference errors.
   */
  propose(label: string, changes: readonly AgentDocumentChange[]): AgentWorkspaceProposal;
  /**
   * Hydrate a fully isolated AgentSessionState over the compiled image.
   * Refuses when the captured documents do not compile or their metadata
   * cannot hydrate honestly.
   */
  openToolState(): AgentToolCandidate;
}

/** An isolated whole-game tool session plus its read-back into a proposal. */
interface AgentToolCandidate {
  readonly state: AgentSessionState;
  finish(label: string, coordinated?: readonly AgentDocumentChange[]): AgentWorkspaceProposal;
}

const RESOURCE_KEY = /^(logic|picture|view|sound):(0|[1-9]\d{0,2})$/;
const AUXILIARY_FILES: Readonly<Record<string, string>> = {
  words: "WORDS.TOK",
  inventory: "OBJECT",
};
const WORLD_FIELDS = ["rooms", "facts", "quests", "launches"];
const UTF8_ENCODE = new TextEncoder();
const UTF8_DECODE = new TextDecoder("utf-8", { fatal: true });

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function copyDocumentMap(
  documents: Readonly<Record<string, DocumentContent>>,
): Record<string, DocumentContent> {
  const out: Record<string, DocumentContent> = Object.create(null);
  for (const [key, content] of Object.entries(documents)) {
    out[key] = content instanceof Uint8Array ? new Uint8Array(content) : content;
  }
  return out;
}

/** Structural JSON equality: key order and whitespace are not differences. */
function sameJsonValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => sameJsonValue(entry, b[index]))
    );
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        Object.hasOwn(b as Record<string, unknown>, key) &&
        sameJsonValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

function safeParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Authored [word, id] pairs, duplicates and case preserved for the codec. */
function wordPairs(value: unknown): { word: string; id: number }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { word: string; id: number }[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [word, id] = entry as unknown[];
    if (typeof word !== "string" || !Number.isInteger(id)) return null;
    out.push({ word, id: id as number });
  }
  return out;
}

function sameDictionary(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [word, id] of a) if (b.get(word) !== id) return false;
  return true;
}

/**
 * The dictionary a words document compiles to, whatever its stored form —
 * folded, sorted and deduplicated exactly like the words codec and compiler,
 * never the raw authored pairs. Null when the content cannot produce one.
 */
function documentDictionary(
  content: DocumentContent | undefined,
): ReadonlyMap<string, number> | null {
  if (content === undefined) return new Map();
  try {
    if (typeof content === "string") {
      const parsed = safeParseJson(content);
      const pairs = parsed.ok ? wordPairs(parsed.value) : null;
      if (pairs === null) return null;
      return new Map(parseWordsTok(buildWordsTok(pairs)).map(({ word, id }) => [word, id]));
    }
    return new Map(parseWordsTok(content).map(({ word, id }) => [word, id]));
  } catch {
    return null;
  }
}

interface InventoryObject {
  readonly name: string;
  readonly startingRoom: number;
}

function normalizeInventory(value: unknown): InventoryObject[] | null {
  if (!Array.isArray(value)) return null;
  const out: InventoryObject[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record["name"] !== "string") return null;
    const room = record["startingRoom"];
    if (room !== undefined && !Number.isInteger(room)) return null;
    out.push({ name: record["name"], startingRoom: room === undefined ? 0 : (room as number) });
  }
  return out;
}

/** Whether two authored documents mean the same playable content. */
function sameDocumentMeaning(key: string, a: string, b: string): boolean {
  const resource = RESOURCE_KEY.exec(key);
  if (resource && (resource[1] === "logic" || resource[1] === "picture")) return a === b;
  const pa = safeParseJson(a);
  const pb = safeParseJson(b);
  if (!pa.ok || !pb.ok) return a === b;
  if (key === "words") {
    const da = documentDictionary(a);
    const db = documentDictionary(b);
    return da !== null && db !== null && sameDictionary(da, db);
  }
  if (key === "inventory") {
    const ia = normalizeInventory(pa.value);
    const ib = normalizeInventory(pb.value);
    return ia !== null && ib !== null && sameJsonValue(ia, ib);
  }
  return sameJsonValue(pa.value, pb.value);
}

/**
 * Whether a source claim states the same content as the captured base
 * document. An unchanged claim whose staged bytes drifted is a tolerated
 * inconsistency; a new or changed claim that cannot reproduce its bytes
 * refuses finish.
 */
function claimMatchesBase(base: DocumentContent | undefined, key: string, claim: string): boolean {
  return typeof base === "string" && sameDocumentMeaning(key, base, claim);
}

function isGameTestsJson(bytes: Uint8Array, profile: AgiProfile): boolean {
  try {
    parseGameTests(bytes, profile);
    return true;
  } catch {
    return false;
  }
}

function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return UTF8_DECODE.decode(bytes);
  } catch {
    return undefined;
  }
}

function diagnostic(
  key: string | null,
  message: string,
  severity: "error" | "warning" = "error",
): AgentCandidateDiagnostic {
  return { key, severity, message };
}

/**
 * Capture the draft's complete document set for agent work. Always succeeds
 * on a well-formed draft — including one whose source does not yet compile —
 * and reports the compile verdict on `compilable`/`diagnostics`. The frozen
 * base, the kept files and every read-back buffer are detached copies.
 */
export function captureAgentWorkspace(input: {
  readonly draft: ProjectDraft;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profileId: ProfileId;
  /** Forwarded to reference inspection; only missing new.room targets soften. */
  readonly allowMissingRooms?: boolean;
}): AgentWorkspace {
  const profile = PROFILES[input.profileId];
  if (!profile) throw new Error(`Unknown AGI profile: ${input.profileId}`);
  const { draft, profileId } = input;
  const allowMissingRooms = input.allowMissingRooms === true;

  // The genuine draft-issued snapshot: proposal authority cannot be forged.
  const snapshot = draft.capture();
  const documents: Record<string, DocumentContent> = Object.create(null);
  for (const key of snapshot.keys) {
    const document = snapshot.read(key);
    if (document) documents[key] = document.content;
  }
  const files: Record<string, Uint8Array> = Object.create(null);
  for (const [name, bytes] of Object.entries(input.files)) files[name] = new Uint8Array(bytes);

  // Indexed slots the base image cannot read. They have no document, no
  // claim can name them, and packing keeps their entry and bytes exactly.
  const baseUnreadable = new Map<string, string>();
  {
    const baseContainer = openContainer(new Map(Object.entries(files)), { profile });
    for (const kind of RESOURCE_KINDS)
      for (let num = 0; num < 256; num++) {
        try {
          baseContainer.getResource(kind, num);
        } catch (error) {
          baseUnreadable.set(
            `${kind}:${num}`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
  }
  const defects: AgentWorkspaceDefect[] = [];
  for (const [key, message] of baseUnreadable) defects.push({ key, cause: "unreadable", message });

  // Reference errors the base already has, counted by document, code,
  // command and message as the edit admission does: byte offsets move with
  // harmless edits, while an additional broken use is new damage.
  const baseFindings = new Map<string, number>();
  const findingMarker = (finding: ReferenceFinding): string =>
    JSON.stringify([finding.document, finding.code, finding.command, finding.message]);

  const diagnostics: AgentCandidateDiagnostic[] = [];
  let compiled: ProjectDocumentsCompile | undefined;
  try {
    compiled = compileProjectDocuments({ files, profileId, documents });
    const bindings = readBindingsDocument(
      typeof documents["bindings"] === "string" ? documents["bindings"] : "{}",
    );
    const container = openContainer(compiled.files(), { profile });
    for (const finding of inspectProjectReferences({
      container,
      profile,
      bindings,
      allowMissingRooms,
    }).diagnostics) {
      diagnostics.push(diagnostic(finding.document, finding.message, finding.severity));
      if (finding.severity !== "error") continue;
      const marker = findingMarker(finding);
      baseFindings.set(marker, (baseFindings.get(marker) ?? 0) + 1);
      if (finding.code === "unreadable-document" && baseUnreadable.has(finding.document)) continue;
      defects.push({
        key: finding.document,
        cause:
          finding.code === "incomplete-logic" || finding.code === "unreadable-document"
            ? "unreadable-logic"
            : "absent-target",
        message: finding.message,
      });
    }
  } catch (error) {
    compiled = undefined;
    diagnostics.push(
      diagnostic(
        error instanceof ProjectDocumentCompileError ? error.key : null,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  /**
   * Compile a complete overlaid document set, then refuse reference errors
   * the change introduces. Errors the base already had carry forward.
   */
  const validateDocuments = (docs: Record<string, DocumentContent>): void => {
    let image: ProjectDocumentsCompile;
    try {
      image = compileProjectDocuments({ files, profileId, documents: docs });
    } catch (error) {
      throw new AgentCandidateError(
        "The change does not build. Fix the part named below, then try again.",
        [
          diagnostic(
            error instanceof ProjectDocumentCompileError ? error.key : null,
            error instanceof Error ? error.message : String(error),
          ),
        ],
      );
    }
    const bindings = readBindingsDocument(
      typeof docs["bindings"] === "string" ? docs["bindings"] : "{}",
    );
    const remaining = new Map(baseFindings);
    const problems = inspectProjectReferences({
      container: openContainer(image.files(), { profile }),
      profile,
      bindings,
      allowMissingRooms,
    })
      .diagnostics.filter((finding) => {
        if (finding.severity !== "error") return false;
        const marker = findingMarker(finding);
        const count = remaining.get(marker) ?? 0;
        if (count === 0) return true;
        remaining.set(marker, count - 1);
        return false;
      })
      .map((finding) => diagnostic(finding.document, finding.message, finding.severity));
    if (problems.length > 0)
      throw new AgentCandidateError(
        "The change refers to a part this game does not have. Add that part or remove the reference, then try again.",
        problems,
      );
  };

  const propose = (
    label: string,
    changes: readonly AgentDocumentChange[],
  ): AgentWorkspaceProposal => {
    const overlaid = copyDocumentMap(documents);
    const seen = new Set<string>();
    for (const { key, content } of changes) {
      checkProjectDocumentKey(key);
      if (seen.has(key)) throw new Error(`Duplicate project document: ${key}`);
      seen.add(key);
      if (content === null) delete overlaid[key];
      else if (typeof content === "string") overlaid[key] = content;
      else if (content instanceof Uint8Array) overlaid[key] = new Uint8Array(content);
      else throw new Error("Project document content must be text, bytes or a deletion.");
    }
    validateDocuments(overlaid);
    return draft.propose(snapshot, label, changes);
  };

  const openToolState = (): AgentToolCandidate => {
    if (!compiled)
      throw new AgentCandidateError(
        "The game does not build right now, so its parts cannot be changed. Fix the part named below, then try again.",
        diagnostics.filter((finding) => finding.severity === "error"),
      );

    const imageFiles = compiled.files();
    const container = openContainer(imageFiles, { profile });

    // The base payloads every read-back comparison is anchored to.
    const basePayloads = new Map<string, Uint8Array>();
    for (const key of Object.keys(documents)) {
      const resource = RESOURCE_KEY.exec(key);
      if (!resource) continue;
      const payload = container.getResource(resource[1] as ResourceKind, Number(resource[2]));
      if (payload) basePayloads.set(key, new Uint8Array(payload));
    }
    for (const [key, name] of Object.entries(AUXILIARY_FILES)) {
      const bytes = imageFiles.get(name);
      if (bytes) basePayloads.set(key, new Uint8Array(bytes));
    }

    // A tests document only maps onto TESTS.JSON when it actually is one;
    // anything else stays an opaque metadata document.
    const testsDocument = documents["tests"];
    let testsBytes: Uint8Array | undefined;
    if (testsDocument !== undefined) {
      const bytes =
        typeof testsDocument === "string"
          ? UTF8_ENCODE.encode(testsDocument)
          : new Uint8Array(testsDocument);
      if (isGameTestsJson(bytes, profile)) {
        testsBytes = bytes;
        container.putFile(GAME_TESTS_FILE, new Uint8Array(bytes));
      }
    }

    const state = createAgentSessionState(container, profile);
    // The captured project already exists — this is not a genesis run.
    state.genesisComplete = true;
    const wordsTok = imageFiles.get("WORDS.TOK");
    const objectFile = imageFiles.get("OBJECT");
    if (wordsTok) state.wordsPayload = new Uint8Array(wordsTok);
    if (objectFile) state.objectPayload = new Uint8Array(objectFile);
    if (testsBytes) state.testsPayload = new Uint8Array(testsBytes);

    // Authored source claims hydrate onto their compiled resources. Envelope
    // sounds keep their exact stored body; native-only resources stay honest.
    for (const [key, content] of Object.entries(documents)) {
      const resource = RESOURCE_KEY.exec(key);
      if (!resource || typeof content !== "string") continue;
      const kind = resource[1] as ResourceKind;
      const num = Number(resource[2]);
      if (kind === "logic") state.sources.logics.set(num, content);
      else if (kind === "picture") state.sources.pictures.set(num, content);
      else if (kind === "view") state.sources.views.set(num, JSON.parse(content) as BuildViewInput);
      else if (kind === "sound") {
        const body = JSON.parse(content) as SoundSourceBody;
        state.sources.sounds.set(
          num,
          isSoundDocumentEnvelopeClaim(body)
            ? readSoundDocumentSource(body, profileId, container.getResource("sound", num))
            : body,
        );
      }
    }
    const inventoryDocument = documents["inventory"];
    if (typeof inventoryDocument === "string") {
      const objects = normalizeInventory(JSON.parse(inventoryDocument));
      if (objects) state.sources.objects = objects.map((item) => ({ ...item }));
    }

    // Authoring state comes from the real documents; a world document the
    // schema cannot round-trip refuses hydration rather than being dropped.
    let bindings: AuthoringState["bindings"];
    try {
      bindings = readBindingsDocument(
        typeof documents["bindings"] === "string" ? documents["bindings"] : "{}",
      );
    } catch (error) {
      throw new AgentCandidateError("The bindings document is not valid authoring state.", [
        diagnostic("bindings", error instanceof Error ? error.message : String(error)),
      ]);
    }
    const worldDocument = documents["world"];
    let world: AuthoringState["world"] = createAuthoringState().world;
    if (worldDocument !== undefined) {
      if (typeof worldDocument !== "string")
        throw new AgentCandidateError("The world document cannot hydrate an authoring state.", [
          diagnostic("world", "expected JSON text"),
        ]);
      const parsed = safeParseJson(worldDocument);
      if (
        !parsed.ok ||
        typeof parsed.value !== "object" ||
        parsed.value === null ||
        Array.isArray(parsed.value) ||
        !Object.keys(parsed.value as Record<string, unknown>).every((field) =>
          WORLD_FIELDS.includes(field),
        )
      )
        throw new AgentCandidateError("The world document cannot hydrate an authoring state.", [
          diagnostic("world", "expected a {rooms, facts, quests, launches} JSON record"),
        ]);
      world = parsed.value as AuthoringState["world"];
    }
    // Authored tempo/inspection intent hydrates from the music document; the
    // compiled set already validated it, and absent means absent.
    let music: AuthoringState["music"];
    const musicDocument = documents["music"];
    if (musicDocument !== undefined) {
      if (typeof musicDocument !== "string")
        throw new AgentCandidateError("The music document cannot hydrate an authoring state.", [
          diagnostic("music", "expected JSON text"),
        ]);
      try {
        music = readMusicDocument(musicDocument);
      } catch (error) {
        throw new AgentCandidateError("The music document cannot hydrate an authoring state.", [
          diagnostic("music", error instanceof Error ? error.message : String(error)),
        ]);
      }
    }
    try {
      state.authoring = validateAuthoringState({ version: 1, music, bindings, world });
    } catch (error) {
      throw new AgentCandidateError("The authoring metadata cannot hydrate an authoring state.", [
        diagnostic("world", error instanceof Error ? error.message : String(error)),
      ]);
    }

    const finish = (
      label: string,
      coordinated: readonly AgentDocumentChange[] = [],
    ): AgentWorkspaceProposal => {
      const problems: AgentCandidateDiagnostic[] = [];
      if (state.profile.id !== profileId)
        problems.push(
          diagnostic(
            null,
            `candidate profile '${state.profile.id}' differs from the captured '${profileId}'`,
          ),
        );
      try {
        validateAuthoringState({
          version: 1,
          bindings: state.authoring.bindings,
          world: createAuthoringState().world,
        });
      } catch (error) {
        problems.push(
          diagnostic("bindings", error instanceof Error ? error.message : String(error)),
        );
      }
      try {
        validateAuthoringState({
          version: 1,
          bindings: {},
          world: state.authoring.world,
        });
      } catch (error) {
        problems.push(diagnostic("world", error instanceof Error ? error.message : String(error)));
      }
      let musicText: string | undefined;
      try {
        if (state.authoring.music !== undefined)
          musicText = JSON.stringify(readMusicDocument(JSON.stringify(state.authoring.music)));
      } catch (error) {
        problems.push(diagnostic("music", error instanceof Error ? error.message : String(error)));
      }
      if (problems.length > 0)
        throw new AgentCandidateError(
          "The change left the game's names, world details or music settings invalid. Correct the part named below, then try again.",
          problems,
        );

      // Reattach every candidate source claim through the real reader: a claim
      // is honored only when it compiles to the candidate bytes exactly.
      const claims: Record<string, string> = Object.create(null);
      for (const [num, source] of state.sources.logics) claims[`logic:${num}`] = source;
      for (const [num, source] of state.sources.pictures) claims[`picture:${num}`] = source;
      for (const [num, source] of state.sources.views)
        claims[`view:${num}`] = JSON.stringify(source);
      for (const [num, source] of state.sources.sounds)
        claims[`sound:${num}`] = JSON.stringify(source);
      const baseWords = documents["words"];
      const baseDictionary = documentDictionary(baseWords);
      if (
        typeof baseWords === "string" ||
        baseDictionary === null ||
        !sameDictionary(baseDictionary, state.sources.words)
      )
        claims["words"] = JSON.stringify([...state.sources.words]);
      if (state.sources.objects !== undefined)
        claims["inventory"] = JSON.stringify(state.sources.objects);

      const stagedFiles = state.getFiles();
      const read = readProjectDocuments({
        files: Object.fromEntries(stagedFiles),
        profileId,
        sources: claims,
        bindings: state.authoring.bindings,
      });

      for (const finding of read.diagnostics) {
        const claim = claims[finding.key];
        // A slot the base could not read either has no claim and no
        // document; it carries forward. A slot that became unreadable, or a
        // claim that does not reproduce its bytes, refuses.
        if (claim === undefined && baseUnreadable.has(finding.key)) continue;
        if (
          claim === undefined ||
          read.documents[finding.key] === undefined ||
          !claimMatchesBase(documents[finding.key], finding.key, claim)
        )
          problems.push(diagnostic(finding.key, finding.message));
      }
      if (problems.length > 0)
        throw new AgentCandidateError(
          "The new text for a part does not match the data it describes. Write the part named below again.",
          problems,
        );

      const stagedPayload = (key: string): { bytes?: Uint8Array; unreadable?: boolean } => {
        const resource = RESOURCE_KEY.exec(key);
        if (resource) {
          try {
            const payload = state.container.getResource(
              resource[1] as ResourceKind,
              Number(resource[2]),
            );
            return payload === null ? {} : { bytes: payload };
          } catch {
            return { unreadable: true };
          }
        }
        const name = AUXILIARY_FILES[key];
        if (name !== undefined) {
          const bytes = stagedFiles.get(name);
          return bytes ? { bytes } : {};
        }
        return {};
      };

      const changeMap = new Map<string, DocumentContent | null>();
      const emit = (key: string, content: DocumentContent | null): void => {
        changeMap.set(key, content);
      };

      // Resource and auxiliary documents: compare what read-back verified
      // against the captured base. A source-backed document whose staged
      // bytes drifted without a verified claim refuses rather than degrade.
      const keys = new Set([...Object.keys(documents), ...Object.keys(read.documents)]);
      for (const key of [...keys].sort()) {
        if (
          key === "bindings" ||
          key === "world" ||
          key === "tests" ||
          key === "references" ||
          key === "music" ||
          key === "notes" ||
          key === "images" ||
          key.startsWith("attachment:")
        )
          continue;
        const base = documents[key];
        const candidate = read.documents[key];
        const staged = stagedPayload(key);
        if (staged.unreadable) {
          problems.push(diagnostic(key, "staged candidate bytes are unreadable"));
          continue;
        }
        if (typeof base === "string") {
          if (typeof candidate === "string") {
            if (!sameDocumentMeaning(key, base, candidate)) emit(key, candidate);
          } else if (candidate instanceof Uint8Array) {
            const basePayload = basePayloads.get(key);
            // Keeping the authored text is honest only while the bytes it
            // describes are untouched; otherwise there is no verified claim
            // left and silently swapping content is not allowed.
            if (!(basePayload && staged.bytes && sameBytes(basePayload, staged.bytes)))
              problems.push(
                diagnostic(key, "native bytes changed under an authored source document"),
              );
          } else {
            emit(key, null);
          }
        } else {
          if (typeof candidate === "string") emit(key, candidate);
          else if (candidate instanceof Uint8Array) {
            if (!(base instanceof Uint8Array && sameBytes(base, candidate)))
              emit(key, new Uint8Array(candidate));
          } else if (base !== undefined) emit(key, null);
        }
      }

      // Bindings: the canonical text is emitted only when the state differs.
      const candidateBindingsText = read.documents["bindings"];
      if (typeof candidateBindingsText !== "string")
        problems.push(diagnostic("bindings", "candidate read-back produced no bindings"));
      else {
        const candidateBindings = readBindingsDocument(candidateBindingsText);
        const baseBindingsDocument = documents["bindings"];
        const baseBindings =
          typeof baseBindingsDocument === "string"
            ? readBindingsDocument(baseBindingsDocument)
            : {};
        if (!sameJsonValue(candidateBindings, baseBindings))
          emit("bindings", candidateBindingsText);
      }

      // World: emit only a semantic difference; exact base text is preserved.
      const candidateWorld = state.authoring.world;
      const baseWorld = documents["world"];
      if (baseWorld === undefined) {
        if (!sameJsonValue(candidateWorld, createAuthoringState().world))
          emit("world", JSON.stringify(candidateWorld));
      } else if (typeof baseWorld === "string") {
        const parsed = safeParseJson(baseWorld);
        if (!parsed.ok || !sameJsonValue(parsed.value, candidateWorld))
          emit("world", JSON.stringify(candidateWorld));
      } else {
        problems.push(diagnostic("world", "the world document is not a text record"));
      }

      // Music: authored tempo/inspection intent is an explicit document diff —
      // emit the canonical validated record only when the state differs.
      const candidateMusic = state.authoring.music;
      const baseMusic = documents["music"];
      if (baseMusic === undefined) {
        if (candidateMusic !== undefined) emit("music", musicText ?? "{}");
      } else if (typeof baseMusic === "string") {
        const parsed = safeParseJson(baseMusic);
        if (!parsed.ok || !sameJsonValue(parsed.value, candidateMusic ?? {}))
          emit("music", musicText ?? "{}");
      } else {
        problems.push(diagnostic("music", "the music document is not a text record"));
      }

      // Tests: an opaque tests document has no staged representation; a staged
      // TESTS.JSON over opaque content refuses rather than shadow it. A
      // TESTS.JSON the native file set carried in unchanged is not a change.
      let stagedTests = stagedFiles.get(GAME_TESTS_FILE);
      const imageTests = imageFiles.get(GAME_TESTS_FILE);
      if (
        stagedTests !== undefined &&
        testsBytes === undefined &&
        imageTests !== undefined &&
        sameBytes(stagedTests, imageTests)
      )
        stagedTests = undefined;
      const baseTests = documents["tests"];
      const baseTestsBytes =
        baseTests === undefined
          ? undefined
          : typeof baseTests === "string"
            ? UTF8_ENCODE.encode(baseTests)
            : baseTests;
      const baseIsGameTests =
        baseTestsBytes !== undefined && isGameTestsJson(baseTestsBytes, profile);
      if (stagedTests === undefined) {
        if (baseIsGameTests) emit("tests", null);
      } else if (baseTestsBytes === undefined || !sameBytes(baseTestsBytes, stagedTests)) {
        if (baseTests !== undefined && !baseIsGameTests)
          problems.push(
            diagnostic("tests", "a staged TESTS.JSON would shadow an opaque tests document"),
          );
        else emit("tests", decodeText(stagedTests) ?? new Uint8Array(stagedTests));
      }

      if (problems.length > 0)
        throw new AgentCandidateError(
          "The change could not be checked against the game's data. Make the change again.",
          problems,
        );

      // Document proposals may coordinate references with staged native tools.
      const coordinatedKeys = new Set<string>();
      for (const { key, content } of coordinated) {
        checkProjectDocumentKey(key);
        if (coordinatedKeys.has(key)) throw new Error(`Duplicate project document: ${key}`);
        coordinatedKeys.add(key);
        changeMap.set(key, content);
      }
      const changes = [...changeMap.keys()].sort().map((key) => ({
        key,
        content: changeMap.get(key)!,
      }));
      const effective = copyDocumentMap(documents);
      for (const { key, content } of changes) {
        if (content === null) delete effective[key];
        else effective[key] = content;
      }
      validateDocuments(effective);
      return draft.propose(snapshot, label, changes);
    };

    return { state, finish };
  };

  return Object.freeze({
    base: snapshot,
    profileId,
    compilable: compiled !== undefined,
    diagnostics: Object.freeze(diagnostics),
    defects: Object.freeze(defects),
    documents: () => Object.freeze(copyDocumentMap(documents)),
    propose,
    openToolState,
  });
}
