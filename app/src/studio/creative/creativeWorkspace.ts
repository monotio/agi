/**
 * The creative material workspace: one EditableProject's bring-in → prepare →
 * preview → keep orchestration, with no engine, worker, provider or key.
 *
 * Local image intake (decodeCreativeImage produces the intake upstream) stages
 * the exact encoded original and the canonical orientation-applied RGBA
 * raster under one staging lease (creativeStore). Preparation jobs are
 * ordinary workspace state: a picture underlay job pins a manual
 * crop/fit/aspect placement (src/picture/preparation.ts), a view job pins
 * regions, frame order, loop/mirror choices, mask and palette
 * (src/view/preparation.ts). The board is the project's kept reference
 * entries plus this workspace's additions and removals.
 *
 * Publication never writes storage directly: Keep composes the resulting
 * kept set, restages the lease with exactly the recipes being sealed,
 * freezes the EditableProject candidate, seals the intent through
 * prepareCreativeKeep and commits through keepCandidate — body, catalog
 * marker and receipt land in one transaction. A resource-editor session can
 * bind `creativeKeepProvider` so its own Keep seals the same work into the
 * same candidate.
 *
 * Durable recovery uses creativeDrafts save/list/read/discard under this
 * workspace's exact receipt and a live lease; stale rows classify for
 * comparison and discard only — the workspace never rebases them.
 */
import {
  CREATIVE_RECIPE_FORMAT,
  CREATIVE_SOURCE_FORMAT,
  checkSourceDerivations,
  readCreativeSource,
  sameVersionRef,
  versionRefKey,
  type CreativeBoardEntry,
  type CreativeCatalog,
  type CreativeRecipe,
  type CreativeSource,
  type PicturePreparation,
  type Rect,
  type VersionRef,
} from "../../../../src/creative/catalog.ts";
import { checkCompositeSourceBytes } from "../../../../src/creative/composite.ts";
import type {
  CreativeDraftLoop,
  CreativePictureDraft,
  CreativeRecipeDraft,
  CreativeRecoveryData,
  CreativeViewDraft,
} from "../../../../src/creative/recovery.ts";
import { sha256Hex } from "../../../../src/crypto.ts";
import type { ProjectId } from "../../../../src/gameIdentity.ts";
import {
  readProjectRecovery,
  writeProjectRecovery,
  type PortableProjectRecovery,
} from "../../../../src/authoring/projectRecovery.ts";
import type { DraftRecovery } from "../../../../src/authoring/projectDraft.ts";
import {
  PICTURE_UNDERLAY_ALGORITHM,
  derivePicturePlacement,
  preparePictureUnderlay,
  type PictureAspect,
  type PictureFit,
  type PreparedPictureUnderlay,
} from "../../../../src/picture/preparation.ts";
import { PROFILES } from "../../../../src/runtime/profile.ts";
import {
  VIEW_PREPARATION_ALGORITHM,
  prepareView,
  type PreparedView,
  type SourceRaster,
  type ViewPreparationRecipe,
  type ViewRecipeFrame,
  type ViewRecipeLoop,
  type ViewRecipeMask,
} from "../../../../src/view/preparation.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../../src/types.ts";
import { frameFromRegion, gridRegions } from "./frameTools.ts";
import {
  discardCreativeDraft,
  listCreativeDrafts,
  readCreativeDraft,
  saveCreativeDraft,
  type CreativeDraftSummary,
} from "../../project/creativeDrafts.ts";
import {
  discardCreativeUndo,
  listCreativeUndos,
  readCreativeUndo,
  saveCreativeUndo,
  type CreativeUndoSummary,
  type RetainedCreativeUndo,
} from "../../project/creativeUndo.ts";
import { sameDraftReceipt } from "../../project/creativeWorkArchive.ts";
import { CreativeUndoJournal } from "./creativeUndoJournal.ts";
import {
  CreativeStoreError,
  loadCreativeCatalog,
  readCreativeBlob,
  releaseCreativeLease,
  stageCreativeBlobs,
} from "../../project/creativeStore.ts";
import type { CreativeKeepPreparation } from "../../project/creativeWorkspaceKeep.ts";
import type {
  EditableCandidate,
  EditableKeepResult,
  EditableProject,
  EditableSavedIdentity,
} from "../../project/editableProject.ts";
import type { DraftReceipt } from "../../project/projectDrafts.ts";
import type { CreativeImageIntake } from "../../references/creativeImageDecode.ts";

/** One staged source and its in-memory bytes, owned by this workspace. */
export interface WorkspaceSource {
  readonly record: CreativeSource;
  /** Canonical RGBA8 pixels (orientation applied once upstream). */
  readonly pixels: Uint8Array;
  /** The exact encoded original bytes. */
  readonly encoded: Uint8Array;
}

/** Room-side work: an image placed under the 160x168 picture for tracing. */
export interface UnderlayJob {
  readonly draftId: string;
  readonly incarnation: string;
  /** versionRefKey of the source being traced. */
  readonly sourceKey: string;
  /** The picture this underlay guides. */
  resourceId: number;
  /** Crop in oriented source pixels. */
  crop: Rect;
  /** Candidate bounds inside the logical picture. */
  bounds: Rect;
  fit: PictureFit;
  intendedAspect: PictureAspect;
  /** Display-only compositor hint for the editor overlay. */
  opacity: number;
  /** Bumped when the job changes after its recipe was published. */
  revision: number;
}

/** View-side work: frames, loops, mask and palette for one VIEW. */
export interface ViewJob {
  readonly draftId: string;
  readonly incarnation: string;
  /** versionRefKeys of every source the frames read. */
  readonly sourceKeys: readonly string[];
  /** The destination VIEW number; null until the creator chooses. */
  destination: number | null;
  frames: ViewRecipeFrame[];
  loops: ViewRecipeLoop[];
  mask: ViewRecipeMask;
  description: string;
  revision: number;
}

export interface CreativeWorkspaceOptions {
  /** Clock for tests; Date.now by default. */
  readonly now?: (() => number) | undefined;
  /** Save a durable recovery after each staging mutation (default on). */
  readonly autosaveRecovery?: boolean | undefined;
  /** Edits to the same field inside this window share one undo step (default 1000ms). */
  readonly undoCoalesceMs?: number | undefined;
}

/** Where an intake came from — provenance only, never authority. */
interface IntakeOrigin {
  readonly kind?: "import" | "paste" | "generated" | undefined;
  readonly title?: string | undefined;
  readonly attribution?: string | undefined;
}

/**
 * Why a material capture or staged use was refused. Stable strings; the
 * generation host maps them onto its own failure reasons.
 */
type CreativeMaterialRefusal =
  /** The pinned authority moved: saved identity, kept base, draft, version. */
  | "superseded"
  /** The workspace ended before or during the operation. */
  | "closed"
  /** A consulted record or byte is gone; the decision cannot be replayed. */
  | "unavailable"
  /** The capture is foreign, forged or revoked. */
  | "authority"
  /** Durable admission refused the write (a CAS or integrity conflict). */
  | "conflict"
  /** The caller's signal aborted before or during admission. */
  | "cancelled";

/** Every consulted source's exact record, keyed by versionRefKey. */
interface CreativeMaterialConsulted {
  readonly sources: Readonly<Record<string, CreativeSource>>;
}

/**
 * The frozen authority a reviewed request stages against: this lease, the
 * project's saved identity, the kept creative revision, the shared draft
 * revision, the workspace content version and the exact consulted source
 * records. A capture that pins all of these cannot be reconstructed by a
 * caller — only `issueMaterialCapture` mints one.
 */
interface CreativeMaterialContext {
  /** The staging lease identity this capture belongs to. */
  readonly lease: { readonly id: string; readonly owner: string };
  readonly saved: EditableSavedIdentity;
  readonly profileId: string;
  readonly keptRevision: number;
  readonly draftRevision: number;
  readonly versionCount: number;
  readonly consulted: CreativeMaterialConsulted;
}

/**
 * An opaque capability: the object itself is the authority. Holding a
 * reference never grants staging — the workspace admits a use only while
 * the exact capture object is still live and its context still holds.
 */
export interface CreativeMaterialCapture {
  readonly context: CreativeMaterialContext;
}

/** What `issueMaterialCapture` consults: workspace resolvable source keys. */
interface CreativeMaterialCaptureInput {
  readonly keys: readonly string[];
  /** Aborted at issue or later reads as `cancelled`. */
  readonly signal?: AbortSignal | undefined;
}

/** One source record plus its exact bytes for a staged material use. */
interface CreativeMaterialStagedSource {
  readonly record: CreativeSource;
  /** Canonical RGBA8 bytes for `record.normalized.blob`. */
  readonly pixels: Uint8Array;
  /** Exact encoded original bytes for `record.encoded`. */
  readonly encoded: Uint8Array;
}

/** The staged pair/set a reviewed request hands to the workspace. */
export interface CreativeMaterialUse {
  /** Records and bytes to stage atomically under this workspace's lease. */
  readonly sources: readonly CreativeMaterialStagedSource[];
  readonly signal?: AbortSignal | undefined;
}

/** The admitted result, or a typed refusal before anything was written. */
export type CreativeMaterialUseResult =
  | {
      /** The staged sources that joined the pending set (deduplicated). */
      readonly sources: readonly CreativeSource[];
      readonly head: number;
      /**
       * The stage is durably admitted and visible; the recovery autosave
       * that follows it was refused. The work stays recoverable through
       * the lease, and this message names the recoverability gap.
       */
      readonly recoverabilityError: string | null;
    }
  | { readonly refusal: CreativeMaterialRefusal };

/** Carries a typed material refusal through the staging admission callback. */
class MaterialRefusalError extends Error {
  readonly refusal: CreativeMaterialRefusal;
  constructor(refusal: CreativeMaterialRefusal, message: string) {
    super(message);
    this.name = "MaterialRefusalError";
    this.refusal = refusal;
  }
}

function closedError(): Error {
  return new Error("This creative workspace is closed.");
}

function busyError(): Error {
  return new Error(
    "A creative Keep is in progress; wait for it to finish before changing this work.",
  );
}

/**
 * Freeze a small plain record tree so callers who receive it cannot reach
 * into the workspace's staged state. Byte arrays are shared on purpose —
 * canvas reads need them — and are left unfrozen (freezing views throws).
 */
function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    value instanceof Uint8Array ||
    Object.isFrozen(value)
  )
    return value;
  for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  return Object.freeze(value);
}

function sameDraftContent(
  current: string | Uint8Array | null,
  recovered: string | Uint8Array | null,
): boolean {
  if (current === recovered) return true;
  if (
    current === null ||
    recovered === null ||
    typeof current === "string" ||
    typeof recovered === "string"
  )
    return false;
  return sameBytes(current, recovered);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** The recipe draft form of one job, for durable recovery. */
function underlayDraftOf(job: UnderlayJob, source: VersionRef): CreativeRecipeDraft {
  const preparation: CreativePictureDraft = {
    kind: "picture-underlay",
    source,
    crop: { ...job.crop },
    destination: { ...job.bounds },
    fit: job.fit,
    intendedAspect: job.intendedAspect,
    sample: "nearest-centre-v1",
    opacity: job.opacity,
    palette: "ega-weighted-243-v1",
    alpha: { threshold: 128, matte: 0 },
    scope: "art",
  };
  return {
    identity: { id: job.draftId, incarnation: job.incarnation, revision: job.revision },
    sources: [source],
    algorithm: PICTURE_UNDERLAY_ALGORITHM,
    destination: { kind: "picture", resourceId: job.resourceId },
    preparation,
  };
}

function cloneRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function cloneFrame(frame: ViewRecipeFrame): ViewRecipeFrame {
  return {
    ...frame,
    source: { ...frame.source },
    region: cloneRect(frame.region),
    sourceAnchor: { ...frame.sourceAnchor },
  };
}

function cloneLoop(loop: ViewRecipeLoop): ViewRecipeLoop {
  return "frameIds" in loop ? { ...loop, frameIds: [...loop.frameIds] } : { ...loop };
}

function cloneMask(mask: ViewRecipeMask): ViewRecipeMask {
  return {
    alphaThreshold: mask.alphaThreshold,
    key: mask.key === null ? null : { ...mask.key, rgb: [...mask.key.rgb] },
  };
}

/** A detached copy callers can hold without reaching into workspace state. */
function cloneUnderlayJob(job: UnderlayJob): UnderlayJob {
  return { ...job, crop: cloneRect(job.crop), bounds: cloneRect(job.bounds) };
}

/** A detached copy callers can hold without reaching into workspace state. */
function cloneViewJob(job: ViewJob): ViewJob {
  return {
    ...job,
    sourceKeys: [...job.sourceKeys],
    frames: job.frames.map(cloneFrame),
    loops: job.loops.map(cloneLoop),
    mask: cloneMask(job.mask),
  };
}

/**
 * Rebuild the open jobs a carried recovery describes; the first draft of
 * each kind wins. Pure: the result commits only when the caller chooses.
 */
function jobsFromDrafts(drafts: readonly CreativeRecipeDraft[]): {
  underlay: UnderlayJob | null;
  view: ViewJob | null;
} {
  let underlay: UnderlayJob | null = null;
  let view: ViewJob | null = null;
  for (const draft of drafts) {
    const preparation = draft.preparation;
    if (preparation === undefined) continue;
    if (preparation.kind === "picture-underlay" && underlay === null) {
      const source = draft.sources[0];
      if (source === undefined) continue;
      underlay = {
        draftId: draft.identity.id,
        incarnation: draft.identity.incarnation,
        sourceKey: versionRefKey(source),
        resourceId: draft.destination?.resourceId ?? 1,
        crop: { ...(preparation.crop ?? { x: 0, y: 0, width: 1, height: 1 }) },
        bounds: {
          ...(preparation.destination ?? {
            x: 0,
            y: 0,
            width: SCREEN_WIDTH,
            height: SCREEN_HEIGHT,
          }),
        },
        fit: preparation.fit ?? "contain",
        intendedAspect: preparation.intendedAspect ?? "native",
        opacity: preparation.opacity ?? 0.5,
        revision: draft.identity.revision,
      };
    } else if (preparation.kind === "view" && view === null) {
      view = {
        draftId: draft.identity.id,
        incarnation: draft.identity.incarnation,
        sourceKeys: draft.sources.map(versionRefKey),
        destination: draft.destination?.resourceId ?? null,
        frames: (preparation.frames ?? []).map((frame) => ({
          ...frame,
          source: { ...frame.source },
          region: { ...frame.region },
          sourceAnchor: { ...frame.sourceAnchor },
        })),
        loops: (preparation.loops ?? []).map((loop) => ({ ...loop })),
        mask: preparation.mask ?? { alphaThreshold: 128, key: null },
        description: preparation.description ?? "",
        revision: draft.identity.revision,
      };
    }
  }
  return { underlay, view };
}

function viewDraftOf(job: ViewJob, sources: readonly VersionRef[]): CreativeRecipeDraft {
  const preparation: CreativeViewDraft = {
    kind: "view",
    algorithm: VIEW_PREPARATION_ALGORITHM,
    sources,
    palette: "ega-weighted-243-v1",
    mask: {
      alphaThreshold: job.mask.alphaThreshold,
      key: job.mask.key === null ? null : { ...job.mask.key, rgb: [...job.mask.key.rgb] },
    },
    frames: job.frames.map((frame) => ({
      ...frame,
      source: { ...frame.source },
      region: { ...frame.region },
      sourceAnchor: { ...frame.sourceAnchor },
    })),
    loops: job.loops.map((loop): CreativeDraftLoop => {
      if ("frameIds" in loop) return { ...loop, frameIds: [...loop.frameIds] };
      if (loop.explicitlyApproved !== true)
        throw new Error(`Loop ${loop.id} mirrors ${loop.mirrorOf} without approval.`);
      return {
        id: loop.id,
        mirrorOf: loop.mirrorOf,
        explicitlyApproved: true,
        ...(loop.facing !== undefined ? { facing: loop.facing } : {}),
      };
    }),
    ...(job.description !== "" ? { description: job.description } : {}),
  };
  return {
    identity: { id: job.draftId, incarnation: job.incarnation, revision: job.revision },
    sources,
    algorithm: VIEW_PREPARATION_ALGORITHM,
    destination: {
      kind: "view",
      ...(job.destination !== null ? { resourceId: job.destination } : {}),
    },
    preparation,
  };
}

export interface CreativeMaterialWorkspace {
  readonly projectId: ProjectId;
  /** The staging lease this workspace owns; bound to the EditableProject. */
  readonly leaseId: string;
  readonly project: EditableProject;
  /** Resolves once the kept catalog/board has been hydrated at open. */
  readonly ready: Promise<void>;
  /** Pending (staged, unkept) sources this workspace imported. */
  readonly sources: readonly WorkspaceSource[];
  /** The resulting board: kept entries carried plus additions minus removals. */
  readonly board: readonly CreativeBoardEntry[];
  readonly underlay: UnderlayJob | null;
  readonly viewJob: ViewJob | null;
  readonly closed: boolean;
  readonly busy: boolean;
  /**
   * A recovery cleanup failure after an acknowledged Keep: the durable row
   * still carries this workspace's exact receipt, and the next saveRecovery
   * retries its discard. Null once cleanup is confirmed.
   */
  readonly cleanupError: string | null;
  /** Bumped on every state change; Vue subscribes to re-read the getters. */
  readonly version: number;
  subscribe(listener: () => void): () => void;

  /** Stage one decoded intake: exact original + canonical raster, durable. */
  importIntake(intake: CreativeImageIntake, origin?: IntakeOrigin): Promise<CreativeSource>;

  /**
   * Mint the opaque staging authority for one reviewed request: the frozen
   * workspace/lease/saved/kept/draft/version axes plus the exact records
   * behind `keys` (pending, retained or kept). Throws when the workspace
   * is closed or a named key resolves nowhere.
   */
  issueMaterialCapture(input: CreativeMaterialCaptureInput): CreativeMaterialCapture;
  /**
   * Stage a reviewed material set — a generated original, or a provider
   * original plus its derived composite — atomically under this lease.
   * Every composite's declared parents must be consulted or kept records
   * whose exact canonical bytes recompute the staged pixels and the
   * deterministic encoded PNG; the serialized admission callback rechecks
   * the whole pinned context inside the staging transaction. Refusals are
   * typed: nothing was written on any of them.
   */
  stageMaterialUse(
    capture: CreativeMaterialCapture,
    use: CreativeMaterialUse,
  ): Promise<CreativeMaterialUseResult>;

  beginUnderlay(sourceKey: string, resourceId: number): UnderlayJob;
  updateUnderlay(patch: Partial<Omit<UnderlayJob, "draftId" | "incarnation" | "sourceKey">>): void;
  clearUnderlay(): void;
  /** The prepared logical underlay for the Room Studio overlay, or null. */
  underlayPreview(): PreparedPictureUnderlay | null;

  beginViewJob(
    sourceKey: string,
    options?: { columns?: number; rows?: number; regions?: readonly Rect[] },
  ): ViewJob;
  updateViewJob(patch: Partial<Pick<ViewJob, "frames" | "loops" | "mask" | "description">>): void;
  setViewDestination(resourceId: number | null): void;
  clearViewJob(): void;
  /** Prepare the native cels/loops/payload for review; throws on invalid recipe. */
  prepareViewJob(): PreparedView;
  /** Write the prepared payload into `view:N` of the shared draft (CAS-guarded). */
  applyViewToDraft(): string;
  /** The lowest VIEW number not present in the draft, or undefined when full. */
  freeViewNumber(): number | undefined;
  /**
   * What a VIEW destination would write over: an existing draft document
   * and/or a kept recipe that already claims the number.
   */
  viewDestinationInfo(resourceId: number): {
    readonly draftDoc: boolean;
    readonly keptRecipe: boolean;
  };

  /**
   * Resolve a source identity to its record + canonical pixels — pending
   * staged sources from memory, kept ones from the verified blob store.
   */
  sourceRaster(
    identity: VersionRef,
  ): Promise<{ record: CreativeSource; pixels: Uint8Array } | null>;
  /**
   * A job's source key resolved synchronously — pending sources plus kept
   * rasters the open jobs retain. Editors need this without a round trip.
   */
  rasterForSourceKey(
    sourceKey: string,
  ): { readonly record: CreativeSource; readonly pixels: Uint8Array } | null;
  /**
   * Pull a kept catalog source into this workspace's resolvable raster set so
   * a board entry's source can drive a new preparation job after reopen.
   * Returns the record, or null when the source is not kept anywhere.
   */
  adoptSource(identity: VersionRef): Promise<CreativeSource | null>;
  /** A board source's record plus the kept recipes that name it. */
  sourceInfo(
    identity: VersionRef,
  ): Promise<{ record: CreativeSource; recipes: readonly CreativeRecipe[] } | null>;
  addBoardEntry(
    sourceKey: string,
    input: {
      roles: readonly ("style" | "composition" | "character-identity" | "exact-source")[];
      notes?: string;
    },
  ): CreativeBoardEntry;
  removeBoardEntry(identity: VersionRef): void;

  /** Publish the workspace's prepared work through one EditableProject Keep. */
  keep(): Promise<EditableKeepResult>;
  /**
   * Seals this workspace's pending creative work into a session Keep's own
   * candidate: stages what the candidate can admit and returns the prepared
   * intent, or undefined when nothing pending belongs to this Keep.
   */
  creativeKeepProvider(candidate: EditableCandidate): Promise<CreativeKeepPreparation | undefined>;

  /** Persist the current recoverable state (staged work, jobs, board). */
  saveRecovery(): Promise<void>;
  listRecoveries(): Promise<readonly CreativeDraftSummary[]>;
  /** Adopt a listed recovery's staged work, jobs and board into this workspace. */
  restoreRecovery(workspaceId: string): Promise<void>;
  discardRecovery(entry: CreativeDraftSummary): Promise<void>;

  /**
   * The project's retained undo snapshots, newest last. Stale or corrupt
   * entries stay listed for review and receipt-checked discard; only a
   * snapshot still matching the current kept/native base can restore.
   */
  readonly undoHistory: readonly CreativeUndoSummary[];
  /** A durable undo capture or restore failure, or null. */
  readonly undoError: string | null;
  /** A refused capture is waiting for an exact-envelope retry. */
  readonly undoRetryPending: boolean;
  /** The cursor's next step is a snapshot that can actually restore. */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Restore one listed snapshot by id; the displaced state stays undoable. */
  restoreUndoSnapshot(snapshotId: string): Promise<void>;
  /** Re-attempt a refused capture with its exact pre-edit envelope. */
  retryUndoCapture(): Promise<void>;
  /** Remove one retained snapshot by its exact receipt. */
  discardUndoSnapshot(entry: CreativeUndoSummary): Promise<void>;

  /** Save the recovery, then end authority; staged bytes stay under the hold. */
  dispose(): Promise<void>;
}

/**
 * One minted undo step: the immutable pre-edit envelope plus the authority
 * pins it was captured under. `recovery` is detached at mint time, so a
 * retry writes the state the edit replaced, never the current one.
 */
interface PendingUndoCapture {
  readonly seq: number;
  readonly snapshotId: string;
  readonly expected: { readonly generation: number; readonly lifetime: string };
  readonly recovery: CreativeRecoveryData;
}

class CreativeMaterialWorkspaceImpl implements CreativeMaterialWorkspace {
  readonly projectId: ProjectId;
  readonly project: EditableProject;
  readonly leaseId: string;
  private readonly leaseOwner: string;
  private readonly now: () => number;
  private readonly autosaveRecovery: boolean;
  private readonly undoCoalesceMs: number;
  private readonly listeners = new Set<() => void>();
  private sourceList: WorkspaceSource[] = [];
  /**
   * Kept-source rasters an open job still reads. A Keep seals a job's recipe
   * without ending the job — the underlay can keep guiding the drawing — so
   * its source is re-adopted here from the verified catalog bytes.
   */
  private retainedRaster = new Map<string, WorkspaceSource>();
  private keptBoard: CreativeBoardEntry[] = [];
  private keptSources: CreativeSource[] = [];
  private keptRevision = 0;
  private boardAdditions: CreativeBoardEntry[] = [];
  private boardRemovals = new Map<string, VersionRef>();
  private underlayJob: UnderlayJob | null = null;
  private viewJobState: ViewJob | null = null;
  private receipt: DraftReceipt | null = null;
  /**
   * The session cursor over the durable undo rows, plus their last
   * classification. `undoRetryQueue` holds refused captures for exact
   * re-issue; their envelopes are already detached.
   */
  private readonly undoJournal = new CreativeUndoJournal();
  private undoRows: readonly CreativeUndoSummary[] = [];
  private undoErrorValue: Error | null = null;
  private undoRetryQueue: PendingUndoCapture[] = [];
  /**
   * The last failed recovery cleanup: a Keep's durable commit already stood
   * when the owned row's delete was refused, so `receipt` still names that
   * exact row and the next `saveRecovery` retries its discard. Cleared once
   * the row is confirmed gone.
   */
  private recoveryCleanupError: Error | null = null;
  /**
   * Live material captures, by object identity: the reference IS the
   * authority, so a caller can never reconstruct or borrow one — only this
   * set decides whether a staged use may proceed.
   */
  private readonly materialLive = new Set<CreativeMaterialCapture>();
  /**
   * The authoritative context for each live capture, keyed by object
   * identity: the capture's public `context` is frozen inspection data only —
   * a caller replacing or cloning the envelope property can never move the
   * authority this workspace actually consults.
   */
  private readonly materialContext = new WeakMap<
    CreativeMaterialCapture,
    CreativeMaterialContext
  >();
  private isClosed = false;
  private inFlight = false;
  private autosavePending = false;
  /** VIEW numbers kept recipe destinations reserve; part of allocation. */
  private keptViewTargets = new Set<number>();
  private versionCount = 0;
  /** Serializes this workspace's storage mutations. */
  private tail: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(project: EditableProject, options: CreativeWorkspaceOptions) {
    this.project = project;
    this.projectId = project.projectId;
    this.leaseId = `creative-${crypto.randomUUID()}`;
    this.leaseOwner = project.workspaceId;
    this.now = options.now ?? (() => Date.now());
    this.autosaveRecovery = options.autosaveRecovery !== false;
    this.undoCoalesceMs = options.undoCoalesceMs ?? 1000;
    // Hydrate the kept board and the retained snapshot chain so earlier
    // Keeps' entries and undo steps show from the start.
    this.ready = this.refreshKept()
      .then(() => this.refreshUndos())
      .then(() => {
        this.undoJournal.hydrate(this.undoRows.map((row) => row.snapshotId));
        this.changed();
      })
      .catch(() => undefined);
  }

  get sources(): readonly WorkspaceSource[] {
    // A caller must not push into the owned pending set.
    return Object.freeze(this.sourceList.slice());
  }
  get board(): readonly CreativeBoardEntry[] {
    const removed = new Set(this.boardRemovals.keys());
    return [
      ...this.keptBoard.filter((entry) => !removed.has(versionRefKey(entry.identity))),
      ...this.boardAdditions,
    ];
  }
  /** Detached snapshot: mutating it cannot reach the open job. */
  get underlay(): UnderlayJob | null {
    return this.underlayJob === null ? null : cloneUnderlayJob(this.underlayJob);
  }
  /** Detached snapshot: mutating it cannot reach the open job. */
  get viewJob(): ViewJob | null {
    return this.viewJobState === null ? null : cloneViewJob(this.viewJobState);
  }
  get closed(): boolean {
    return this.isClosed;
  }
  get busy(): boolean {
    return this.inFlight;
  }
  get cleanupError(): string | null {
    return this.recoveryCleanupError?.message ?? null;
  }
  get undoHistory(): readonly CreativeUndoSummary[] {
    return this.undoRows;
  }
  get undoError(): string | null {
    return this.undoErrorValue?.message ?? null;
  }
  get undoRetryPending(): boolean {
    return this.undoRetryQueue.length > 0;
  }
  /**
   * The journal's next step is restorable only when its retained row still
   * reads as current and intact against this project's live base.
   */
  get canUndo(): boolean {
    return this.restorable(this.undoJournal.undoTarget());
  }
  get canRedo(): boolean {
    return this.restorable(this.undoJournal.redoTarget());
  }

  private restorable(snapshotId: string | null): boolean {
    if (this.isClosed || snapshotId === null) return false;
    const row = this.undoRows.find((entry) => entry.snapshotId === snapshotId);
    return row !== undefined && row.status === "current" && row.integrity;
  }

  get version(): number {
    return this.versionCount;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private checkOpen(): void {
    if (this.isClosed) throw closedError();
  }

  /**
   * Synchronous mutations refuse while a Keep holds the publication phase:
   * an edit admitted after the intent was sealed would be silently dropped
   * by the pending-set clear that follows the durable receipt. Async intake
   * and restore go through `run` instead — they land after the Keep and
   * stay pending.
   */
  private checkMutable(): void {
    this.checkOpen();
    if (this.inFlight) throw busyError();
  }

  /**
   * The carried draft envelope's pinned base must still equal the project's
   * current saved identity — including a recreated project's fresh digest —
   * or the envelope is stale: comparable and discardable, never rebased.
   */
  private checkRecoveryBase(portable: PortableProjectRecovery): DraftRecovery {
    const { base, recovery } = readProjectRecovery(portable);
    const saved = this.project.savedIdentity();
    const stale: string[] = [];
    if (base.revision !== saved.revision) stale.push("revision");
    if (base.authoring !== saved.authoring) stale.push("authoring");
    if (base.profileId !== this.project.profileId) stale.push("profileId");
    if (stale.length > 0)
      throw new Error("This unsaved work belongs to an older project version. Discard removes it.");
    return recovery;
  }

  /**
   * Validate the carried project-draft envelope and partition its changes by
   * recovered operation group. Pure: no draft or workspace mutation. Throws
   * on a stale base (revision/authoring/profile moved since the capture —
   * including a recreated project) and on a conflicting dirty document:
   * a live unkept edit on a recovered key or on a recovered group's sibling
   * refuses rather than being overwritten or silently rebased. Dirty keys
   * the recovery never touched stay untouched and are not conflicts.
   */
  private draftRestorePlan(
    portable: PortableProjectRecovery | undefined,
  ): readonly (readonly { key: string; content: string | Uint8Array | null }[])[] {
    if (portable === undefined) return [];
    const recovery = this.checkRecoveryBase(portable);
    const changes = new Map(recovery.changes.map((change) => [change.key, change]));
    const grouped = new Set(recovery.groups.flat());
    const snapshot = this.project.draft.capture();
    const conflicts: string[] = [];
    for (const key of this.project.draft.dirtyKeys()) {
      const change = changes.get(key);
      if (change !== undefined) {
        if (!sameDraftContent(snapshot.read(key)?.content ?? null, change.content))
          conflicts.push(key);
      } else if (grouped.has(key)) {
        // A coordinated write's sibling diverged after the capture.
        conflicts.push(key);
      }
    }
    if (conflicts.length > 0)
      throw new Error(
        `Creative recovery conflicts: ${conflicts.sort().join(", ")} ${
          conflicts.length === 1 ? "has" : "have"
        } unkept changes that differ from the recovery; keep or discard them first.`,
      );
    const groupOf = new Map<string, number>();
    recovery.groups.forEach((keys, index) => {
      for (const key of keys) groupOf.set(key, index);
    });
    const sets = new Map<number, { key: string; content: string | Uint8Array | null }[]>();
    const singles: { key: string; content: string | Uint8Array | null }[] = [];
    for (const change of recovery.changes) {
      const index = groupOf.get(change.key);
      if (index === undefined) singles.push({ key: change.key, content: change.content });
      else {
        const set = sets.get(index) ?? [];
        set.push({ key: change.key, content: change.content });
        sets.set(index, set);
      }
    }
    const ordered = [...sets.entries()]
      .sort(([a], [b]) =>
        (recovery.groups[a]?.[0] ?? "") < (recovery.groups[b]?.[0] ?? "") ? -1 : 1,
      )
      .map(([, set]) => Object.freeze(set));
    return [...ordered, ...singles.map((single) => Object.freeze([single]))];
  }

  /**
   * Apply the plan to the shared draft: each recovered operation lands as one
   * atomic proposal so the restored coordinated group stays selectable
   * together. Purely synchronous — nothing can interleave between the
   * conflict check above and these applies.
   */
  private applyDraftPlan(
    plan: readonly (readonly { key: string; content: string | Uint8Array | null }[])[],
  ): void {
    for (const set of plan) {
      const proposal = this.project.draft.propose(
        this.project.draft.capture(),
        "Restore creative recovery",
        set,
      );
      this.project.draft.apply(proposal);
    }
  }

  /** Coalesced durable autosave behind each staging mutation. */
  private autosave(): void {
    if (!this.autosaveRecovery || this.isClosed || this.inFlight || this.autosavePending) return;
    this.autosavePending = true;
    void this.saveRecovery()
      .catch(() => undefined)
      .finally(() => {
        this.autosavePending = false;
      });
  }

  private changed(): void {
    this.versionCount++;
    for (const listener of this.listeners) listener();
  }

  /**
   * A durable/bookkeeping change listeners should re-read (persisted
   * captures, saved recovery rows, refused-operation errors). It does not
   * bump `versionCount`: an operation pinning authority must not see a
   * queued persist or save notification as a content change, while a real
   * document/source/job/board edit always bumps it.
   */
  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private sourceOf(key: string): WorkspaceSource {
    const found =
      this.sourceList.find((entry) => versionRefKey(entry.record.identity) === key) ??
      this.retainedRaster.get(key);
    if (found === undefined) throw new Error(`No staged source '${key}' in this workspace.`);
    return found;
  }

  private rasterOf(key: string): SourceRaster {
    const source = this.sourceOf(key);
    return {
      identity: source.record.identity,
      width: source.record.normalized.width,
      height: source.record.normalized.height,
      rgba: source.pixels,
    };
  }

  /** Serializes storage mutations so racing keep/stage calls never interleave. */
  private run<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * (Re)stage the lease: the whole pending set replaces the previous one.
   * Blob bytes re-upload only when the catalog no longer registers them —
   * after a consumed lease or a GC pass the same bytes restore by hash.
   * `options.admission` runs inside the staging transaction as the last
   * gate before the write commits; `options.signal` refuses at every
   * boundary it is consulted.
   */
  private async stage(
    recipes: readonly CreativeRecipe[] = [],
    extraSources: readonly WorkspaceSource[] = [],
    options?: {
      readonly admission?: ((catalog: CreativeCatalog) => void) | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<{ head: number }> {
    options?.signal?.throwIfAborted();
    const { catalog } = await loadCreativeCatalog(this.projectId);
    options?.signal?.throwIfAborted();
    const sources = [...this.sourceList, ...extraSources];
    const blobs: { hash: string; mime: string; bytes: Uint8Array }[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      for (const ref of [source.record.encoded, source.record.normalized.blob]) {
        if (seen.has(ref.hash) || catalog?.blobs[ref.hash] !== undefined) continue;
        seen.add(ref.hash);
        const bytes = ref.hash === source.record.encoded.hash ? source.encoded : source.pixels;
        blobs.push({ hash: ref.hash, mime: ref.mime, bytes });
      }
    }
    const staged = await stageCreativeBlobs({
      projectId: this.projectId,
      expectedHead: catalog?.head ?? 0,
      lease: { id: this.leaseId, owner: this.leaseOwner, workspace: this.project.workspaceId },
      staged: { sources: sources.map((entry) => entry.record), recipes },
      blobs,
      expectedLifetime: this.project.savedIdentity().lifetime,
      ...(options?.admission !== undefined ? { admission: options.admission } : {}),
    });
    // Admission is the cancellation boundary. Once the transaction commits,
    // report its result so the caller accepts the durably staged records.
    return { head: staged.head };
  }

  async importIntake(intake: CreativeImageIntake, origin?: IntakeOrigin): Promise<CreativeSource> {
    this.checkOpen();
    this.captureUndoStep("import");
    const record = deepFreeze<CreativeSource>({
      format: CREATIVE_SOURCE_FORMAT,
      version: 1,
      identity: {
        id: `source-${crypto.randomUUID()}`,
        incarnation: crypto.randomUUID(),
        revision: 0,
      },
      encoded: { ...intake.encoded },
      availability: "original",
      normalized: { ...intake.normalized, blob: { ...intake.normalized.blob } },
      origin: {
        kind: origin?.kind ?? "import",
        title: origin?.title ?? "Imported image",
        ...(origin?.attribution !== undefined ? { attribution: origin.attribution } : {}),
      },
    });
    const staged: WorkspaceSource = {
      record,
      pixels: new Uint8Array(intake.pixels),
      encoded: new Uint8Array(intake.encodedBytes),
    };
    await this.run(async () => {
      this.sourceList = [...this.sourceList, staged];
      try {
        await this.stage();
      } catch (error) {
        this.sourceList = this.sourceList.filter((entry) => entry !== staged);
        throw error;
      }
      this.checkOpen();
    });
    this.changed();
    if (this.autosaveRecovery) await this.saveRecovery();
    // A close that raced this import must not hand the caller a live source:
    // the staged bytes stay durably recoverable, the intake still refuses.
    this.checkOpen();
    return record;
  }

  /** A consulted source record: pending, retained by an open job, or kept. */
  private materialRecord(key: string): CreativeSource | undefined {
    return (
      this.sourceList.find((entry) => versionRefKey(entry.record.identity) === key)?.record ??
      this.retainedRaster.get(key)?.record ??
      this.keptSources.find((entry) => versionRefKey(entry.identity) === key)
    );
  }

  issueMaterialCapture(input: CreativeMaterialCaptureInput): CreativeMaterialCapture {
    this.checkOpen();
    input.signal?.throwIfAborted();
    const consulted: Record<string, CreativeSource> = {};
    for (const key of input.keys) {
      if (typeof key !== "string" || key === "")
        throw new Error("A material capture needs workspace source keys.");
      if (consulted[key] !== undefined) continue;
      const record = this.materialRecord(key);
      if (record === undefined)
        throw new Error(`No staged or kept source '${key}' in this workspace.`);
      consulted[key] = record;
    }
    const context = deepFreeze<CreativeMaterialContext>({
      lease: { id: this.leaseId, owner: this.leaseOwner },
      saved: { ...this.project.savedIdentity() },
      profileId: this.project.profileId,
      keptRevision: this.keptRevision,
      draftRevision: this.project.draft.capture().revision,
      versionCount: this.versionCount,
      consulted: { sources: consulted },
    });
    // The envelope is frozen: `context` stays the exact issued snapshot for
    // inspection while the authoritative record lives in materialContext —
    // reachable only through this workspace's own registry.
    const capture: CreativeMaterialCapture = Object.freeze({ context });
    this.materialContext.set(capture, context);
    this.materialLive.add(capture);
    return capture;
  }

  /**
   * The synchronous pin check behind every material-use boundary: null
   * means the exact capture is live and every frozen axis still holds —
   * saved identity, profile, kept revision, draft revision, workspace
   * version and each consulted record.
   */
  private materialFailure(
    capture: CreativeMaterialCapture,
    signal: AbortSignal | undefined,
  ): CreativeMaterialRefusal | null {
    if (signal?.aborted === true) return "cancelled";
    if (this.isClosed) return "closed";
    if (!this.materialLive.has(capture)) return "authority";
    // Authority comes from the issuer's registry, never the caller-visible
    // envelope: a real capture object whose `context` was replaced still
    // resolves to the issued pins.
    const context = this.materialContext.get(capture);
    if (context === undefined) return "authority";
    if (context.lease.id !== this.leaseId || context.lease.owner !== this.leaseOwner)
      return "authority";
    const saved = this.project.savedIdentity();
    if (saved.lifetime !== context.saved.lifetime) return "authority";
    if (
      saved.generation !== context.saved.generation ||
      saved.revision !== context.saved.revision ||
      saved.authoring !== context.saved.authoring ||
      this.project.profileId !== context.profileId ||
      this.keptRevision !== context.keptRevision ||
      this.project.draft.capture().revision !== context.draftRevision ||
      this.versionCount !== context.versionCount
    )
      return "superseded";
    for (const [key, record] of Object.entries(context.consulted.sources)) {
      const current = this.materialRecord(key);
      if (current === undefined) return "unavailable";
      if (
        !sameVersionRef(current.identity, record.identity) ||
        JSON.stringify(current) !== JSON.stringify(record)
      )
        return "superseded";
    }
    return null;
  }

  async stageMaterialUse(
    capture: CreativeMaterialCapture,
    use: CreativeMaterialUse,
  ): Promise<CreativeMaterialUseResult> {
    const early = this.materialFailure(capture, use.signal);
    if (early !== null) return { refusal: early };
    return this.run(async (): Promise<CreativeMaterialUseResult> => {
      const failure = this.materialFailure(capture, use.signal);
      if (failure !== null) return { refusal: failure };
      const context = this.materialContext.get(capture);
      if (context === undefined) return { refusal: "authority" };
      try {
        // Canonical records with exact detached bytes, checked before any
        // parent byte is read.
        const staged: WorkspaceSource[] = [];
        for (const offered of use.sources) {
          const record = readCreativeSource(offered.record, "a staged material source");
          const pixels = new Uint8Array(offered.pixels);
          const encoded = new Uint8Array(offered.encoded);
          if (
            pixels.length !== record.normalized.blob.byteLength ||
            sha256Hex(pixels) !== record.normalized.blob.hash ||
            encoded.length !== record.encoded.byteLength ||
            sha256Hex(encoded) !== record.encoded.hash
          )
            throw new MaterialRefusalError(
              "conflict",
              `the staged bytes of '${record.identity.id}' do not match its record.`,
            );
          staged.push({ record, pixels, encoded });
        }
        // The identity pool a composite's parents may resolve against:
        // kept records, the capture's consulted records and the staged set
        // itself — never another lease's staged records.
        const records = new Map<string, CreativeSource>();
        for (const source of this.keptSources) records.set(versionRefKey(source.identity), source);
        for (const source of this.sourceList)
          records.set(versionRefKey(source.record.identity), source.record);
        for (const source of Object.values(context.consulted.sources))
          records.set(versionRefKey(source.identity), source);
        for (const entry of staged) records.set(versionRefKey(entry.record.identity), entry.record);
        // Structural closure first: identity reuse, missing parents, cycles
        // and geometry all refuse by name before any ancestry walk or byte
        // read — a cyclic derivation can never loop the walk below.
        try {
          checkSourceDerivations([...records.values()], "a staged material use");
        } catch (error) {
          throw new MaterialRefusalError(
            "conflict",
            error instanceof Error ? error.message : String(error),
          );
        }
        const held = [...this.sourceList, ...staged];
        const blobBytes = async (hash: string): Promise<Uint8Array> => {
          for (const entry of held) {
            if (entry.record.normalized.blob.hash === hash) return entry.pixels;
            if (entry.record.encoded.hash === hash) return entry.encoded;
          }
          return (await readCreativeBlob(this.projectId, hash)).bytes;
        };
        // Strict transform admission: recompute each declared composite
        // from the carried parents' exact canonical bytes and require byte
        // equality on the canonical raster and the encoded original. The
        // checked pool is the composite's whole transitive ancestry — a
        // nested composite's base is itself revalidated here.
        for (const entry of staged) {
          const derivation = entry.record.derivation;
          if (derivation === undefined) continue;
          const closure = new Map<string, CreativeSource>([
            [versionRefKey(entry.record.identity), entry.record],
          ]);
          const walk: CreativeSource[] = [entry.record];
          while (walk.length > 0) {
            const ancestors = walk.pop()!.derivation;
            if (ancestors === undefined) continue;
            for (const ref of [ancestors.base, ancestors.provider]) {
              const key = versionRefKey(ref);
              if (closure.has(key)) continue;
              const record = records.get(key);
              if (record === undefined)
                throw new MaterialRefusalError(
                  "authority",
                  `the composite '${entry.record.identity.id}' is missing a consulted or kept parent.`,
                );
              closure.set(key, record);
              walk.push(record);
            }
          }
          const all = [...closure.values()];
          const blobMap = new Map<string, Uint8Array>();
          const hashes = new Set<string>();
          for (const source of all) {
            hashes.add(source.normalized.blob.hash);
            if (source.derivation !== undefined) hashes.add(source.encoded.hash);
          }
          for (const hash of hashes)
            if (!blobMap.has(hash)) blobMap.set(hash, await blobBytes(hash));
          try {
            checkCompositeSourceBytes(all, (hash) => blobMap.get(hash), "a staged material use");
          } catch (error) {
            throw new MaterialRefusalError(
              "conflict",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        // Identity reuse: a staged record may repeat an already-pending
        // identity only when it is the very same record.
        const novel: WorkspaceSource[] = [];
        const seen = new Set<string>();
        for (const entry of staged) {
          const key = versionRefKey(entry.record.identity);
          if (seen.has(key)) continue;
          seen.add(key);
          const existing = this.materialRecord(key);
          if (existing !== undefined) {
            if (JSON.stringify(existing) !== JSON.stringify(entry.record))
              throw new MaterialRefusalError(
                "conflict",
                `staged source '${key}' reuses an identity under a different record.`,
              );
            continue;
          }
          novel.push(entry);
        }
        const moved = this.materialFailure(capture, use.signal);
        if (moved !== null) return { refusal: moved };
        const admitted = await this.stage([], novel, {
          admission: (catalog) => {
            const refused = this.materialFailure(capture, use.signal);
            if (refused !== null)
              throw new MaterialRefusalError(
                refused,
                `the material capture is stale (${refused}).`,
              );
            // Inside the transaction: a derivation parent that is a kept
            // record must still be the exact record the semantic check
            // recomputed from — a foreign replace or removal refuses.
            const fresh = new Map(
              catalog.sources.map((entry) => [versionRefKey(entry.identity), entry]),
            );
            for (const entry of staged) {
              const derivation = entry.record.derivation;
              if (derivation === undefined) continue;
              for (const parent of [derivation.base, derivation.provider]) {
                const key = versionRefKey(parent);
                const keptRecord = fresh.get(key);
                if (keptRecord === undefined) continue;
                const consulted = records.get(key);
                if (
                  consulted === undefined ||
                  JSON.stringify(keptRecord) !== JSON.stringify(consulted)
                )
                  throw new MaterialRefusalError(
                    "conflict",
                    `the parent record '${key}' moved before the stage committed.`,
                  );
              }
            }
          },
          signal: use.signal,
        });
        // Only now is the write durable: the novel records join the pending
        // set, ordered after the existing sources — one undo step inverts
        // the whole staged set as a group.
        if (novel.length > 0) {
          this.captureUndoStep("material-use");
          this.sourceList = [...this.sourceList, ...novel];
          this.changed();
        }
        let recoverabilityError: string | null = null;
        if (this.autosaveRecovery) {
          try {
            await this.saveRecoveryNow();
          } catch (error) {
            recoverabilityError = error instanceof Error ? error.message : String(error);
          }
        }
        return {
          sources: novel.map((entry) => entry.record),
          head: admitted.head,
          recoverabilityError,
        };
      } catch (error) {
        if (error instanceof MaterialRefusalError) return { refusal: error.refusal };
        if (use.signal?.aborted === true) return { refusal: "cancelled" };
        if (this.isClosed) return { refusal: "closed" };
        if (error instanceof CreativeStoreError)
          return { refusal: error.reason === "missing" ? "unavailable" : "conflict" };
        return { refusal: "unavailable" };
      }
    });
  }

  beginUnderlay(sourceKey: string, resourceId: number): UnderlayJob {
    this.checkMutable();
    const source = this.sourceOf(sourceKey);
    const { width, height } = source.record.normalized;
    const job: UnderlayJob = {
      draftId: `underlay-${crypto.randomUUID()}`,
      incarnation: crypto.randomUUID(),
      sourceKey,
      resourceId,
      crop: { x: 0, y: 0, width, height },
      bounds: { x: 0, y: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
      fit: "contain",
      intendedAspect: "native",
      opacity: 0.5,
      revision: 0,
    };
    this.captureUndoStep(null);
    this.underlayJob = job;
    this.changed();
    this.autosave();
    return cloneUnderlayJob(job);
  }

  updateUnderlay(patch: Partial<Omit<UnderlayJob, "draftId" | "incarnation" | "sourceKey">>): void {
    this.checkMutable();
    const job = this.underlayJob;
    if (job === null) throw new Error("No underlay job is open.");
    this.captureUndoStep(`underlay:${job.incarnation}`);
    const { crop, bounds, ...rest } = patch;
    Object.assign(job, rest);
    // Caller-held rects copy in; a later caller mutation never moves the job.
    if (crop !== undefined) job.crop = cloneRect(crop);
    if (bounds !== undefined) job.bounds = cloneRect(bounds);
    job.revision++;
    this.changed();
    this.autosave();
  }

  clearUnderlay(): void {
    this.checkMutable();
    if (this.underlayJob !== null) this.captureUndoStep(null);
    this.underlayJob = null;
    this.pruneRetained();
    this.changed();
    this.autosave();
  }

  /** The finalized underlay recipe for the job, or null when incomplete. */
  private underlayRecipe(job: UnderlayJob): CreativeRecipe {
    const source = this.sourceOf(job.sourceKey);
    const { normalized } = source.record;
    const placement = derivePicturePlacement({
      sourceWidth: normalized.width,
      sourceHeight: normalized.height,
      crop: job.crop,
      bounds: job.bounds,
      fit: job.fit,
      intendedAspect: job.intendedAspect,
    });
    const preparation: PicturePreparation = {
      kind: "picture-underlay",
      source: source.record.identity,
      crop: placement.crop,
      destination: placement.destination,
      fit: job.fit,
      intendedAspect: job.intendedAspect,
      sample: "nearest-centre-v1",
      opacity: job.opacity,
      palette: "ega-weighted-243-v1",
      alpha: { threshold: 128, matte: 0 },
      scope: "art",
    };
    return {
      format: CREATIVE_RECIPE_FORMAT,
      version: 1,
      identity: { id: job.draftId, incarnation: job.incarnation, revision: job.revision },
      sources: [source.record.identity],
      algorithm: PICTURE_UNDERLAY_ALGORITHM,
      preparation,
      destination: { kind: "picture", resourceId: job.resourceId },
    };
  }

  underlayPreview(): PreparedPictureUnderlay | null {
    const job = this.underlayJob;
    if (job === null) return null;
    const source =
      this.sourceList.find((entry) => versionRefKey(entry.record.identity) === job.sourceKey) ??
      this.retainedRaster.get(job.sourceKey);
    if (source === undefined) return null;
    try {
      return preparePictureUnderlay(
        {
          identity: source.record.identity,
          width: source.record.normalized.width,
          height: source.record.normalized.height,
          rgba: source.pixels,
        },
        this.underlayRecipe(job),
        source.record.normalized,
      );
    } catch {
      return null;
    }
  }

  beginViewJob(
    sourceKey: string,
    options?: { columns?: number; rows?: number; regions?: readonly Rect[] },
  ): ViewJob {
    this.checkMutable();
    const source = this.sourceOf(sourceKey);
    const { width, height } = source.record.normalized;
    const frameSource = { ...source.record.identity };
    const regions: readonly Rect[] =
      options?.regions !== undefined
        ? options.regions
        : options?.columns !== undefined || options?.rows !== undefined
          ? gridRegions(width, height, options?.columns ?? 1, options?.rows ?? 1)
          : [{ x: 0, y: 0, width, height }];
    if (regions.length === 0)
      throw new Error("The chosen frame regions leave no pixels to prepare.");
    const frames = regions.map((region, index) =>
      frameFromRegion(`f${index}`, frameSource, region),
    );
    const job: ViewJob = {
      draftId: `view-${crypto.randomUUID()}`,
      incarnation: crypto.randomUUID(),
      sourceKeys: [sourceKey],
      destination: null,
      frames,
      loops: [
        {
          id: "l0",
          frameIds: frames.map((frame) => frame.id),
        },
      ],
      mask: { alphaThreshold: 128, key: null },
      description: "",
      revision: 0,
    };
    this.captureUndoStep(null);
    this.viewJobState = job;
    this.changed();
    this.autosave();
    return cloneViewJob(job);
  }

  updateViewJob(patch: Partial<Pick<ViewJob, "frames" | "loops" | "mask" | "description">>): void {
    this.checkMutable();
    const job = this.viewJobState;
    if (job === null) throw new Error("No view job is open.");
    this.captureUndoStep(`view:${job.incarnation}`);
    // Every payload copies in: a caller-held frame/loop/mask object must
    // never reach into the job after this call, or move a captured recipe.
    if (patch.frames !== undefined) job.frames = patch.frames.map(cloneFrame);
    if (patch.loops !== undefined) job.loops = patch.loops.map(cloneLoop);
    if (patch.mask !== undefined) job.mask = cloneMask(patch.mask);
    if (patch.description !== undefined) job.description = patch.description;
    job.revision++;
    this.changed();
    this.autosave();
  }

  setViewDestination(resourceId: number | null): void {
    this.checkMutable();
    const job = this.viewJobState;
    if (job === null) throw new Error("No view job is open.");
    if (
      resourceId !== null &&
      (!Number.isInteger(resourceId) || resourceId < 0 || resourceId > 255)
    )
      throw new Error("A VIEW destination must be an integer 0..255.");
    if (job.destination !== resourceId) {
      this.captureUndoStep(`view:${job.incarnation}`);
      job.destination = resourceId;
      job.revision++;
    }
    this.changed();
    this.autosave();
  }

  clearViewJob(): void {
    this.checkMutable();
    if (this.viewJobState !== null) this.captureUndoStep(null);
    this.viewJobState = null;
    this.pruneRetained();
    this.changed();
    this.autosave();
  }

  private viewRecipeOf(job: ViewJob): ViewPreparationRecipe {
    const sources = job.sourceKeys.map((key) => this.sourceOf(key).record.identity);
    return {
      format: CREATIVE_RECIPE_FORMAT,
      version: 1,
      kind: "view",
      algorithm: VIEW_PREPARATION_ALGORITHM,
      sources,
      palette: "ega-weighted-243-v1",
      mask: {
        alphaThreshold: job.mask.alphaThreshold,
        key: job.mask.key === null ? null : { mode: "ega-index-v1", rgb: [...job.mask.key.rgb] },
      },
      frames: job.frames.map((frame) => ({
        ...frame,
        source: { ...frame.source },
        region: { ...frame.region },
        sourceAnchor: { ...frame.sourceAnchor },
      })),
      loops: job.loops.map((loop) => ({ ...loop })),
      ...(job.description !== "" ? { description: job.description } : {}),
    };
  }

  prepareViewJob(): PreparedView {
    this.checkOpen();
    const job = this.viewJobState;
    if (job === null) throw new Error("No view job is open.");
    const profile = PROFILES[this.project.profileId];
    if (!profile) throw new Error(`Unknown build profile: ${this.project.profileId}.`);
    return prepareView(
      job.sourceKeys.map((key) => this.rasterOf(key)),
      this.viewRecipeOf(job),
      profile,
    );
  }

  /** The finalized recipe for the view job; requires a prepared payload hash. */
  private viewRecipeRecord(job: ViewJob, prepared: PreparedView): CreativeRecipe {
    if (job.destination === null)
      throw new Error("Choose a VIEW destination before keeping this preparation.");
    const sources = job.sourceKeys.map((key) => this.sourceOf(key).record.identity);
    return {
      format: CREATIVE_RECIPE_FORMAT,
      version: 1,
      identity: { id: job.draftId, incarnation: job.incarnation, revision: job.revision },
      sources,
      algorithm: VIEW_PREPARATION_ALGORITHM,
      preparation: this.viewRecipeOf(job),
      destination: { kind: "view", resourceId: job.destination },
      outputPayloadHash: sha256Hex(prepared.payload),
    };
  }

  applyViewToDraft(): string {
    this.checkMutable();
    const job = this.viewJobState;
    if (job === null) throw new Error("No view job is open.");
    this.captureUndoStep(`view:${job.incarnation}`);
    const key = this.writeViewToDraft(job);
    this.autosave();
    return key;
  }

  /**
   * The CAS-guarded draft write behind both the public apply and the Keep:
   * absent `view:N` keys mint the document, identical bytes no-op, and a
   * foreign unkept edit on the destination refuses instead of overwriting.
   */
  private writeViewToDraft(job: ViewJob): string {
    if (job.destination === null) throw new Error("Choose a VIEW destination first.");
    const prepared = this.prepareViewJob();
    const key = `view:${job.destination}`;
    const snapshot = this.project.draft.capture();
    const doc = snapshot.read(key);
    if (
      doc !== undefined &&
      doc.content instanceof Uint8Array &&
      sameBytes(doc.content, prepared.payload)
    )
      return key;
    if (this.project.draft.dirtyKeys().includes(key))
      throw new Error(
        `VIEW ${job.destination} has unkept changes; keep or discard them in the editor first.`,
      );
    this.project.draft.edit(key, prepared.payload, snapshot.version(key));
    return key;
  }

  /**
   * The lowest VIEW number free in the draft AND unclaimed by a kept
   * recipe's byte-only destination — an existing prepared-but-not-applied
   * VIEW stays reserved so a new job cannot squat on it.
   */
  freeViewNumber(): number | undefined {
    const snapshot = this.project.draft.capture();
    const used = new Set(
      snapshot.keys.filter((key) => key.startsWith("view:")).map((key) => Number(key.slice(5))),
    );
    for (const target of this.keptViewTargets) used.add(target);
    for (let n = 0; n <= 255; n++) if (!used.has(n)) return n;
    return undefined;
  }

  viewDestinationInfo(resourceId: number): {
    readonly draftDoc: boolean;
    readonly keptRecipe: boolean;
  } {
    return {
      draftDoc: this.project.draft.capture().read(`view:${resourceId}`) !== undefined,
      keptRecipe: this.keptViewTargets.has(resourceId),
    };
  }

  async sourceRaster(
    identity: VersionRef,
  ): Promise<{ record: CreativeSource; pixels: Uint8Array } | null> {
    const pending = this.sourceList.find(
      (entry) => versionRefKey(entry.record.identity) === versionRefKey(identity),
    );
    if (pending !== undefined) return { record: pending.record, pixels: pending.pixels };
    const { catalog } = await loadCreativeCatalog(this.projectId);
    const record = catalog?.sources.find(
      (entry) => versionRefKey(entry.identity) === versionRefKey(identity),
    );
    if (record === undefined) return null;
    try {
      const blob = await readCreativeBlob(this.projectId, record.normalized.blob.hash);
      return { record, pixels: blob.bytes };
    } catch {
      return null;
    }
  }

  rasterForSourceKey(
    sourceKey: string,
  ): { readonly record: CreativeSource; readonly pixels: Uint8Array } | null {
    const held =
      this.sourceList.find((entry) => versionRefKey(entry.record.identity) === sourceKey) ??
      this.retainedRaster.get(sourceKey);
    return held ?? null;
  }

  async adoptSource(identity: VersionRef): Promise<CreativeSource | null> {
    this.checkOpen();
    const key = versionRefKey(identity);
    const held =
      this.sourceList.find((entry) => versionRefKey(entry.record.identity) === key) ??
      this.retainedRaster.get(key);
    if (held !== undefined) return held.record;
    return this.run(async () => {
      this.checkOpen();
      const { catalog } = await loadCreativeCatalog(this.projectId);
      const record = catalog?.sources.find((entry) => versionRefKey(entry.identity) === key);
      if (record === undefined) return null;
      const raster = await readCreativeBlob(this.projectId, record.normalized.blob.hash);
      const encoded = await readCreativeBlob(this.projectId, record.encoded.hash);
      this.checkOpen();
      this.retainedRaster.set(key, {
        record,
        pixels: raster.bytes,
        encoded: encoded.bytes,
      });
      this.changed();
      return record;
    });
  }

  async sourceInfo(
    identity: VersionRef,
  ): Promise<{ record: CreativeSource; recipes: readonly CreativeRecipe[] } | null> {
    this.checkOpen();
    const key = versionRefKey(identity);
    const pending = this.sourceList.find(
      (entry) => versionRefKey(entry.record.identity) === key,
    )?.record;
    const { catalog } = await loadCreativeCatalog(this.projectId);
    const record =
      pending ?? catalog?.sources.find((entry) => versionRefKey(entry.identity) === key);
    if (record === undefined) return null;
    const recipes = (catalog?.recipes ?? []).filter((recipe) =>
      recipe.sources.some((source) => versionRefKey(source) === key),
    );
    return { record, recipes };
  }

  addBoardEntry(
    sourceKey: string,
    input: {
      roles: readonly ("style" | "composition" | "character-identity" | "exact-source")[];
      notes?: string;
    },
  ): CreativeBoardEntry {
    this.checkMutable();
    const source = this.sourceOf(sourceKey);
    const entry = deepFreeze<CreativeBoardEntry>({
      identity: {
        id: `board-${crypto.randomUUID()}`,
        incarnation: crypto.randomUUID(),
        revision: 0,
      },
      source: { ...source.record.identity },
      roles: [...input.roles],
      approval: "approved",
      notes: input.notes ?? "",
    });
    this.captureUndoStep(`board:add:${versionRefKey(entry.identity)}`);
    this.boardAdditions = [...this.boardAdditions, entry];
    this.changed();
    this.autosave();
    return entry;
  }

  removeBoardEntry(identity: VersionRef): void {
    this.checkMutable();
    const key = versionRefKey(identity);
    const kept = this.keptBoard.some((entry) => versionRefKey(entry.identity) === key);
    this.captureUndoStep(`board:remove:${key}`);
    if (kept) {
      this.boardRemovals.set(key, identity);
    } else {
      this.boardAdditions = this.boardAdditions.filter(
        (entry) => versionRefKey(entry.identity) !== key,
      );
    }
    this.changed();
    this.autosave();
  }

  /**
   * The kept catalog the workspace last saw — refreshed at open, after each
   * stage and after each Keep. Kept board entries feed `board` merges and
   * kept recipe destinations reserve their VIEW numbers for allocation.
   */
  private async refreshKept(): Promise<void> {
    const { catalog } = await loadCreativeCatalog(this.projectId);
    this.keptBoard = [...(catalog?.board ?? [])];
    this.keptSources = [...(catalog?.sources ?? [])];
    this.keptRevision = catalog?.kept ?? 0;
    this.keptViewTargets = new Set(
      (catalog?.recipes ?? [])
        .filter((recipe) => recipe.destination.kind === "view")
        .map((recipe) => recipe.destination.resourceId),
    );
    await this.retainJobSources(catalog);
  }

  /** Kept sources an open job references move to `retainedRaster`. */
  private async retainJobSources(
    catalog: { sources: readonly CreativeSource[] } | null | undefined,
  ): Promise<void> {
    const needed = new Set<string>();
    if (this.underlayJob !== null) needed.add(this.underlayJob.sourceKey);
    for (const key of this.viewJobState?.sourceKeys ?? []) needed.add(key);
    for (const key of needed) {
      if (this.retainedRaster.has(key)) continue;
      if (this.sourceList.some((entry) => versionRefKey(entry.record.identity) === key)) continue;
      const record = catalog?.sources.find((entry) => versionRefKey(entry.identity) === key);
      if (record === undefined) continue;
      try {
        const raster = await readCreativeBlob(this.projectId, record.normalized.blob.hash);
        const encoded = await readCreativeBlob(this.projectId, record.encoded.hash);
        this.retainedRaster.set(key, { record, pixels: raster.bytes, encoded: encoded.bytes });
      } catch {
        /* a missing retained blob leaves the preview empty, never wrong */
      }
    }
  }

  /** Retained rasters no open job references are released back to the catalog. */
  private pruneRetained(): void {
    const needed = new Set<string>();
    if (this.underlayJob !== null) needed.add(this.underlayJob.sourceKey);
    for (const key of this.viewJobState?.sourceKeys ?? []) needed.add(key);
    for (const key of [...this.retainedRaster.keys()])
      if (!needed.has(key)) this.retainedRaster.delete(key);
  }

  /**
   * Compose the declared publication intent for one candidate: the complete
   * resulting kept set, the exact destinations the sealed recipes prepare,
   * and the reviewed dropped identities. `recipes` are the finalized
   * recipes this Keep stages and seals; `state` is the immutable capture the
   * composition was built from — nothing later than it is acknowledged here.
   */
  private async composeIntent(
    recipes: readonly CreativeRecipe[],
    state: {
      sources: readonly WorkspaceSource[];
      board: readonly CreativeBoardEntry[];
      removals: ReadonlyMap<string, VersionRef>;
    },
  ): Promise<CreativeKeepPreparation> {
    const { catalog } = await loadCreativeCatalog(this.projectId);
    const dropped = new Map<string, VersionRef>(state.removals);
    // A re-edited job supersedes only the kept recipe revisions of the jobs
    // this Keep is actually sealing; a pending job never removes kept work.
    const sealed = new Map<string, number>(
      recipes.map((recipe) => [
        `${recipe.identity.id} ${recipe.identity.incarnation}`,
        recipe.identity.revision,
      ]),
    );
    for (const kept of catalog?.recipes ?? []) {
      const revision = sealed.get(`${kept.identity.id} ${kept.identity.incarnation}`);
      if (revision !== undefined && kept.identity.revision < revision)
        dropped.set(versionRefKey(kept.identity), kept.identity);
    }
    const removals = [...dropped.values()];
    const removalKeys = new Set(removals.map(versionRefKey));
    return {
      lease: { id: this.leaseId, owner: this.leaseOwner },
      keep: {
        sources: [
          ...(catalog?.sources ?? [])
            .map((entry) => entry.identity)
            .filter((ref) => !removalKeys.has(versionRefKey(ref))),
          ...state.sources.map((entry) => entry.record.identity),
        ],
        derivatives: (catalog?.derivatives ?? []).map((entry) => entry.identity),
        recipes: [
          ...(catalog?.recipes ?? [])
            .map((entry) => entry.identity)
            .filter((ref) => !removalKeys.has(versionRefKey(ref))),
          ...recipes.map((recipe) => recipe.identity),
        ],
        board: state.board,
      },
      destinations: recipes.map((recipe) => recipe.destination),
      ...(removals.length > 0 ? { reviewedCreativeRemovals: removals } : {}),
    };
  }

  async keep(): Promise<EditableKeepResult> {
    this.checkOpen();
    if (this.inFlight) throw busyError();
    return this.run(async () => {
      this.checkOpen();
      // From here every synchronous mutation refuses (checkMutable), so the
      // captured jobs/board/sources are exactly what this Keep seals; async
      // intake/restore queue behind `run` and land after the clear.
      this.inFlight = true;
      try {
        // The pre-Keep state is its own undo step, durable before the commit
        // proceeds: a refused capture aborts the Keep and retains the work.
        await this.captureUndoNow("keep");
        const recipes: CreativeRecipe[] = [];
        const selectedKeys: string[] = [];
        // Immutable capture of exactly what this Keep acknowledges; sealed
        // recipes derive from the same captured jobs.
        const state = {
          sources: [...this.sourceList],
          board: [...this.board],
          removals: new Map(this.boardRemovals),
        };
        const underlay = this.underlayJob;
        if (underlay !== null) {
          // The destination must exist in the candidate image.
          const key = `picture:${underlay.resourceId}`;
          if (this.project.draft.capture().read(key) === undefined)
            throw new Error(`The underlay's destination ${key} does not exist in this project.`);
          recipes.push(this.underlayRecipe(underlay));
        }
        const viewJob = this.viewJobState;
        if (viewJob !== null && viewJob.destination !== null) {
          const prepared = this.prepareViewJob();
          recipes.push(this.viewRecipeRecord(viewJob, prepared));
          selectedKeys.push(this.writeViewToDraft(viewJob));
        }
        const hasWork =
          this.sourceList.length > 0 ||
          recipes.length > 0 ||
          this.boardAdditions.length > 0 ||
          this.boardRemovals.size > 0;
        if (!hasWork) throw new Error("There is no creative work to keep.");
        await this.stage(recipes);
        this.checkOpen();
        const candidate = this.project.buildSelected(selectedKeys);
        const preparation = await this.composeIntent(recipes, state);
        const creative = await this.project.prepareCreativeKeep(candidate, preparation);
        const result = await this.project.keepCandidate(candidate, { creative });
        // The lease is consumed and every sealed record is kept now: the
        // pending set clears, kept board entries merge, the open jobs'
        // kept sources re-adopt as retained rasters, and the owned
        // recovery row is released by its exact receipt.
        this.sourceList = [];
        this.boardAdditions = [];
        this.boardRemovals.clear();
        if (viewJob !== null && this.viewJobState === viewJob && viewJob.destination !== null)
          this.viewJobState = null;
        await this.refreshKept();
        // The commit moved the kept base: retained snapshots classify stale
        // on the next read, so the undo controls re-read them now.
        await this.refreshUndos();
        this.changed();
        // Work newer than the sealed capture can exist: an editor session may
        // have drafted document changes during the Keep's awaits, and an open
        // underlay job stays pending by design. The carried row's base moved
        // with this Keep and cannot be rebased — release it by exact receipt
        // first, then write a fresh recovery against the new base.
        const stillPending =
          this.underlayJob !== null ||
          this.viewJobState !== null ||
          this.sourceList.length > 0 ||
          this.boardAdditions.length > 0 ||
          this.boardRemovals.size > 0 ||
          this.project.draft.dirtyKeys().length > 0;
        let cleanupFailed = false;
        if (this.receipt !== null) {
          try {
            await discardCreativeDraft(
              this.projectId,
              this.project.workspaceId,
              this.receipt,
              this.project.savedIdentity().lifetime,
            );
            // The held authority retires only once the durable delete is
            // confirmed; a failed cleanup keeps the exact receipt so the
            // next saveRecovery retries the same owned row instead of
            // stranding it.
            this.receipt = null;
            this.recoveryCleanupError = null;
          } catch (error) {
            cleanupFailed = true;
            this.recoveryCleanupError = error instanceof Error ? error : new Error(String(error));
            this.changed();
          }
        }
        // The durable Keep already succeeded; a recovery rewrite is
        // best-effort and retried by the next autosave. A refused cleanup
        // waits for that retry rather than hammering the same storage row.
        if (stillPending && this.autosaveRecovery && !cleanupFailed)
          await this.saveRecoveryNow().catch(() => undefined);
        return result;
      } finally {
        this.inFlight = false;
      }
    });
  }

  readonly creativeKeepProvider = async (
    candidate: EditableCandidate,
  ): Promise<CreativeKeepPreparation | undefined> => {
    if (this.isClosed) return undefined;
    // Serialized with the workspace's own Keep/stage/recovery ops: the
    // capture the intent is composed from cannot be torn down mid-read, and
    // a concurrent workspace Keep composes against post-commit state.
    return this.run(async () => {
      this.checkOpen();
      this.inFlight = true;
      try {
        const documents = candidate.documents();
        const selected = new Set(candidate.keys);
        const state = {
          sources: [...this.sourceList],
          board: [...this.board],
          removals: new Map(this.boardRemovals),
        };
        const recipes: CreativeRecipe[] = [];
        const underlay = this.underlayJob;
        if (underlay !== null && documents[`picture:${underlay.resourceId}`] !== undefined) {
          recipes.push(this.underlayRecipe(underlay));
        }
        const viewJob = this.viewJobState;
        if (viewJob !== null && viewJob.destination !== null) {
          const key = `view:${viewJob.destination}`;
          if (selected.has(key)) {
            const prepared = this.prepareViewJob();
            const recipe = this.viewRecipeRecord(viewJob, prepared);
            // Seal only when this candidate's VIEW bytes are the reviewed
            // prepared payload; an edit made after preparing leaves the job
            // pending rather than blocking the drawing Keep.
            const doc = candidate.documents()[key];
            if (doc instanceof Uint8Array && sha256Hex(doc) === recipe.outputPayloadHash)
              recipes.push(recipe);
          }
        }
        const pending =
          state.sources.length > 0 ||
          recipes.length > 0 ||
          this.boardAdditions.length > 0 ||
          state.removals.size > 0;
        if (!pending) return undefined;
        await this.stage(recipes);
        this.checkOpen();
        return this.composeIntent(recipes, state);
      } finally {
        this.inFlight = false;
      }
    });
  };

  /**
   * The recovery envelope for the workspace's current state. `sources` are
   * the pending staged records plus copies of the kept source records the
   * open jobs still read; `pins` names those kept identities plus the kept
   * board entries the board is carrying.
   */
  private recoveryData(
    saved: ReturnType<EditableProject["savedIdentity"]>,
    kept: number,
    keptCatalog: { sources: readonly CreativeSource[]; board: readonly CreativeBoardEntry[] },
  ): CreativeRecoveryData {
    const drafts: CreativeRecipeDraft[] = [];
    if (this.underlayJob !== null) {
      const source = this.sourceOf(this.underlayJob.sourceKey);
      drafts.push(underlayDraftOf(this.underlayJob, source.record.identity));
    }
    if (this.viewJobState !== null) {
      const sources = this.viewJobState.sourceKeys.map((key) => this.sourceOf(key).record.identity);
      drafts.push(viewDraftOf(this.viewJobState, sources));
    }
    const pendingKeys = new Set(
      this.sourceList.map((entry) => versionRefKey(entry.record.identity)),
    );
    const board = this.board;
    const needed = new Set<string>();
    if (this.underlayJob !== null) needed.add(this.underlayJob.sourceKey);
    for (const key of this.viewJobState?.sourceKeys ?? []) needed.add(key);
    // A board entry's source must be carried with the entry.
    for (const entry of board) needed.add(versionRefKey(entry.source));
    // A composite's full ancestry travels with it: parents needed only by
    // a carried composite are carried too, transitively.
    const carried = new Map<string, CreativeSource>();
    for (const entry of this.sourceList)
      carried.set(versionRefKey(entry.record.identity), entry.record);
    for (const record of keptCatalog.sources) carried.set(versionRefKey(record.identity), record);
    const queue = [...needed];
    for (const entry of this.sourceList) {
      const derivation = entry.record.derivation;
      if (derivation === undefined) continue;
      for (const parent of [derivation.base, derivation.provider]) {
        const key = versionRefKey(parent);
        if (!needed.has(key)) {
          needed.add(key);
          queue.push(key);
        }
      }
    }
    while (queue.length > 0) {
      const derivation = carried.get(queue.pop()!)?.derivation;
      if (derivation === undefined) continue;
      for (const parent of [derivation.base, derivation.provider]) {
        const key = versionRefKey(parent);
        if (!needed.has(key)) {
          needed.add(key);
          queue.push(key);
        }
      }
    }
    const carriedSources = keptCatalog.sources.filter(
      (record) =>
        needed.has(versionRefKey(record.identity)) &&
        !pendingKeys.has(versionRefKey(record.identity)),
    );
    const keptKeys = new Set(keptCatalog.board.map((entry) => versionRefKey(entry.identity)));
    const pins: VersionRef[] = [
      ...carriedSources.map((record) => record.identity),
      ...board
        .filter((entry) => keptKeys.has(versionRefKey(entry.identity)))
        .map((entry) => entry.identity),
    ];
    const dirty = this.project.draft.dirtyKeys();
    return {
      base: {
        revision: saved.revision,
        authoring: saved.authoring,
        profileId: this.project.profileId,
        kept,
        pins,
      },
      sources: [...this.sourceList.map((entry) => entry.record), ...carriedSources],
      derivatives: [],
      board,
      recipes: [],
      drafts,
      ...(dirty.length > 0
        ? {
            projectDraft: writeProjectRecovery(
              {
                revision: saved.revision,
                authoring: saved.authoring,
                profileId: this.project.profileId,
              },
              this.project.draft.captureRecovery(),
            ),
          }
        : {}),
    };
  }

  async saveRecovery(): Promise<void> {
    this.checkOpen();
    await this.run(() => this.saveRecoveryNow());
    this.notify();
  }

  /** The save body; callable inside an already-serialized `run`. */
  private async saveRecoveryNow(): Promise<void> {
    this.checkOpen();
    const nothingPending =
      this.sourceList.length === 0 &&
      this.underlayJob === null &&
      this.viewJobState === null &&
      this.boardAdditions.length === 0 &&
      this.boardRemovals.size === 0 &&
      this.project.draft.dirtyKeys().length === 0;
    if (nothingPending && this.receipt === null) return;
    if (this.receipt !== null) {
      // The held receipt may name a row a Keep's cleanup could not retire:
      // its base moved with that commit, so it is stale and cannot be
      // overwritten in place. Retire the exact owned row first, then the
      // save below captures a fresh recovery against the current base.
      const stored = await readCreativeDraft(this.projectId, this.project.workspaceId);
      if (stored === null) {
        // Already gone — the held authority is dead either way.
        this.receipt = null;
      } else if (!sameDraftReceipt(stored.receipt, this.receipt)) {
        // A foreign newer row owns this slot; never discard or overwrite it.
        throw new Error("This creative recovery changed; read the latest before saving again.");
      } else if (stored.status !== "current") {
        await discardCreativeDraft(
          this.projectId,
          this.project.workspaceId,
          this.receipt,
          this.project.savedIdentity().lifetime,
        );
        // Retire the authority only once the durable delete is confirmed.
        this.receipt = null;
        this.recoveryCleanupError = null;
      }
      // A current row under our own receipt is CAS-replaced by the save.
    }
    // A live lease authorizes the save; re-stage if the last Keep consumed it.
    await this.stage();
    const { catalog } = await loadCreativeCatalog(this.projectId);
    const saved = this.project.savedIdentity();
    const result = await saveCreativeDraft({
      projectId: this.projectId,
      workspaceId: this.project.workspaceId,
      expectedReceipt: this.receipt,
      expected: { generation: saved.generation, lifetime: saved.lifetime },
      authority: {
        kind: "lease",
        lease: { id: this.leaseId, owner: this.leaseOwner, workspace: this.project.workspaceId },
      },
      recovery: this.recoveryData(saved, catalog?.kept ?? 0, {
        sources: catalog?.sources ?? [],
        board: catalog?.board ?? [],
      }),
    });
    this.receipt = result.receipt;
  }

  async listRecoveries(): Promise<readonly CreativeDraftSummary[]> {
    this.checkOpen();
    return listCreativeDrafts(this.projectId);
  }

  async restoreRecovery(workspaceId: string): Promise<void> {
    this.checkOpen();
    this.captureUndoStep("recovery");
    await this.run(async () => {
      this.checkOpen();
      const entry = await readCreativeDraft(this.projectId, workspaceId);
      if (entry === null) throw new Error("That creative recovery is gone.");
      if (entry.status !== "current" || !entry.integrity)
        throw new Error(
          "This unsaved work belongs to an older project version. Discard removes it.",
        );
      const recovery = entry.recovery;
      // Fail fast: a stale/conflicting draft envelope refuses before any
      // source byte is read or workspace state is touched.
      this.draftRestorePlan(recovery.projectDraft);
      const { catalog } = await loadCreativeCatalog(this.projectId);
      const keptKeys = new Set(
        [
          ...(catalog?.sources ?? []),
          ...(catalog?.derivatives ?? []),
          ...(catalog?.recipes ?? []),
          ...(catalog?.board ?? []),
        ].map((record) => versionRefKey(record.identity)),
      );
      // Re-adopt every carried source (pending or kept) so open jobs resolve:
      // verified against the catalog descriptors by readCreativeBlob. The
      // collected set commits only after the draft recheck below.
      const adopted: WorkspaceSource[] = [];
      const held = new Set(this.sourceList.map((held2) => versionRefKey(held2.record.identity)));
      for (const source of recovery.sources) {
        if (held.has(versionRefKey(source.identity))) continue;
        const encoded = await readCreativeBlob(this.projectId, source.encoded.hash);
        const raster = await readCreativeBlob(this.projectId, source.normalized.blob.hash);
        held.add(versionRefKey(source.identity));
        adopted.push({ record: source, pixels: raster.bytes, encoded: encoded.bytes });
      }
      // Kept board entries already live in the catalog; recovered workspace
      // entries that were never kept return as additions.
      const boardAdds: CreativeBoardEntry[] = [];
      for (const boardEntry of recovery.board) {
        const key = versionRefKey(boardEntry.identity);
        if (keptKeys.has(key)) continue;
        if (
          this.boardAdditions.some((added) => versionRefKey(added.identity) === key) ||
          boardAdds.some((added) => versionRefKey(added.identity) === key)
        )
          continue;
        boardAdds.push(deepFreeze({ ...boardEntry }));
      }
      // Merge semantics: recovered jobs apply only onto empty slots; a job
      // already open here keeps its state and the recovered one is ignored.
      const jobs = jobsFromDrafts(recovery.drafts);
      const underlay = this.underlayJob === null ? jobs.underlay : null;
      const view = this.viewJobState === null ? jobs.view : null;
      // Stage the adopted bytes under this lease before they are needed;
      // nothing user-visible commits yet if the draft recheck refuses.
      await this.stage([], adopted);
      await this.refreshKept();
      // Everything below is synchronous, so nothing can interleave: a
      // foreign draft edit or a job/source/board mutation landing during
      // the awaits above is caught by these rechecks before either side
      // mutates.
      if (
        (underlay !== null && this.underlayJob !== null) ||
        (view !== null && this.viewJobState !== null)
      )
        throw new Error(
          "Creative recovery conflicts: a preparation job began while the recovery was being read; clear it or restore first.",
        );
      const plan = this.draftRestorePlan(recovery.projectDraft);
      this.applyDraftPlan(plan);
      const heldSources = new Set(
        this.sourceList.map((held2) => versionRefKey(held2.record.identity)),
      );
      this.sourceList = [
        ...this.sourceList,
        ...adopted.filter(
          (adoptedSource) => !heldSources.has(versionRefKey(adoptedSource.record.identity)),
        ),
      ];
      const heldBoard = new Set(this.boardAdditions.map((added) => versionRefKey(added.identity)));
      this.boardAdditions = [
        ...this.boardAdditions,
        ...boardAdds.filter((added) => !heldBoard.has(versionRefKey(added.identity))),
      ];
      if (underlay !== null) this.underlayJob = underlay;
      if (view !== null) this.viewJobState = view;
      // Adopting this workspace's own row means its receipt becomes the base
      // for the next autosave; another workspace's row never moves ours.
      if (workspaceId === this.project.workspaceId) this.receipt = entry.receipt;
      this.changed();
    });
    if (this.autosaveRecovery) await this.saveRecovery();
  }

  async discardRecovery(entry: CreativeDraftSummary): Promise<void> {
    this.checkOpen();
    await discardCreativeDraft(
      this.projectId,
      entry.workspaceId,
      entry.receipt,
      this.project.savedIdentity().lifetime,
    );
    if (entry.workspaceId === this.project.workspaceId) {
      this.receipt = null;
      this.recoveryCleanupError = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Durable undo: immutable pre-edit captures plus validated replacement. */
  /* ------------------------------------------------------------------ */

  private async refreshUndos(): Promise<void> {
    this.undoRows = await listCreativeUndos(this.projectId);
  }

  /**
   * The immutable pre-edit envelope, minted synchronously. `recoveryData`
   * detaches everything it reads, so a later retry writes the state the
   * edit replaced, never the current one, and the edit itself never waits
   * on storage — pending field buffers and focus are untouched.
   */
  private mintUndoCapture(seq: number): PendingUndoCapture {
    const saved = this.project.savedIdentity();
    return {
      seq,
      snapshotId: crypto.randomUUID(),
      expected: { generation: saved.generation, lifetime: saved.lifetime },
      recovery: this.recoveryData(saved, this.keptRevision, {
        sources: this.keptSources,
        board: this.keptBoard,
      }),
    };
  }

  /**
   * Persist one minted capture under this workspace's live lease; the row's
   * retained hold derives from the fresh receipt it is written under. A
   * refusal leaves `cap` in the retry queue unchanged. Callable only inside
   * `run`.
   */
  private async persistUndoCapture(cap: PendingUndoCapture): Promise<void> {
    await this.stage();
    await saveCreativeUndo({
      projectId: this.projectId,
      workspaceId: this.project.workspaceId,
      snapshotId: cap.snapshotId,
      expected: cap.expected,
      authority: {
        kind: "lease",
        lease: { id: this.leaseId, owner: this.leaseOwner, workspace: this.project.workspaceId },
      },
      recovery: cap.recovery,
      now: this.now,
    });
    this.undoRetryQueue = this.undoRetryQueue.filter((entry) => entry.seq !== cap.seq);
    this.undoErrorValue = null;
    await this.refreshUndos();
  }

  private noteUndoError(error: unknown): void {
    this.undoErrorValue = error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Hook for synchronous mutations: mints the pre-edit envelope before the
   * edit lands and queues its durable write on the serialized tail — ahead
   * of any later queued mutation — while the edit itself stays synchronous.
   * A refused write leaves the work untouched and exposes Retry.
   */
  private captureUndoStep(key: string | null): void {
    const decision = this.undoJournal.step(key, this.now(), this.undoCoalesceMs);
    if (decision.kind !== "capture") return;
    let cap: PendingUndoCapture;
    try {
      cap = this.mintUndoCapture(decision.seq);
    } catch (error) {
      this.undoJournal.failed(decision.seq);
      this.noteUndoError(error);
      return;
    }
    void this.run(async () => {
      try {
        await this.persistUndoCapture(cap);
        this.undoJournal.persisted(cap.seq, cap.snapshotId);
      } catch (error) {
        this.undoJournal.failed(cap.seq);
        this.undoRetryQueue.push(cap);
        this.undoRetryQueue.sort((a, b) => a.seq - b.seq);
        this.noteUndoError(error);
      }
      this.notify();
    });
  }

  /**
   * The awaited variant for transitions that must hold a durable pre-state
   * before proceeding — a Keep, or the state an undo/redo displaces. A
   * refused write joins the retry queue for the controls to surface, then
   * refuses the transition.
   */
  private async captureUndoNow(key: string | null): Promise<void> {
    const decision = this.undoJournal.step(key, this.now(), this.undoCoalesceMs);
    if (decision.kind !== "capture") return;
    let cap: PendingUndoCapture;
    try {
      cap = this.mintUndoCapture(decision.seq);
    } catch (error) {
      this.undoJournal.failed(decision.seq);
      this.noteUndoError(error);
      throw error;
    }
    try {
      await this.persistUndoCapture(cap);
    } catch (error) {
      this.undoJournal.failed(cap.seq);
      this.undoRetryQueue.push(cap);
      this.undoRetryQueue.sort((a, b) => a.seq - b.seq);
      this.noteUndoError(error);
      throw error;
    }
    this.undoJournal.persisted(cap.seq, cap.snapshotId);
  }

  /**
   * The durable identity the live preparation already equals, or a fresh
   * displaced-state capture persisted inline. Callable only inside `run`.
   */
  private async retainLiveState(): Promise<string> {
    const live = this.undoJournal.liveId;
    if (live !== null) return live;
    const cap = this.mintUndoCapture(this.undoJournal.mint());
    await this.persistUndoCapture(cap);
    this.undoJournal.settled(cap.seq);
    return cap.snapshotId;
  }

  /**
   * The same grouped plan as `draftRestorePlan` plus one trailing revert
   * set: dirty documents the snapshot does not carry return to their kept
   * content so the draft equals the captured state exactly. No conflict
   * check on foreign dirty keys — they are preserved inside the displaced
   * snapshot the caller persisted first.
   */
  private draftReplacePlan(
    portable: PortableProjectRecovery | undefined,
  ): readonly (readonly { key: string; content: string | Uint8Array | null }[])[] {
    const desired = new Map<string, string | Uint8Array | null>();
    let groups: readonly (readonly string[])[] = [];
    if (portable !== undefined) {
      const recovery = this.checkRecoveryBase(portable);
      for (const change of recovery.changes) desired.set(change.key, change.content);
      groups = recovery.groups;
    }
    const sets: { key: string; content: string | Uint8Array | null }[][] = [];
    const grouped = new Set<string>();
    for (const keys of groups) {
      const set = keys
        .filter((key) => desired.has(key))
        .map((key) => ({ key, content: desired.get(key)! }));
      for (const entry of set) grouped.add(entry.key);
      if (set.length > 0) sets.push(set);
    }
    for (const [key, content] of desired) if (!grouped.has(key)) sets.push([{ key, content }]);
    const keptDocuments = this.project.draft.select([]).documents();
    const reverts = this.project.draft
      .dirtyKeys()
      .filter((key) => !desired.has(key))
      .map((key) => ({ key, content: keptDocuments[key] ?? null }));
    if (reverts.length > 0) sets.push(reverts);
    return sets.map((set) => Object.freeze(set));
  }

  /**
   * The retained row's cheap restorability gate, shared by the pre-retain
   * check and the full restore: exists, intact and current against the
   * live base. Bytes are still verified downstream per blob.
   */
  private async loadRestorableUndo(snapshotId: string): Promise<RetainedCreativeUndo> {
    const entry = await readCreativeUndo(this.projectId, snapshotId);
    if (entry === null) throw new Error("That creative snapshot is gone.");
    if (!entry.integrity)
      throw new Error(
        "That creative snapshot's retained records are incomplete; it can only be compared or discarded.",
      );
    if (entry.status !== "current")
      throw new Error(
        `That creative snapshot is stale: the project's ${entry.staleFields.join(", ")} moved since it was captured. It can only be compared or discarded.`,
      );
    return entry;
  }

  /**
   * The validated replacement behind undo, redo and explicit jumps. Read
   * the retained row, verify every carried byte by hash, rebuild the
   * complete desired state, then revalidate what could have moved during
   * the awaits — the row's status and exact receipt, the project's
   * generation/lifetime and kept revision, and the shared draft's revision —
   * before the synchronous swap, so a refusal never leaves a partial
   * mutation. Never rewinds runtime state and never rewrites the row's
   * generation to disguise staleness.
   */
  private async replaceWithUndoSnapshot(
    snapshotId: string,
    base: {
      readonly saved: EditableSavedIdentity;
      readonly keptRevision: number;
      readonly draftRevision: number;
      readonly versionCount: number;
    },
  ): Promise<void> {
    const entry = await this.loadRestorableUndo(snapshotId);
    const recovery = entry.recovery;
    // Fail fast on a stale draft envelope before any byte is read.
    const plan = this.draftReplacePlan(recovery.projectDraft);
    // Rebuild the carried sources: pending ones return as staged sources,
    // kept pins the open jobs read return as retained rasters.
    // readCreativeBlob verifies the bytes against their stored hash, so a
    // missing or tampered record refuses before anything mutates.
    const pinned = new Set(recovery.base.pins.map(versionRefKey));
    const needed = new Set(recovery.drafts.flatMap((draft) => draft.sources.map(versionRefKey)));
    const pending: WorkspaceSource[] = [];
    const retained = new Map<string, WorkspaceSource>();
    for (const source of recovery.sources) {
      const key = versionRefKey(source.identity);
      if (pinned.has(key) && !needed.has(key)) continue;
      const encoded = await readCreativeBlob(this.projectId, source.encoded.hash);
      const raster = await readCreativeBlob(this.projectId, source.normalized.blob.hash);
      const held: WorkspaceSource = {
        record: source,
        pixels: raster.bytes,
        encoded: encoded.bytes,
      };
      if (pinned.has(key)) retained.set(key, held);
      else pending.push(held);
    }
    const boardKeys = new Set(
      recovery.board.map((boardEntry) => versionRefKey(boardEntry.identity)),
    );
    const keptKeys = new Set(
      this.keptBoard.map((boardEntry) => versionRefKey(boardEntry.identity)),
    );
    const additions = recovery.board
      .filter((boardEntry) => !keptKeys.has(versionRefKey(boardEntry.identity)))
      .map((boardEntry) => deepFreeze({ ...boardEntry }));
    const removals = new Map<string, VersionRef>(
      this.keptBoard
        .filter((boardEntry) => !boardKeys.has(versionRefKey(boardEntry.identity)))
        .map((boardEntry) => [versionRefKey(boardEntry.identity), boardEntry.identity]),
    );
    const jobs = jobsFromDrafts(recovery.drafts);
    // Stage the returning pending bytes under this lease before the commit;
    // a refused stage leaves live state intact.
    await this.stage([], pending);
    const { catalog } = await loadCreativeCatalog(this.projectId);
    if ((catalog?.kept ?? 0) !== recovery.base.kept)
      throw new Error(
        "That creative snapshot's kept base moved while it was being read; refresh the history before restoring.",
      );
    const current = this.project.savedIdentity();
    if (
      current.generation !== entry.expected.generation ||
      current.lifetime !== entry.expected.lifetime
    )
      throw new Error(
        "The project changed while the snapshot was being read; refresh before restoring.",
      );
    const again = await this.loadRestorableUndo(snapshotId);
    if (!sameDraftReceipt(again.receipt, entry.receipt))
      throw new Error(
        "That creative snapshot changed while it was being read; review the latest before restoring.",
      );
    // The last await passed: everything the operation pinned before its
    // first await must still hold, or an external edit landed mid-read and
    // the restore refuses without a partial mutation.
    this.assertOperationBase(base);
    this.sourceList = pending;
    this.retainedRaster = retained;
    this.boardAdditions = additions;
    this.boardRemovals = removals;
    this.underlayJob = jobs.underlay;
    this.viewJobState = jobs.view;
    this.applyDraftPlan(plan);
    this.changed();
  }

  /**
   * What a history operation pins before its first await, rechecked
   * against live values after the last one: the stored project identity
   * (open lifetime, generation, native revision and authoring), the kept
   * creative base, the shared draft's revision and this workspace's
   * version. Any movement means an external change landed mid-operation
   * and the restore refuses rather than overwriting it.
   */
  private operationBase(): {
    readonly saved: EditableSavedIdentity;
    readonly keptRevision: number;
    readonly draftRevision: number;
    readonly versionCount: number;
  } {
    return {
      saved: this.project.savedIdentity(),
      keptRevision: this.keptRevision,
      draftRevision: this.project.draft.capture().revision,
      versionCount: this.versionCount,
    };
  }

  /** Refuse when anything the operation pinned moved during its awaits. */
  private assertOperationBase(base: {
    readonly saved: EditableSavedIdentity;
    readonly keptRevision: number;
    readonly draftRevision: number;
    readonly versionCount: number;
  }): void {
    this.checkOpen();
    const saved = this.project.savedIdentity();
    if (saved.lifetime !== base.saved.lifetime)
      throw new Error(
        "The project's open lifetime changed while the snapshot was being read; restore refused so newer work is not lost.",
      );
    if (
      saved.generation !== base.saved.generation ||
      saved.revision !== base.saved.revision ||
      saved.authoring !== base.saved.authoring
    )
      throw new Error(
        "The saved project moved while the snapshot was being read; restore refused so newer work is not lost.",
      );
    if (this.keptRevision !== base.keptRevision)
      throw new Error(
        "The kept creative base moved while the snapshot was being read; restore refused so newer work is not lost.",
      );
    if (this.project.draft.capture().revision !== base.draftRevision)
      throw new Error(
        "The shared draft changed while the snapshot was being read; restore refused so newer edits are not lost.",
      );
    if (this.versionCount !== base.versionCount)
      throw new Error(
        "The creative workspace changed while the snapshot was being read; restore refused so newer edits are not lost.",
      );
  }

  /**
   * Shared spine for undo, redo and jump: retain the displaced live state
   * durably first — its refusal aborts the restore and keeps the work —
   * then swap under the rechecked snapshot and move the cursor.
   */
  private async stepHistory(targetId: string, commit: (displaced: string) => void): Promise<void> {
    this.checkOpen();
    if (this.inFlight) throw busyError();
    // Pinned before the first await: queued prior work draining on the
    // tail only emits bookkeeping notifications, never content bumps, so
    // a moved pin here always means an external content change.
    const base = this.operationBase();
    try {
      await this.run(async () => {
        this.checkOpen();
        this.inFlight = true;
        try {
          // Refuse an unrestorable target before the displaced-state
          // capture so a refused undo never mints a new retained row.
          await this.loadRestorableUndo(targetId);
          const displaced = await this.retainLiveState();
          await this.replaceWithUndoSnapshot(targetId, base);
          // The swap and the cursor move are one synchronous step; a
          // fallible list refresh after it cannot undo the commit.
          commit(displaced);
          await this.refreshUndos().catch(() => undefined);
        } finally {
          this.inFlight = false;
        }
      });
    } catch (error) {
      this.noteUndoError(error);
      this.notify();
      throw error;
    }
    this.undoErrorValue = null;
    // Best-effort, matching autosave(): an unresolved reviewable recovery
    // row legitimately refuses the write and stays for the user to resolve.
    if (this.autosaveRecovery) await this.saveRecovery().catch(() => undefined);
    this.notify();
  }

  async undo(): Promise<void> {
    const target = this.undoJournal.undoTarget();
    if (target === null) throw new Error("There is nothing to undo.");
    await this.stepHistory(target, (displaced) => this.undoJournal.noteUndo(target, displaced));
  }

  async redo(): Promise<void> {
    const target = this.undoJournal.redoTarget();
    if (target === null) throw new Error("There is nothing to redo.");
    await this.stepHistory(target, (displaced) => this.undoJournal.noteRedo(target, displaced));
  }

  async restoreUndoSnapshot(snapshotId: string): Promise<void> {
    await this.stepHistory(snapshotId, (displaced) =>
      this.undoJournal.noteRestore(snapshotId, displaced),
    );
  }

  /** Re-issue refused captures oldest-first with their exact envelopes. */
  async retryUndoCapture(): Promise<void> {
    this.checkOpen();
    if (this.undoRetryQueue.length === 0)
      throw new Error("There is no refused undo capture to retry.");
    await this.run(async () => {
      this.checkOpen();
      // Drain order matters: earlier envelopes precede newer ones in the
      // journal's seq slots, and the queue keeps only what still refuses.
      while (this.undoRetryQueue.length > 0) {
        const cap = this.undoRetryQueue[0]!;
        await this.persistUndoCapture(cap);
        this.undoJournal.persisted(cap.seq, cap.snapshotId);
      }
      this.notify();
    });
  }

  async discardUndoSnapshot(entry: CreativeUndoSummary): Promise<void> {
    this.checkOpen();
    await this.run(async () => {
      this.checkOpen();
      await discardCreativeUndo(
        this.projectId,
        entry.snapshotId,
        entry.receipt,
        this.project.savedIdentity().lifetime,
      );
      this.undoJournal.drop(entry.snapshotId);
      await this.refreshUndos();
      this.changed();
    });
  }

  async dispose(): Promise<void> {
    if (this.isClosed) return;
    // Best-effort: durable state first, then the lease release. A failed
    // recovery save keeps the lease alive so staged bytes stay reachable.
    let saved = false;
    try {
      await this.saveRecovery();
      saved = true;
    } catch {
      /* a failed save keeps the lease alive so staged bytes stay reachable */
    }
    this.isClosed = true;
    // Disposal revokes every outstanding material capture: an operation
    // that outlives the workspace cannot stage through its authority.
    this.materialLive.clear();
    if (saved && this.sourceList.length === 0) {
      await releaseCreativeLease({
        projectId: this.projectId,
        lease: { id: this.leaseId, owner: this.leaseOwner },
        expectedLifetime: this.project.savedIdentity().lifetime,
      }).catch(() => undefined);
    }
    this.changed();
  }
}

/**
 * Open the creative material workspace over an already-open EditableProject.
 * Provider-independent: nothing here creates an agent session, worker,
 * model call or running-game claim.
 */
export function openCreativeWorkspace(
  project: EditableProject,
  options: CreativeWorkspaceOptions = {},
): CreativeMaterialWorkspace {
  return new CreativeMaterialWorkspaceImpl(project, options);
}
