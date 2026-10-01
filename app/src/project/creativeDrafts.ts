/**
 * Durable recovery for unfinished creative preparation work.
 *
 * A workspace's imported originals, canonical rasters and editable recipe
 * state outlive the staging lease they arrived under: this service persists
 * them as a recovery row beside the project body so closing, reloading or
 * crashing cannot lose work that was never Kept. Everything lives in the
 * shared "projects" object store under the existing `creative/<projectId>`
 * prefix — the catalog, the content-addressed blobs, a discovery index at
 * `creative/<projectId>/drafts` and one row per workspace at
 * `creative/<projectId>/draft/<workspaceId>`. There is no second database
 * and no duplicate blob store; the project's delete sweep already covers
 * the prefix.
 *
 * Publishing is atomic: the recovery row, the discovery index entry and the
 * exact durable hold that keeps every referenced blob land in one
 * read-write transaction on the shared head mechanism. A staging lease can
 * expire and GC can run — the hold keeps the bytes the recovery references,
 * and only those bytes.
 *
 * Authority to save is proven inside the transaction: either a live staging
 * lease owned by this workspace, or an existing durable recovery this
 * workspace already holds (compare-and-swapped by exact receipt). The hold's
 * hash inventory is derived from the recovery's own references, never taken
 * from the caller, and every referenced blob's bytes are verified inside
 * the same transaction. Records the recovery carries that are not kept pins
 * must be present — identically — in the live lease's staged set, the kept
 * set, or the recovery being replaced; a caller cannot attach arbitrary
 * records to pinned bytes.
 *
 * The base a recovery was captured against decides staleness: the resource
 * revision, kept editable-content digest and profile from the body, plus the
 * kept catalog revision. A moved base leaves the row readable and clearly
 * classified but refuses a fresh save or silent rebase. Discard removes only
 * the row, its index entry and its own hold — kept resources, foreign
 * workspaces, live leases, retained-undo holds and a newer receipt are all
 * untouched. Existing recoveries are never evicted to admit new work.
 */
import type { ProjectId } from "../../../src/gameIdentity.ts";
import { detectProfile } from "../../../src/runtime/profile.ts";
import {
  CREATIVE_LIMITS,
  CreativeCatalogError,
  checkRetainedBudgets,
  compareCodePoints,
  creativeBlobKey,
  creativeCatalogKey,
  mergeBlobRegistration,
  readCreativeCatalogRecord,
  readCreativeHold,
  verifyCreativeBlob,
  versionRefKey,
  writeCreativeCatalogRecord,
  type BlobHash,
  type CreativeCatalog,
  type CreativeHold,
  type CreativeLease,
  type RegisteredBlob,
  type VersionRef,
} from "../../../src/creative/catalog.ts";
import {
  creativeRecoveryBlobHashes,
  readCreativeRecovery,
  writeCreativeRecovery,
  type CreativeRecoveryBase,
  type CreativeRecoveryData,
  type PortableCreativeRecovery,
} from "../../../src/creative/recovery.ts";
import type { CachedGameData, CreativeMarker } from "./gameTypes.ts";
import type { DraftReceipt } from "./projectDrafts.ts";
import {
  authoringFingerprint,
  generationOf,
  historyLifetimeGuard,
  lifetimeHolds,
  liveLifetime,
  projectBodyGuard,
  readBodyRecordSet,
  readBodyRecords,
  serializeWrite,
  updateBodyRecords,
  type HistoryLifetime,
} from "./gameStorage.ts";
import {
  MAX_CREATIVE_DRAFT_WORKSPACES,
  CreativeDraftError,
  creativeDraftIndexKey,
  creativeDraftKey,
  creativeDraftRecord,
  creativeDraftStaleFields,
  creativeRecoveryHoldId,
  readCreativeDraftIndex,
  readCreativeDraftRow,
  readDraftExpected,
  readDraftReceipt,
  requireCreativeDraftProjectId,
  requireCreativeWorkspaceId,
  sameDraftReceipt,
  writeCreativeDraftIndexRecord,
  writeCreativeDraftRowRecord,
  type CreativeDraftReason,
  type StoredCreativeDraft,
} from "./creativeWorkArchive.ts";

export { CreativeDraftError };
export type { CreativeDraftStaleField } from "./creativeWorkArchive.ts";
import type { CreativeDraftStaleField } from "./creativeWorkArchive.ts";

function fail(reason: CreativeDraftReason, message: string): never {
  throw new CreativeDraftError(reason, message);
}

/** Codec refusals become typed operation errors without losing the detail. */
function storeError(reason: CreativeDraftReason, error: unknown): never {
  if (error instanceof CreativeDraftError) throw error;
  if (error instanceof CreativeCatalogError)
    fail(error.code === "unsupported" ? "unsupported" : reason, error.message);
  throw error;
}

/** Proven authorization for a save, checked inside the write transaction. */
export type CreativeDraftAuthority =
  | {
      readonly kind: "lease";
      readonly lease: {
        readonly id: string;
        readonly owner: string;
        readonly workspace: string;
      };
    }
  | { readonly kind: "recovery" };

export interface CreativeDraftSummary {
  readonly workspaceId: string;
  readonly receipt: DraftReceipt;
  /** Stale work may be compared or discarded, never silently rebased. */
  readonly status: "current" | "stale";
  /** The base pins that no longer match the current project. */
  readonly staleFields: readonly CreativeDraftStaleField[];
  /** Index → row → hold → registry chain intact at read time. */
  readonly integrity: boolean;
  readonly summary: {
    readonly sources: number;
    readonly derivatives: number;
    readonly recipes: number;
    readonly drafts: number;
    /** Sum of the referenced blob byte lengths. */
    readonly bytes: number;
  };
}

/** A recoverable workspace: the detached envelope plus its classification. */
export interface RecoverableCreativeDraft extends CreativeDraftSummary {
  readonly expected: { readonly generation: number; readonly lifetime: string };
  readonly recovery: PortableCreativeRecovery;
}

function readAuthority(input: CreativeDraftAuthority): CreativeDraftAuthority {
  if (input === null || typeof input !== "object")
    throw new CreativeDraftError("authority", "A save authority is required.");
  if (input.kind === "recovery") return { kind: "recovery" };
  if (input.kind !== "lease")
    throw new CreativeDraftError(
      "authority",
      `Unknown save authority '${String((input as { kind?: unknown }).kind)}'.`,
    );
  const raw = creativeDraftRecord((input as { lease?: unknown }).lease, [
    "id",
    "owner",
    "workspace",
  ]);
  const bounded = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= CREATIVE_LIMITS.maxIdLength;
  if (!bounded(raw["id"]) || !bounded(raw["owner"]) || !bounded(raw["workspace"]))
    throw new CreativeDraftError("authority", "Invalid staging lease authority.");
  return {
    kind: "lease",
    lease: { id: raw["id"], owner: raw["owner"], workspace: raw["workspace"] },
  };
}

export function readCatalog(raw: unknown, projectId: ProjectId): CreativeCatalog | undefined {
  if (raw === undefined) return undefined;
  try {
    return readCreativeCatalogRecord(raw, projectId);
  } catch (error) {
    storeError("integrity", error);
  }
}

export function markerKept(marker: CreativeMarker | undefined): number | null {
  return marker === undefined ? null : marker.kept;
}

/**
 * The body and catalog are read in one snapshot; a kept catalog must match
 * the body's creative marker, and a staging-only catalog (kept 0) must have
 * no marker. Recovery never fabricates the marker the commit path owns.
 */
export function checkMarker(data: CachedGameData, catalog: CreativeCatalog): void {
  const kept = markerKept(data.creative);
  if (kept === null ? catalog.kept !== 0 : kept !== catalog.kept)
    throw new CreativeDraftError(
      "conflict",
      kept === null
        ? `the catalog is kept at ${catalog.kept} but the body lost its creative marker.`
        : `the body pins kept catalog ${kept} but the catalog is at kept ${catalog.kept}.`,
    );
}

/** The base a recovery may be saved against: identical to the current snapshot. */
export function checkFreshBase(
  data: CachedGameData,
  expected: { generation: number; lifetime: string },
  base: CreativeRecoveryBase,
): void {
  if (
    generationOf(data) !== expected.generation ||
    data.library?.revision !== base.revision ||
    authoringFingerprint(data.authoringState, data.workspace) !== base.authoring ||
    detectProfile(new Map(Object.entries(data.files)), data.library?.profile).id !== base.profileId
  )
    throw new CreativeDraftError(
      "stale",
      "The saved project moved; capture the recovery against the current base.",
    );
}

export function findKeptRecord(catalog: CreativeCatalog, ref: VersionRef): unknown {
  const key = versionRefKey(ref);
  return [...catalog.sources, ...catalog.derivatives, ...catalog.board, ...catalog.recipes].find(
    (entry) => versionRefKey(entry.identity) === key,
  );
}

export function findCarriedRecord(recovery: PortableCreativeRecovery, ref: VersionRef): unknown {
  const key = versionRefKey(ref);
  return [
    ...recovery.sources,
    ...recovery.derivatives,
    ...recovery.board,
    ...recovery.recipes,
  ].find((entry) => versionRefKey(entry.identity) === key);
}

/** The canonical serialization every stored and staged record shares. */
function canonical(record: unknown): string {
  return JSON.stringify(record);
}

/**
 * Records a recovery may carry without pinning: the kept set, the live
 * lease's staged set and the durable rows the caller proved. Keyed by
 * identity so an offered record must be identical, not merely same-named.
 */
export function recordPool(
  catalog: CreativeCatalog,
  lease: CreativeLease | undefined,
  previous: Pick<StoredCreativeDraft, "recovery"> | undefined,
): Map<string, string> {
  const pool = new Map<string, string>();
  const add = (records: readonly { readonly identity: VersionRef }[]): void => {
    for (const entry of records) pool.set(versionRefKey(entry.identity), canonical(entry));
  };
  add(catalog.sources);
  add(catalog.derivatives);
  add(catalog.board);
  add(catalog.recipes);
  if (lease !== undefined) {
    add(lease.staged.sources);
    add(lease.staged.derivatives);
    add(lease.staged.recipes);
  }
  if (previous !== undefined) {
    add(previous.recovery.sources);
    add(previous.recovery.derivatives);
    add(previous.recovery.board);
    add(previous.recovery.recipes);
  }
  return pool;
}

export function upsertHold(holds: readonly CreativeHold[], hold: CreativeHold): CreativeHold[] {
  const index = holds.findIndex((entry) => entry.id === hold.id);
  const next =
    index === -1 ? [...holds, hold] : holds.map((entry, i) => (i === index ? hold : entry));
  return next.sort((a, b) => compareCodePoints(a.id, b.id));
}

function catalogIntegrity(
  stored: StoredCreativeDraft,
  catalog: CreativeCatalog | undefined,
  data: CachedGameData | undefined,
): boolean {
  if (catalog === undefined || data === undefined) return false;
  if (
    markerKept(data.creative) === null
      ? catalog.kept !== 0
      : markerKept(data.creative) !== catalog.kept
  )
    return false;
  const hold = catalog.holds.find(
    (entry) => entry.id === creativeRecoveryHoldId(stored.receipt.incarnation),
  );
  if (hold === undefined || hold.kind !== "recovery") return false;
  // The hold must prove exactly the inventory the recovery derives: a hash
  // added or dropped is damage, and a hold of another kind is not ours.
  const wanted = creativeRecoveryBlobHashes(stored.recovery);
  if (hold.hashes.length !== wanted.length) return false;
  const claimed = new Set(wanted);
  if (!hold.hashes.every((hash) => claimed.has(hash))) return false;
  return wanted.every((hash) => catalog.blobs[hash] !== undefined);
}

export function staleFieldsOf(
  stored: Pick<StoredCreativeDraft, "expected" | "recovery">,
  catalog: CreativeCatalog | undefined,
  data: CachedGameData | undefined,
  lifetimeRaw: unknown,
): CreativeDraftStaleField[] {
  return creativeDraftStaleFields(stored, {
    lifetimeMatches: lifetimeHolds(
      stored.expected.lifetime,
      liveLifetime(lifetimeRaw as HistoryLifetime | undefined),
    ),
    body:
      data === undefined
        ? undefined
        : {
            generation: generationOf(data),
            revision: data.library?.revision,
            authoring: authoringFingerprint(data.authoringState, data.workspace),
            profileId: detectProfile(new Map(Object.entries(data.files)), data.library?.profile).id,
          },
    kept: catalog?.kept,
  });
}

function summarize(
  stored: StoredCreativeDraft,
  catalog: CreativeCatalog | undefined,
  data: CachedGameData | undefined,
  lifetimeRaw: unknown,
  listed: boolean,
): CreativeDraftSummary {
  const staleFields = staleFieldsOf(stored, catalog, data, lifetimeRaw);
  let bytes = 0;
  for (const descriptor of Object.values(stored.recovery.blobs)) bytes += descriptor.byteLength;
  return {
    workspaceId: stored.workspaceId,
    receipt: stored.receipt,
    status: staleFields.length === 0 ? "current" : "stale",
    staleFields,
    integrity: listed && catalogIntegrity(stored, catalog, data),
    summary: {
      sources: stored.recovery.sources.length,
      derivatives: stored.recovery.derivatives.length,
      recipes: stored.recovery.recipes.length,
      drafts: stored.recovery.drafts.length,
      bytes,
    },
  };
}

/**
 * Persist one workspace's creative recovery. The envelope is canonicalized
 * and detached before the first await; the row, discovery index entry and
 * the durable hold covering exactly the referenced blobs then publish in a
 * single transaction. A refused or failed write leaves the previous
 * recovery, its hold and the catalog untouched.
 */
export async function saveCreativeDraft(input: {
  readonly projectId: ProjectId;
  readonly workspaceId: string;
  /** CAS: the receipt this save replaces, or null for a first save. */
  readonly expectedReceipt: DraftReceipt | null;
  /** The body generation and history lifetime this save was prepared against. */
  readonly expected: { readonly generation: number; readonly lifetime: string };
  /** A live staging lease this workspace owns, or the owned recovery it replaces. */
  readonly authority: CreativeDraftAuthority;
  readonly recovery: CreativeRecoveryData | PortableCreativeRecovery;
  readonly now?: (() => number) | undefined;
}): Promise<{ readonly receipt: DraftReceipt; readonly head: number }> {
  const projectId = requireCreativeDraftProjectId(input.projectId);
  const workspaceId = requireCreativeWorkspaceId(input.workspaceId);
  const expectedReceipt =
    input.expectedReceipt === null ? null : readDraftReceipt(input.expectedReceipt);
  const expected = readDraftExpected(input.expected);
  const authority = readAuthority(input.authority);
  // Canonicalize and detach the envelope before the first await: caller-side
  // mutation afterwards cannot reach what the transaction stores.
  const recoveryRecord = writeCreativeRecovery(input.recovery);
  const recovery = readCreativeRecovery(recoveryRecord);
  const blobHashes = creativeRecoveryBlobHashes(recovery);
  const now = input.now?.() ?? Date.now();
  const indexKey = creativeDraftIndexKey(projectId);
  const rowKey = creativeDraftKey(projectId, workspaceId);
  const catalogKey = creativeCatalogKey(projectId);
  let body: CachedGameData | undefined;
  let catalogRaw: unknown;
  let previous: StoredCreativeDraft | undefined;
  let lifetimeRaw: unknown;
  return serializeWrite(projectId, () =>
    updateBodyRecords(
      indexKey,
      (raw) => {
        const workspaces = readCreativeDraftIndex(raw, indexKey);
        const listed = workspaces.includes(workspaceId);
        if ((previous !== undefined) !== listed)
          fail("conflict", "The creative recovery index is inconsistent and was left unchanged.");
        if (!sameDraftReceipt(previous?.receipt ?? null, expectedReceipt))
          fail("conflict", "This creative recovery changed; read the latest before saving again.");
        if (previous === undefined && workspaces.length >= MAX_CREATIVE_DRAFT_WORKSPACES)
          fail(
            "budget",
            `Too many recoverable creative workspaces. Restore or discard an older recovery first.`,
          );
        const data = body;
        if (data === undefined)
          fail("missing", "The project body could not be read for this save.");
        const catalog = readCatalog(catalogRaw, projectId);
        if (catalog === undefined)
          fail("missing", "The project has no creative catalog to recover from.");
        checkMarker(data, catalog);
        if (recovery.base.kept !== catalog.kept)
          fail(
            "stale",
            `The kept creative catalog is at ${catalog.kept}; this recovery was captured against ${recovery.base.kept}.`,
          );
        // A stale existing row cannot be silently rebased: the base it was
        // captured against and the generation/lifetime it pinned are
        // validated against this same snapshot. Stale work stays readable
        // for comparison or discard; an explicit rebase is a separate
        // reviewed operation.
        if (previous !== undefined) {
          const moved = staleFieldsOf(previous, catalog, data, lifetimeRaw);
          if (moved.length > 0)
            fail(
              "stale",
              `The existing creative recovery was captured against a base that moved (${moved.join(", ")}); it stays readable for comparison or discard.`,
            );
        }
        // Authority: a live staging lease owned by this workspace, or the
        // owned recovery the receipt CAS already proved this workspace holds.
        let lease: CreativeLease | undefined;
        if (authority.kind === "lease") {
          if (authority.lease.workspace !== workspaceId)
            fail(
              "authority",
              `lease '${authority.lease.id}' belongs to workspace '${authority.lease.workspace}'; this recovery is owned by '${workspaceId}'.`,
            );
          lease = catalog.leases.find((entry) => entry.id === authority.lease.id);
          if (
            lease === undefined ||
            lease.owner !== authority.lease.owner ||
            lease.workspace !== authority.lease.workspace
          )
            fail("authority", `lease '${authority.lease.id}' is not owned by this workspace.`);
          if (lease.expiresAt <= now)
            fail("authority", `lease '${authority.lease.id}' already expired.`);
        } else if (previous === undefined)
          fail("authority", "No owned creative recovery exists to save from.");
        // Every pin names a record the kept set still holds, carried unchanged.
        const pinned = new Set(recovery.base.pins.map(versionRefKey));
        for (const pin of recovery.base.pins) {
          const kept = findKeptRecord(catalog, pin);
          if (kept === undefined)
            fail(
              "integrity",
              `base.pins names '${versionRefKey(pin)}' which the kept set does not hold.`,
            );
          if (canonical(kept) !== canonical(findCarriedRecord(recovery, pin)))
            fail(
              "integrity",
              `base.pins record '${versionRefKey(pin)}' does not match the kept record.`,
            );
        }
        // Unpinned records must be identical to staged, kept or previously
        // recovered ones; board placements and drafts are workspace state,
        // not byte claims, so only byte-claiming lists join the pool check.
        const pool = recordPool(catalog, lease, previous);
        const claimLists: readonly [string, readonly { readonly identity: VersionRef }[]][] = [
          ["sources", recovery.sources],
          ["derivatives", recovery.derivatives],
          ["recipes", recovery.recipes],
        ];
        for (const [label, records] of claimLists)
          for (const [i, entry] of records.entries()) {
            const key = versionRefKey(entry.identity);
            if (pinned.has(key)) continue;
            if (pool.get(key) !== canonical(entry))
              fail(
                "integrity",
                `creative recovery.${label}[${i}] is not staged, kept or previously recovered work.`,
              );
          }
        // The hold inventory is derived from the recovery's references; every
        // claimed blob must be registered with a matching descriptor, and its
        // bytes are verified in the deferred read below.
        const blobs: Record<BlobHash, RegisteredBlob> = { ...catalog.blobs };
        for (const hash of blobHashes) {
          const ref = recovery.blobs[hash]!;
          const registered = catalog.blobs[hash];
          if (registered === undefined)
            fail("integrity", `creative recovery references unregistered blob '${hash}'.`);
          if (registered.byteLength !== ref.byteLength || registered.mime !== ref.mime)
            fail("integrity", `blob '${hash}' does not match its registered descriptor.`);
          try {
            for (const bucket of ref.buckets) mergeBlobRegistration(blobs, ref, bucket);
          } catch (error) {
            storeError("integrity", error);
          }
        }
        const incarnation = previous?.receipt.incarnation ?? crypto.randomUUID();
        const sequence = (previous?.receipt.sequence ?? 0) + 1;
        if (!Number.isSafeInteger(sequence))
          fail("conflict", "Creative recovery sequence limit reached.");
        const receipt = { incarnation, sequence };
        const hold = readCreativeHold({
          id: creativeRecoveryHoldId(incarnation),
          kind: "recovery",
          hashes: blobHashes,
        });
        // A hold id is bound to this row's incarnation: an incumbent with a
        // different kind is foreign work and an incumbent without a previous
        // row is damage — refuse instead of silently repairing either.
        const incumbent = catalog.holds.find((entry) => entry.id === hold.id);
        if (incumbent !== undefined && (incumbent.kind !== "recovery" || previous === undefined))
          fail(
            "integrity",
            `blob hold '${hold.id}' is owned by different work and cannot be replaced here.`,
          );
        if (incumbent === undefined && catalog.holds.length >= CREATIVE_LIMITS.maxHolds)
          fail("budget", `the project already holds ${CREATIVE_LIMITS.maxHolds} blob holds.`);
        const next: CreativeCatalog = {
          ...catalog,
          head: catalog.head + 1,
          holds: upsertHold(catalog.holds, hold),
          blobs,
        };
        try {
          checkRetainedBudgets(next, now, "creative recovery");
        } catch (error) {
          storeError("budget", error);
        }
        const puts: unknown[] = [
          writeCreativeDraftIndexRecord(
            indexKey,
            listed ? workspaces : [...workspaces, workspaceId].sort(compareCodePoints),
          ),
          writeCreativeDraftRowRecord(rowKey, workspaceId, receipt, expected, recovery),
          writeCreativeCatalogRecord(next),
        ];
        return {
          reads: blobHashes.map((hash) => creativeBlobKey(projectId, hash)),
          complete: (records) => {
            for (const hash of blobHashes) {
              const stored = records.get(creativeBlobKey(projectId, hash));
              try {
                verifyCreativeBlob(stored, projectId, recovery.blobs[hash]!);
              } catch (error) {
                if (error instanceof CreativeCatalogError)
                  fail(stored === undefined ? "missing" : "integrity", error.message);
                throw error;
              }
            }
            return { result: { receipt, head: next.head }, puts };
          },
        };
      },
      [
        projectBodyGuard(projectId, (data) => {
          body = data;
          checkFreshBase(data, expected, recovery.base);
        }),
        historyLifetimeGuard(projectId, expected.lifetime),
        {
          key: `lifetime/${projectId}`,
          check(raw) {
            lifetimeRaw = raw;
          },
        },
        {
          key: catalogKey,
          check(raw) {
            catalogRaw = raw;
          },
        },
        {
          key: rowKey,
          check(raw) {
            previous =
              raw === undefined ? undefined : readCreativeDraftRow(raw, rowKey, workspaceId);
          },
        },
      ],
    ),
  );
}

/**
 * Every workspace recovery for a project with its classification, from one
 * snapshot: the index, the rows, the body, the lifetime receipt and the
 * catalog all agree at read time.
 */
export async function listCreativeDrafts(
  projectId: ProjectId,
): Promise<readonly CreativeDraftSummary[]> {
  requireCreativeDraftProjectId(projectId);
  const indexKey = creativeDraftIndexKey(projectId);
  const catalogKey = creativeCatalogKey(projectId);
  const snapshot = await readBodyRecords(indexKey, (raw) => [
    projectId,
    `lifetime/${projectId}`,
    catalogKey,
    ...readCreativeDraftIndex(raw, indexKey).map((id) => creativeDraftKey(projectId, id)),
  ]);
  const workspaces = readCreativeDraftIndex(snapshot.head, indexKey);
  if (workspaces.length === 0) return [];
  const catalog = readCatalog(snapshot.records.get(catalogKey), projectId);
  let data: CachedGameData | undefined;
  const body = snapshot.records.get(projectId);
  if (body !== undefined)
    try {
      projectBodyGuard(projectId, (parsed) => {
        data = parsed;
      }).check(body);
    } catch {
      data = undefined;
    }
  return workspaces.map((workspaceId) => {
    const key = creativeDraftKey(projectId, workspaceId);
    const raw = snapshot.records.get(key);
    if (raw === undefined)
      fail("integrity", "The creative recovery index lists a row that does not exist.");
    return summarize(
      readCreativeDraftRow(raw, key, workspaceId),
      catalog,
      data,
      snapshot.records.get(`lifetime/${projectId}`),
      true,
    );
  });
}

/**
 * One workspace's detached recovery data for a future restore UI: the exact
 * envelope, its receipt, and how it classifies against the current project.
 * Blob bytes come through `readCreativeBlob` — immutable and hash-verified.
 * Returns null when no recovery exists for the workspace.
 */
export async function readCreativeDraft(
  projectId: ProjectId,
  workspaceId: string,
): Promise<RecoverableCreativeDraft | null> {
  requireCreativeDraftProjectId(projectId);
  requireCreativeWorkspaceId(workspaceId);
  const indexKey = creativeDraftIndexKey(projectId);
  const catalogKey = creativeCatalogKey(projectId);
  const rowKey = creativeDraftKey(projectId, workspaceId);
  const snapshot = await readBodyRecordSet([
    indexKey,
    rowKey,
    catalogKey,
    projectId,
    `lifetime/${projectId}`,
  ]);
  const listed = readCreativeDraftIndex(snapshot.get(indexKey), indexKey).includes(workspaceId);
  const raw = snapshot.get(rowKey);
  if (raw === undefined) {
    if (listed) fail("integrity", "The creative recovery index lists a row that does not exist.");
    return null;
  }
  const stored = readCreativeDraftRow(raw, rowKey, workspaceId);
  const catalog = readCatalog(snapshot.get(catalogKey), projectId);
  let data: CachedGameData | undefined;
  const body = snapshot.get(projectId);
  if (body !== undefined)
    try {
      projectBodyGuard(projectId, (parsed) => {
        data = parsed;
      }).check(body);
    } catch {
      data = undefined;
    }
  // Referenced blob records must still exist with matching descriptors;
  // their bytes stay lazily verified through readCreativeBlob.
  let blobsPresent = true;
  const hashes = creativeRecoveryBlobHashes(stored.recovery);
  if (hashes.length > 0) {
    const records = await readBodyRecordSet(hashes.map((hash) => creativeBlobKey(projectId, hash)));
    for (const hash of hashes) {
      const ref = stored.recovery.blobs[hash]!;
      const record = records.get(creativeBlobKey(projectId, hash)) as
        { byteLength?: unknown; mime?: unknown } | undefined;
      if (record === undefined || record.byteLength !== ref.byteLength || record.mime !== ref.mime)
        blobsPresent = false;
    }
  }
  const summary = summarize(stored, catalog, data, snapshot.get(`lifetime/${projectId}`), listed);
  return {
    ...summary,
    integrity: summary.integrity && blobsPresent,
    expected: stored.expected,
    recovery: stored.recovery,
  };
}

/**
 * Remove one workspace's recovery by exact receipt: its index entry, its row
 * and its own durable hold, in one transaction. Kept records, foreign
 * workspaces, live leases, retained-undo holds and a newer receipt are all
 * untouched. A stale recovery may still be discarded — the lifetime just has
 * to be live.
 */
export async function discardCreativeDraft(
  projectId: ProjectId,
  workspaceId: string,
  expectedReceipt: DraftReceipt,
  expectedLifetime?: string,
): Promise<void> {
  requireCreativeDraftProjectId(projectId);
  requireCreativeWorkspaceId(workspaceId);
  const receipt = readDraftReceipt(expectedReceipt);
  const indexKey = creativeDraftIndexKey(projectId);
  const catalogKey = creativeCatalogKey(projectId);
  const rowKey = creativeDraftKey(projectId, workspaceId);
  let catalogRaw: unknown;
  let previous: StoredCreativeDraft | undefined;
  await serializeWrite(projectId, () =>
    updateBodyRecords(
      indexKey,
      (raw) => {
        const workspaces = readCreativeDraftIndex(raw, indexKey);
        const listed = workspaces.includes(workspaceId);
        if ((previous !== undefined) !== listed)
          fail("conflict", "The creative recovery index is inconsistent and was left unchanged.");
        if (!sameDraftReceipt(previous?.receipt ?? null, receipt))
          fail(
            "conflict",
            "This creative recovery changed; review the latest before discarding it.",
          );
        const catalog = readCatalog(catalogRaw, projectId);
        const remaining = workspaces.filter((id) => id !== workspaceId);
        const puts: unknown[] = [];
        if (catalog !== undefined && previous !== undefined) {
          const holdId = creativeRecoveryHoldId(previous.receipt.incarnation);
          // Release only this recovery's own hold: a same-id hold of another
          // kind is foreign work and stays put.
          const holds = catalog.holds.filter(
            (entry) => !(entry.id === holdId && entry.kind === "recovery"),
          );
          if (holds.length !== catalog.holds.length)
            puts.push(
              writeCreativeCatalogRecord({
                ...catalog,
                head: catalog.head + 1,
                holds,
              }),
            );
        }
        if (remaining.length > 0) puts.unshift(writeCreativeDraftIndexRecord(indexKey, remaining));
        return {
          result: undefined,
          deletes: remaining.length > 0 ? [rowKey] : [rowKey, indexKey],
          puts,
        };
      },
      [
        historyLifetimeGuard(projectId, expectedLifetime),
        {
          key: catalogKey,
          check(raw) {
            catalogRaw = raw;
          },
        },
        {
          key: rowKey,
          check(raw) {
            previous =
              raw === undefined ? undefined : readCreativeDraftRow(raw, rowKey, workspaceId);
          },
        },
      ],
    ),
  );
}
