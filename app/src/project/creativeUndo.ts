/**
 * Durable retained snapshots of creative preparation state.
 *
 * A snapshot is one immutable `PortableCreativeRecovery` retained under an
 * append-only history: when a workspace's preparation is worth keeping for
 * review — before a Keep, a coordinated change or a discard — this service
 * persists it beside the recovery rows under `creative/<projectId>`. One
 * ordered index at `creative/<projectId>/undos` names each snapshot's row at
 * `creative/<projectId>/undo/<snapshotId>`; the row's durable hold is bound
 * to its receipt incarnation as `undo-<incarnation>` and pins exactly the
 * blobs the recovery references. Snapshots are never updated in place and
 * never evicted to admit newer ones: a later capture is a new row, and only
 * an explicit discard removes one.
 *
 * Appending a snapshot follows the same proof discipline as the recovery
 * service, checked inside the one read-write transaction that writes row,
 * index member, hold and catalog: a live staging lease this workspace owns,
 * the exact receipt of a durable recovery or snapshot this workspace
 * already holds, or a snapshot composed of exactly the currently kept
 * records. An arbitrary hash or envelope is not authority. Every referenced
 * blob's registered descriptor and stored bytes verify before the commit —
 * a refused or failed write leaves the previous index, rows and holds
 * untouched. A retry of the same append — same snapshot id and same
 * canonical content — returns the existing receipt and writes nothing.
 *
 * Staleness is classified at read time from the body/lifetime/catalog the
 * snapshot was read beside, never from a caller claim: a snapshot captured
 * before a later Keep stays stale and preserved for review, and nothing
 * here rebases it. Snapshots do not restore native runtime state and do not
 * serialize operation history — they are the exact retained preparation a
 * later review or restore can ask for.
 */
import { projectId as validProjectId, type ProjectId } from "../../../src/gameIdentity.ts";
import {
  CREATIVE_LIMITS,
  CreativeCatalogError,
  checkRetainedBudgets,
  creativeBlobKey,
  creativeCatalogKey,
  mergeBlobRegistration,
  readCreativeHold,
  verifyCreativeBlob,
  versionRefKey,
  writeCreativeCatalogRecord,
  type BlobHash,
  type CreativeCatalog,
  type CreativeLease,
  type RegisteredBlob,
  type VersionRef,
} from "../../../src/creative/catalog.ts";
import {
  creativeRecoveryBlobHashes,
  readCreativeRecovery,
  writeCreativeRecovery,
  type CreativeRecoveryData,
  type PortableCreativeRecovery,
} from "../../../src/creative/recovery.ts";
import type { CachedGameData } from "./gameTypes.ts";
import type { DraftReceipt } from "./projectDrafts.ts";
import {
  historyLifetimeGuard,
  projectBodyGuard,
  readBodyRecordSet,
  readBodyRecords,
  serializeWrite,
  updateBodyRecords,
} from "./gameStorage.ts";
import {
  checkFreshBase,
  checkMarker,
  findCarriedRecord,
  findKeptRecord,
  markerKept,
  readCatalog,
  recordPool,
  staleFieldsOf,
  upsertHold,
} from "./creativeDrafts.ts";
import {
  MAX_CREATIVE_DRAFT_WORKSPACES,
  MAX_CREATIVE_UNDO_SNAPSHOTS,
  CreativeDraftError,
  creativeDraftKey,
  creativeDraftRecord,
  creativeUndoHoldId,
  creativeUndoIndexKey,
  creativeUndoKey,
  readCreativeDraftRow,
  readCreativeUndoIndex,
  readCreativeUndoRow,
  readDraftExpected,
  readDraftReceipt,
  requireCreativeDraftProjectId,
  requireCreativeWorkspaceId,
  sameDraftReceipt,
  writeCreativeUndoIndexRecord,
  writeCreativeUndoRowRecord,
  type CreativeDraftReason,
  type CreativeDraftStaleField,
  type StoredCreativeDraft,
  type StoredCreativeUndo,
} from "./creativeWorkArchive.ts";

export { CreativeDraftError };

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

/**
 * Proven authorization for an append, checked inside the transaction:
 * - `lease`: a live staging lease this workspace owns (id + owner + workspace
 *   must match the stored lease exactly and it must not be expired);
 * - `draft`: the exact receipt of the durable recovery this workspace holds;
 * - `snapshot`: the exact receipt of a retained snapshot this workspace holds;
 * - `kept`: the snapshot carries only records identical to the kept set.
 */
export type CreativeUndoAuthority =
  | {
      readonly kind: "lease";
      readonly lease: {
        readonly id: string;
        readonly owner: string;
        readonly workspace: string;
      };
    }
  | { readonly kind: "draft"; readonly receipt: DraftReceipt }
  | {
      readonly kind: "snapshot";
      readonly snapshotId: string;
      readonly receipt: DraftReceipt;
    }
  | { readonly kind: "kept" };

function readAuthority(input: CreativeUndoAuthority): CreativeUndoAuthority {
  if (input === null || typeof input !== "object")
    throw new CreativeDraftError("authority", "An append authority is required.");
  const bounded = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= CREATIVE_LIMITS.maxIdLength;
  switch (input.kind) {
    case "kept":
      return { kind: "kept" };
    case "draft":
      return { kind: "draft", receipt: readDraftReceipt(input.receipt) };
    case "snapshot": {
      const snapshotId = (input as { snapshotId?: unknown }).snapshotId;
      if (typeof snapshotId !== "string" || validProjectId(snapshotId) === null)
        throw new CreativeDraftError("authority", "Invalid snapshot authority id.");
      return { kind: "snapshot", snapshotId, receipt: readDraftReceipt(input.receipt) };
    }
    case "lease": {
      const raw = creativeDraftRecord((input as { lease?: unknown }).lease, [
        "id",
        "owner",
        "workspace",
      ]);
      if (!bounded(raw["id"]) || !bounded(raw["owner"]) || !bounded(raw["workspace"]))
        throw new CreativeDraftError("authority", "Invalid staging lease authority.");
      return {
        kind: "lease",
        lease: { id: raw["id"], owner: raw["owner"], workspace: raw["workspace"] },
      };
    }
    default:
      throw new CreativeDraftError(
        "authority",
        `Unknown append authority '${String((input as { kind?: unknown }).kind)}'.`,
      );
  }
}

/** One retained snapshot in the index's append order, with classification. */
export interface CreativeUndoSummary {
  readonly workspaceId: string;
  readonly snapshotId: string;
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

/** A retained snapshot's detached recovery data plus its classification. */
export interface RetainedCreativeUndo extends CreativeUndoSummary {
  readonly expected: { readonly generation: number; readonly lifetime: string };
  readonly recovery: PortableCreativeRecovery;
}

function undoIntegrity(
  stored: StoredCreativeUndo,
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
    (entry) => entry.id === creativeUndoHoldId(stored.receipt.incarnation),
  );
  if (hold === undefined || hold.kind !== "retained-undo") return false;
  const wanted = creativeRecoveryBlobHashes(stored.recovery);
  if (hold.hashes.length !== wanted.length) return false;
  const claimed = new Set(wanted);
  if (!hold.hashes.every((hash) => claimed.has(hash))) return false;
  return wanted.every((hash) => catalog.blobs[hash] !== undefined);
}

function summarize(
  stored: StoredCreativeUndo,
  catalog: CreativeCatalog | undefined,
  data: CachedGameData | undefined,
  lifetimeRaw: unknown,
  listed: boolean,
): CreativeUndoSummary {
  const staleFields = staleFieldsOf(stored, catalog, data, lifetimeRaw);
  let bytes = 0;
  for (const descriptor of Object.values(stored.recovery.blobs)) bytes += descriptor.byteLength;
  return {
    workspaceId: stored.workspaceId,
    snapshotId: stored.snapshotId,
    receipt: stored.receipt,
    status: staleFields.length === 0 ? "current" : "stale",
    staleFields,
    integrity: listed && undoIntegrity(stored, catalog, data),
    summary: {
      sources: stored.recovery.sources.length,
      derivatives: stored.recovery.derivatives.length,
      recipes: stored.recovery.recipes.length,
      drafts: stored.recovery.drafts.length,
      bytes,
    },
  };
}

/** The canonical serialization a stored row's recovery is compared by. */
function canonicalRecovery(recovery: PortableCreativeRecovery): string {
  return JSON.stringify(writeCreativeRecovery(recovery));
}

/**
 * Retain one immutable snapshot of a workspace's creative preparation. The
 * envelope is canonicalized and detached before the first await; the row,
 * index member, retained-undo hold and catalog update then publish in a
 * single transaction whose guards verify the body base, the lifetime, the
 * catalog and the named authority. A retry of the same snapshot id with the
 * same canonical content returns the stored receipt without writing; a
 * different claim under an existing id, or an index without its row,
 * refuses by name and preserves the stored data.
 */
export async function saveCreativeUndo(input: {
  readonly projectId: ProjectId;
  readonly workspaceId: string;
  /** The caller-minted idempotency identity of this logical append. */
  readonly snapshotId: string;
  /** The body generation and history lifetime this append was prepared against. */
  readonly expected: { readonly generation: number; readonly lifetime: string };
  /** A live lease, an owned durable row's receipt, or the kept set. */
  readonly authority: CreativeUndoAuthority;
  readonly recovery: CreativeRecoveryData | PortableCreativeRecovery;
  readonly now?: (() => number) | undefined;
}): Promise<{ readonly receipt: DraftReceipt; readonly head: number }> {
  const projectId = requireCreativeDraftProjectId(input.projectId);
  const workspaceId = requireCreativeWorkspaceId(input.workspaceId);
  if (typeof input.snapshotId !== "string" || validProjectId(input.snapshotId) === null)
    throw new CreativeDraftError("missing", "The snapshot id is invalid.");
  const snapshotId = input.snapshotId;
  const expected = readDraftExpected(input.expected);
  const authority = readAuthority(input.authority);
  // Canonicalize and detach the envelope before the first await: caller-side
  // mutation afterwards cannot reach what the transaction stores.
  const recoveryRecord = writeCreativeRecovery(input.recovery);
  const recovery = readCreativeRecovery(recoveryRecord);
  const offered = canonicalRecovery(recovery);
  const blobHashes = creativeRecoveryBlobHashes(recovery);
  const now = input.now?.() ?? Date.now();
  const indexKey = creativeUndoIndexKey(projectId);
  const rowKey = creativeUndoKey(projectId, snapshotId);
  const catalogKey = creativeCatalogKey(projectId);
  const draftKey = creativeDraftKey(projectId, workspaceId);
  const authorityRowKey =
    authority.kind === "snapshot" ? creativeUndoKey(projectId, authority.snapshotId) : undefined;
  let body: CachedGameData | undefined;
  let catalogRaw: unknown;
  let rowRaw: unknown;
  let draftRaw: unknown;
  let authorityRowRaw: unknown;
  return serializeWrite(projectId, () =>
    updateBodyRecords(
      indexKey,
      (raw) => {
        const entries = readCreativeUndoIndex(raw, indexKey);
        const member = entries.find((entry) => entry.snapshot === snapshotId);
        const catalog = readCatalog(catalogRaw, projectId);
        if (member !== undefined || rowRaw !== undefined) {
          // Retry or collision: an index member needs its row and a row needs
          // its member — a one-sided record is damage, not an empty append.
          if (member === undefined || rowRaw === undefined)
            fail("integrity", "The creative undo index and its row disagree; nothing changed.");
          const stored = readCreativeUndoRow(rowRaw, rowKey, member.workspace, snapshotId);
          if (
            stored.workspaceId !== workspaceId ||
            stored.expected.generation !== expected.generation ||
            stored.expected.lifetime !== expected.lifetime ||
            canonicalRecovery(stored.recovery) !== offered
          )
            fail(
              "conflict",
              `creative undo snapshot '${snapshotId}' already retains different content.`,
            );
          // Idempotence may only report an intact snapshot: before the stored
          // receipt is returned, the stored row's whole durable chain —
          // catalog marker, its exact retained-undo hold, the registered
          // descriptors and the actual blob bytes — verifies inside this same
          // transaction. A lost hold or tampered byte refuses by name and
          // leaves every record untouched; the intact row is the retry's
          // authority, so no lease re-acquisition is asked of it.
          const retriedData = body;
          if (retriedData === undefined)
            fail("missing", "The project body could not be read for this retry.");
          if (catalog === undefined)
            fail("missing", "The project has no creative catalog for the stored snapshot.");
          checkMarker(retriedData, catalog);
          const retained = creativeRecoveryBlobHashes(stored.recovery);
          const storedHoldId = creativeUndoHoldId(stored.receipt.incarnation);
          const storedHold = catalog.holds.find((entry) => entry.id === storedHoldId);
          if (storedHold === undefined || storedHold.kind !== "retained-undo")
            fail(
              "integrity",
              `creative undo snapshot hold '${storedHoldId}' is missing or foreign.`,
            );
          const retainedSet = new Set(retained);
          if (
            storedHold.hashes.length !== retained.length ||
            !storedHold.hashes.every((hash) => retainedSet.has(hash))
          )
            fail(
              "integrity",
              `creative undo snapshot hold '${storedHoldId}' does not cover its row's blob inventory.`,
            );
          for (const hash of retained) {
            const ref = stored.recovery.blobs[hash]!;
            const registered = catalog.blobs[hash];
            if (registered === undefined)
              fail("integrity", `creative undo snapshot references unregistered blob '${hash}'.`);
            if (registered.byteLength !== ref.byteLength || registered.mime !== ref.mime)
              fail("integrity", `blob '${hash}' does not match its registered descriptor.`);
          }
          return {
            reads: retained.map((hash) => creativeBlobKey(projectId, hash)),
            complete: (records) => {
              for (const hash of retained) {
                const storedBlob = records.get(creativeBlobKey(projectId, hash));
                try {
                  verifyCreativeBlob(storedBlob, projectId, stored.recovery.blobs[hash]!);
                } catch (error) {
                  if (error instanceof CreativeCatalogError)
                    fail(storedBlob === undefined ? "missing" : "integrity", error.message);
                  throw error;
                }
              }
              return { result: { receipt: stored.receipt, head: catalog.head } };
            },
          };
        }
        const workspaces = new Set(entries.map((entry) => entry.workspace));
        if (!workspaces.has(workspaceId) && workspaces.size >= MAX_CREATIVE_DRAFT_WORKSPACES)
          fail(
            "budget",
            `Too many workspaces hold retained creative snapshots. Discard an older snapshot first.`,
          );
        if (entries.length >= MAX_CREATIVE_UNDO_SNAPSHOTS)
          fail(
            "budget",
            `the project already retains ${MAX_CREATIVE_UNDO_SNAPSHOTS} creative snapshots.`,
          );
        const data = body;
        if (data === undefined)
          fail("missing", "The project body could not be read for this append.");
        if (catalog === undefined)
          fail("missing", "The project has no creative catalog to snapshot from.");
        checkMarker(data, catalog);
        if (recovery.base.kept !== catalog.kept)
          fail(
            "stale",
            `The kept creative catalog is at ${catalog.kept}; this snapshot was captured against ${recovery.base.kept}.`,
          );
        // Authority: a live staging lease this workspace owns, the exact
        // receipt of a durable row this workspace already holds, or a
        // snapshot built from exactly the kept records.
        let lease: CreativeLease | undefined;
        let proven: Pick<StoredCreativeDraft, "recovery"> | undefined;
        if (authority.kind === "lease") {
          if (authority.lease.workspace !== workspaceId)
            fail(
              "authority",
              `lease '${authority.lease.id}' belongs to workspace '${authority.lease.workspace}'; this snapshot is owned by '${workspaceId}'.`,
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
        } else if (authority.kind === "draft") {
          if (draftRaw === undefined)
            fail("authority", "No owned creative recovery exists to snapshot from.");
          const owned = readCreativeDraftRow(draftRaw, draftKey, workspaceId);
          if (!sameDraftReceipt(owned.receipt, authority.receipt))
            fail(
              "authority",
              "The presented receipt does not match this workspace's durable recovery.",
            );
          proven = owned;
        } else if (authority.kind === "snapshot") {
          if (authorityRowRaw === undefined)
            fail("authority", "No owned creative snapshot exists to append from.");
          const probe = creativeDraftRecord(authorityRowRaw, [
            "projectId",
            "format",
            "version",
            "workspaceId",
            "snapshotId",
            "receipt",
            "expected",
            "recovery",
          ]);
          const owned = readCreativeUndoRow(
            authorityRowRaw,
            authorityRowKey!,
            probe["workspaceId"] as string,
            authority.snapshotId,
          );
          if (owned.workspaceId !== workspaceId)
            fail(
              "authority",
              `snapshot '${authority.snapshotId}' belongs to workspace '${owned.workspaceId}'.`,
            );
          if (!sameDraftReceipt(owned.receipt, authority.receipt))
            fail(
              "authority",
              "The presented receipt does not match this workspace's retained snapshot.",
            );
          proven = owned;
        } else if (authority.kind === "kept" && catalog.kept === 0)
          fail("authority", "The project keeps no creative records to snapshot from.");
        // Every pin names a record the kept set still holds, carried unchanged.
        const pinned = new Set(recovery.base.pins.map(versionRefKey));
        for (const pin of recovery.base.pins) {
          const kept = findKeptRecord(catalog, pin);
          if (kept === undefined)
            fail(
              "integrity",
              `base.pins names '${versionRefKey(pin)}' which the kept set does not hold.`,
            );
          if (JSON.stringify(kept) !== JSON.stringify(findCarriedRecord(recovery, pin)))
            fail(
              "integrity",
              `base.pins record '${versionRefKey(pin)}' does not match the kept record.`,
            );
        }
        // Unpinned records must be identical to staged, kept or proven ones;
        // under `kept` authority the pool is exactly the kept set.
        const pool = recordPool(catalog, lease, proven);
        const claimLists: readonly [string, readonly { readonly identity: VersionRef }[]][] = [
          ["sources", recovery.sources],
          ["derivatives", recovery.derivatives],
          ["recipes", recovery.recipes],
        ];
        for (const [label, records] of claimLists)
          for (const [i, entry] of records.entries()) {
            const key = versionRefKey(entry.identity);
            if (pinned.has(key)) continue;
            if (pool.get(key) !== JSON.stringify(entry))
              fail(
                "integrity",
                `creative undo snapshot.${label}[${i}] is not staged, kept or proven work.`,
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
            fail("integrity", `creative undo snapshot references unregistered blob '${hash}'.`);
          if (registered.byteLength !== ref.byteLength || registered.mime !== ref.mime)
            fail("integrity", `blob '${hash}' does not match its registered descriptor.`);
          try {
            for (const bucket of ref.buckets) mergeBlobRegistration(blobs, ref, bucket);
          } catch (error) {
            storeError("integrity", error);
          }
        }
        // Each successful append issues a fresh incarnation: the caller's
        // snapshot id is the idempotency key, never the receipt. A discarded
        // and recreated row cannot therefore inherit the old row's receipt or
        // hold identity.
        const receipt = { incarnation: crypto.randomUUID(), sequence: 1 };
        const hold = readCreativeHold({
          id: creativeUndoHoldId(receipt.incarnation),
          kind: "retained-undo",
          hashes: blobHashes,
        });
        // A hold id is bound to this row: any incumbent at it is foreign or
        // stale work — a bare inventory, a replaced row — never this append's.
        if (catalog.holds.some((entry) => entry.id === hold.id))
          fail(
            "integrity",
            `blob hold '${hold.id}' is owned by different work and cannot be replaced here.`,
          );
        if (catalog.holds.length >= CREATIVE_LIMITS.maxHolds)
          fail("budget", `the project already holds ${CREATIVE_LIMITS.maxHolds} blob holds.`);
        const next: CreativeCatalog = {
          ...catalog,
          head: catalog.head + 1,
          holds: upsertHold(catalog.holds, hold),
          blobs,
        };
        try {
          checkRetainedBudgets(next, now, "creative undo snapshot");
        } catch (error) {
          storeError("budget", error);
        }
        const puts: unknown[] = [
          writeCreativeUndoIndexRecord(indexKey, [
            ...entries,
            { workspace: workspaceId, snapshot: snapshotId },
          ]),
          writeCreativeUndoRowRecord(rowKey, workspaceId, snapshotId, receipt, expected, recovery),
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
          key: catalogKey,
          check(raw) {
            catalogRaw = raw;
          },
        },
        {
          key: rowKey,
          check(raw) {
            rowRaw = raw;
          },
        },
        {
          key: draftKey,
          check(raw) {
            draftRaw = raw;
          },
        },
        ...(authorityRowKey !== undefined
          ? [
              {
                key: authorityRowKey,
                check(raw: unknown) {
                  authorityRowRaw = raw;
                },
              },
            ]
          : []),
      ],
    ),
  );
}

/**
 * Every retained snapshot for a project in index order, with its
 * classification, from one coherent read: the index, the rows, the body,
 * the lifetime receipt and the catalog all agree at read time.
 */
export async function listCreativeUndos(
  projectId: ProjectId,
): Promise<readonly CreativeUndoSummary[]> {
  requireCreativeDraftProjectId(projectId);
  const indexKey = creativeUndoIndexKey(projectId);
  const catalogKey = creativeCatalogKey(projectId);
  const snapshot = await readBodyRecords(indexKey, (raw) => [
    projectId,
    `lifetime/${projectId}`,
    catalogKey,
    ...readCreativeUndoIndex(raw, indexKey).map((entry) =>
      creativeUndoKey(projectId, entry.snapshot),
    ),
  ]);
  const entries = readCreativeUndoIndex(snapshot.head, indexKey);
  if (entries.length === 0) return [];
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
  const lifetimeRaw = snapshot.records.get(`lifetime/${projectId}`);
  return entries.map((entry) => {
    const key = creativeUndoKey(projectId, entry.snapshot);
    const raw = snapshot.records.get(key);
    if (raw === undefined)
      fail("integrity", "The creative undo index lists a row that does not exist.");
    return summarize(
      readCreativeUndoRow(raw, key, entry.workspace, entry.snapshot),
      catalog,
      data,
      lifetimeRaw,
      true,
    );
  });
}

/**
 * One retained snapshot's detached data for a later restore or review UI:
 * the exact envelope, its receipt, and how it classifies against the
 * current project. Blob bytes come through `readCreativeBlob` — immutable
 * and hash-verified. Returns null when no such snapshot exists.
 */
export async function readCreativeUndo(
  projectId: ProjectId,
  snapshotId: string,
): Promise<RetainedCreativeUndo | null> {
  requireCreativeDraftProjectId(projectId);
  if (typeof snapshotId !== "string" || validProjectId(snapshotId) === null)
    throw new CreativeDraftError("missing", "The snapshot id is invalid.");
  const indexKey = creativeUndoIndexKey(projectId);
  const catalogKey = creativeCatalogKey(projectId);
  const rowKey = creativeUndoKey(projectId, snapshotId);
  const snapshot = await readBodyRecordSet([
    indexKey,
    rowKey,
    catalogKey,
    projectId,
    `lifetime/${projectId}`,
  ]);
  const entries = readCreativeUndoIndex(snapshot.get(indexKey), indexKey);
  const member = entries.find((entry) => entry.snapshot === snapshotId);
  const raw = snapshot.get(rowKey);
  if (raw === undefined) {
    if (member !== undefined)
      fail("integrity", "The creative undo index lists a row that does not exist.");
    return null;
  }
  if (member === undefined)
    fail("integrity", "A creative undo row exists without its index member.");
  const stored = readCreativeUndoRow(raw, rowKey, member.workspace, snapshotId);
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
    const blobs = await readBodyRecordSet(hashes.map((hash) => creativeBlobKey(projectId, hash)));
    for (const hash of hashes) {
      const ref = stored.recovery.blobs[hash]!;
      const record = blobs.get(creativeBlobKey(projectId, hash)) as
        { byteLength?: unknown; mime?: unknown } | undefined;
      if (record === undefined || record.byteLength !== ref.byteLength || record.mime !== ref.mime)
        blobsPresent = false;
    }
  }
  const summary = summarize(stored, catalog, data, snapshot.get(`lifetime/${projectId}`), true);
  return {
    ...summary,
    integrity: summary.integrity && blobsPresent,
    expected: stored.expected,
    recovery: stored.recovery,
  };
}

/**
 * Remove one retained snapshot by exact receipt: its index member, its row
 * and its own durable hold, in one transaction. Kept records, foreign
 * snapshots, live leases, recovery holds and a newer receipt are all
 * untouched; a byte another hold still pins stays put for GC to keep.
 * A stale snapshot may still be discarded — the lifetime just has to be
 * live.
 */
export async function discardCreativeUndo(
  projectId: ProjectId,
  snapshotId: string,
  expectedReceipt: DraftReceipt,
  expectedLifetime?: string,
): Promise<void> {
  requireCreativeDraftProjectId(projectId);
  if (typeof snapshotId !== "string" || validProjectId(snapshotId) === null)
    throw new CreativeDraftError("missing", "The snapshot id is invalid.");
  const receipt = readDraftReceipt(expectedReceipt);
  const indexKey = creativeUndoIndexKey(projectId);
  const catalogKey = creativeCatalogKey(projectId);
  const rowKey = creativeUndoKey(projectId, snapshotId);
  let catalogRaw: unknown;
  let rowRaw: unknown;
  await serializeWrite(projectId, () =>
    updateBodyRecords(
      indexKey,
      (raw) => {
        const entries = readCreativeUndoIndex(raw, indexKey);
        const member = entries.find((entry) => entry.snapshot === snapshotId);
        if ((rowRaw !== undefined) !== (member !== undefined))
          fail("conflict", "The creative undo index is inconsistent and was left unchanged.");
        if (member === undefined || rowRaw === undefined)
          fail(
            "conflict",
            "This creative snapshot changed; review the latest before discarding it.",
          );
        const previous = readCreativeUndoRow(rowRaw, rowKey, member.workspace, snapshotId);
        if (!sameDraftReceipt(previous.receipt, receipt))
          fail(
            "conflict",
            "This creative snapshot changed; review the latest before discarding it.",
          );
        const catalog = readCatalog(catalogRaw, projectId);
        const remaining = entries.filter((entry) => entry.snapshot !== snapshotId);
        const puts: unknown[] = [];
        if (catalog !== undefined) {
          const holdId = creativeUndoHoldId(previous.receipt.incarnation);
          // Release only this snapshot's own hold: a same-id hold of another
          // kind is foreign work and stays put.
          const holds = catalog.holds.filter(
            (entry) => !(entry.id === holdId && entry.kind === "retained-undo"),
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
        if (remaining.length > 0) puts.unshift(writeCreativeUndoIndexRecord(indexKey, remaining));
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
            rowRaw = raw;
          },
        },
      ],
    ),
  );
}
