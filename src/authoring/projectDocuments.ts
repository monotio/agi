/**
 * Project document codec: the frozen representation a workspace holds per
 * document — `logic:N`, `picture:N`, `view:N`, `sound:N` (N 0..255), `words`,
 * `inventory` and `bindings`. Logic and picture documents carry their source
 * DSL text; a view document is JSON of the BuildViewInput, a sound document
 * JSON of the SoundTrackInput[] or the bounded `agi.sound-document` v1
 * envelope (src/sound/source.ts), `words` JSON of [word, id] pairs, `inventory`
 * JSON of {name, startingRoom} items and `bindings` JSON of the named-binding
 * record. A Uint8Array for a resource, `words` or `inventory` document means
 * retained native bytes — never mistaken for original source.
 * `world`, `tests`, `references` and `music` are owner metadata: carried
 * detached by the compiled result, never turned into playable files. A `music`
 * document is JSON of the authoring-state music map — sound number to
 * {revision cache hint, tempo} — validated through that same schema.
 *
 * readProjectDocuments detaches every indexed resource and the WORDS.TOK and
 * OBJECT files, and re-associates a claimed source only while it still
 * compiles under the given profile to exactly the stored bytes — anything
 * else stays byte-only with a diagnostic. compileProjectDocuments treats the
 * document set as complete: an indexed resource with no document is deleted,
 * WORDS and bindings are decoded before any source-backed LOGIC compiles, and
 * all upserts/removals land through one transactional putResources before the
 * captured build verifies every authored LOGIC origin. Neither direction
 * mutates its inputs, migrates storage, installs a worker or checks static
 * references.
 */

import { readBindingsDocument } from "./projectBindings.ts";
export { readBindingsDocument } from "./projectBindings.ts";
import { readImageReferences } from "../creative/imageAttachments.ts";
import { sha256Hex } from "../crypto.ts";
import { openContainer } from "../container/container.ts";
import { canonicalResourceName } from "../container/playableFiles.ts";
import { disassembleLogicWarnings } from "../logic/disassembler.ts";
import { buildWordsTok, parseWordsTok, type WordEntry } from "../logic/words.ts";
import { renderPicture } from "../picture/renderer.ts";
import { compilePictureSource } from "../picture/source.ts";
import { decodeInventoryFile } from "../runtime/inventoryFile.ts";
import { PROFILES, type AgiProfile, type ProfileId } from "../runtime/profile.ts";
import { buildSound, type SoundTrackInput } from "../sound/build.ts";
import { parseSound } from "../sound/sound.ts";
import { compileSoundDocumentSource, isSoundDocumentEnvelopeClaim } from "../sound/source.ts";
import {
  createPictureSurface,
  RESOURCE_KINDS,
  type GameContainer,
  type ResourceKind,
} from "../types.ts";
import { buildView, parseView, type BuildViewInput } from "../view/view.ts";
import { validateAuthoringState, type AuthoringState } from "./authoringState.ts";
import { buildObjectFile, readInventoryObjects } from "./inventory.ts";
import { captureProjectBuild } from "./projectBuild.ts";
import { compileProjectLogic } from "./projectLogic.ts";

type DocumentContent = string | Uint8Array;

export interface ReadProjectDocumentsInput {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profileId: ProfileId;
  /**
   * Claimed authored text per document key. A claim is associated only when it
   * compiles to the stored bytes exactly; the bytes stay authoritative.
   */
  readonly sources?: Readonly<Record<string, string>>;
  readonly bindings?: AuthoringState["bindings"];
}

export interface ProjectDocumentsRead {
  readonly documents: Readonly<Record<string, DocumentContent>>;
  readonly diagnostics: readonly { key: string; message: string }[];
}

export interface CompileProjectDocumentsInput {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profileId: ProfileId;
  /**
   * The complete desired native document set (typically a draft selection's
   * documents), not a patch: an indexed resource without a document is
   * deleted, and so are WORDS.TOK/OBJECT without `words`/`inventory`.
   */
  readonly documents: Readonly<Record<string, DocumentContent>>;
}

/** A document compile failure retains its document identity and original cause. */
export class ProjectDocumentCompileError extends Error {
  readonly key: string;

  constructor(key: string, cause: unknown) {
    super(`Cannot compile ${key}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "ProjectDocumentCompileError";
    this.key = key;
  }
}

export interface ProjectDocumentsCompile {
  readonly build: ReturnType<typeof captureProjectBuild>;
  /** Owned copies of the document set this image was compiled from. */
  documents(): Readonly<Record<string, DocumentContent>>;
  /** Owned copies of the resulting native file image. */
  files(): ReadonlyMap<string, Uint8Array>;
}

const compiledProjects = new WeakSet<ProjectDocumentsCompile>();

/** Only an actual detached compiler result may supply a model image. */
export function isCompiledProjectDocuments(value: ProjectDocumentsCompile): boolean {
  return compiledProjects.has(value);
}

type DocumentKey =
  | { readonly type: "resource"; readonly kind: ResourceKind; readonly num: number }
  | { readonly type: "words" }
  | { readonly type: "inventory" }
  | { readonly type: "bindings" }
  | { readonly type: "metadata" };

const RESOURCE_DOCUMENT = /^(logic|picture|view|sound):(0|[1-9]\d{0,2})$/;

function classifyDocumentKey(key: string): DocumentKey {
  if (/^attachment:[a-f0-9]{64}$/.test(key) || key === "images") return { type: "metadata" };
  const resource = RESOURCE_DOCUMENT.exec(key);
  if (resource) {
    const num = Number(resource[2]);
    if (num > 255) throw new Error(`Invalid project document: ${key}`);
    return { type: "resource", kind: resource[1] as ResourceKind, num };
  }
  switch (key) {
    case "words":
      return { type: "words" };
    case "inventory":
      return { type: "inventory" };
    case "bindings":
      return { type: "bindings" };
    case "notes":
    case "world":
    case "tests":
    case "references":
    case "music":
      return { type: "metadata" };
    default:
      throw new Error(`Invalid project document: ${key}`);
  }
}

function describeKey(key: DocumentKey): string {
  switch (key.type) {
    case "resource":
      return `${key.kind.toUpperCase()} ${key.num}`;
    case "words":
      return "WORDS.TOK";
    case "inventory":
      return "OBJECT";
    default:
      return "document";
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Canonical-name owned copies; two spellings of one playable file conflict. */
function canonicalFiles(files: Readonly<Record<string, Uint8Array>>): Map<string, Uint8Array> {
  const owned = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) {
    const canonical = canonicalResourceName(name);
    if (owned.has(canonical)) throw new Error(`Duplicate game resource name: ${name}.`);
    owned.set(canonical, new Uint8Array(bytes));
  }
  return owned;
}

function copyDocuments(
  documents: Readonly<Record<string, DocumentContent>>,
): Record<string, DocumentContent> {
  const out: Record<string, DocumentContent> = Object.create(null);
  for (const [key, content] of Object.entries(documents)) {
    out[key] = content instanceof Uint8Array ? new Uint8Array(content) : content;
  }
  return out;
}

function parseJson(text: string, key: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid project document ${key}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) throw new Error(`Invalid document field '${field}'.`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}: expected an object.`);
  return value as Record<string, unknown>;
}

function readWordEntries(value: unknown): WordEntry[] {
  if (!Array.isArray(value)) throw new Error("Invalid words document: expected [word, id] pairs.");
  return value.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !Number.isInteger(entry[1])
    )
      throw new Error("Invalid words document: expected [word, id] pairs.");
    return { word: entry[0], id: entry[1] as number };
  });
}

/** The compiler's WORDS text reader, also used by source diagnostics. */
export function readWordsDocument(source: string): readonly WordEntry[] {
  return readWordEntries(parseJson(source, "words"));
}

interface InventoryItem {
  readonly name: string;
  readonly startingRoom: number;
}

function readInventoryItems(value: unknown): InventoryItem[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error("Invalid inventory document: expected at most 256 {name, startingRoom} items.");
  return value.map((entry) => {
    const item = asRecord(entry, "inventory item");
    rejectUnknownFields(item, ["name", "startingRoom"]);
    if (typeof item["name"] !== "string")
      throw new Error("Invalid inventory item: 'name' must be text.");
    const name = item["name"];
    for (let i = 0; i < name.length; i++) {
      const code = name.charCodeAt(i);
      if (code === 0 || code > 0xff)
        throw new Error(`Invalid inventory item name '${name}': characters must be single bytes.`);
    }
    const room = item["startingRoom"];
    if (
      room !== undefined &&
      (!Number.isInteger(room) || (room as number) < 0 || (room as number) > 255)
    )
      throw new Error(`Invalid inventory item '${name}': startingRoom must be an integer 0..255.`);
    return { name, startingRoom: room === undefined ? 0 : (room as number) };
  });
}

/** Locate a refused table entry with the same readers and builders as compilation. */
export function projectDocumentErrorRow(key: string, source: string): number | undefined {
  if (key !== "words" && key !== "inventory") return;
  let rows: unknown;
  try {
    rows = JSON.parse(source);
  } catch {
    return;
  }
  if (!Array.isArray(rows)) return;
  for (const [index, row] of rows.entries()) {
    try {
      if (key === "words") buildWordsTok(readWordEntries([row]));
      else buildObjectFile(readInventoryItems([row]));
    } catch {
      return index;
    }
  }
}

function readSoundTracks(value: unknown): SoundTrackInput[] {
  if (!Array.isArray(value) || value.length > 4)
    throw new Error("Invalid sound document: expected at most four tracks.");
  return value.map((track, index) => {
    const raw = asRecord(track, `sound track ${index}`);
    rejectUnknownFields(raw, ["notes"]);
    if (!Array.isArray(raw["notes"]))
      throw new Error(`Invalid sound track ${index}: 'notes' must be an array.`);
    const notes = raw["notes"].map((note, noteIndex) => {
      const rawNote = asRecord(note, `sound note ${noteIndex}`);
      rejectUnknownFields(rawNote, ["note", "duration", "freqDivisor", "attenuation"]);
      const duration = rawNote["duration"];
      if (typeof duration !== "number" || !Number.isFinite(duration))
        throw new Error(`Invalid sound note ${noteIndex}: 'duration' must be a number.`);
      for (const field of ["freqDivisor", "attenuation"] as const) {
        const fieldValue = rawNote[field];
        if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== "number")
          throw new Error(`Invalid sound note ${noteIndex}: '${field}' must be a number.`);
      }
      const noteValue = rawNote["note"];
      if (
        noteValue !== undefined &&
        noteValue !== null &&
        typeof noteValue !== "string" &&
        typeof noteValue !== "number"
      )
        throw new Error(`Invalid sound note ${noteIndex}: 'note' must be text or a number.`);
      return {
        duration,
        ...(noteValue !== undefined ? { note: noteValue } : {}),
        ...(rawNote["freqDivisor"] !== undefined
          ? { freqDivisor: rawNote["freqDivisor"] as number | null }
          : {}),
        ...(rawNote["attenuation"] !== undefined
          ? { attenuation: rawNote["attenuation"] as number | null }
          : {}),
      };
    });
    return { notes };
  });
}

function readViewInput(value: unknown): BuildViewInput {
  const raw = asRecord(value, "view document");
  rejectUnknownFields(raw, ["loops", "description"]);
  if (!Array.isArray(raw["loops"]))
    throw new Error("Invalid view document: 'loops' must be an array.");
  const description = raw["description"];
  if (description !== undefined && description !== null && typeof description !== "string")
    throw new Error("Invalid view document: 'description' must be text.");
  const loops = raw["loops"].map((loop, loopIndex) => {
    const rawLoop = asRecord(loop, `view loop ${loopIndex}`);
    rejectUnknownFields(rawLoop, ["cels", "mirrorLoop"]);
    const mirrorLoop = rawLoop["mirrorLoop"];
    if (mirrorLoop !== undefined && mirrorLoop !== null && !Number.isInteger(mirrorLoop))
      throw new Error(`Invalid view loop ${loopIndex}: 'mirrorLoop' must be an integer.`);
    const celsValue = rawLoop["cels"];
    const out: { cels?: BuildViewInput["loops"][number]["cels"]; mirrorLoop?: number } = {};
    if (celsValue !== undefined && celsValue !== null) {
      if (!Array.isArray(celsValue))
        throw new Error(`Invalid view loop ${loopIndex}: 'cels' must be an array.`);
      out.cels = celsValue.map((cel, celIndex) => {
        const rawCel = asRecord(cel, `view cel ${celIndex}`);
        rejectUnknownFields(rawCel, ["width", "height", "transparentColor", "mirror", "pixels"]);
        const width = rawCel["width"];
        const height = rawCel["height"];
        const pixels = rawCel["pixels"];
        if (!Number.isInteger(width) || !Number.isInteger(height))
          throw new Error(`Invalid view cel ${celIndex}: 'width'/'height' must be integers.`);
        if (!Array.isArray(pixels) || !pixels.every((p) => Number.isInteger(p)))
          throw new Error(`Invalid view cel ${celIndex}: 'pixels' must be an integer array.`);
        const transparent = rawCel["transparentColor"];
        if (transparent !== undefined && transparent !== null && !Number.isInteger(transparent))
          throw new Error(`Invalid view cel ${celIndex}: 'transparentColor' must be an integer.`);
        const mirror = rawCel["mirror"];
        if (mirror !== undefined && mirror !== null && typeof mirror !== "boolean")
          throw new Error(`Invalid view cel ${celIndex}: 'mirror' must be a boolean.`);
        return {
          width: width as number,
          height: height as number,
          pixels: pixels as number[],
          ...(transparent !== undefined ? { transparentColor: transparent as number | null } : {}),
          ...(mirror !== undefined ? { mirror: mirror as boolean | null } : {}),
        };
      });
    }
    if (mirrorLoop !== undefined) out.mirrorLoop = mirrorLoop as number;
    return out;
  });
  return {
    loops,
    ...(typeof description === "string" ? { description } : {}),
  };
}

/**
 * Strict music document: the authoring-state music map — sound number to
 * {revision cache hint, tempo} — carried by the same schema the session
 * record uses. Authoring intent only; native SOUND bytes stay authoritative.
 */
export function readMusicDocument(text: string): NonNullable<AuthoringState["music"]> {
  const parsed = parseJson(text, "music");
  try {
    return (
      validateAuthoringState({
        version: 1,
        music: parsed,
        bindings: {},
        world: { rooms: {}, facts: {}, quests: {} },
      }).music ?? {}
    );
  } catch (error) {
    throw new Error(
      `Invalid project document music: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Code-point ordered JSON so equal bindings serialize to equal text. */
function bindingsText(bindings: AuthoringState["bindings"]): string {
  const sorted = Object.fromEntries(
    Object.entries(bindings)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, binding]) => [name, { ...binding }]),
  );
  return JSON.stringify(sorted);
}

function numBindings(
  bindings: AuthoringState["bindings"],
): Record<string, { readonly num: number }> {
  return Object.fromEntries(
    Object.entries(bindings).map(([name, binding]) => [name, { num: binding.num }]),
  );
}

function inventoryLimit(container: GameContainer, profile: AgiProfile): number {
  const bytes = container.files.get("OBJECT");
  if (!bytes || profile.inventoryHeaderBytes < 3) return 255;
  const decoded = decodeInventoryFile(bytes, profile);
  return profile.inventoryHeaderBytes === 4
    ? (decoded[2] ?? 255) | ((decoded[3] ?? 0) << 8)
    : (decoded[2] ?? 255);
}

interface CompileContext {
  readonly profile: AgiProfile;
  readonly maximumDrawableObjectIndex: number;
  readonly dictionary: ReadonlyMap<string, number>;
  readonly bindings: Readonly<Record<string, { readonly num: number }>>;
}

/** The one compile path shared by source verification and image building. */
function compileTextDocument(
  key: Extract<DocumentKey, { type: "resource" | "words" | "inventory" }>,
  text: string,
  context: CompileContext,
): Uint8Array {
  switch (key.type) {
    case "words":
      return buildWordsTok(readWordsDocument(text));
    case "inventory":
      return buildObjectFile(
        readInventoryItems(parseJson(text, "inventory")),
        context.profile,
        context.maximumDrawableObjectIndex,
      );
    case "resource":
      switch (key.kind) {
        case "logic":
          return compileProjectLogic(text, {
            profile: context.profile,
            dictionary: context.dictionary,
            bindings: context.bindings,
          }).assembly.payload;
        case "picture":
          return compilePictureSource(text, { profile: context.profile }).bytes;
        case "view":
          return buildView(readViewInput(parseJson(text, "view")), context.profile);
        case "sound": {
          const body = parseJson(text, "sound");
          // The tagged envelope pins its profile and compiles to exactly its
          // encode() bytes; legacy track arrays keep the strict reader.
          if (isSoundDocumentEnvelopeClaim(body))
            return compileSoundDocumentSource(body, context.profile.id);
          return buildSound(readSoundTracks(body));
        }
      }
  }
}

/** Validation for a native payload the caller changed or introduced. */
function validateNativeResource(
  kind: ResourceKind,
  num: number,
  payload: Uint8Array,
  context: CompileContext,
): void {
  switch (kind) {
    case "logic": {
      const warnings = disassembleLogicWarnings(payload, {
        profile: context.profile,
        dictionary: context.dictionary,
      });
      if (warnings.length > 0)
        throw new Error(`Invalid project document logic:${num}: ${warnings.join("; ")}`);
      return;
    }
    case "picture":
      renderPicture(payload, createPictureSurface(), { profile: context.profile });
      return;
    case "view":
      parseView(payload, context.profile);
      return;
    case "sound":
      parseSound(payload);
      return;
  }
}

/** Indexed payload, or undefined when absent — or present but unreadable. */
function indexedPayload(
  container: GameContainer,
  kind: ResourceKind,
  num: number,
): Uint8Array | undefined {
  try {
    return container.getResource(kind, num) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Readable entries can be removed by omission; unreadable imported slots stay indexed. */
function hasReadablePayload(container: GameContainer, kind: ResourceKind, num: number): boolean {
  try {
    return container.getResource(kind, num) !== null;
  } catch {
    return false;
  }
}

function profileOrThrow(profileId: ProfileId): AgiProfile {
  const profile = PROFILES[profileId];
  if (!profile) throw new Error(`Unknown build profile: ${profileId}`);
  return profile;
}

export function readProjectDocuments(input: ReadProjectDocumentsInput): ProjectDocumentsRead {
  const profile = profileOrThrow(input.profileId);
  const container = openContainer(canonicalFiles(input.files), { profile });
  const diagnostics: { key: string; message: string }[] = [];
  const documents: Record<string, DocumentContent> = Object.create(null);
  const storedPayloads = new Map<string, Uint8Array>();

  for (const kind of RESOURCE_KINDS) {
    for (let num = 0; num < 256; num++) {
      const key = `${kind}:${num}`;
      let payload: Uint8Array | null;
      try {
        payload = container.getResource(kind, num);
      } catch (error) {
        diagnostics.push({
          key,
          message: `Indexed ${describeKey({ type: "resource", kind, num })} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      if (payload === null) continue;
      const detached = new Uint8Array(payload);
      documents[key] = detached;
      storedPayloads.set(key, detached);
    }
  }
  for (const [key, file] of [
    ["words", "WORDS.TOK"],
    ["inventory", "OBJECT"],
  ] as const) {
    const bytes = container.files.get(file);
    if (!bytes) continue;
    const detached = new Uint8Array(bytes);
    documents[key] = detached;
    storedPayloads.set(key, detached);
  }
  const bindings = readBindingsDocument(JSON.stringify(input.bindings ?? {}));
  documents["bindings"] = bindingsText(bindings);

  let dictionary: ReadonlyMap<string, number> | undefined;
  const requireDictionary = (): ReadonlyMap<string, number> => {
    if (dictionary === undefined) {
      const words = container.files.get("WORDS.TOK");
      dictionary = new Map(words ? parseWordsTok(words).map(({ word, id }) => [word, id]) : []);
    }
    return dictionary;
  };
  const context: CompileContext = {
    profile,
    maximumDrawableObjectIndex: inventoryLimit(container, profile),
    dictionary: new Map(),
    bindings: numBindings(bindings),
  };

  for (const key of Object.keys(input.sources ?? {}).sort()) {
    const source = input.sources![key]!;
    let target: DocumentKey;
    try {
      target = classifyDocumentKey(key);
    } catch {
      diagnostics.push({ key, message: "Claimed source has no playable document." });
      continue;
    }
    if (target.type === "bindings" || target.type === "metadata") {
      diagnostics.push({ key, message: "Claimed source has no playable document." });
      continue;
    }
    const stored = storedPayloads.get(key);
    if (!stored) {
      diagnostics.push({
        key,
        message: `Claimed source has no ${describeKey(target)}.`,
      });
      continue;
    }
    try {
      const needsDictionary = target.type === "resource" && target.kind === "logic";
      const compiled = compileTextDocument(target, source, {
        ...context,
        dictionary: needsDictionary ? requireDictionary() : context.dictionary,
      });
      if (sameBytes(compiled, stored)) {
        documents[key] = source;
      } else {
        diagnostics.push({
          key,
          message: `Claimed source does not reproduce ${describeKey(target)}.`,
        });
      }
    } catch (error) {
      diagnostics.push({
        key,
        message: `Claimed source for ${describeKey(target)} is unusable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    documents: Object.freeze(
      Object.fromEntries(Object.entries(documents).sort(([a], [b]) => (a < b ? -1 : 1))),
    ),
    diagnostics: Object.freeze(diagnostics),
  };
}

export function compileProjectDocuments(
  input: CompileProjectDocumentsInput,
): ProjectDocumentsCompile {
  const profile = profileOrThrow(input.profileId);
  const container = openContainer(canonicalFiles(input.files), { profile });

  // Detached, fully classified desired set — unknown keys and content types fail.
  const documents = new Map<string, DocumentContent>();
  for (const [key, content] of Object.entries(input.documents)) {
    classifyDocumentKey(key);
    if (typeof content !== "string" && !(content instanceof Uint8Array))
      throw new Error(`Invalid project document ${key}: content must be text or bytes.`);
    documents.set(key, content instanceof Uint8Array ? new Uint8Array(content) : content);
  }

  for (const [key, content] of documents) {
    if (
      key.startsWith("attachment:") &&
      (!(content instanceof Uint8Array) || sha256Hex(content) !== key.slice(11))
    )
      throw new ProjectDocumentCompileError(key, "Attachment bytes differ from their hash.");
  }
  const imageReferences = readImageReferences(Object.fromEntries(documents));
  for (const target of Object.keys(imageReferences.traces)) {
    if (!documents.has(target))
      throw new ProjectDocumentCompileError(
        "images",
        `Trace target ${target} is missing. Remove its reference or add the PICTURE.`,
      );
  }

  // The compile context first: every source-backed LOGIC sees the final
  // dictionary and named bindings, so a coordinated vocabulary change
  // recompiles coherent bytes rather than mixing revisions.
  const bindingsDocument = documents.get("bindings");
  let bindings: AuthoringState["bindings"];
  try {
    if (bindingsDocument !== undefined && typeof bindingsDocument !== "string")
      throw new Error("Invalid project document bindings: expected JSON text.");
    bindings = readBindingsDocument(bindingsDocument ?? "{}");
  } catch (error) {
    throw new ProjectDocumentCompileError("bindings", error);
  }

  const musicDocument = documents.get("music");
  try {
    if (musicDocument !== undefined) {
      if (typeof musicDocument !== "string")
        throw new Error("Invalid project document music: expected JSON text.");
      readMusicDocument(musicDocument);
    }
  } catch (error) {
    throw new ProjectDocumentCompileError("music", error);
  }

  const wordsDocument = documents.get("words");
  let wordsBytes: Uint8Array | null = null;
  let dictionary: ReadonlyMap<string, number> = new Map();
  try {
    if (wordsDocument !== undefined) {
      if (typeof wordsDocument === "string") {
        wordsBytes = buildWordsTok(readWordsDocument(wordsDocument));
      } else {
        const current = container.files.get("WORDS.TOK");
        if (!current || !sameBytes(current, wordsDocument)) parseWordsTok(wordsDocument);
        wordsBytes = wordsDocument;
      }
      // Authored LOGIC needs a readable final dictionary. A fully bytes-only
      // import preserves unchanged opaque WORDS until source needs it.
      if (
        typeof wordsDocument === "string" ||
        [...documents].some(
          ([key, content]) => key.startsWith("logic:") && typeof content === "string",
        )
      )
        dictionary = new Map(parseWordsTok(wordsBytes).map(({ word, id }) => [word, id]));
    }
  } catch (error) {
    throw new ProjectDocumentCompileError("words", error);
  }

  const inventoryDocument = documents.get("inventory");
  let inventoryBytes: Uint8Array | null = null;
  try {
    if (inventoryDocument !== undefined) {
      if (typeof inventoryDocument === "string") {
        inventoryBytes = buildObjectFile(
          readInventoryItems(parseJson(inventoryDocument, "inventory")),
          profile,
          inventoryLimit(container, profile),
        );
      } else {
        const current = container.files.get("OBJECT");
        if (!current || !sameBytes(current, inventoryDocument))
          readInventoryObjects(inventoryDocument, profile);
        inventoryBytes = inventoryDocument;
      }
    }
  } catch (error) {
    throw new ProjectDocumentCompileError("inventory", error);
  }

  const context: CompileContext = {
    profile,
    maximumDrawableObjectIndex: inventoryLimit(container, profile),
    dictionary,
    bindings: numBindings(bindings),
  };

  // Resolve every desired payload before touching the container; a rejected
  // document leaves the staged image (and both caller arguments) untouched.
  const desired = new Map<string, { kind: ResourceKind; num: number; payload: Uint8Array }>();
  const sources: Record<string, string> = {};
  for (const [key, content] of documents) {
    const documentKey = classifyDocumentKey(key);
    if (documentKey.type !== "resource") continue;
    const { kind, num } = documentKey;
    let payload: Uint8Array;
    try {
      if (typeof content === "string") {
        payload = compileTextDocument(documentKey, content, context);
        if (kind === "logic") sources[String(num)] = content;
      } else {
        payload = content;
        const current = indexedPayload(container, kind, num);
        // Unchanged imported bytes stay opaque; a new or changed native payload
        // must pass the family's existing structural validation.
        if (current === undefined || !sameBytes(current, content))
          validateNativeResource(kind, num, content, context);
      }
    } catch (error) {
      throw new ProjectDocumentCompileError(key, error);
    }
    desired.set(key, { kind, num, payload });
  }

  const changes: { kind: ResourceKind; num: number; payload: Uint8Array | null }[] = [];
  for (const { kind, num, payload } of desired.values()) {
    const current = indexedPayload(container, kind, num);
    if (current === undefined || !sameBytes(current, payload)) changes.push({ kind, num, payload });
  }
  for (const kind of RESOURCE_KINDS) {
    for (let num = 0; num < 256; num++) {
      if (!desired.has(`${kind}:${num}`) && hasReadablePayload(container, kind, num))
        changes.push({ kind, num, payload: null });
    }
  }
  if (changes.length > 0) container.putResources(changes);
  if (wordsBytes) container.putFile("WORDS.TOK", wordsBytes);
  if (inventoryBytes) container.putFile("OBJECT", inventoryBytes);

  const finalFiles = new Map(container.files);
  if (wordsBytes === null) finalFiles.delete("WORDS.TOK");
  if (inventoryBytes === null) finalFiles.delete("OBJECT");

  // Verifies every authored LOGIC origin against the final dictionary,
  // bindings and profile — a supplied source must reproduce the staged bytes.
  const build = captureProjectBuild({
    files: Object.fromEntries(finalFiles),
    profileId: input.profileId,
    sources,
    bindings: numBindings(bindings),
  });

  const compiled = Object.freeze({
    build,
    documents(): Readonly<Record<string, DocumentContent>> {
      return copyDocuments(Object.fromEntries(documents));
    },
    files(): ReadonlyMap<string, Uint8Array> {
      return new Map([...finalFiles].map(([name, bytes]) => [name, new Uint8Array(bytes)]));
    },
  });
  compiledProjects.add(compiled);
  return compiled;
}
