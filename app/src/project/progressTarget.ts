/**
 * The physical address of one game's stored progress.
 *
 * A `ProgressTarget` is frozen locator and binding data, created at a safe
 * continuation boundary and handed to the progress callers. It replaces the
 * released practice of passing the progress storage key around as a bare
 * string and re-deriving `projectId(key)` at every use site — a spelling
 * that silently dropped installed instances whose folder is outside the
 * project-id alphabet and let two folders sharing a WORDS.TOK hash land on
 * one record set.
 *
 * Two disjoint physical domains:
 * - `installed:<digest>:<revision>` — a locally installed game build,
 *   addressed by the SHA-256 of its folder's exact UTF-8 bytes bound to the
 *   full resource revision it runs. Case and Unicode spelling participate
 *   in the digest, and a replaced build under the same folder owns a fresh
 *   address rather than the previous build's records. Folder text stays
 *   out of the storage key, and the prefix separates it from a saved
 *   project's `project:` address.
 * - `project:<id>:<epoch>` — a saved project body, addressed by its
 *   unchanged `ProjectId` bound to the body's live lifetime epoch captured
 *   atomically with the body read. A delete-and-recreate under the same id
 *   mints a new epoch, so the recreated body can never inherit the removed
 *   one's progress records.
 *
 * A target is locator/binding information, not issued mutation authority:
 * the runtime history service still validates owner, body presence and
 * lifetime inside each actual transaction. The project factory binds an
 * epoch that a platform binder captured in the same atomic snapshot that
 * proved the body exists — the pure factory cannot establish presence and
 * never mints a lifetime of its own.
 *
 * `legacyKeys` carries the storage spellings released builds may already
 * hold this game's progress under, in released priority order, for read
 * context and migration. `identity` is the released `GameIdentity` record —
 * `identity.project` is always a valid `ProjectId`, never a colon locator.
 */
import { sha256Hex } from "../../../src/crypto.ts";
import {
  projectId,
  resourceRevision,
  type GameIdentity,
  type ProjectId,
  type ResourceRevision,
} from "../../../src/gameIdentity.ts";

/**
 * The installed domain's locator prefix. `installed:` cannot collide with
 * a saved-domain `project:` address, and neither can appear inside a valid
 * `ProjectId` (its alphabet excludes `:`), so the two physical domains and
 * every legacy storage key stay pairwise disjoint.
 */
const INSTALLED_LOCATOR_PREFIX = "installed:";
const PROJECT_LOCATOR_PREFIX = "project:";

/** Canonical lowercase hex of one SHA-256 folder digest in a locator. */
const FOLDER_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The complete unreleased predecessor locator: `installed:` + the folder
 * digest with no revision suffix. Progress stored under it predates the
 * revision binding; the spelling stays recognized as namespace data at the
 * read boundary while never parsing as a writable current locator.
 */
const LEGACY_INSTALLED_NAMESPACE_PATTERN = /^installed:[0-9a-f]{64}$/;

/**
 * The epoch alphabet a lifetime receipt can hold: `initial` (a body written
 * before receipts existed) or a lowercase hyphenated `crypto.randomUUID()`.
 * Receipts never carry `/` or `:` — those would corrupt the
 * `project:<id>:<epoch>` and `history/<key>/…` key layouts.
 */
const BODY_EPOCH_PATTERN =
  /^(?:initial|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The captured live epoch, or null when the value cannot be one. Never maps null to `initial`. */
function validBodyEpoch(value: unknown): string | null {
  return typeof value === "string" && BODY_EPOCH_PATTERN.test(value) ? value : null;
}

/**
 * The folder's exact UTF-8 bytes, or null when there is no single encoding.
 * A string carrying an unpaired surrogate encodes ambiguously (the encoder
 * maps it to U+FFFD, so two different spellings would share one locator);
 * it is refused rather than hashed.
 */
function utf8FolderBytes(folder: string): Uint8Array | null {
  if (typeof folder !== "string" || folder === "" || /[\uD800-\uDFFF]/u.test(folder)) return null;
  return new TextEncoder().encode(folder);
}

/**
 * The installed-entry evidence a caller already holds. `folder` is the
 * instance's exact served spelling; `hash` and `alias` are the released
 * convenience spellings its progress may already be stored under. A
 * descriptor that supplies no folder stays legacy read context — it names
 * no current independent instance.
 */
export interface InstalledTargetEvidence {
  readonly folder?: string | null | undefined;
  readonly hash?: string | null | undefined;
  readonly alias?: string | null | undefined;
}

interface ProgressTargetBase {
  readonly kind: "installed" | "project";
  /** The physical address: `installed:<digest>:<revision>` or `project:<id>:<epoch>`. */
  readonly locator: string;
  /** The released identity record; `identity.project` is a valid `ProjectId`. */
  readonly identity: GameIdentity;
  /** Released storage keys progress may already live under, priority order. */
  readonly legacyKeys: readonly string[];
}

/** One installed game instance's progress address. */
export interface InstalledProgressTarget extends ProgressTargetBase {
  readonly kind: "installed";
  /** The served folder's exact spelling, case and Unicode preserved. */
  readonly folder: string;
}

/** One saved project body's progress address, bound to its captured epoch. */
export interface ProjectProgressTarget extends ProgressTargetBase {
  readonly kind: "project";
  readonly project: ProjectId;
  /**
   * The live body lifetime the platform binder captured atomically with
   * the body snapshot: the `lifetime/<id>` receipt's epoch, or `initial`
   * for a receipt-free pre-receipt body. A deleted lifetime (null) is
   * refused upstream, never rebound here.
   */
  readonly bodyEpoch: string;
}

/** Where one game's progress lives: an installed instance or a saved body epoch. */
export type ProgressTarget = InstalledProgressTarget | ProjectProgressTarget;

/**
 * The physical locator one exact folder spelling owns while it serves one
 * full resource revision: `installed:` + SHA-256 of the folder's UTF-8
 * bytes + `:` + the revision. Null when the folder is missing, empty or
 * has no single UTF-8 encoding, or when the revision is not a full
 * released revision. The revision is required — a folder-only spelling is
 * the unreleased predecessor form, never a writable current address.
 */
export function installedProgressLocator(folder: string, revision: string): string | null {
  const bytes = utf8FolderBytes(folder);
  const rev = resourceRevision(revision);
  if (bytes === null || rev === null) return null;
  return `${INSTALLED_LOCATOR_PREFIX}${sha256Hex(bytes)}:${rev}`;
}

/**
 * The released storage keys an installed instance's progress may already
 * live under, in the released fallback order: the folder itself when it is
 * a valid `ProjectId`, then the descriptor's `hash`, then its `alias`.
 * Only explicitly supplied evidence becomes a candidate.
 */
function installedLegacyKeys(folder: string, evidence: InstalledTargetEvidence): readonly string[] {
  const keys: string[] = [];
  if (projectId(folder) !== null) keys.push(folder);
  for (const spelling of [evidence.hash, evidence.alias]) {
    if (typeof spelling === "string" && spelling !== "" && !keys.includes(spelling))
      keys.push(spelling);
  }
  return Object.freeze(keys);
}

/**
 * The progress target for one installed instance. `evidence` supplies the
 * exact folder and the legacy spellings; `revision` is the instance's
 * current full resource revision. Returns null when the folder is missing,
 * empty or ambiguous under UTF-8, or when the revision is not a full
 * released revision. A descriptor without a folder yields no target — it
 * stays legacy read context.
 */
export function installedProgressTarget(
  evidence: InstalledTargetEvidence,
  revision: string,
): InstalledProgressTarget | null {
  const folder = evidence.folder;
  const locator = typeof folder === "string" ? installedProgressLocator(folder, revision) : null;
  if (folder == null || locator === null) return null;
  const parsed = parseProgressLocator(locator);
  if (parsed?.kind !== "installed") return null;
  // A folder that is itself a valid ProjectId keeps it, exactly as released
  // storage keys did. Any other spelling (spaces, Unicode, overlength, a
  // literal colon) gets a stable id minted from the same digest — always a
  // valid ProjectId, never a locator.
  const project = projectId(folder) ?? projectId(`installed-${parsed.folderDigest}`);
  if (project === null) return null;
  return Object.freeze({
    kind: "installed",
    locator,
    folder,
    identity: Object.freeze({ project, revision: parsed.revision }),
    legacyKeys: installedLegacyKeys(folder, evidence),
  });
}

/**
 * The progress target for one saved project body. `project` is the body's
 * unchanged `ProjectId`; `bodyEpoch` is the live lifetime string the
 * platform binder captured in the same atomic snapshot that established
 * the body exists (`readHistoryLifetime`/`liveLifetime` semantics:
 * `initial` or the receipt's UUID). `initial` is accepted only as that
 * explicitly provided live epoch — null (a deleted lifetime), undefined
 * and any other spelling are refused, never defaulted. Returns null on
 * any invalid input.
 */
export function projectProgressTarget(
  project: string,
  revision: string,
  bodyEpoch: string | null | undefined,
): ProjectProgressTarget | null {
  const id = projectId(project);
  const rev = resourceRevision(revision);
  const epoch = validBodyEpoch(bodyEpoch);
  if (id === null || rev === null || epoch === null) return null;
  return Object.freeze({
    kind: "project",
    locator: `${PROJECT_LOCATOR_PREFIX}${id}:${epoch}`,
    project: id,
    bodyEpoch: epoch,
    identity: Object.freeze({ project: id, revision: rev }),
    legacyKeys: Object.freeze([id]),
  });
}

/** The decoded fields of one supported physical locator. */
export type ParsedProgressLocator =
  | {
      readonly kind: "installed";
      readonly folderDigest: string;
      readonly revision: ResourceRevision;
    }
  | {
      readonly kind: "project";
      readonly project: ProjectId;
      readonly bodyEpoch: string;
    };

/**
 * Decode a physical progress locator. Only the two supported forms parse —
 * `installed:<64 lowercase hex>:<full resource revision>` and
 * `project:<id>:<epoch>` — with each component validated against its
 * released alphabet. The unreleased folder-only `installed:<digest>`
 * spelling, legacy spellings (a bare hash, alias, folder or storage key)
 * and every unknown prefix return null; nothing else aliases into these
 * addresses.
 */
export function parseProgressLocator(locator: string): ParsedProgressLocator | null {
  if (typeof locator !== "string") return null;
  if (locator.startsWith(INSTALLED_LOCATOR_PREFIX)) {
    const parts = locator.slice(INSTALLED_LOCATOR_PREFIX.length).split(":");
    if (parts.length !== 2) return null;
    const revision = resourceRevision(parts[1]);
    if (revision === null || !FOLDER_DIGEST_PATTERN.test(parts[0]!)) return null;
    return Object.freeze({ kind: "installed", folderDigest: parts[0]!, revision });
  }
  if (locator.startsWith(PROJECT_LOCATOR_PREFIX)) {
    const parts = locator.slice(PROJECT_LOCATOR_PREFIX.length).split(":");
    if (parts.length !== 2) return null;
    const project = projectId(parts[0]);
    const epoch = validBodyEpoch(parts[1]);
    if (project === null || epoch === null) return null;
    return Object.freeze({ kind: "project", project, bodyEpoch: epoch });
  }
  return null;
}

/**
 * Whether `source` names a progress namespace address — the read-boundary
 * classification shared by the legacy snapshot refusal and every Earlier
 * progress discovery exclusion. True for exactly two spellings:
 *
 * 1. a locator the strict `parseProgressLocator` accepts
 *    (`installed:<digest>:<revision>` or `project:<id>:<epoch>`);
 * 2. the complete unreleased predecessor `installed:<64 lowercase hex>`
 *    with no revision suffix.
 *
 * Everything else — bare folders, hashes, aliases, and near-match
 * spellings like an uppercase or short digest — is an ordinary released
 * source spelling. The input is classified exactly as supplied: no case
 * change, trim, Unicode normalization or decoding happens here (callers
 * perform the one required saves-key decode themselves).
 *
 * This recognizes an address class only. It never returns a
 * `ProgressTarget`, revision, owner, inferred identity, migration plan or
 * writable address — writable callers keep using `installedProgressLocator`
 * and `projectProgressTarget`. A released folder literally spelled like the
 * old grammar cannot be told apart from that grammar through this string
 * alone, so the established namespace refusal stands and the explicit
 * `{kind: "local"}` read route keeps those bytes reachable.
 */
export function isProgressNamespace(source: string): boolean {
  return parseProgressLocator(source) !== null || LEGACY_INSTALLED_NAMESPACE_PATTERN.test(source);
}

/** The outcome of resolving an installed locator against served instances. */
export type InstalledFolderResolution =
  | { readonly status: "resolved"; readonly folder: string }
  | { readonly status: "unresolved" }
  | { readonly status: "ambiguous"; readonly folders: readonly string[] };

/**
 * Resolve an `installed:` locator to the exact served folder its digest
 * names, by folder-digest equality alone — each entry's folder is
 * re-digested and compared; a convenience spelling never counts. String
 * entries name a folder directly. A descriptor without a folder
 * contributes nothing. Zero matching folders resolves `unresolved`; more
 * than one distinct folder resolves `ambiguous` with all of them — a
 * collision is reported, never settled by picking first. A locator that
 * is not a valid installed address is `unresolved`.
 *
 * The locator's revision takes no part in routing: a resolved folder only
 * proves which instance the address belongs to. Whether the folder still
 * serves that exact revision is the caller's separate check against the
 * fetched build.
 */
export function resolveInstalledFolder(
  locator: string,
  entries: readonly (string | InstalledTargetEvidence)[] | null | undefined,
): InstalledFolderResolution {
  const parsed = parseProgressLocator(locator);
  if (parsed?.kind !== "installed") return Object.freeze({ status: "unresolved" });
  const folders: string[] = [];
  for (const entry of entries ?? []) {
    const folder = typeof entry === "string" ? entry : entry.folder;
    if (folder == null) continue;
    const bytes = utf8FolderBytes(folder);
    if (bytes !== null && sha256Hex(bytes) === parsed.folderDigest && !folders.includes(folder))
      folders.push(folder);
  }
  if (folders.length === 0) return Object.freeze({ status: "unresolved" });
  if (folders.length === 1) return Object.freeze({ status: "resolved", folder: folders[0]! });
  return Object.freeze({ status: "ambiguous", folders: Object.freeze(folders) });
}
