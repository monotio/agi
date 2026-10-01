/**
 * Creative asset storage: the staged/kept blob store beside the project body.
 *
 * Every record lives in the shared "projects" object store as a namespaced
 * sidecar — the authoritative catalog at `creative/<projectId>` and immutable
 * content-addressed blobs under `creative/<projectId>/blob/<sha256>`. There
 * is no separate database and no localStorage authority: discovery already
 * ignores "/" keys, so losing the index loses nothing here.
 *
 * Staging writes blob records and a lease row in one transaction so recovery
 * can reference staged bytes before they are kept. Publication itself is a
 * commitProject admission — the body, its lifetime receipt, the commit
 * receipt and the new kept catalog land in the one transaction there.
 * Renewal, release, explicit durable holds (recovery / retained undo) and GC
 * are separate bounded catalog mutations on the same monotone head revision.
 *
 * Unknown formats or nested versions are refused without rewriting; a
 * missing or mismatched required catalog reports a typed error rather than
 * reading as empty.
 */
import { sha256Hex } from "../../../src/crypto.ts";
import {
  CREATIVE_LIMITS,
  CreativeCatalogError,
  checkRetainedBudgets,
  checkSourceDerivations,
  compareCodePoints,
  creativeBlobKey,
  creativeCatalogKey,
  derivativeBlobBucket,
  emptyCreativeCatalog,
  mergeBlobRegistration,
  reachableBlobHashes,
  readCreativeCatalogRecord,
  readCreativeDerivative,
  readCreativeHold,
  readCreativeLease,
  readCreativeRecipe,
  readCreativeSource,
  sameVersionRef,
  verifyCreativeBlob,
  versionRefKey,
  writeCreativeBlobRecord,
  writeCreativeCatalogRecord,
  type BlobBucket,
  type BlobHash,
  type BlobRef,
  type CreativeCatalog,
  type CreativeLease,
  type RegisteredBlob,
} from "../../../src/creative/catalog.ts";
import { projectId as validProjectId, type ProjectId } from "../../../src/gameIdentity.ts";
import type { CreativeMarker } from "./gameTypes.ts";
import {
  historyLifetimeGuard,
  projectBodyGuard,
  readBodyRecordSet,
  serializeWrite,
  updateBodyRecords,
  bodyTransaction,
} from "./gameStorage.ts";

/** Default staging lease lifetime; renewals extend by the same bound. */
const CREATIVE_LEASE_MS = 10 * 60 * 1000;
/** The longest ttl a stage or renew may grant. */
const CREATIVE_LEASE_MAX_MS = 60 * 60 * 1000;

/** Why a creative storage operation refused. */
export type CreativeStoreReason =
  | "missing" // a required catalog, lease or blob record is absent
  | "conflict" // a head/identity compare-and-swap failed
  | "lease" // the lease expired, or belongs to another owner/workspace
  | "integrity" // bytes or descriptors do not match their claims
  | "budget"; // a declared limit is exceeded

export class CreativeStoreError extends Error {
  readonly reason: CreativeStoreReason;
  constructor(reason: CreativeStoreReason, message: string) {
    super(message);
    this.name = "CreativeStoreError";
    this.reason = reason;
  }
}

function storeError(reason: CreativeStoreReason, message: string): CreativeStoreError {
  return new CreativeStoreError(reason, message);
}

function requireProjectId(projectId: ProjectId): void {
  if (validProjectId(projectId) === null)
    throw new CreativeStoreError("missing", "The project id is invalid.");
}

function readCatalog(raw: unknown, projectId: ProjectId): CreativeCatalog | undefined {
  return readCreativeCatalogRecord(raw, projectId);
}

function ttl(input: number | undefined): number {
  if (input === undefined) return CREATIVE_LEASE_MS;
  if (!Number.isFinite(input) || input <= 0)
    throw new CreativeStoreError(
      "lease",
      "The lease duration must be a positive millisecond time.",
    );
  return Math.min(input, CREATIVE_LEASE_MAX_MS);
}

/**
 * Stage candidate records and blob bytes under a lease. The blob records and
 * the manifest's lease row land in one transaction — a recovery payload may
 * reference staged bytes as soon as this returns. `expectedHead` is the
 * catalog revision the caller prepared against (0 for a project's first
 * catalog). Re-staging the same lease id under the same owner and workspace
 * replaces its staged set; a different owner is a conflict.
 */
export async function stageCreativeBlobs(input: {
  readonly projectId: ProjectId;
  readonly expectedHead: number;
  readonly lease: { readonly id: string; readonly owner: string; readonly workspace: string };
  readonly staged?: {
    readonly sources?: readonly unknown[];
    readonly derivatives?: readonly unknown[];
    readonly recipes?: readonly unknown[];
  };
  readonly blobs?: readonly {
    readonly hash: string;
    readonly mime: string;
    readonly bytes: Uint8Array;
  }[];
  readonly expectedLifetime?: string | null | undefined;
  readonly ttlMs?: number | undefined;
  /**
   * Optional synchronous gate called inside the staging transaction after
   * every structural check: it receives the exact catalog this write
   * replaces — pins a caller captured earlier (kept revision, consulted
   * records, operation liveness) can compare against committed state at
   * the durable admission point. Throwing refuses the stage; nothing is
   * written.
   */
  readonly admission?: ((catalog: CreativeCatalog) => void) | undefined;
  readonly now?: (() => number) | undefined;
}): Promise<{ head: number; kept: number; lease: CreativeLease }> {
  const projectId = input.projectId;
  requireProjectId(projectId);
  if (!Number.isSafeInteger(input.expectedHead) || input.expectedHead < 0)
    throw new CreativeStoreError("conflict", "The expected catalog head is invalid.");
  const now = input.now?.() ?? Date.now();
  // Ownership precedes the first await: clone and verify the offered bytes.
  const stagedBlobs = new Map<BlobHash, { ref: BlobRef; bytes: Uint8Array }>();
  for (const [i, blob] of (input.blobs ?? []).entries()) {
    const label = `blobs[${i}]`;
    if (!(blob.bytes instanceof Uint8Array))
      throw storeError("integrity", `${label} bytes must be a byte array.`);
    const bytes = new Uint8Array(blob.bytes);
    if (bytes.length === 0) throw storeError("integrity", `${label} must not be empty.`);
    const hash = typeof blob.hash === "string" ? blob.hash : "";
    if (sha256Hex(bytes) !== hash)
      throw storeError("integrity", `${label} bytes do not match their claimed hash.`);
    if (
      typeof blob.mime !== "string" ||
      blob.mime.length === 0 ||
      blob.mime.length > CREATIVE_LIMITS.maxMimeLength
    )
      throw storeError(
        "integrity",
        `${label}.mime must be a string of 1..${CREATIVE_LIMITS.maxMimeLength} characters.`,
      );
    const prior = stagedBlobs.get(hash);
    if (prior !== undefined && prior.ref.mime !== blob.mime)
      throw storeError("integrity", `${label} repeats a hash with a different mime.`);
    if (prior === undefined)
      stagedBlobs.set(hash, { ref: { hash, byteLength: bytes.length, mime: blob.mime }, bytes });
  }
  if (stagedBlobs.size > CREATIVE_LIMITS.maxStagedBlobs)
    throw storeError("budget", `staging ${stagedBlobs.size} blobs exceeds the staged bound.`);
  // The staged records are validated once here, canonically — the codecs are
  // pure, so this needs no transaction and their output is detached.
  const staged = {
    sources: (input.staged?.sources ?? []).map((source, i) =>
      readCreativeSource(source, `staged.sources[${i}]`),
    ),
    derivatives: (input.staged?.derivatives ?? []).map((derivative, i) =>
      readCreativeDerivative(derivative, `staged.derivatives[${i}]`),
    ),
    recipes: (input.staged?.recipes ?? []).map((recipe, i) =>
      readCreativeRecipe(recipe, `staged.recipes[${i}]`),
    ),
    blobs: [] as BlobRef[],
  };
  // Every blob reference the staged records make, with the budget buckets
  // they claim it under. The same bytes under two roles keep both buckets.
  const stagedClaims = new Map<BlobHash, { ref: BlobRef; buckets: Set<BlobBucket> }>();
  const claim = (ref: BlobRef, bucket: BlobBucket, label: string): void => {
    const prior = stagedClaims.get(ref.hash);
    if (prior === undefined) {
      stagedClaims.set(ref.hash, { ref, buckets: new Set([bucket]) });
      return;
    }
    if (prior.ref.byteLength !== ref.byteLength || prior.ref.mime !== ref.mime)
      throw storeError("integrity", `${label} conflicts with another claim on blob '${ref.hash}'.`);
    prior.buckets.add(bucket);
  };
  for (const source of staged.sources) {
    claim(source.encoded, "original", "staged source encoded");
    claim(source.normalized.blob, "canonical", "staged source normalized");
  }
  for (const derivative of staged.derivatives)
    claim(derivative.blob, derivativeBlobBucket(derivative.purpose), "staged derivative");
  // The lease's blob list is derived: every reference its staged records
  // make, deduplicated. Bytes staged under a lease must be claimed by a
  // staged record — an unreferenced blob is refused.
  staged.blobs = [...stagedClaims.values()]
    .map(({ ref }) => ref)
    .sort((a, b) => compareCodePoints(a.hash, b.hash));
  for (const hash of stagedBlobs.keys())
    if (!stagedClaims.has(hash))
      throw storeError(
        "integrity",
        `staged blob '${hash}' is not referenced by any staged record.`,
      );
  const expiresAt = now + ttl(input.ttlMs);
  const lease = readCreativeLease({
    id: input.lease.id,
    owner: input.lease.owner,
    workspace: input.lease.workspace,
    expiresAt,
    staged,
  });
  const key = creativeCatalogKey(projectId);
  return serializeWrite(projectId, () =>
    updateBodyRecords(
      key,
      (raw) => {
        const catalog = readCatalog(raw, projectId) ?? emptyCreativeCatalog(projectId);
        if (catalog.head !== input.expectedHead)
          throw storeError(
            "conflict",
            `the catalog moved to head ${catalog.head}; expected ${input.expectedHead}.`,
          );
        const previous = catalog.leases.find((entry) => entry.id === lease.id);
        if (
          previous !== undefined &&
          (previous.owner !== lease.owner || previous.workspace !== lease.workspace)
        )
          throw storeError(
            "conflict",
            `lease '${lease.id}' belongs to another owner or workspace.`,
          );
        const leases =
          previous === undefined
            ? [...catalog.leases, lease]
            : catalog.leases.map((entry) => (entry.id === lease.id ? lease : entry));
        if (leases.length > CREATIVE_LIMITS.maxLeases)
          throw storeError(
            "budget",
            `the project already holds ${CREATIVE_LIMITS.maxLeases} staging leases.`,
          );
        // Every blob a staged record names must be freshly staged here or
        // already registered, with the same byte length and mime; bucket
        // provenance unions into the registry.
        const blobs: Record<BlobHash, RegisteredBlob> = { ...catalog.blobs };
        for (const [hash, { ref, buckets }] of stagedClaims) {
          const descriptor = catalog.blobs[hash] ?? stagedBlobs.get(hash)?.ref;
          if (descriptor === undefined)
            throw storeError(
              "integrity",
              `a staged record references blob '${hash}' that was not staged.`,
            );
          if (descriptor.byteLength !== ref.byteLength || descriptor.mime !== ref.mime)
            throw storeError("integrity", `blob '${hash}' does not match its descriptor.`);
          try {
            for (const bucket of buckets) mergeBlobRegistration(blobs, ref, bucket);
          } catch (error) {
            if (error instanceof CreativeCatalogError) throw storeError("integrity", error.message);
            throw error;
          }
        }
        const next: CreativeCatalog = {
          ...catalog,
          head: catalog.head + 1,
          leases: leases.sort((a, b) => compareCodePoints(a.id, b.id)),
          blobs,
        };
        // Staged derivation closure: a composite's two parents resolve in
        // the kept set or this same lease — never another lease's staged
        // records — and a staged record may not reuse a kept identity
        // under different data.
        for (const source of lease.staged.sources) {
          const kept = catalog.sources.find((entry) =>
            sameVersionRef(entry.identity, source.identity),
          );
          if (kept !== undefined && JSON.stringify(kept) !== JSON.stringify(source))
            throw storeError(
              "integrity",
              `staged source '${versionRefKey(source.identity)}' reuses a kept identity under a different record.`,
            );
        }
        try {
          checkSourceDerivations(
            [...catalog.sources, ...lease.staged.sources],
            `lease '${lease.id}' staged sources`,
          );
        } catch (error) {
          if (error instanceof CreativeCatalogError) throw storeError("integrity", error.message);
          throw error;
        }
        // Budgets hold prospectively over everything retained at this moment:
        // kept records, every live lease's staged set (including this one)
        // and every durable hold — each hash once per bucket it claims.
        try {
          checkRetainedBudgets(next, now, "staging");
        } catch (error) {
          if (error instanceof CreativeCatalogError) throw storeError("budget", error.message);
          throw error;
        }
        input.admission?.(catalog);
        const puts: unknown[] = [writeCreativeCatalogRecord(next)];
        for (const { ref, bytes } of stagedBlobs.values())
          puts.push(writeCreativeBlobRecord(projectId, ref, bytes));
        return { result: { head: next.head, kept: next.kept, lease }, puts };
      },
      [
        projectBodyGuard(projectId, () => {}),
        historyLifetimeGuard(projectId, input.expectedLifetime),
      ],
    ),
  );
}

/**
 * Renew a live lease. An expired lease cannot be renewed — its staged set is
 * already collectible; stage it again instead. Returns the new catalog head.
 */
export async function renewCreativeLease(input: {
  readonly projectId: ProjectId;
  readonly lease: { readonly id: string; readonly owner: string };
  readonly expectedHead?: number | undefined;
  readonly expectedLifetime?: string | null | undefined;
  readonly ttlMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}): Promise<{ head: number; expiresAt: number }> {
  const projectId = input.projectId;
  requireProjectId(projectId);
  const now = input.now?.() ?? Date.now();
  const expiresAt = now + ttl(input.ttlMs);
  const key = creativeCatalogKey(projectId);
  return serializeWrite(projectId, () =>
    updateBodyRecords(
      key,
      (raw) => {
        const catalog = readCatalog(raw, projectId);
        if (catalog === undefined)
          throw storeError("missing", "the project has no creative catalog.");
        checkExpectedHead(catalog, input.expectedHead);
        const lease = catalog.leases.find((entry) => entry.id === input.lease.id);
        if (lease === undefined)
          throw storeError("missing", `lease '${input.lease.id}' was not found.`);
        if (lease.owner !== input.lease.owner)
          throw storeError("lease", `lease '${input.lease.id}' belongs to another owner.`);
        if (lease.expiresAt <= now)
          throw storeError("lease", `lease '${input.lease.id}' already expired; stage it again.`);
        const next: CreativeCatalog = {
          ...catalog,
          head: catalog.head + 1,
          leases: catalog.leases.map((entry) =>
            entry.id === lease.id ? { ...entry, expiresAt } : entry,
          ),
        };
        return {
          result: { head: next.head, expiresAt },
          puts: [writeCreativeCatalogRecord(next)],
        };
      },
      historyLifetimeGuard(projectId, input.expectedLifetime),
    ),
  );
}

/** Release a lease the owner no longer needs; its staged set becomes collectible. */
export async function releaseCreativeLease(input: {
  readonly projectId: ProjectId;
  readonly lease: { readonly id: string; readonly owner: string };
  readonly expectedHead?: number | undefined;
  readonly expectedLifetime?: string | null | undefined;
}): Promise<{ head: number }> {
  const projectId = input.projectId;
  requireProjectId(projectId);
  const key = creativeCatalogKey(projectId);
  return serializeWrite(projectId, () =>
    updateBodyRecords(
      key,
      (raw) => {
        const catalog = readCatalog(raw, projectId);
        if (catalog === undefined)
          throw storeError("missing", "the project has no creative catalog.");
        checkExpectedHead(catalog, input.expectedHead);
        const lease = catalog.leases.find((entry) => entry.id === input.lease.id);
        if (lease === undefined)
          throw storeError("missing", `lease '${input.lease.id}' was not found.`);
        if (lease.owner !== input.lease.owner)
          throw storeError("lease", `lease '${input.lease.id}' belongs to another owner.`);
        const next: CreativeCatalog = {
          ...catalog,
          head: catalog.head + 1,
          leases: catalog.leases.filter((entry) => entry.id !== lease.id),
        };
        return { result: { head: next.head }, puts: [writeCreativeCatalogRecord(next)] };
      },
      historyLifetimeGuard(projectId, input.expectedLifetime),
    ),
  );
}

/**
 * Pin blob hashes for a durable consumer — a recovery payload or a retained
 * undo slot — until released. projectDrafts wiring lands in a later slice;
 * this is the explicit hold the GC already respects.
 */
export async function holdCreativeBlobs(input: {
  readonly projectId: ProjectId;
  readonly hold: {
    readonly id: string;
    readonly kind: "recovery" | "retained-undo";
    readonly hashes: readonly string[];
  };
  readonly expectedHead?: number | undefined;
  readonly expectedLifetime?: string | null | undefined;
}): Promise<{ head: number }> {
  const projectId = input.projectId;
  requireProjectId(projectId);
  const hold = readCreativeHold(input.hold);
  const key = creativeCatalogKey(projectId);
  return serializeWrite(projectId, () =>
    updateBodyRecords(
      key,
      (raw) => {
        const catalog = readCatalog(raw, projectId);
        if (catalog === undefined)
          throw storeError("missing", "the project has no creative catalog.");
        checkExpectedHead(catalog, input.expectedHead);
        if (catalog.holds.some((entry) => entry.id === hold.id))
          throw storeError("conflict", `hold '${hold.id}' already exists.`);
        const missing = hold.hashes.filter((hash) => catalog.blobs[hash] === undefined);
        if (missing.length > 0)
          throw storeError("missing", `hold '${hold.id}' references unknown blob '${missing[0]}'.`);
        if (catalog.holds.length >= CREATIVE_LIMITS.maxHolds)
          throw storeError(
            "budget",
            `the project already holds ${CREATIVE_LIMITS.maxHolds} blob holds.`,
          );
        const next: CreativeCatalog = {
          ...catalog,
          head: catalog.head + 1,
          holds: [...catalog.holds, hold].sort((a, b) => compareCodePoints(a.id, b.id)),
        };
        return { result: { head: next.head }, puts: [writeCreativeCatalogRecord(next)] };
      },
      historyLifetimeGuard(projectId, input.expectedLifetime),
    ),
  );
}

/** Drop a durable hold; its hashes keep only their remaining references. */
export async function releaseCreativeHold(input: {
  readonly projectId: ProjectId;
  readonly holdId: string;
  readonly expectedHead?: number | undefined;
  readonly expectedLifetime?: string | null | undefined;
}): Promise<{ head: number }> {
  const projectId = input.projectId;
  requireProjectId(projectId);
  const key = creativeCatalogKey(projectId);
  return serializeWrite(projectId, () =>
    updateBodyRecords(
      key,
      (raw) => {
        const catalog = readCatalog(raw, projectId);
        if (catalog === undefined)
          throw storeError("missing", "the project has no creative catalog.");
        checkExpectedHead(catalog, input.expectedHead);
        if (!catalog.holds.some((entry) => entry.id === input.holdId))
          throw storeError("missing", `hold '${input.holdId}' was not found.`);
        const next: CreativeCatalog = {
          ...catalog,
          head: catalog.head + 1,
          holds: catalog.holds.filter((entry) => entry.id !== input.holdId),
        };
        return { result: { head: next.head }, puts: [writeCreativeCatalogRecord(next)] };
      },
      historyLifetimeGuard(projectId, input.expectedLifetime),
    ),
  );
}

function checkExpectedHead(catalog: CreativeCatalog, expectedHead: number | undefined): void {
  if (expectedHead === undefined) return;
  if (!Number.isSafeInteger(expectedHead) || expectedHead < 0 || catalog.head !== expectedHead)
    throw storeError(
      "conflict",
      `the catalog moved to head ${catalog.head}; expected ${String(expectedHead)}.`,
    );
}

/**
 * Garbage collection: drop expired leases and delete staged blob records no
 * kept record, live lease or durable hold references. Kept originals and
 * retained recovery are never evicted for quota. Runs inside one transaction
 * — a concurrent publish either observes the catalog before it (and its head
 * CAS then refuses) or after it (and sees the fresh reachability).
 */
export async function collectCreativeGarbage(input: {
  readonly projectId: ProjectId;
  readonly expectedLifetime?: string | null | undefined;
  readonly now?: (() => number) | undefined;
}): Promise<{ removed: number; head: number }> {
  const projectId = input.projectId;
  requireProjectId(projectId);
  const now = input.now?.() ?? Date.now();
  const key = creativeCatalogKey(projectId);
  return serializeWrite(projectId, () =>
    updateBodyRecords<{ removed: number; head: number }>(
      key,
      (raw) => {
        const catalog = readCatalog(raw, projectId);
        if (catalog === undefined) return { result: { removed: 0, head: 0 } };
        const reachable = reachableBlobHashes(catalog, now);
        const liveLeases = catalog.leases.filter((entry) => entry.expiresAt > now);
        const unreachable = Object.keys(catalog.blobs).filter((hash) => !reachable.has(hash));
        if (unreachable.length === 0 && liveLeases.length === catalog.leases.length)
          return { result: { removed: 0, head: catalog.head } };
        // The blob keys are only known after the manifest is read, so the
        // deletes complete in a second phase of the same transaction.
        const keys = unreachable.map((hash) => creativeBlobKey(projectId, hash));
        return {
          reads: keys,
          complete: (records) => {
            const deletes: string[] = [];
            for (const key of keys) if (records.get(key) !== undefined) deletes.push(key);
            const blobs = { ...catalog.blobs };
            for (const hash of unreachable) delete blobs[hash];
            const next: CreativeCatalog = {
              ...catalog,
              head: catalog.head + 1,
              leases: liveLeases,
              blobs,
            };
            return {
              result: { removed: deletes.length, head: next.head },
              puts: [writeCreativeCatalogRecord(next)],
              deletes,
            };
          },
        };
      },
      historyLifetimeGuard(projectId, input.expectedLifetime),
    ),
  );
}

/**
 * One blob's exact bytes, verified against its content hash. Missing,
 * malformed or tampered records refuse with a typed error; returned bytes
 * are a detached copy.
 */
export async function readCreativeBlob(
  projectId: ProjectId,
  hash: BlobHash,
): Promise<{ bytes: Uint8Array; mime: string }> {
  requireProjectId(projectId);
  const stored = await bodyTransaction<unknown>("readonly", (store) =>
    store.get(creativeBlobKey(projectId, hash)),
  );
  try {
    const bytes = verifyCreativeBlob(stored, projectId, hash);
    return { bytes, mime: (stored as { mime: string }).mime };
  } catch (error) {
    if (error instanceof CreativeCatalogError)
      throw storeError(stored === undefined ? "missing" : "integrity", error.message);
    throw error;
  }
}

/** The body's creative marker, validated: the kept catalog revision it pins. */
function readCreativeMarker(value: unknown): CreativeMarker | null {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger((value as { kept?: unknown }).kept) ||
    ((value as { kept: number }).kept ?? -1) < 1 ||
    Object.keys(value).length !== 1
  )
    throw new CreativeCatalogError("invalid", "the project body's creative marker is malformed.");
  return value as CreativeMarker;
}

/**
 * Read the catalog together with the body marker that pins it, in one
 * snapshot. A marker naming a kept revision the catalog does not hold, a
 * missing catalog, or a kept catalog whose body marker was lost all refuse:
 * creative data never reads as quietly empty.
 */
export async function loadCreativeCatalog(
  projectId: ProjectId,
): Promise<{ catalog: CreativeCatalog | null; marker: CreativeMarker | null }> {
  requireProjectId(projectId);
  // Body and catalog must come from one snapshot, and the body read cannot
  // depend on the catalog record existing — a missing catalog is exactly the
  // refusal this check reports.
  const snapshot = await readBodyRecordSet([creativeCatalogKey(projectId), projectId]);
  const catalog = readCatalog(snapshot.get(creativeCatalogKey(projectId)), projectId) ?? null;
  const body = snapshot.get(projectId) as Record<string, unknown> | undefined;
  const marker = readCreativeMarker(body?.["creative"]);
  if (catalog === null) {
    if (marker !== null)
      throw storeError("missing", `the body pins kept catalog ${marker.kept} but none exists.`);
    return { catalog: null, marker: null };
  }
  if (marker === null ? catalog.kept !== 0 : marker.kept !== catalog.kept)
    throw storeError(
      "conflict",
      marker === null
        ? `the catalog is kept at ${catalog.kept} but the body lost its creative marker.`
        : `the body pins kept catalog ${marker.kept} but the catalog is at kept ${catalog.kept}.`,
    );
  return { catalog, marker };
}
