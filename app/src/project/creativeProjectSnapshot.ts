import {
  historyBlobKeys,
  hydrateProjectHistory,
  type StoredProjectHistory,
} from "./projectHistoryStorage.ts";
/**
 * Coherent capture of a project's kept creative data and its durable
 * unfinished work for archive export.
 *
 * `captureCreativeProject` reads the project body, the creative catalog,
 * the recovery index, every indexed recovery row, every durable hold's
 * blob inventory and the blob records the kept set and the work reference
 * inside ONE IndexedDB transaction, so a concurrent Keep, staging write,
 * GC pass or delete can only move the snapshot's point in time — it can
 * never mix records from different catalog revisions into one capture.
 * The body read goes through the same `readStoredBody` codec every project
 * read uses, the catalog through the strict manifest reader, and the
 * index/rows through the shared draft-record codec; a missing,
 * unknown-version or corrupt record refuses instead of capturing a
 * partial set.
 *
 * The result is a `CreativeProjectSnapshot`: the portable manifest (when a
 * kept set exists), the portable work envelope (when durable recovery or
 * retained-undo material exists) and their verified blob bytes plus the
 * storage binding (project, body generation, kept revision, catalog head,
 * resource revision) an archive writer checks before trusting it.
 * Storage authority — the body's marker, catalog head, receipts, lease
 * ids and lifetimes — never enters the portable data.
 *
 * Work captured this way keeps its truth: a stale recovery stays stale
 * with its original base, retained-undo inventories stay bare hash
 * inventories (they do not claim reconstructable undo history), and a
 * project with only durable recovery — no kept marker — captures as a
 * work-only snapshot rather than inventing a Keep. Active staging leases
 * are not durable data and are omitted; bytes they staged remain
 * reachable only through a durable hold that covers them.
 */
import {
  CreativeCatalogError,
  creativeBlobKey,
  creativeCatalogKey,
  readCreativeCatalogRecord,
  verifyCreativeBlob,
  type BlobHash,
  type CreativeCatalog,
} from "../../../src/creative/catalog.ts";
import {
  deriveCreativeProjectManifest,
  type CreativeProjectManifest,
} from "../../../src/creative/project.ts";
import type { PortableCreativeWork } from "../../../src/creative/workArchive.ts";
import { detectProfile } from "../../../src/runtime/profile.ts";
import {
  projectId as validProjectId,
  type ProjectId,
  type ResourceRevision,
} from "../../../src/gameIdentity.ts";
import { gameRevision } from "./gameMetadata.ts";
import type { CachedGameData } from "./gameTypes.ts";
import {
  authoringFingerprint,
  generationOf,
  historyLifetimeGuard,
  lifetimeHolds,
  liveLifetime,
  readStoredBody,
  runInWriteTurn,
  serializeWrite,
  updateBodyRecords,
  type HistoryLifetime,
  type OwnedWriteTurn,
} from "./gameStorage.ts";
import {
  CreativeDraftError,
  assembleCreativeWorkCapture,
  creativeDraftIndexKey,
  creativeDraftKey,
  creativeUndoIndexKey,
  creativeUndoKey,
  readCreativeDraftIndex,
  readCreativeDraftRow,
  readCreativeUndoIndex,
  readCreativeUndoRow,
  type CreativeDraftAxes,
  type CreativeUndoIndexEntry,
  type StoredCreativeDraft,
  type StoredCreativeUndo,
} from "./creativeWorkArchive.ts";

/** Why a creative capture refused. */
export type CreativeSnapshotReason =
  | "missing" // a required body, catalog, row or blob record is absent
  | "conflict" // the body marker and catalog disagree
  | "integrity" // bytes, descriptors or record claims do not match
  | "unsupported"; // a stored shape names a format or version this build cannot read

export class CreativeSnapshotError extends Error {
  readonly reason: CreativeSnapshotReason;
  constructor(reason: CreativeSnapshotReason, message: string) {
    super(message);
    this.name = "CreativeSnapshotError";
    this.reason = reason;
  }
}

function snapshotError(reason: CreativeSnapshotReason, message: string): CreativeSnapshotError {
  return new CreativeSnapshotError(reason, message);
}

/** Map codec and draft-record refusals onto the capture error; other errors pass through. */
function asSnapshotError(error: unknown): never {
  if (error instanceof CreativeCatalogError)
    throw snapshotError(error.code === "unsupported" ? "unsupported" : "integrity", error.message);
  if (error instanceof CreativeDraftError)
    throw snapshotError(
      error.reason === "unsupported"
        ? "unsupported"
        : error.reason === "missing"
          ? "missing"
          : "integrity",
      error.message,
    );
  throw error;
}

/**
 * A captured kept creative set plus durable work, bound to the body they
 * were read with. `manifest`/`blobs` are the portable kept assets (null/empty
 * when nothing was Kept); `work`/`workBlobs` are the portable durable-work
 * envelope and the exact bytes it references (null when no recovery row or
 * retained hold exists). `projectId`, `generation`, `kept`, `head` and
 * `revision` bind this capture to the one durable state it came from, so a
 * writer can refuse a snapshot offered beside a different body instead of
 * archiving a mismatched pair.
 */
export interface CreativeProjectSnapshot {
  readonly projectId: ProjectId;
  /** The durable body this snapshot was read with, validated by `readStoredBody`. */
  readonly data: CachedGameData;
  /** The body's storage generation at capture; 0 for a pre-generation record. */
  readonly generation: number;
  /** The kept catalog revision the body's marker pinned at capture; 0 with no marker. */
  readonly kept: number;
  /** The catalog head revision at capture; diagnostic, never authority. */
  readonly head: number;
  /** The playable-bytes revision of the captured body. */
  readonly revision: ResourceRevision;
  /** The portable kept set, when the body's marker pinned one. */
  readonly manifest: CreativeProjectManifest | null;
  /** Byte bodies for exactly the kept manifest's declared hashes. */
  readonly blobs: Readonly<Record<BlobHash, Uint8Array>>;
  /** The portable durable-work envelope, when recovery rows or retained holds exist. */
  readonly work: PortableCreativeWork | null;
  /** Byte bodies for exactly the work envelope's declared hashes. */
  readonly workBlobs: Readonly<Record<BlobHash, Uint8Array>>;
}

/**
 * Capture the kept creative set and durable work of `projectId` in one
 * coherent snapshot. Returns null when the project keeps no creative data
 * at all — no marker, no catalog, no recovery rows, no holds. A staging-only
 * catalog (kept 0, no holds, no rows) is not durable work and also reads
 * as null. `expectedLifetime`, when given, additionally requires the
 * project's live history lifetime to match, so a capture cannot silently
 * follow a delete-and-recreate.
 *
 * The capture writes nothing: no catalog head bump, no lease, no hold, no
 * body or index change — reads only.
 */
export async function captureCreativeProject(
  projectId: ProjectId,
  expectedLifetime?: string | null,
): Promise<CreativeProjectSnapshot | null> {
  return captureProject(
    (operation) => serializeWrite(projectId, operation),
    projectId,
    expectedLifetime,
  );
}

/**
 * The same coherent capture, run inside a write turn the caller already
 * holds for this project — the only path an action that suspended on a
 * lazy module load may use, since its own `serializeWrite` call would
 * deadlock behind the turn it holds. The turn is validated by
 * `runInWriteTurn`; every other caller keeps `captureCreativeProject`,
 * which queues on the project's write slot like any other read.
 */
export function captureCreativeProjectInTurn(
  turn: OwnedWriteTurn,
  projectId: ProjectId,
  expectedLifetime?: string | null,
): Promise<CreativeProjectSnapshot | null> {
  return captureProject(
    (operation) => runInWriteTurn(turn, projectId, operation),
    projectId,
    expectedLifetime,
  );
}

async function captureProject(
  run: <T>(operation: () => Promise<T>) => Promise<T>,
  projectId: ProjectId,
  expectedLifetime: string | null | undefined,
): Promise<CreativeProjectSnapshot | null> {
  if (validProjectId(projectId) === null)
    throw snapshotError("missing", "The project id is invalid.");
  const catalogKey = creativeCatalogKey(projectId);
  const indexKey = creativeDraftIndexKey(projectId);
  const undoIndexKey = creativeUndoIndexKey(projectId);
  let bodyRaw: unknown;
  let lifetimeRaw: unknown;
  let indexRaw: unknown;
  let undoIndexRaw: unknown;
  let captured:
    | {
        data: CachedGameData;
        catalog: CreativeCatalog;
        markerKept: number | null;
        manifest: CreativeProjectManifest | null;
        rows: StoredCreativeDraft[];
        undos: StoredCreativeUndo[];
      }
    | undefined;
  const blobRecords = await run(() =>
    updateBodyRecords<Map<string, unknown> | null>(
      catalogKey,
      (raw) => {
        if (bodyRaw === undefined)
          throw snapshotError("missing", "The project's body record is missing.");
        let parsed: CachedGameData;
        try {
          parsed = readStoredBody(bodyRaw, projectId);
        } catch (error) {
          throw snapshotError("integrity", error instanceof Error ? error.message : String(error));
        }
        const marker = parsed.creative ?? null;
        let catalog: CreativeCatalog | undefined;
        try {
          catalog = readCreativeCatalogRecord(raw, projectId);
        } catch (error) {
          asSnapshotError(error);
        }
        let workspaces: string[];
        let undoEntries: CreativeUndoIndexEntry[];
        try {
          workspaces = readCreativeDraftIndex(indexRaw, indexKey);
          undoEntries = readCreativeUndoIndex(undoIndexRaw, undoIndexKey);
        } catch (error) {
          asSnapshotError(error);
        }
        if (catalog === undefined) {
          if (marker !== null)
            throw snapshotError(
              "missing",
              `the body pins kept catalog ${marker.kept} but none exists.`,
            );
          if (workspaces.length > 0 || undoEntries!.length > 0)
            throw snapshotError(
              "integrity",
              "a creative recovery or undo index lists rows but the catalog is missing.",
            );
          return { result: null };
        }
        if (marker === null && catalog.kept !== 0)
          throw snapshotError(
            "conflict",
            `the catalog is kept at ${catalog.kept} but the body lost its creative marker.`,
          );
        if (marker !== null && marker.kept !== catalog.kept)
          throw snapshotError(
            "conflict",
            `the body pins kept catalog ${marker.kept} but the catalog is at kept ${catalog.kept}.`,
          );
        let manifest: CreativeProjectManifest | null = null;
        if (marker !== null) {
          try {
            manifest = deriveCreativeProjectManifest(catalog);
          } catch (error) {
            asSnapshotError(error);
          }
        }
        // Nothing durable to carry: a staging-only catalog (no kept set, no
        // holds, no indexed rows) still reads as "no creative capture" —
        // live leases are workspace state, not durable work.
        const heldKeys = catalog.holds.flatMap((hold) => [...hold.hashes]);
        if (
          marker === null &&
          heldKeys.length === 0 &&
          workspaces.length === 0 &&
          undoEntries.length === 0
        )
          return { result: null };
        // Every referenced claim must be registered in this same snapshot
        // of the catalog, with the byte length and mime the claim records —
        // kept blobs, then the durable holds' inventories.
        const wanted: [key: string, hash: BlobHash][] = [];
        const seen = new Set<BlobHash>();
        const want = (
          hash: BlobHash,
          claimed: { byteLength: number; mime: string } | undefined,
        ) => {
          const registered = catalog.blobs[hash];
          if (registered === undefined)
            throw snapshotError(
              "missing",
              `creative blob '${hash}' is not registered in the catalog.`,
            );
          if (
            claimed !== undefined &&
            (registered.byteLength !== claimed.byteLength || registered.mime !== claimed.mime)
          )
            throw snapshotError(
              "integrity",
              `creative blob '${hash}' does not match its registered descriptor.`,
            );
          if (!seen.has(hash)) {
            seen.add(hash);
            wanted.push([creativeBlobKey(projectId, hash), hash]);
          }
        };
        for (const hash of Object.keys(manifest?.blobs ?? {})) want(hash, manifest!.blobs[hash]!);
        for (const hash of heldKeys) want(hash, undefined);
        return {
          reads: [
            ...historyBlobKeys(
              projectId,
              (bodyRaw as { editHistory?: StoredProjectHistory }).editHistory,
            ),
            ...wanted.map(([key]) => key),
            ...workspaces.map((workspaceId) => creativeDraftKey(projectId, workspaceId)),
            ...undoEntries.map((entry) => creativeUndoKey(projectId, entry.snapshot)),
          ],
          complete: (records) => {
            const editHistory = (bodyRaw as { editHistory?: StoredProjectHistory }).editHistory;
            if (editHistory !== undefined)
              parsed.projectHistory = hydrateProjectHistory(projectId, editHistory, records);
            // Same transaction, deferred phase: the blob and row keys are
            // only nameable once the catalog and index have been read. A
            // claimed record absent here is damage, not an empty capture.
            for (const [, hash] of wanted)
              if (records.get(creativeBlobKey(projectId, hash)) === undefined)
                throw snapshotError("missing", `the creative blob record '${hash}' is missing.`);
            const rows: StoredCreativeDraft[] = [];
            for (const workspaceId of workspaces) {
              const key = creativeDraftKey(projectId, workspaceId);
              const stored = records.get(key);
              if (stored === undefined)
                throw snapshotError(
                  "missing",
                  `the creative recovery index lists workspace '${workspaceId}' whose row is missing.`,
                );
              try {
                rows.push(readCreativeDraftRow(stored, key, workspaceId));
              } catch (error) {
                asSnapshotError(error);
              }
            }
            const undoRows: StoredCreativeUndo[] = [];
            for (const entry of undoEntries) {
              const key = creativeUndoKey(projectId, entry.snapshot);
              const stored = records.get(key);
              if (stored === undefined)
                throw snapshotError(
                  "missing",
                  `the creative undo index lists snapshot '${entry.snapshot}' whose row is missing.`,
                );
              try {
                undoRows.push(readCreativeUndoRow(stored, key, entry.workspace, entry.snapshot));
              } catch (error) {
                asSnapshotError(error);
              }
            }
            captured = {
              data: parsed,
              catalog,
              markerKept: marker?.kept ?? null,
              manifest,
              rows,
              undos: undoRows,
            };
            return { result: records };
          },
        };
      },
      [
        // The body, lifetime receipt and recovery index are read inside the
        // same transaction through the guard slots — one snapshot covers
        // the catalog, the body that pins it, the index that discovers the
        // rows and every record both name.
        {
          key: projectId,
          check: (raw) => {
            bodyRaw = raw;
          },
        },
        historyLifetimeGuard(projectId, expectedLifetime),
        {
          key: `lifetime/${projectId}`,
          check: (raw) => {
            lifetimeRaw = raw;
          },
        },
        {
          key: indexKey,
          check: (raw) => {
            indexRaw = raw;
          },
        },
        {
          key: undoIndexKey,
          check: (raw) => {
            undoIndexRaw = raw;
          },
        },
      ],
    ),
  );
  if (blobRecords === null || captured === undefined) return null;
  const { data, catalog, markerKept, manifest, rows, undos } = captured;
  // The transaction has closed and every byte is already an owned clone;
  // exact-hash verification runs now rather than holding a write lock.
  const blobs: Record<BlobHash, Uint8Array> = {};
  if (manifest !== null)
    for (const hash of Object.keys(manifest.blobs)) {
      const descriptor = manifest.blobs[hash]!;
      try {
        blobs[hash] = verifyCreativeBlob(
          blobRecords.get(creativeBlobKey(projectId, hash)),
          projectId,
          descriptor,
        );
      } catch (error) {
        asSnapshotError(error);
      }
    }
  // The semantic basis the captured work was classified against: the
  // resource revision of the captured bytes, the authoring fingerprint,
  // the resolved profile and the catalog's kept revision.
  const revision = await gameRevision(data.files);
  const authoring = authoringFingerprint(data.authoringState, data.workspace);
  const profileId = detectProfile(new Map(Object.entries(data.files)), data.library?.profile).id;
  const live = liveLifetime(lifetimeRaw as HistoryLifetime | undefined);
  const axes = (row: Pick<StoredCreativeDraft, "expected" | "recovery">): CreativeDraftAxes => ({
    lifetimeMatches: lifetimeHolds(row.expected.lifetime, live),
    body: {
      generation: generationOf(data),
      revision: data.library?.revision,
      authoring,
      profileId,
    },
    kept: catalog.kept,
  });
  let workBundle: { work: PortableCreativeWork; hashes: readonly BlobHash[] } | null = null;
  try {
    workBundle = assembleCreativeWorkCapture({
      catalog,
      rows,
      undos,
      axes,
      basis: { revision, authoring, profileId, kept: catalog.kept },
    });
  } catch (error) {
    asSnapshotError(error);
  }
  const workBlobs: Record<BlobHash, Uint8Array> = {};
  for (const hash of workBundle?.hashes ?? []) {
    try {
      workBlobs[hash] = verifyCreativeBlob(
        blobRecords.get(creativeBlobKey(projectId, hash)),
        projectId,
        catalog.blobs[hash]!,
      );
    } catch (error) {
      asSnapshotError(error);
    }
  }
  return {
    projectId,
    data,
    generation: generationOf(data),
    kept: markerKept ?? 0,
    head: catalog.head,
    revision,
    manifest,
    blobs,
    work: workBundle?.work ?? null,
    workBlobs,
  };
}
