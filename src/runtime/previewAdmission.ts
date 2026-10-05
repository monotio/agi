/**
 * Detached staging helpers for the same-Engine Play-preview native update.
 *
 * A host-side preview build produces a complete replacement container image
 * (directory + volume files plus WORDS.TOK / OBJECT / TESTS.JSON). Admission
 * is a single transaction: the whole candidate is canonicalized, opened
 * detached, diffed and semantically validated before the Engine performs any
 * live write. Nothing in this module reads or mutates Engine state; the
 * Engine passes snapshots of its own caches in and decides whether staged
 * work may commit at a naturally completed idle-cycle boundary.
 */
import {
  canonicalResourceName,
  createPictureSurface,
  RESOURCE_KINDS,
  type GameContainer,
  type ResourceKind,
} from "../types.ts";
import { detectContainerFormat, openContainer, DIRECTORY_FILES } from "../container/container.ts";
import { parseLogicResource, type LogicResource } from "../logic/resource.ts";
import { parseView, type AgiView } from "../view/view.ts";
import { renderPicture } from "../picture/renderer.ts";
import { SoundPlayback } from "../sound/sound.ts";
import { parseWordsTok } from "../logic/words.ts";
import { decodeInventoryFile, inventoryTableFits } from "./inventoryFile.ts";
import type { AgiProfile, ProfileId } from "./profile.ts";
import type { PictureComposition } from "./previewPictureComposition.ts";
import type { PictureSurface } from "../types.ts";

/** Terminal outcomes of a preview admission attempt. */
export type PreviewUpdateStatus =
  "committed" | "unchanged" | "deferred" | "restartRequired" | "refused";

export interface PreviewUpdateResult {
  readonly status: PreviewUpdateStatus;
  /** Precise refusal/deferral cause; absent for committed and unchanged. */
  readonly reason?: string;
  /** Installed native image revision observed by this result. */
  readonly patchGeneration: number;
  /** All current blockers can be resolved by a real entry into the current room. */
  readonly roomReentry?: true;
}

/**
 * A complete candidate container image as the host preview build would
 * produce it: every directory/volume/auxiliary file of the draft. `profile`
 * is the issuer-declared profile identity; when supplied it must equal the
 * running Engine's profile.
 */
export interface PreviewUpdateCandidate {
  readonly files: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>;
  readonly profile?: ProfileId;
}

/** Staging failure carrying the terminal status the attempt must report. */
export class PreviewBlock extends Error {
  readonly status: "refused" | "restartRequired";
  constructor(status: "refused" | "restartRequired", message: string) {
    super(message);
    this.name = "PreviewBlock";
    this.status = status;
  }
}

function unsupported(message: string): PreviewBlock {
  return new PreviewBlock("restartRequired", message);
}

/** One resource whose candidate bytes differ from the installed bytes. */
export interface ResourceChange {
  readonly kind: ResourceKind;
  readonly num: number;
  /** Installed payload, or null when the installed entry was unreadable/absent. */
  readonly oldPayload: Uint8Array | null;
  readonly newPayload: Uint8Array;
}

export interface ResourceRemoval {
  readonly kind: ResourceKind;
  readonly num: number;
}

/** Append-only OBJECT change staged for commit. */
export interface InventoryAppend {
  /** First index genuinely new in the candidate. */
  readonly firstNew: number;
  /** Initial room byte of each new entry, in index order. */
  readonly initials: readonly number[];
}

/**
 * Everything the commit phase needs, produced while the engine made no
 * writes. The staged container and every parse artifact are detached copies
 * owned by the issuing engine's private plan record; they become live state
 * only through a successful commit.
 */
export interface StagedPreviewUpdate {
  readonly container: GameContainer;
  readonly changed: readonly ResourceChange[];
  readonly logicParses: ReadonlyMap<
    number,
    { readonly resource: LogicResource; readonly codeChanged: boolean }
  >;
  readonly viewParses: ReadonlyMap<number, AgiView>;
  /** Staged WORDS dictionary, or null when WORDS.TOK is unchanged. */
  readonly dictionary: ReadonlyMap<string, number> | null;
  /** Append-only OBJECT analysis, or null when OBJECT is unchanged. */
  readonly inventory: InventoryAppend | null;
  /** Picture evidence fingerprinted at preparation time. */
  readonly composition: PictureComposition;
  /** True when a changed PIC participates in the current composition. */
  readonly compositionAffected: boolean;
  /** Detached rebuilt backdrop when an affected composition is feasible. */
  readonly surface: PictureSurface | null;
  /** Why an affected composition cannot commit, when it cannot. */
  readonly compositionBlocked: string | null;
}

/**
 * Opaque, engine-bound, single-use admission handle. The only handles a
 * commit accepts are the ones `Engine.preparePreviewUpdate` issued: all
 * prepared state — staged container, parse artifacts, terminal verdict,
 * bound generation, consumption — lives in the issuing engine's private
 * IssuedPreviewPlan registry keyed by this handle and reachable nowhere
 * else. Constructing, Object.create-ing, cloning, spreading or field-forging
 * a look-alike yields an unissued token that commit refuses.
 */
export class PreviewUpdatePlan {
  /** Nominal brand only; emits nothing and is never read. */
  declare private issuer: void;
}

/**
 * Engine-private issuer record behind a PreviewUpdatePlan. The issuing
 * Engine holds these in its own WeakMap; no public surface exposes the
 * staged container, byte maps, parse artifacts, verdict, generation or
 * consumption kept here.
 */
export interface IssuedPreviewPlan {
  /** `previewSerial` of the installed image this plan was prepared against. */
  readonly generation: number;
  /** True once a terminal verdict or a successful commit settled the plan. */
  consumed: boolean;
  /** Terminal verdict fixed at preparation, when the candidate could not stage. */
  terminal: PreviewUpdateResult | null;
  /** The fully validated detached candidate; null for a byte-identical image. */
  staged: StagedPreviewUpdate | null;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Container image shape used to separate managed files from auxiliaries. */
export interface ImageLayout {
  readonly kind: "v2-split" | "v3-combined";
  readonly prefix: string;
}

const VOL_FILE = /^VOL\.\d+$/;

/** Names the container itself owns: directory and volume payloads. */
function isContainerManagedName(name: string, layout: ImageLayout): boolean {
  if (layout.kind === "v3-combined") {
    return name === `${layout.prefix}DIR` || name.startsWith(`${layout.prefix}VOL.`);
  }
  return (Object.values(DIRECTORY_FILES) as string[]).includes(name) || VOL_FILE.test(name);
}

/**
 * Copy the candidate into canonical detached bytes. Duplicate canonical
 * names and non-bytes payloads are admission refusals: the candidate is a
 * file image, not a caller-owned view into live memory.
 */
export function canonicalizeCandidateFiles(
  files: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>,
): Map<string, Uint8Array> {
  const canonical = new Map<string, Uint8Array>();
  const entries = files instanceof Map ? files.entries() : Object.entries(files);
  for (const [name, bytes] of entries) {
    if (!(bytes instanceof Uint8Array)) {
      throw new PreviewBlock("refused", `preview candidate file '${String(name)}' is not bytes`);
    }
    const canonicalName = canonicalResourceName(name);
    if (canonical.has(canonicalName)) {
      throw new PreviewBlock(
        "refused",
        `preview candidate names '${name}' and a sibling collapse to '${canonicalName}'`,
      );
    }
    canonical.set(canonicalName, bytes.slice());
  }
  return canonical;
}

export function imageLayout(files: ReadonlyMap<string, Uint8Array>): ImageLayout {
  try {
    const detected = detectContainerFormat(files);
    return { kind: detected.kind, prefix: detected.prefix };
  } catch (error) {
    throw new PreviewBlock(
      "refused",
      `preview candidate has no readable container layout: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Open the canonical files as a detached, self-owned container. */
export function openStagedContainer(
  files: ReadonlyMap<string, Uint8Array>,
  profile: AgiProfile,
): GameContainer {
  let staged: GameContainer;
  try {
    staged = openContainer(files, { profile });
  } catch (error) {
    throw new PreviewBlock(
      "refused",
      `preview candidate is not a loadable container: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  for (const name of staged.files.keys()) {
    if (!files.has(name)) {
      throw new PreviewBlock(
        "refused",
        `preview candidate is incomplete: '${name}' is synthesized, not part of the image`,
      );
    }
  }
  return staged;
}

/** Whole-image byte identity: equal name sets plus equal payload bytes. */
export function filesIdentical(
  a: ReadonlyMap<string, Uint8Array>,
  b: ReadonlyMap<string, Uint8Array>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [name, bytes] of a) {
    const other = b.get(name);
    if (other === undefined || !bytesEqual(bytes, other)) return false;
  }
  return true;
}

const AUXILIARY_FILES = new Set(["WORDS.TOK", "OBJECT", "TESTS.JSON"]);

/**
 * Non-container files the candidate may atomically replace. Any other
 * addition/change/removal outside directory+volume payloads is a
 * Restart-required outcome; removals are never silently dropped.
 */
export function analyzeAuxiliaryChanges(
  installed: ReadonlyMap<string, Uint8Array>,
  candidate: ReadonlyMap<string, Uint8Array>,
  layout: ImageLayout,
): { readonly changedAux: ReadonlySet<string> } {
  const changedAux = new Set<string>();
  for (const name of new Set([...installed.keys(), ...candidate.keys()])) {
    if (isContainerManagedName(name, layout)) continue;
    const before = installed.get(name);
    const after = candidate.get(name);
    if (before !== undefined && after !== undefined && bytesEqual(before, after)) continue;
    if (before !== undefined && after === undefined) {
      throw unsupported(`preview candidate removes the '${name}' file`);
    }
    if (!AUXILIARY_FILES.has(name)) {
      throw unsupported(`preview candidate changes the unsupported '${name}' file`);
    }
    changedAux.add(name);
  }
  return { changedAux };
}

interface ResourceEntry {
  readonly status: "absent" | "ok" | "corrupt";
  readonly payload: Uint8Array | null;
}

function readResourceEntry(
  container: GameContainer,
  kind: ResourceKind,
  num: number,
): ResourceEntry {
  let payload: Uint8Array | null;
  try {
    payload = container.getResource(kind, num);
  } catch {
    return { status: "corrupt", payload: null };
  }
  return payload === null ? { status: "absent", payload: null } : { status: "ok", payload };
}

/**
 * Enumerate every resource slot on both images. Existing unreadable slots
 * stay opaque; new unreadable slots are refused. Repairs compare as changes
 * the candidate must validate.
 */
export function diffResources(
  installed: GameContainer,
  candidate: GameContainer,
): { readonly changes: readonly ResourceChange[]; readonly removals: readonly ResourceRemoval[] } {
  const changes: ResourceChange[] = [];
  const removals: ResourceRemoval[] = [];
  for (const kind of RESOURCE_KINDS) {
    for (let num = 0; num < 256; num++) {
      const before = readResourceEntry(installed, kind, num);
      const after = readResourceEntry(candidate, kind, num);
      if (after.status === "corrupt") {
        if (before.status === "corrupt") continue;
        throw new PreviewBlock(
          "refused",
          `preview candidate ${kind} resource ${num} cannot be read`,
        );
      }
      if (after.status === "absent") {
        if (before.status !== "absent") removals.push({ kind, num });
        continue;
      }
      const oldPayload = before.status === "ok" ? before.payload : null;
      if (oldPayload === null || !bytesEqual(oldPayload, after.payload!)) {
        changes.push({ kind, num, oldPayload, newPayload: after.payload! });
      }
    }
  }
  return { changes, removals };
}

export interface ValidatedResource {
  readonly logic?: { readonly resource: LogicResource; readonly codeChanged: boolean };
  readonly view?: AgiView;
}

/**
 * Parse one changed resource exactly the way its next live use would.
 * Anything that throws becomes a refusal before any live write, which is
 * what makes the malformed-VIEW eviction defect of the older patch path
 * impossible here. `codeChanged` compares decoded LOGIC instruction bytes so
 * a message-table-only edit stays committable next to a parked scan.start.
 */
export function validateCandidateResource(
  kind: ResourceKind,
  num: number,
  newPayload: Uint8Array,
  oldPayload: Uint8Array | null,
  profile: AgiProfile,
  soundDevice: number,
): ValidatedResource {
  try {
    if (kind === "logic") {
      const resource = parseLogicResource(newPayload);
      let codeChanged = true;
      if (oldPayload !== null) {
        try {
          codeChanged = !bytesEqual(parseLogicResource(oldPayload).code, resource.code);
        } catch {
          codeChanged = true;
        }
      }
      return { logic: { resource, codeChanged } };
    }
    if (kind === "view") return { view: parseView(newPayload, profile) };
    if (kind === "picture") {
      renderPicture(newPayload, createPictureSurface(), { profile });
      return {};
    }
    if (kind === "sound") {
      new SoundPlayback(profile, newPayload, soundDevice);
      return {};
    }
  } catch (error) {
    throw new PreviewBlock(
      "refused",
      `preview candidate ${kind} resource ${num} is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {};
}

/** Decode a staged WORDS.TOK into the word→id map the parser consumes. */
export function stageDictionary(wordsTok: Uint8Array): Map<string, number> {
  try {
    const dictionary = new Map<string, number>();
    for (const { word, id } of parseWordsTok(wordsTok)) dictionary.set(word, id);
    return dictionary;
  } catch (error) {
    throw new PreviewBlock(
      "refused",
      `preview candidate WORDS.TOK is not a valid dictionary: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Per-entry initial room bytes of a decoded OBJECT table. */
export function inventoryInitials(
  decodedEntries: Uint8Array | null,
  entryCount: number,
  entryStride: number,
): readonly number[] {
  const initials: number[] = [];
  for (let i = 0; i < entryCount; i++) {
    initials.push(decodedEntries?.[i * entryStride + 2] ?? 0);
  }
  return initials;
}

/** OBJECT contents in the shape commit checks compare. */
export interface InventoryTable {
  readonly entryCount: number;
  readonly objectRecords: number;
  readonly names: readonly string[];
  readonly initials: readonly number[];
}

function readCandidateInventory(
  payload: Uint8Array,
  profile: AgiProfile,
  objectRecordsOverride: number | null,
): InventoryTable {
  const decoded = decodeInventoryFile(payload, profile);
  const header = profile.inventoryHeaderBytes;
  const stride = profile.inventoryEntryBytes;
  if (!inventoryTableFits(decoded, profile)) {
    throw new PreviewBlock("refused", "preview candidate OBJECT table does not fit its header");
  }
  const tableSize = decoded[0]! | (decoded[1]! << 8);
  const entryCount = Math.floor(tableSize / stride);
  const entries = decoded.subarray(header, header + tableSize);
  // Same record-count reading as Engine.inventoryMetadata: the drawable limit
  // comes from the header unless the profile pin overrides it.
  const objectRecords = objectRecordsOverride ?? (header >= 3 ? decoded[2]! + 1 : 21);
  const names: string[] = [];
  const decoder = new TextDecoder();
  for (
    let at = header;
    at + stride <= header + tableSize && at + stride <= decoded.length;
    at += stride
  ) {
    const rel = decoded[at]! | (decoded[at + 1]! << 8);
    let end = header + rel;
    while (end < decoded.length && decoded[end] !== 0) end++;
    names.push(decoder.decode(decoded.subarray(header + rel, end)));
  }
  return {
    entryCount,
    objectRecords,
    names,
    initials: inventoryInitials(entries, entryCount, stride),
  };
}

/**
 * Bounded append-only OBJECT contract: prior indices, names, initial
 * semantics and the drawable-record configuration all stay identical; the
 * candidate may only append new entries. Anything else refuses the whole
 * candidate with a Restart-required outcome rather than silently omitting a
 * deletion. `before` and `objectRecordsOverride` are read from the live
 * engine (`inventoryMetadata`, `itemNames`, `maxDrawnObjectsCount`).
 */
export function analyzeInventoryAppend(
  before: InventoryTable,
  candidateBytes: Uint8Array,
  profile: AgiProfile,
  objectRecordsOverride: number | null,
): InventoryAppend {
  const after = readCandidateInventory(candidateBytes, profile, objectRecordsOverride);
  if (after.objectRecords !== before.objectRecords) {
    throw unsupported("preview candidate changes the OBJECT drawable-record configuration");
  }
  if (after.entryCount < before.entryCount) {
    throw unsupported("preview candidate removes OBJECT entries");
  }
  for (let i = 0; i < before.entryCount; i++) {
    if ((after.names[i] ?? "") !== (before.names[i] ?? "")) {
      throw unsupported(`preview candidate reorders or renames OBJECT entry ${i}`);
    }
    if ((after.initials[i] ?? 0) !== (before.initials[i] ?? 0)) {
      throw unsupported(`preview candidate moves OBJECT entry ${i}'s initial location`);
    }
  }
  return { firstNew: before.entryCount, initials: after.initials.slice(before.entryCount) };
}

/** Loop/cel shape check for a VIEW already loaded in the live engine. */
export function sameViewStructure(staged: AgiView, loaded: AgiView): boolean {
  if (staged.loops.length !== loaded.loops.length) return false;
  for (let i = 0; i < staged.loops.length; i++) {
    if (staged.loops[i]!.cels.length !== loaded.loops[i]!.cels.length) return false;
  }
  return true;
}
