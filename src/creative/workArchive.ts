/**
 * Portable creative-work envelope for private Project archives.
 *
 * A project keeps finished creative assets in the kept manifest; everything
 * still unfinished lives in the durable work layer: one recovery row per
 * workspace, plus bare `retained-undo` holds that pin byte inventories the
 * workspace may still reach for. This codec carries that whole set in one
 * detached, versioned record so a private Project archive can preserve
 * unfinished art faithfully — bytes stay in the archive's content-addressed
 * blob entries, this record carries only references.
 *
 * Each entry pairs a logical workspace name with its strict
 * `PortableCreativeRecovery` and the staleness it had at capture. `status`
 * is data, not authority: "current" is admitted only when the entry's
 * recovery base equals the envelope's `basis` field-for-field, and the
 * receiving store re-derives its own classification. A stale entry keeps
 * its original base verbatim and can never silently become current.
 *
 * `basis` is the semantic identity the captured work was classified
 * against: resource revision, authoring fingerprint, interpreter profile
 * and the kept revision. Storage-local counters it does not carry — no
 * project id, lifetime, generation, catalog head, lease owner, expiry,
 * hold id, receipt or credentials. The reader refuses unknown fields,
 * versions and formats before any byte it describes is trusted.
 *
 * `retained` carries bare undo holds as their exact blob inventories; the
 * inventories alone do not claim reconstructable undo history. `blobs` is
 * the declared registry of every hash the envelope references — stored
 * provenance, checked against what the carried recoveries claim — never
 * the bytes themselves.
 */
import {
  CREATIVE_LIMITS,
  CreativeCatalogError,
  compareCodePoints,
  type BlobBucket,
  type BlobHash,
  type RegisteredBlob,
} from "./catalog.ts";
import {
  readCreativeRecovery,
  writeCreativeRecovery,
  type CreativeRecoveryData,
  type PortableCreativeRecovery,
} from "./recovery.ts";
import { projectId, resourceRevision, type ResourceRevision } from "../gameIdentity.ts";
import { PROFILES, type ProfileId } from "../runtime/profile.ts";

export const CREATIVE_WORK_FORMAT = "monotio.agi.creative-work";

/** Hard bounds applied before any output allocation in both directions. */
export const CREATIVE_WORK_LIMITS = Object.freeze({
  /** Durable recovery workspaces one envelope may carry. */
  maxDrafts: CREATIVE_LIMITS.maxSources,
  /** Retained undo snapshots across all workspaces. */
  maxUndos: 64,
  /** Bare retained-undo inventories one envelope may carry. */
  maxRetained: CREATIVE_LIMITS.maxHolds,
  /** Unique blob descriptors the registry may declare. */
  maxBlobs: CREATIVE_LIMITS.maxHoldHashes * 4,
} as const);

/**
 * The semantic identity the captured work was classified against. Unlike a
 * recovery base it has no pins — the kept records each entry pins are
 * carried inside that entry's own recovery — and it is compared field for
 * field, never trusted as authority.
 */
export interface CreativeWorkBasis {
  readonly revision: ResourceRevision;
  /** 64 lowercase hex digits: SHA-256 of the kept editable content. */
  readonly authoring: string;
  readonly profileId: ProfileId;
  /** The kept catalog revision the captured work was classified against. */
  readonly kept: number;
}

/** Whether the captured row still matched its basis at capture time. */
export type CreativeWorkStatus = "current" | "stale";

export interface PortableCreativeWorkEntry {
  readonly workspace: string;
  readonly status: CreativeWorkStatus;
  readonly recovery: PortableCreativeRecovery;
}

/** The canonical stored envelope: validated, detached, canonical order. */
export interface PortableCreativeWork {
  readonly format: typeof CREATIVE_WORK_FORMAT;
  readonly version: 1;
  readonly basis: CreativeWorkBasis;
  /** One durable recovery per workspace, in workspace order. */
  readonly drafts: readonly PortableCreativeWorkEntry[];
  /** Retained undo snapshots, grouped by workspace in workspace order. */
  readonly undos: readonly PortableCreativeWorkEntry[];
  /** Bare retained-undo blob inventories, in canonical order. */
  readonly retained: readonly (readonly BlobHash[])[];
  /** Declared descriptors for every referenced hash; storage provenance. */
  readonly blobs: Readonly<Record<BlobHash, RegisteredBlob>>;
}

/** A write-side entry: the recovery may be data or a decoded envelope. */
export interface CreativeWorkEntryData {
  readonly workspace: string;
  readonly status: CreativeWorkStatus;
  readonly recovery: CreativeRecoveryData | PortableCreativeRecovery;
}

/** The writable shape; `format` and `version` are owned by the codec. */
export interface CreativeWorkData {
  readonly basis: CreativeWorkBasis;
  readonly drafts: readonly CreativeWorkEntryData[];
  readonly undos: readonly CreativeWorkEntryData[];
  readonly retained: readonly (readonly BlobHash[])[];
  readonly blobs: Readonly<Record<BlobHash, RegisteredBlob>>;
}

function invalid(message: string): never {
  throw new CreativeCatalogError("invalid", `Invalid creative work data: ${message}`);
}

function unsupported(message: string): never {
  throw new CreativeCatalogError("unsupported", `Unsupported creative work data: ${message}`);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    invalid(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

function fields(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const record = plainObject(value, label);
  for (const name of required)
    if (!Object.hasOwn(record, name)) invalid(`${label} is missing '${name}'.`);
  for (const key of Object.keys(record))
    if (!required.includes(key) && !optional.includes(key))
      invalid(`${label} has an unknown field '${key}'.`);
  return record;
}

function int(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    invalid(`${label} must be an integer ${min}..${max}.`);
  return value;
}

function boundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    invalid(`${label} must be a string of 1..${max} characters.`);
  return value;
}

function blobHash(value: unknown, label: string): BlobHash {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    invalid(`${label} must be a lowercase SHA-256 hex digest.`);
  return value;
}

const BLOB_BUCKET_NAMES = ["canonical", "disposable", "original"] as const;
const AUTHORING_DIGEST = /^[0-9a-f]{64}$/;
const ENTRY_STATUSES = ["current", "stale"] as const;

function readBasis(value: unknown): CreativeWorkBasis {
  const record = fields(value, "creative work basis", [
    "revision",
    "authoring",
    "profileId",
    "kept",
  ]);
  const revision = resourceRevision(record["revision"]);
  if (revision === null)
    invalid(`basis.revision '${String(record["revision"])}' is not a resource revision.`);
  const authoring = record["authoring"];
  if (typeof authoring !== "string" || !AUTHORING_DIGEST.test(authoring))
    invalid("basis.authoring must be a 64-digit lowercase SHA-256 hex digest.");
  const profile = record["profileId"];
  if (typeof profile !== "string" || !Object.hasOwn(PROFILES, profile))
    invalid(`basis.profileId is not a known profile: ${String(profile)}.`);
  return {
    revision,
    authoring,
    profileId: profile as ProfileId,
    kept: int(record["kept"], 0, Number.MAX_SAFE_INTEGER, "basis.kept"),
  };
}

/** "current" is a claim the envelope verifies, not a field it trusts. */
function checkStatus(
  status: CreativeWorkStatus,
  recovery: PortableCreativeRecovery,
  basis: CreativeWorkBasis,
  label: string,
): void {
  if (status !== "current") return;
  const base = recovery.base;
  if (
    base.revision !== basis.revision ||
    base.authoring !== basis.authoring ||
    base.profileId !== basis.profileId ||
    base.kept !== basis.kept
  )
    invalid(`${label} claims 'current' but its recovery base does not match the basis.`);
}

function readEntry(
  value: unknown,
  label: string,
  basis: CreativeWorkBasis,
): PortableCreativeWorkEntry {
  const record = fields(value, label, ["workspace", "status", "recovery"]);
  const workspace = projectId(record["workspace"]);
  if (workspace === null)
    invalid(`${label}.workspace '${String(record["workspace"])}' is not a workspace id.`);
  const status = record["status"];
  if (!ENTRY_STATUSES.includes(status as (typeof ENTRY_STATUSES)[number]))
    invalid(`${label}.status '${String(status)}' is unknown.`);
  let recovery: PortableCreativeRecovery;
  try {
    recovery = readCreativeRecovery(record["recovery"]);
  } catch (error) {
    if (error instanceof CreativeCatalogError) {
      if (error.code === "unsupported") unsupported(`${label}.recovery: ${error.message}`);
      invalid(`${label}.recovery: ${error.message}`);
    }
    throw error;
  }
  checkStatus(status as CreativeWorkStatus, recovery, basis, label);
  return { workspace, status: status as CreativeWorkStatus, recovery };
}

function readEntries(
  value: unknown,
  label: string,
  bound: number,
  basis: CreativeWorkBasis,
): PortableCreativeWorkEntry[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array of workspaces.`);
  if (value.length > bound) invalid(`${label} lists ${value.length} entries, over ${bound}.`);
  return (value as unknown[]).map((entry, i) => readEntry(entry, `${label}[${i}]`, basis));
}

function readDrafts(value: unknown, basis: CreativeWorkBasis): PortableCreativeWorkEntry[] {
  const drafts = readEntries(value, "creative work drafts", CREATIVE_WORK_LIMITS.maxDrafts, basis);
  for (let i = 1; i < drafts.length; i++)
    if (compareCodePoints(drafts[i - 1]!.workspace, drafts[i]!.workspace) >= 0)
      invalid("creative work drafts must order each workspace once, in canonical order.");
  return drafts;
}

function readUndos(value: unknown, basis: CreativeWorkBasis): PortableCreativeWorkEntry[] {
  const undos = readEntries(value, "creative work undos", CREATIVE_WORK_LIMITS.maxUndos, basis);
  for (let i = 1; i < undos.length; i++)
    if (compareCodePoints(undos[i - 1]!.workspace, undos[i]!.workspace) > 0)
      invalid("creative work undos must keep each workspace's snapshots contiguous and ordered.");
  return undos;
}

/** Canonical order for retained inventories: element-wise, then length. */
function compareInventories(a: readonly BlobHash[], b: readonly BlobHash[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const order = compareCodePoints(a[i]!, b[i]!);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

function readInventory(value: unknown, label: string): BlobHash[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array of blob hashes.`);
  if (value.length === 0 || value.length > CREATIVE_LIMITS.maxHoldHashes)
    invalid(`${label} must list 1..${CREATIVE_LIMITS.maxHoldHashes} blob hashes.`);
  const hashes = (value as unknown[]).map((hash, i) => blobHash(hash, `${label}[${i}]`));
  for (let i = 1; i < hashes.length; i++)
    if (compareCodePoints(hashes[i - 1]!, hashes[i]!) >= 0)
      invalid(`${label} must list each hash once, in canonical order.`);
  return hashes;
}

function readRetained(value: unknown): BlobHash[][] {
  if (!Array.isArray(value)) invalid("creative work retained must be an array of inventories.");
  if (value.length > CREATIVE_WORK_LIMITS.maxRetained)
    invalid(
      `creative work retained lists ${value.length} inventories, over ${CREATIVE_WORK_LIMITS.maxRetained}.`,
    );
  const inventories = (value as unknown[]).map((inventory, i) =>
    readInventory(inventory, `creative work retained[${i}]`),
  );
  for (let i = 1; i < inventories.length; i++)
    if (compareInventories(inventories[i - 1]!, inventories[i]!) >= 0)
      invalid("creative work retained must list each inventory once, in canonical order.");
  return inventories;
}

function readBlobBuckets(value: unknown, label: string): BlobBucket[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((bucket) => BLOB_BUCKET_NAMES.includes(bucket as BlobBucket)) ||
    new Set(value).size !== value.length
  )
    invalid(`${label} must list each known budget bucket at most once.`);
  return [...(value as BlobBucket[])].sort(compareCodePoints);
}

function readRegisteredBlob(value: unknown, label: string): RegisteredBlob {
  const record = fields(value, label, ["hash", "byteLength", "mime", "buckets"]);
  return {
    hash: blobHash(record["hash"], `${label}.hash`),
    byteLength: int(record["byteLength"], 1, Number.MAX_SAFE_INTEGER, `${label}.byteLength`),
    mime: boundedString(record["mime"], CREATIVE_LIMITS.maxMimeLength, `${label}.mime`),
    buckets: readBlobBuckets(record["buckets"], `${label}.buckets`),
  };
}

function readBlobMap(value: unknown): Record<BlobHash, RegisteredBlob> {
  const record = plainObject(value, "creative work blobs");
  const entries = Object.entries(record);
  if (entries.length > CREATIVE_WORK_LIMITS.maxBlobs)
    invalid(
      `creative work blobs lists ${entries.length} blobs; the bound is ${CREATIVE_WORK_LIMITS.maxBlobs}.`,
    );
  const declared: Record<BlobHash, RegisteredBlob> = {};
  for (const [key, descriptor] of entries) {
    const hash = blobHash(key, "creative work blobs key");
    const entry = readRegisteredBlob(descriptor, `creative work blobs['${hash}']`);
    if (entry.hash !== hash) invalid(`creative work blobs['${hash}'] claims hash '${entry.hash}'.`);
    declared[hash] = entry;
  }
  return declared;
}

/**
 * The declared registry must cover exactly the hashes the envelope
 * references. A hash a carried recovery claims must agree on byte length
 * and mime; buckets are stored provenance and may widen.
 */
function checkRegistry(
  declared: Record<BlobHash, RegisteredBlob>,
  entries: readonly PortableCreativeWorkEntry[],
  retained: readonly (readonly BlobHash[])[],
): void {
  const referenced = new Map<BlobHash, RegisteredBlob>();
  const claim = (hash: BlobHash, descriptor: RegisteredBlob | undefined, label: string) => {
    const existing = referenced.get(hash);
    if (existing !== undefined) {
      // `existing` is the declared registry descriptor the first claim was
      // already checked against, so agreement with it covers every prior
      // claim too — on byte length and mime alike, whatever position the
      // later claim appears at.
      if (descriptor !== undefined) {
        if (descriptor.byteLength !== existing.byteLength)
          invalid(`${label} claims hash '${hash}' with a different byte length.`);
        if (descriptor.mime !== existing.mime)
          invalid(`${label} claims hash '${hash}' with a different mime.`);
      }
      return;
    }
    const entry = declared[hash];
    if (entry === undefined) invalid(`${label} references hash '${hash}' the registry lacks.`);
    if (
      descriptor !== undefined &&
      (entry.byteLength !== descriptor.byteLength || entry.mime !== descriptor.mime)
    )
      invalid(`${label}['${hash}'] disagrees with the carried recovery's descriptor.`);
    referenced.set(hash, entry);
  };
  for (const entry of entries)
    for (const [hash, descriptor] of Object.entries(entry.recovery.blobs))
      claim(hash, descriptor, `creative work['${entry.workspace}']`);
  for (const inventory of retained)
    for (const hash of inventory) claim(hash, undefined, "creative work retained");
  for (const hash of Object.keys(declared))
    if (!referenced.has(hash))
      invalid(`creative work blobs['${hash}'] is not referenced by any entry.`);
}

const ENVELOPE_FIELDS = ["format", "version", "basis", "drafts", "undos", "retained", "blobs"];

/**
 * Validate a stored creative-work envelope. Format and version are checked
 * before any content is traversed; the field set is exact, drafts order
 * unique workspaces and undos keep each workspace's snapshots contiguous,
 * every "current" claim is checked against the basis, and the blob
 * registry must cover exactly the referenced hashes. Returned records are
 * the canonical detached reads.
 */
export function readCreativeWork(value: unknown): PortableCreativeWork {
  const envelope = plainObject(value, "creative work");
  if (envelope["format"] !== CREATIVE_WORK_FORMAT)
    unsupported(
      `creative work.format '${String(envelope["format"])}' is not '${CREATIVE_WORK_FORMAT}'.`,
    );
  if (envelope["version"] !== 1)
    unsupported(`creative work.version ${String(envelope["version"])} is not 1.`);
  const record = fields(envelope, "creative work", ENVELOPE_FIELDS);
  const basis = readBasis(record["basis"]);
  const drafts = readDrafts(record["drafts"], basis);
  const undos = readUndos(record["undos"], basis);
  const retained = readRetained(record["retained"]);
  const blobs = readBlobMap(record["blobs"]);
  checkRegistry(blobs, [...drafts, ...undos], retained);
  const out: Record<BlobHash, RegisteredBlob> = {};
  for (const hash of Object.keys(blobs).sort(compareCodePoints)) out[hash] = blobs[hash]!;
  return {
    format: CREATIVE_WORK_FORMAT,
    version: 1,
    basis,
    drafts,
    undos,
    retained,
    blobs: out,
  };
}

function writeEntry(entry: CreativeWorkEntryData, label: string): Record<string, unknown> {
  const workspace = projectId(entry.workspace);
  if (workspace === null)
    invalid(`${label}.workspace '${String(entry.workspace)}' is not a workspace id.`);
  if (!ENTRY_STATUSES.includes(entry.status))
    invalid(`${label}.status '${String(entry.status)}' is unknown.`);
  const record = plainObject(entry, label);
  for (const key of Object.keys(record))
    if (key !== "workspace" && key !== "status" && key !== "recovery")
      invalid(`${label} has an unknown field '${key}'.`);
  return {
    workspace,
    status: entry.status,
    recovery: writeCreativeRecovery(entry.recovery),
  };
}

/**
 * Serialize a creative-work envelope. Entries are canonicalized through the
 * recovery codec, drafts are sorted by workspace, undos keep each
 * workspace's order, inventories and the registry are canonicalized. The
 * registry is declared provenance: it must cover exactly the referenced
 * hashes and agree with each recovery's claims. The stored record is
 * self-checked through the reader before it is returned.
 */
export function writeCreativeWork(
  data: CreativeWorkData | PortableCreativeWork,
): Record<string, unknown> {
  const input = fields(
    data,
    "creative work input",
    ["basis", "drafts", "undos", "retained", "blobs"],
    ["format", "version"],
  );
  if (input["format"] !== undefined && input["format"] !== CREATIVE_WORK_FORMAT)
    unsupported(
      `creative work input.format '${String(input["format"])}' is not '${CREATIVE_WORK_FORMAT}'.`,
    );
  if (input["version"] !== undefined && input["version"] !== 1)
    unsupported(`creative work input.version ${String(input["version"])} is not 1.`);
  const drafts = data.drafts.map((entry, i) => writeEntry(entry, `creative work drafts[${i}]`));
  drafts.sort((a, b) => compareCodePoints(a["workspace"] as string, b["workspace"] as string));
  const undos = data.undos.map((entry, i) => writeEntry(entry, `creative work undos[${i}]`));
  // Stable sort keeps one workspace's snapshot order inside its group.
  undos.sort((a, b) => compareCodePoints(a["workspace"] as string, b["workspace"] as string));
  const retained = data.retained.map((inventory, i) =>
    readInventory([...inventory].sort(compareCodePoints), `creative work input retained[${i}]`),
  );
  retained.sort(compareInventories);
  const record: Record<string, unknown> = {
    format: CREATIVE_WORK_FORMAT,
    version: 1,
    basis: { ...structuredClone(data.basis) },
    drafts,
    undos,
    retained,
    blobs: structuredClone(data.blobs),
  };
  readCreativeWork(structuredClone(record));
  return record;
}
