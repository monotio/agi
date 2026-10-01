/**
 * Shared durable creative-work record format and portable-work planning.
 *
 * Pure helpers only — no IndexedDB, no storage module. The live services
 * (`creativeDrafts.ts` and `creativeUndo.ts`, which import the storage
 * layer), the coherent capture in `creativeProjectSnapshot.ts` and the
 * new-project publication transaction inside `gameStorage.ts` all share
 * these codecs, so the row/index record formats, the staleness
 * classification and the portable-work assembly plans stay single-sourced.
 *
 * Stored records: a recovery index at `creative/<projectId>/drafts` with
 * one row per workspace at `creative/<projectId>/draft/<workspaceId>`, and
 * a retained-snapshot index at `creative/<projectId>/undos` with one
 * append-only row per snapshot at `creative/<projectId>/undo/<snapshotId>`.
 * A row's durable hold id is bound to its receipt incarnation — recovery
 * holds read `recovery-<incarnation>`, snapshot holds `undo-<incarnation>`.
 * Portable side: `PortableCreativeWork` — the versioned, authority-free
 * envelope the private Project archive carries.
 */
import { projectId as validProjectId, type ProjectId } from "../../../src/gameIdentity.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import {
  compareCodePoints,
  CreativeCatalogError,
  versionRefKey,
  type BlobHash,
  type CreativeCatalog,
  type CreativeHold,
  type RegisteredBlob,
} from "../../../src/creative/catalog.ts";
import {
  creativeRecoveryBlobHashes,
  readCreativeRecovery,
  type PortableCreativeRecovery,
} from "../../../src/creative/recovery.ts";
import {
  CREATIVE_WORK_LIMITS,
  readCreativeWork,
  writeCreativeWork,
  type CreativeWorkBasis,
  type CreativeWorkStatus,
  type PortableCreativeWork,
} from "../../../src/creative/workArchive.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import type { DraftReceipt } from "./projectDrafts.ts";

/** Never evict an existing recovery to admit a newly opened workspace. */
export const MAX_CREATIVE_DRAFT_WORKSPACES = 16;
export const CREATIVE_DRAFT_FORMAT = "monotio.agi.creative-draft";
export const CREATIVE_DRAFTS_FORMAT = "monotio.agi.creative-drafts";

/** Why a creative recovery operation refused. */
export type CreativeDraftReason =
  | "missing" // a required catalog, row or blob record is absent
  | "conflict" // a receipt CAS failed, or index/row/hold disagree
  | "stale" // the captured base moved; save against the current one
  | "authority" // no live lease or owned recovery authorizes this save
  | "integrity" // bytes, descriptors or record claims do not match
  | "budget" // a declared limit is exceeded
  | "unsupported"; // an unknown format or nested version

export class CreativeDraftError extends Error {
  readonly reason: CreativeDraftReason;
  constructor(reason: CreativeDraftReason, message: string) {
    super(message);
    this.name = "CreativeDraftError";
    this.reason = reason;
  }
}

/** Which pinned identity moved, when a recovery is classified stale. */
export type CreativeDraftStaleField =
  "lifetime" | "body" | "generation" | "revision" | "authoring" | "profile" | "kept";

export function creativeDraftIndexKey(projectId: ProjectId): string {
  return `creative/${projectId}/drafts`;
}

export function creativeDraftKey(projectId: ProjectId, workspaceId: string): string {
  return `creative/${projectId}/draft/${workspaceId}`;
}

/** A recovery's hold id is bound to its receipt incarnation: a discarded and recreated workspace can never inherit the old hold. */
export function creativeRecoveryHoldId(incarnation: string): string {
  return `recovery-${incarnation}`;
}

export interface StoredCreativeDraft {
  readonly projectId: string;
  readonly format: typeof CREATIVE_DRAFT_FORMAT;
  readonly version: 1;
  readonly workspaceId: string;
  readonly receipt: DraftReceipt;
  readonly expected: { readonly generation: number; readonly lifetime: string };
  readonly recovery: PortableCreativeRecovery;
}

export function requireCreativeDraftProjectId(projectId: ProjectId): ProjectId {
  if (validProjectId(projectId) === null)
    throw new CreativeDraftError("missing", "The project id is invalid.");
  return projectId;
}

export function requireCreativeWorkspaceId(workspaceId: string): string {
  if (validProjectId(workspaceId) === null)
    throw new CreativeDraftError("missing", "The workspace id is invalid.");
  return workspaceId;
}

export function creativeDraftRecord(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new CreativeDraftError("integrity", "Invalid saved creative recovery record.");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !fields.includes(key)))
    throw new CreativeDraftError("integrity", "Unknown saved creative recovery field.");
  return result;
}

function versioned(value: unknown, format: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    (value as Record<string, unknown>)["format"] !== format ||
    (value as Record<string, unknown>)["version"] !== 1
  )
    throw new CreativeDraftError(
      "unsupported",
      "This saved creative recovery version is not supported by this app.",
    );
  return value as Record<string, unknown>;
}

export function readDraftReceipt(value: unknown): DraftReceipt {
  const raw = creativeDraftRecord(value, ["incarnation", "sequence"]);
  if (
    typeof raw["incarnation"] !== "string" ||
    validProjectId(raw["incarnation"]) === null ||
    !Number.isSafeInteger(raw["sequence"]) ||
    (raw["sequence"] as number) < 1
  )
    throw new CreativeDraftError("integrity", "Invalid creative recovery receipt.");
  return { incarnation: raw["incarnation"], sequence: raw["sequence"] as number };
}

export function sameDraftReceipt(left: DraftReceipt | null, right: DraftReceipt | null): boolean {
  return left === null || right === null
    ? left === right
    : left.incarnation === right.incarnation && left.sequence === right.sequence;
}

export function readDraftExpected(value: unknown): { generation: number; lifetime: string } {
  const raw = creativeDraftRecord(value, ["generation", "lifetime"]);
  if (
    !Number.isSafeInteger(raw["generation"]) ||
    (raw["generation"] as number) < 0 ||
    typeof raw["lifetime"] !== "string" ||
    !raw["lifetime"] ||
    raw["lifetime"].length > 128
  )
    throw new CreativeDraftError("integrity", "Invalid saved creative recovery base.");
  return { generation: raw["generation"] as number, lifetime: raw["lifetime"] };
}

export function readCreativeDraftIndex(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  versioned(value, CREATIVE_DRAFTS_FORMAT);
  const raw = creativeDraftRecord(value, ["projectId", "format", "version", "workspaces"]);
  const workspaces = raw["workspaces"];
  if (
    raw["projectId"] !== key ||
    !Array.isArray(workspaces) ||
    workspaces.length > MAX_CREATIVE_DRAFT_WORKSPACES ||
    workspaces.some((id) => typeof id !== "string" || validProjectId(id) === null) ||
    new Set(workspaces).size !== workspaces.length
  )
    throw new CreativeDraftError("integrity", "Invalid creative recovery workspace index.");
  for (let i = 1; i < workspaces.length; i++)
    if (compareCodePoints(workspaces[i - 1] as string, workspaces[i] as string) >= 0)
      throw new CreativeDraftError(
        "integrity",
        "The creative recovery index is not stored in canonical order.",
      );
  return [...workspaces] as string[];
}

export function readCreativeDraftRow(
  value: unknown,
  key: string,
  workspaceId: string,
): StoredCreativeDraft {
  versioned(value, CREATIVE_DRAFT_FORMAT);
  const raw = creativeDraftRecord(value, [
    "projectId",
    "format",
    "version",
    "workspaceId",
    "receipt",
    "expected",
    "recovery",
  ]);
  if (raw["projectId"] !== key || raw["workspaceId"] !== workspaceId)
    throw new CreativeDraftError("integrity", "Invalid saved creative recovery identity.");
  let recovery: PortableCreativeRecovery;
  try {
    recovery = readCreativeRecovery(raw["recovery"]);
  } catch (error) {
    if (error instanceof CreativeDraftError) throw error;
    if (error instanceof CreativeCatalogError)
      throw new CreativeDraftError(
        error.code === "unsupported" ? "unsupported" : "integrity",
        error.message,
      );
    throw error;
  }
  return {
    projectId: key,
    format: CREATIVE_DRAFT_FORMAT,
    version: 1,
    workspaceId,
    receipt: readDraftReceipt(raw["receipt"]),
    expected: readDraftExpected(raw["expected"]),
    recovery,
  };
}

/** The index record a transaction puts; the workspace list must already be unique and canonically ordered. */
export function writeCreativeDraftIndexRecord(
  indexKey: string,
  workspaces: readonly string[],
): Record<string, unknown> {
  return {
    projectId: indexKey,
    format: CREATIVE_DRAFTS_FORMAT,
    version: 1,
    workspaces: [...workspaces],
  };
}

// ---------- retained snapshot (undo) records ----------

export const CREATIVE_UNDO_FORMAT = "monotio.agi.creative-undo";
export const CREATIVE_UNDOS_FORMAT = "monotio.agi.creative-undos";
/** Total retained snapshots a project may hold; matches the portable bound. */
export const MAX_CREATIVE_UNDO_SNAPSHOTS = CREATIVE_WORK_LIMITS.maxUndos;
/** Snapshot-bearing workspaces are bounded like recovery workspaces. */
const MAX_CREATIVE_UNDO_WORKSPACES = MAX_CREATIVE_DRAFT_WORKSPACES;

export function creativeUndoIndexKey(projectId: ProjectId): string {
  return `creative/${projectId}/undos`;
}

export function creativeUndoKey(projectId: ProjectId, snapshotId: string): string {
  return `creative/${projectId}/undo/${snapshotId}`;
}

/** A snapshot's retained hold id is bound to its receipt incarnation: a discarded snapshot can never be revived under the same hold. */
export function creativeUndoHoldId(incarnation: string): string {
  return `undo-${incarnation}`;
}

/** One index member: the snapshot's workspace and id, in append order. */
export interface CreativeUndoIndexEntry {
  readonly workspace: string;
  readonly snapshot: string;
}

export interface StoredCreativeUndo {
  readonly projectId: string;
  readonly format: typeof CREATIVE_UNDO_FORMAT;
  readonly version: 1;
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly receipt: DraftReceipt;
  readonly expected: { readonly generation: number; readonly lifetime: string };
  readonly recovery: PortableCreativeRecovery;
}

export function readCreativeUndoIndex(value: unknown, key: string): CreativeUndoIndexEntry[] {
  if (value === undefined) return [];
  versioned(value, CREATIVE_UNDOS_FORMAT);
  const raw = creativeDraftRecord(value, ["projectId", "format", "version", "snapshots"]);
  const snapshots = raw["snapshots"];
  if (
    raw["projectId"] !== key ||
    !Array.isArray(snapshots) ||
    snapshots.length > MAX_CREATIVE_UNDO_SNAPSHOTS
  )
    throw new CreativeDraftError("integrity", "Invalid creative undo snapshot index.");
  const entries: CreativeUndoIndexEntry[] = [];
  const seenSnapshots = new Set<string>();
  const workspaces = new Set<string>();
  for (const [i, member] of (snapshots as unknown[]).entries()) {
    const entry = creativeDraftRecord(member, ["workspace", "snapshot"]);
    const workspace = entry["workspace"];
    const snapshot = entry["snapshot"];
    if (
      typeof workspace !== "string" ||
      validProjectId(workspace) === null ||
      typeof snapshot !== "string" ||
      validProjectId(snapshot) === null
    )
      throw new CreativeDraftError(
        "integrity",
        `Invalid creative undo snapshot index member ${i}.`,
      );
    if (seenSnapshots.has(snapshot))
      throw new CreativeDraftError(
        "integrity",
        `creative undo snapshot '${snapshot}' is indexed twice.`,
      );
    seenSnapshots.add(snapshot);
    workspaces.add(workspace);
    entries.push({ workspace, snapshot });
  }
  if (workspaces.size > MAX_CREATIVE_UNDO_WORKSPACES)
    throw new CreativeDraftError(
      "budget",
      `the creative undo index names ${workspaces.size} workspaces, over the ${MAX_CREATIVE_UNDO_WORKSPACES} bound.`,
    );
  return entries;
}

export function readCreativeUndoRow(
  value: unknown,
  key: string,
  workspaceId: string,
  snapshotId: string,
): StoredCreativeUndo {
  versioned(value, CREATIVE_UNDO_FORMAT);
  const raw = creativeDraftRecord(value, [
    "projectId",
    "format",
    "version",
    "workspaceId",
    "snapshotId",
    "receipt",
    "expected",
    "recovery",
  ]);
  if (
    raw["projectId"] !== key ||
    raw["workspaceId"] !== workspaceId ||
    raw["snapshotId"] !== snapshotId
  )
    throw new CreativeDraftError("integrity", "Invalid saved creative undo snapshot identity.");
  let recovery: PortableCreativeRecovery;
  try {
    recovery = readCreativeRecovery(raw["recovery"]);
  } catch (error) {
    if (error instanceof CreativeDraftError) throw error;
    if (error instanceof CreativeCatalogError)
      throw new CreativeDraftError(
        error.code === "unsupported" ? "unsupported" : "integrity",
        error.message,
      );
    throw error;
  }
  return {
    projectId: key,
    format: CREATIVE_UNDO_FORMAT,
    version: 1,
    workspaceId,
    snapshotId,
    receipt: readDraftReceipt(raw["receipt"]),
    expected: readDraftExpected(raw["expected"]),
    recovery,
  };
}

/** The index record a transaction puts; `entries` keep append order. */
export function writeCreativeUndoIndexRecord(
  indexKey: string,
  entries: readonly CreativeUndoIndexEntry[],
): Record<string, unknown> {
  return {
    projectId: indexKey,
    format: CREATIVE_UNDOS_FORMAT,
    version: 1,
    snapshots: entries.map((entry) => ({ workspace: entry.workspace, snapshot: entry.snapshot })),
  };
}

/** The row record a transaction puts. `recovery` must be the canonical codec read. */
export function writeCreativeUndoRowRecord(
  rowKey: string,
  workspaceId: string,
  snapshotId: string,
  receipt: DraftReceipt,
  expected: { readonly generation: number; readonly lifetime: string },
  recovery: PortableCreativeRecovery,
): Record<string, unknown> {
  return {
    projectId: rowKey,
    format: CREATIVE_UNDO_FORMAT,
    version: 1,
    workspaceId,
    snapshotId,
    receipt,
    expected,
    recovery,
  } satisfies StoredCreativeUndo;
}

/** The row record a transaction puts. `recovery` must be the canonical codec read. */
export function writeCreativeDraftRowRecord(
  rowKey: string,
  workspaceId: string,
  receipt: DraftReceipt,
  expected: { readonly generation: number; readonly lifetime: string },
  recovery: PortableCreativeRecovery,
): Record<string, unknown> {
  return {
    projectId: rowKey,
    format: CREATIVE_DRAFT_FORMAT,
    version: 1,
    workspaceId,
    receipt,
    expected,
    recovery,
  } satisfies StoredCreativeDraft;
}

/**
 * The live pins a stored row is classified against, supplied by the caller's
 * own storage read — this module never opens storage itself.
 */
export interface CreativeDraftAxes {
  /** Whether the row's stored lifetime expectation matches the live epoch. */
  readonly lifetimeMatches: boolean;
  /** The body's pins, or undefined when the body record is absent or unreadable. */
  readonly body:
    | {
        readonly generation: number;
        /** The body's stored library revision; raw equality is what matters. */
        readonly revision: unknown;
        readonly authoring: string;
        readonly profileId: ProfileId;
      }
    | undefined;
  /** The catalog's kept revision, or undefined when no catalog exists. */
  readonly kept: number | undefined;
}

/**
 * The exact staleness axes the live drafts service reports: which stored
 * pin no longer matches the project the row was read beside. Same order as
 * `staleFieldsOf` — lifetime, then body, generation, revision, authoring,
 * profile, kept.
 */
export function creativeDraftStaleFields(
  stored: Pick<StoredCreativeDraft, "expected" | "recovery">,
  axes: CreativeDraftAxes,
): CreativeDraftStaleField[] {
  const stale: CreativeDraftStaleField[] = [];
  if (!axes.lifetimeMatches) stale.push("lifetime");
  if (axes.body === undefined) {
    stale.push("body");
    return stale;
  }
  const base = stored.recovery.base;
  if (axes.body.generation !== stored.expected.generation) stale.push("generation");
  if (axes.body.revision !== base.revision) stale.push("revision");
  if (axes.body.authoring !== base.authoring) stale.push("authoring");
  if (axes.body.profileId !== base.profileId) stale.push("profile");
  if (axes.kept === undefined || axes.kept !== base.kept) stale.push("kept");
  return stale;
}

/**
 * Assemble the portable work envelope from one coherent read: the catalog
 * (whose holds pin the rows' bytes), the indexed recovery rows, the indexed
 * retained-snapshot rows and a per-row axes callback the caller computes
 * from the same snapshot. Refuses by name — an index↔row↔hold mismatch, an
 * unregistered claim, a corrupt envelope — never returns a partial bundle.
 * Returns null when the project holds no durable work at all.
 *
 * A `retained-undo` hold is snapshot-owned exactly when its id is
 * `undo-<incarnation>` for an indexed snapshot row's receipt; its inventory
 * must then equal that snapshot's derived registry. Every other
 * `retained-undo` hold is a bare inventory and travels under `retained`.
 */
export function assembleCreativeWorkCapture(input: {
  readonly catalog: CreativeCatalog;
  readonly rows: readonly StoredCreativeDraft[];
  readonly undos: readonly StoredCreativeUndo[];
  readonly axes: (row: Pick<StoredCreativeDraft, "expected" | "recovery">) => CreativeDraftAxes;
  readonly basis: CreativeWorkBasis;
}): { work: PortableCreativeWork; hashes: readonly BlobHash[] } | null {
  const { catalog, rows, undos, axes, basis } = input;
  const held = new Map<string, CreativeHold>();
  for (const hold of catalog.holds) held.set(hold.id, hold);
  const seen = new Set<string>();
  const classify = (row: Pick<StoredCreativeDraft, "expected" | "recovery">): CreativeWorkStatus =>
    creativeDraftStaleFields(row, axes(row)).length === 0 ? "current" : "stale";
  const claimHold = (
    holdId: string,
    kind: CreativeHold["kind"],
    row: { readonly recovery: PortableCreativeRecovery },
    label: string,
  ): void => {
    if (seen.has(holdId))
      throw new CreativeDraftError(
        "integrity",
        `two durable creative rows share incarnation '${holdId.slice(kind.length + 1)}'.`,
      );
    seen.add(holdId);
    const hold = held.get(holdId);
    if (hold === undefined || hold.kind !== kind)
      throw new CreativeDraftError(
        "integrity",
        `creative ${label} hold '${holdId}' is missing or foreign.`,
      );
    held.delete(holdId);
    const wanted = creativeRecoveryBlobHashes(row.recovery);
    const claimed = new Set(wanted);
    if (hold.hashes.length !== wanted.length || !hold.hashes.every((hash) => claimed.has(hash)))
      throw new CreativeDraftError(
        "integrity",
        `creative ${label} hold '${holdId}' does not cover its row's blob inventory.`,
      );
  };
  const drafts = rows.map((row) => {
    claimHold(creativeRecoveryHoldId(row.receipt.incarnation), "recovery", row, "recovery");
    return { workspace: row.workspaceId, status: classify(row), recovery: row.recovery };
  });
  const undoEntries = undos.map((row) => {
    claimHold(creativeUndoHoldId(row.receipt.incarnation), "retained-undo", row, "undo snapshot");
    return { workspace: row.workspaceId, status: classify(row), recovery: row.recovery };
  });
  // Any recovery-kind hold the rows did not claim is an orphan: bytes it
  // pins belong to a row the index lost, which this module cannot carry
  // truthfully — refuse by name rather than drop them.
  const orphan = [...held.values()].find((hold) => hold.kind === "recovery");
  if (orphan !== undefined)
    throw new CreativeDraftError(
      "integrity",
      `creative recovery hold '${orphan.id}' has no indexed workspace row.`,
    );
  const retained = [...held.values()]
    .filter((hold) => hold.kind === "retained-undo")
    .map((hold) => [...hold.hashes]);
  if (drafts.length === 0 && undoEntries.length === 0 && retained.length === 0) return null;
  // The registry is the catalog's own provenance for every referenced hash;
  // a hash a row claims that the registry lacks, or whose descriptor
  // disagrees, refuses rather than archiving an unverifiable claim.
  const registry: Record<BlobHash, RegisteredBlob> = {};
  const referenced = (hash: BlobHash, claimed: RegisteredBlob | undefined, label: string): void => {
    const registered = catalog.blobs[hash];
    if (registered === undefined)
      throw new CreativeDraftError(
        "integrity",
        `${label} references blob '${hash}' the catalog does not register.`,
      );
    if (
      claimed !== undefined &&
      (registered.byteLength !== claimed.byteLength || registered.mime !== claimed.mime)
    )
      throw new CreativeDraftError(
        "integrity",
        `blob '${hash}' does not match its registered descriptor.`,
      );
    registry[hash] = registered;
  };
  for (const draft of [...drafts, ...undoEntries])
    for (const [hash, descriptor] of Object.entries(draft.recovery.blobs))
      referenced(hash, descriptor, `creative work['${draft.workspace}']`);
  for (const inventory of retained)
    for (const hash of inventory) referenced(hash, undefined, "creative work retained");
  const work = readCreativeWork(
    writeCreativeWork({ basis, drafts, undos: undoEntries, retained, blobs: registry }),
  );
  return { work, hashes: Object.keys(work.blobs).sort(compareCodePoints) };
}

/** The publication plan a portable work envelope expands to. */
export interface CreativeWorkPlan {
  readonly drafts: readonly {
    readonly workspaceId: string;
    readonly recovery: PortableCreativeRecovery;
    readonly current: boolean;
  }[];
  /** Retained snapshots in envelope order (grouped per workspace). */
  readonly undos: readonly {
    readonly workspaceId: string;
    readonly recovery: PortableCreativeRecovery;
    readonly current: boolean;
  }[];
  readonly retained: readonly (readonly BlobHash[])[];
  readonly registry: Readonly<Record<BlobHash, RegisteredBlob>>;
  /** Every referenced hash in canonical order. */
  readonly hashes: readonly BlobHash[];
}

/**
 * Expand a validated envelope into its publication plan. Recovery rows and
 * retained snapshots both republish as fresh target-local records — new
 * incarnations, holds and counters are minted at write time; the portable
 * envelope contributes data, never authority.
 */
export function planCreativeWorkPublication(work: PortableCreativeWork): CreativeWorkPlan {
  return {
    drafts: work.drafts.map((entry) => ({
      workspaceId: entry.workspace,
      recovery: entry.recovery,
      current: entry.status === "current",
    })),
    undos: work.undos.map((entry) => ({
      workspaceId: entry.workspace,
      recovery: entry.recovery,
      current: entry.status === "current",
    })),
    retained: work.retained.map((inventory) => [...inventory]),
    registry: work.blobs,
    hashes: Object.keys(work.blobs).sort(compareCodePoints),
  };
}

/**
 * The portable basis is trusted only after it matches the target's own
 * freshly derived identity — the resource revision, authoring fingerprint,
 * profile and kept-set presence are recomputed at publication, never taken
 * from the envelope.
 */
export function checkCreativeWorkBasis(
  basis: CreativeWorkBasis,
  actual: {
    readonly revision: string;
    readonly authoring: string;
    readonly profileId: ProfileId;
    readonly keptSet: boolean;
  },
): void {
  if (
    basis.revision !== actual.revision ||
    basis.authoring !== actual.authoring ||
    basis.profileId !== actual.profileId
  )
    throw new CreativeCatalogError(
      "invalid",
      "The portable creative work was captured against a different project body.",
    );
  if (basis.kept > 0 !== actual.keptSet)
    throw new CreativeCatalogError(
      "invalid",
      basis.kept > 0
        ? "The portable creative work pins kept records the candidate does not carry."
        : "The portable creative work claims no kept set beside a kept catalog.",
    );
}

/**
 * A "current" entry's kept pins must resolve — identically — in the kept
 * catalog being published. Stale drafts and stale snapshots keep their
 * foreign bases verbatim and are never re-pinned.
 */
export function checkCurrentWorkDrafts(
  plan: CreativeWorkPlan,
  catalog: CreativeCatalog | undefined,
): void {
  const keptPool = new Map<string, string>();
  for (const entry of [
    ...(catalog?.sources ?? []),
    ...(catalog?.derivatives ?? []),
    ...(catalog?.board ?? []),
    ...(catalog?.recipes ?? []),
  ])
    keptPool.set(versionRefKey(entry.identity), JSON.stringify(entry));
  for (const [label, entries] of [
    ["draft", plan.drafts],
    ["undo", plan.undos],
  ] as const)
    for (const entry of entries) {
      if (!entry.current) continue;
      for (const pin of entry.recovery.base.pins) {
        const key = versionRefKey(pin);
        const keptRecord = keptPool.get(key);
        if (keptRecord === undefined)
          throw new CreativeCatalogError(
            "invalid",
            `creative work ${label} '${entry.workspaceId}' pins '${key}' which the kept set does not hold.`,
          );
        const carried = [
          ...entry.recovery.sources,
          ...entry.recovery.derivatives,
          ...entry.recovery.board,
          ...entry.recovery.recipes,
        ].find((record) => versionRefKey(record.identity) === key);
        if (JSON.stringify(carried) !== keptRecord)
          throw new CreativeCatalogError(
            "invalid",
            `creative work ${label} '${entry.workspaceId}' pin '${key}' does not match the kept record.`,
          );
      }
    }
}

/**
 * Own and verify a caller-offered blob map against the envelope's declared
 * registry: the key set must match exactly and every byte array must verify
 * against its declared descriptor. Returns detached copies.
 */
export function ownCreativeWorkBlobs(
  work: PortableCreativeWork,
  offered: unknown,
): Record<BlobHash, Uint8Array> {
  if (offered === null || typeof offered !== "object" || Array.isArray(offered))
    throw new CreativeCatalogError("invalid", "Invalid creative work blob set.");
  const blobs = offered as Record<string, unknown>;
  const keys = Object.keys(blobs);
  const declared = Object.keys(work.blobs);
  if (keys.length !== declared.length || declared.some((hash) => !Object.hasOwn(blobs, hash)))
    throw new CreativeCatalogError(
      "invalid",
      "The creative work blob set does not match its envelope's registry.",
    );
  const out: Record<BlobHash, Uint8Array> = {};
  for (const hash of declared) {
    const descriptor = work.blobs[hash]!;
    const bytes = blobs[hash];
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length !== descriptor.byteLength ||
      sha256Hex(bytes) !== hash
    )
      throw new CreativeCatalogError(
        "invalid",
        `creative work blob '${hash}' does not match its envelope descriptor.`,
      );
    out[hash] = new Uint8Array(bytes);
  }
  return out;
}

/** Canonicalize a caller-offered envelope through the strict codec round-trip. */
export function ownCreativeWorkEnvelope(value: unknown): PortableCreativeWork {
  return readCreativeWork(
    writeCreativeWork(structuredClone(value) as Parameters<typeof writeCreativeWork>[0]),
  );
}
