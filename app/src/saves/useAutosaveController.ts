/**
 * Autosave & progress controller.
 * Manages autosave storage, background flushes, worker synchronization,
 * and game resume / start-over lifecycle.
 */
import type { AgentLogEntry } from "../agent/agentLog.ts";
import type { LlmConfig } from "../agent/llmClient.ts";
import { gameRevision, updateBootedResources } from "../project/gameMetadata.ts";
import { resourceRevisionBytes } from "../../../src/authoring/resourceRevision.ts";
import {
  AUTOSAVE_FILE,
  autosaveKey,
  autosaveMatchesKey,
  parseAutosaveRecord,
  readGameProgress,
  writeAutosave,
  withCheckpointLock,
  type AutosaveGame,
  type AutosaveRecord,
} from "./gameProgress.ts";
import {
  getCachedGameMeta,
  getStorageKey,
  loadAuthoredGameWithHistoryLifetime,
  readHistoryLifetime,
  updateAuthoredGameFilesAt,
} from "../project/gameStorage.ts";
import { markBehindStorage, markRemoved } from "../project/projectTransaction.ts";
import {
  findInstalledFolder,
  gameStorageKey,
  type BootedGame,
  type InstalledGameDescriptor,
  type ProjectId,
} from "../project/gameTypes.ts";
import {
  bindProgressTarget,
  bindSavedProgressTarget,
  resolveProgressTarget,
} from "../project/progressBinding.ts";
import {
  installedProgressTarget,
  parseProgressLocator,
  projectProgressTarget,
  resolveInstalledFolder,
  type ProgressTarget,
} from "../project/progressTarget.ts";
import {
  LEGACY_LAST_GAME_KEY,
  RESUME_POINTER_KEY,
  clearResumePointer,
  readResumePointer,
  writeResumePointer,
} from "./resumePointer.ts";
import { resolveGameHash } from "../../../src/games/knownGames.ts";
import { projectId, type ResourceRevision } from "../../../src/gameIdentity.ts";
import type { EngineMenuState } from "../../../src/runtime/engine.ts";
import { detectProfile, type ProfileId } from "../../../src/runtime/profile.ts";
import type { PreparedEarlierCheckpoint } from "./earlierCheckpoint.ts";
import { isProgressPreview } from "./progressPreview.ts";
import type { WorkerInbound } from "../worker/workerProtocol.ts";

/**
 * The released last-game key, kept exported for the session bootstrap that
 * still recognizes it. New boots and checkpoints write only the dedicated
 * resumeTarget key (resumePointer.ts); this one stays legacy read context.
 * @public
 */
export const LAST_GAME_KEY = LEGACY_LAST_GAME_KEY;
const RESUME_CAPTION_MS = 10_000;
/** A posted resume waits this long for the worker's restore acknowledgement. */
const RESUME_ACK_TIMEOUT_MS = 15_000;

export { autosaveKey, writeAutosave };
export type { AutosaveRecord, AutosaveGame };

/**
 * Storage holds another revision than the running project game: it is
 * marked behind, or the project index names a newer save. Only a reason to
 * skip this game's saves — the conditional file write and the cross-tab
 * notice decide `behindStorage`, since this tab's own Keep also passes
 * through a moment where the index is ahead of the game it installs into.
 */
export function storageMovedPast(game: BootedGame): boolean {
  if (game.installed || !game.projectId) return false;
  if (game.behindStorage) return true;
  const stored = getCachedGameMeta(game.projectId)?.library?.revision;
  return stored !== undefined && stored !== game.revision;
}

export function autosaveMatches(game: AutosaveGame, targetKey: string): boolean {
  // The record's identity must belong under the key it was read from: a
  // physical locator matches by domain, a released spelling by the embedded
  // project — a record found at another key does not apply.
  return autosaveMatchesKey(game, targetKey);
}

/** Every storage read is a maybe: a blocked, full or corrupt store is normal. */
export function readAutosave(targetKey: string): AutosaveRecord | null {
  try {
    const direct = parseAutosaveRecord(localStorage.getItem(autosaveKey(targetKey)));
    if (direct && autosaveMatches(direct.game, targetKey)) return direct;
    const resolved = resolveGameHash(targetKey);
    if (resolved && resolved !== targetKey) {
      const byHash = parseAutosaveRecord(localStorage.getItem(autosaveKey(resolved)));
      if (byHash && autosaveMatches(byHash.game, resolved)) return byHash;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove the checkpoint stored under `targetKey` (and its released hash
 * spelling). The resume pointer follows only when it selects this exact
 * checkpoint — either key's stored value — so a pointer naming another game
 * survives a selected clear.
 */
function clearCheckpointBytes(targetKey: string): void {
  try {
    localStorage.removeItem(autosaveKey(targetKey));
    const resolved = resolveGameHash(targetKey);
    if (resolved && resolved !== targetKey) {
      localStorage.removeItem(autosaveKey(resolved));
    }
    const pointer = readResumePointer(localStorage);
    if (
      pointer !== null &&
      (pointer.value === targetKey || (resolved !== null && pointer.value === resolved))
    ) {
      if (pointer.legacy) localStorage.removeItem(LEGACY_LAST_GAME_KEY);
      else clearResumePointer(localStorage);
    }
  } catch {
    /* nothing to clear in a store we cannot reach */
  }
}

export function clearAutosave(targetKey: string): Promise<void> {
  return withCheckpointLock(targetKey, () => clearCheckpointBytes(targetKey));
}

/**
 * The checkpoint Home may offer to continue: the last game played's, while
 * its game can still boot. An authored project's checkpoint without a
 * stored record is the removed project's own leftover under its own key:
 * it is cleared, pointer and all, never offered. An installed edition's
 * stays (its folder may only be missing for now); an index this release
 * cannot read is kept but not offered.
 */
export function resumableAutosave(): AutosaveRecord | null {
  const key = lastGameKey();
  const record = key ? readAutosave(key) : null;
  if (!key || !record || record.game.installed) return record;
  const project = record.game.identity.project;
  if (getCachedGameMeta(project)) return record;
  try {
    if (localStorage.getItem(getStorageKey(project)) === null) void clearAutosave(key);
  } catch {
    /* a store we cannot read offers nothing */
  }
  return null;
}

/**
 * The storage key of the game an autosave exists for, or null. Used by the
 * picker. The dedicated physical pointer wins while it exists — an old
 * tab's lastGame write can never outrank it; the released value is read
 * only when no physical pointer was ever stored.
 */
export function lastGameKey(): string | null {
  return readResumePointer(localStorage)?.value ?? null;
}

export interface AutosaveControllerContext {
  readonly state: {
    installedGames?: readonly InstalledGameDescriptor[] | null | undefined;
    resumed: boolean;
    leaving?: boolean;
  };
  readonly getBootedGame: () => BootedGame | null;
  readonly getWorker: () => Worker | null;
  readonly getRunScope?: () => string | undefined;
  /** The project's write owner makes its live image durable before a checkpoint. */
  readonly prepareCheckpoint?: (
    game: BootedGame,
    files: Record<string, Uint8Array> | undefined,
    revision: ResourceRevision | undefined,
  ) => Promise<"owned" | "legacy" | "refused" | "not_ready">;
  readonly onAutosaveStored?: (cycle: number) => void;
  readonly onAutosaveRestored?: (room: number, egoX: number, egoY: number) => void;
  /** An autosave found a newer save in storage and wrote nothing; called once per game. */
  readonly onBehindStorage?: () => void;
  /**
   * The running project was removed: found by a checkpoint's lifetime check
   * (once per game) or by a reload from storage (every time it is asked).
   */
  readonly onRemoved?: () => void;
  readonly logAgent: (kind: AgentLogEntry["kind"], message: string, details?: unknown) => void;
  readonly isInstalledGame: (targetGame: string) => boolean;
  readonly bootGame: (targetFolder: string, carrier?: ResumeBootCarrier) => Promise<void>;
  /**
   * Start over's fresh installed boot (useGameLifecycle.bootInstalledFresh):
   * the folder's served files are fetched and prepared once into a private
   * candidate while the current world keeps running; after the last
   * preparation await the candidate's actual physical locator is proven
   * against the selection, `admission` re-runs, and only then — synchronously
   * — the selected checkpoint clears and the same candidate installs. A
   * composition without it refuses an installed selection before anything
   * is cleared or fetched: a clear-then-ordinary-boot fallback would delete
   * the checkpoint before the served bytes prove anything and manufacture
   * a completed outcome from the ordinary boot's void return.
   */
  readonly bootInstalledFresh?: (
    selected: SelectedInstalledTarget,
    admission: FreshInstalledAdmission,
  ) => Promise<StartOverOutcome>;
  readonly bootAuthoredGame: (
    prompt: string,
    config: LlmConfig,
    options?: {
      projectId?: ProjectId;
      title?: string;
      useCached?: boolean;
      resumeCarrier?: ResumeBootCarrier;
    },
  ) => Promise<void>;
  readonly configForGame: (projectId: ProjectId, config: LlmConfig) => LlmConfig;
  /**
   * A resume's armed worker answered `restored:false` — or its ack timed
   * out — while still owning the slot: retire it synchronously so its queued
   * booted/history/autosave traffic can never publish, and surface the
   * failure. Called only when `game` is still the booted game; anything it
   * already retired or replaced answers nothing.
   */
  readonly retireFailedRecovery: (game: BootedGame, message: string) => void;
  /**
   * How long an armed resume may spend preparing and waiting for the worker's
   * restore acknowledgement before settling `timeout`. An unanswered owned
   * worker is retired. Earlier binding before arming is outside this limit.
   * A non-finite or non-positive value waits indefinitely — test-only control.
   */
  readonly resumeAckTimeoutMs?: number | undefined;
}

type AutosaveFlushResult =
  | { status: "saved"; cycle: number }
  | { status: "already_durable"; cycle: number }
  | { status: "not_checkpointable" }
  | { status: "not_ready" }
  | { status: "storage_failure"; error?: unknown }
  | { status: "timeout" };

/**
 * What a selection spelling or physical locator resolves to: the physical
 * address the checkpoint lives under plus the boot destination it names.
 */
export type SelectedProgressTarget =
  | { readonly kind: "installed"; readonly locator: string; readonly folder: string }
  | { readonly kind: "project"; readonly locator: string; readonly project: ProjectId };

/** The installed member of SelectedProgressTarget: folder plus physical locator. */
export type SelectedInstalledTarget = Extract<
  SelectedProgressTarget,
  { readonly kind: "installed" }
>;

/**
 * The final admission a fresh installed boot runs after its last preparation
 * await, while the previous world still occupies the slot. `admitted`
 * re-checks the calling operation's captured ownership against the build the
 * folder actually served; `commit` runs only once the candidate is proven —
 * synchronously — and clears exactly the selected physical checkpoint while
 * dropping this operation's pending resume intent. Its failure propagates:
 * a checkpoint storage refused to read or remove keeps the running world.
 */
export interface FreshInstalledAdmission {
  readonly admitted: (landed: SelectedInstalledTarget) => boolean;
  readonly commit: () => void;
}

/**
 * The admission ticket a start-over operation carries into its own boot.
 * The caller re-proves it after every awaited binding step — including the
 * last one, immediately before the checkpoint is cleared — so a slot or a
 * body replaced underneath the call is caught before any destructive write.
 * `selected` is the target this call just resolved; the operation admits
 * only the exact physical target it captured.
 */
export interface StartOverAdmission {
  readonly admitted: (selected: SelectedProgressTarget | null) => boolean;
}

/**
 * How a start over ended: it cleared its selection's checkpoint and booted;
 * the selection proved nothing current; or the operation's own admission
 * rejected it after a binding await — nothing was cleared or booted in the
 * last two.
 */
export type StartOverOutcome =
  | { readonly status: "completed" }
  | { readonly status: "refused" }
  | { readonly status: "superseded" };

/**
 * The destination candidate one resume intent's admission inspects: the
 * game the boot built — not yet installed into the slot — plus the exact
 * file bytes and interpreter override that boot will post.
 */
export interface ResumeBootCandidate {
  readonly game: BootedGame;
  readonly files: Record<string, Uint8Array>;
  readonly profile?: ProfileId | undefined;
  /** The lifecycle operation still owns the slot after every preparation await. */
  readonly isCurrent?: (() => boolean) | undefined;
}

/**
 * What the boot carrying a resume's destination learns from its admission
 * check. `none` posts an ordinary boot; `restore` posts the pending
 * record's image and menus; `aborted` stops the boot before any worker or
 * session move — its intent already ended, or its evidence mismatched, and
 * a fresh boot must never stand in for a failed restore.
 */
type ResumeAdmission =
  | { readonly status: "none" }
  | {
      readonly status: "restore";
      readonly restoreImage: string;
      readonly restoreMenus?: EngineMenuState | undefined;
    }
  | { readonly status: "aborted"; readonly message?: string | undefined };

/**
 * How one resume operation ended. `restored` is only the worker's own
 * `restored:true` for the armed intent — a resolved boot callback never
 * certifies it. `refused` is a pre-boot answer (idle gate, moved evidence);
 * `failed` is the worker's refusal or a boot error; `superseded` is a newer
 * operation, a reset or an eject taking over; `timeout` is an armed post
 * whose acknowledgement never arrived.
 */
type ResumeOutcome =
  | { readonly status: "restored" }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "superseded" }
  | { readonly status: "timeout" };

/** One local recovery operation, carried through its own boot adapters. */
export interface ResumeBootCarrier {
  readonly isCurrent: () => boolean;
  readonly admit: (boot: ResumeBootCandidate) => Promise<ResumeAdmission>;
}

export interface AutosaveController {
  readAutosave(targetKey: string): AutosaveRecord | null;
  clearAutosave(targetKey: string): Promise<void>;
  lastAutosaveRecord(): AutosaveRecord | null;
  getAutosaveWrite(): Promise<boolean>;
  flushAutosave(timeoutMs?: number): Promise<boolean>;
  flushAutosaveDetailed(timeoutMs?: number): Promise<AutosaveFlushResult>;
  handleAutosave(msg: {
    image: string;
    revision?: ResourceRevision;
    preview?: unknown;
    menus?: EngineMenuState;
    cycle: number;
    room: number;
    files?: Record<string, Uint8Array>;
  }): void;
  handleFlushed(msg: { id: number; taken: boolean; cycle?: number | undefined }): void;
  handleRestored(msg: {
    ok: boolean;
    room?: number;
    egoX?: number;
    egoY?: number;
    message?: string;
  }): void;
  /** Retire an armed recovery synchronously before queued worker publications. */
  handleRecoveryError(message: string): boolean;
  beginResumeBoot(carrier?: ResumeBootCarrier): boolean;
  takeResumeState(boot: ResumeBootCandidate, carrier?: ResumeBootCarrier): Promise<ResumeAdmission>;
  resumeLastGame(config: LlmConfig): Promise<boolean>;
  resumeFromRecord(
    record: AutosaveRecord,
    config: LlmConfig,
    resumeLocator?: string,
    isCurrent?: () => boolean,
  ): Promise<boolean>;
  /**
   * The pending resume intent's proven destination target while it is
   * unsettled — the physical locator the caller named or the bound target
   * its armed boot resolved. Null once the intent settled or none exists.
   */
  pendingProgressTarget(): ProgressTarget | null;
  /**
   * Open a proven earlier checkpoint into its explicitly selected
   * destination: the PreparedEarlierCheckpoint is ordinary data, revalidated
   * here against the destination's live native evidence — the saved body's
   * atomic epoch, its bytes' own hash and the effective interpreter — and
   * then rides the ordinary boot's pending intent through to the worker's
   * restore acknowledgement. Restricted to an idle library for now: a
   * running or departing world refuses, and no earlier history, saves,
   * maps or conversation are adopted — the restore records a fresh segment
   * under the destination's own physical target.
   */
  resumeEarlierCheckpoint(
    prepared: PreparedEarlierCheckpoint,
    config: LlmConfig,
  ): Promise<ResumeOutcome>;
  /**
   * The physical target a selection names, proven while `booted` still owns
   * the slot: a physical locator resolves by digest/epoch evidence alone, a
   * released spelling through the running game's bound target, the single
   * folder it resolves to, or the live project body. Null when the selection
   * names nothing current or the slot moved underneath the proof.
   */
  selectProgressTarget(
    targetKey: string,
    booted: BootedGame | null,
  ): Promise<SelectedProgressTarget | null>;
  startOver(
    targetKey: string,
    config: LlmConfig,
    admission?: StartOverAdmission,
  ): Promise<StartOverOutcome>;
  reloadFromStorage(config: LlmConfig): Promise<boolean>;
  drainFlushWaiters(): void;
  reset(): void;
  resetScreen(): void;
}

export function useAutosaveController(ctx: AutosaveControllerContext): AutosaveController {
  let lastAutosave: AutosaveRecord | null = null;
  let lastAutosaveScope: {
    game: BootedGame;
    worker: Worker | null;
    lifetime: string | null | undefined;
    run: string | undefined;
  } | null = null;
  function invalidateOldCheckpoint(): void {
    const game = ctx.getBootedGame();
    if (
      lastAutosave !== null &&
      (lastAutosaveScope?.game !== game ||
        lastAutosaveScope.worker !== ctx.getWorker() ||
        lastAutosaveScope.lifetime !== game?.historyLifetime ||
        lastAutosaveScope.run !== ctx.getRunScope?.() ||
        lastAutosave.game.identity.revision !== game?.revision)
    ) {
      lastAutosave = null;
      lastAutosaveScope = null;
    }
  }
  let preparationNotReady = false;
  let checkpointTraceCount = 0;
  function traceCheckpoint(stage: string, details: unknown) {
    if (checkpointTraceCount++ < 32)
      ctx.logAgent("log", `Checkpoint ${stage}: ${JSON.stringify(details)}`);
  }
  let autosaveWrite: Promise<boolean> = Promise.resolve(true);
  const flushWaiters = new Map<number, (saved: boolean) => void>();
  const flushDetailedWaiters = new Map<number, (res: AutosaveFlushResult) => void>();
  let lastSeenCycle = 0;
  let nextFlushQueryId = 0;
  let resumeCaptionTimer: number | null = null;

  /**
   * One resume operation's intent: the checkpoint to restore (a rebound
   * record for an earlier checkpoint), the destination it names and the
   * evidence its boot must still prove. `admittedTo` is the candidate the
   * matching boot validated — only that worker's `restored` message settles
   * the intent, and only while the candidate still owns the slot. `target`
   * is the physical destination captured at admission or armed at the boot;
   * `failure` is a terminal settle's wording for a late-arriving own boot.
   * A settled intent stays until its driver's end so its own boot still in
   * flight aborts instead of becoming a fresh boot over the checkpoint.
   */
  interface PendingResumeIntent {
    readonly carrier: ResumeBootCarrier;
    readonly record: AutosaveRecord;
    /** The exact physical locator the booted game must bind, when the caller named one. */
    readonly expectedLocator?: string | undefined;
    /** The installed folder or saved project this intent's boot names. */
    readonly folder?: string | undefined;
    readonly project?: ProjectId | undefined;
    /** The effective interpreter the restore was proven under, when captured. */
    readonly profile?: ProfileId | undefined;
    target?: ProgressTarget | undefined;
    admittedTo?: BootedGame | undefined;
    failure?: string | undefined;
    settled: boolean;
    timer: number | null;
    readonly outcome: Promise<ResumeOutcome>;
    readonly settle: (outcome: ResumeOutcome) => void;
  }

  let pendingResume: PendingResumeIntent | null = null;
  // A recovery owns its clock before any binding/storage await.
  let resumeGeneration = 0;

  function beginResumeOperation(): number {
    dropResumeIntent(true);
    return resumeGeneration;
  }

  function installResumeIntent(spec: {
    operation: number;
    isCurrent?: (() => boolean) | undefined;
    record: AutosaveRecord;
    expectedLocator?: string | undefined;
    folder?: string | undefined;
    project?: ProjectId | undefined;
    profile?: ProfileId | undefined;
    target?: ProgressTarget | undefined;
  }): PendingResumeIntent {
    if (spec.operation !== resumeGeneration)
      throw new Error("This recovery operation was superseded during preparation.");
    let resolve!: (outcome: ResumeOutcome) => void;
    const outcome = new Promise<ResumeOutcome>((r) => {
      resolve = r;
    });
    const pending: PendingResumeIntent = {
      ...spec,
      record: structuredClone(spec.record),
      carrier: {
        isCurrent: () =>
          spec.operation === resumeGeneration &&
          (spec.isCurrent?.() ?? true) &&
          pendingResume === pending &&
          !pending.settled,
        admit: (boot) => admitResumeState(pending, boot),
      },
      settled: false,
      timer: null,
      outcome,
      settle: (settled) => {
        if (pending.settled) return;
        pending.settled = true;
        if (pending.timer !== null) {
          clearTimeout(pending.timer);
          pending.timer = null;
        }
        if (settled.status === "failed" || settled.status === "refused") {
          pending.failure = settled.message;
        }
        resolve(settled);
      },
    };
    const timeout = ctx.resumeAckTimeoutMs ?? RESUME_ACK_TIMEOUT_MS;
    if (Number.isFinite(timeout) && timeout > 0) {
      const timer = setTimeout(() => settleResumeTimeout(pending), timeout) as unknown;
      pending.timer = timer as number;
      // A parked timer must not pin a Node test process open.
      (timer as { unref?: () => void }).unref?.();
    }
    pendingResume = pending;
    return pending;
  }

  /**
   * The ack timeout: settle the intent truthfully, and when its armed
   * candidate still owns the slot retire the unanswered worker the same way
   * a refusal does — nothing it still queues may publish. The tombstone
   * stays so the intent's own late-arriving boot aborts rather than
   * booting fresh over the destination's checkpoint.
   */
  function settleResumeTimeout(pending: PendingResumeIntent): void {
    pending.failure = "Resuming the saved checkpoint timed out.";
    pending.settle({ status: "timeout" });
    const admitted = pending.admittedTo;
    if (admitted !== undefined && ctx.getBootedGame() === admitted) {
      ctx.retireFailedRecovery(admitted, "Resuming the saved checkpoint timed out.");
    }
  }

  /**
   * The resume's driver: the intent is armed, the destination's ordinary
   * boot runs, and the promise stays open for the worker's real
   * acknowledgement. The boot resolving says only that the boot posted —
   * success is the matching `restored:true`, nothing else.
   */
  async function runResumeIntent(
    pending: PendingResumeIntent,
    boot: (carrier: ResumeBootCarrier) => Promise<void>,
  ): Promise<ResumeOutcome> {
    // Preparation may remain parked after cancellation. Observe the existing
    // outcome independently; its private carrier keeps the late-install veto.
    void (async () => {
      try {
        await boot(pending.carrier);
      } catch (error) {
        pending.settle({ status: "failed", message: String(error) });
      }
      if (!pending.settled) {
        const armed =
          pending.admittedTo !== undefined && ctx.getBootedGame() === pending.admittedTo;
        if (!armed) pending.settle({ status: "superseded" });
      }
    })();
    const outcome = await pending.outcome;
    // The tombstone's veto ends with the operation: a later ordinary boot
    // of the same destination is nobody's resume.
    if (pendingResume === pending) pendingResume = null;
    return outcome;
  }

  /** End the pending intent privately — a discard, reset or drain takes over. */
  function dropResumeIntent(retireAdmitted = false): void {
    resumeGeneration++;
    const pending = pendingResume;
    pendingResume = null;
    if (pending === null || pending.settled) return;
    pending.settle({ status: "superseded" });
    if (
      retireAdmitted &&
      pending.admittedTo !== undefined &&
      ctx.getBootedGame() === pending.admittedTo &&
      ctx.getWorker() !== null
    ) {
      ctx.retireFailedRecovery(pending.admittedTo, "Recovery canceled.");
    }
  }

  function showResumeCaption(): void {
    ctx.state.resumed = true;
    if (resumeCaptionTimer !== null) {
      clearTimeout(resumeCaptionTimer);
    }
    resumeCaptionTimer = setTimeout(() => {
      ctx.state.resumed = false;
      resumeCaptionTimer = null;
    }, RESUME_CAPTION_MS) as unknown as number;
  }

  /**
   * The removal's lifetime check: whether the running project's history
   * lifetime was ended by a removal (its receipt says deleted) or replaced
   * — a body recreated under the same id mints a new epoch, and this
   * incarnation's progress belongs to the removed one. `expectedEpoch` is
   * the incarnation this write answers to: the boot's captured receipt, or
   * the bound target's when the boot carries the binding alone — a
   * recreated body can never satisfy the old epoch. The first finding
   * marks the game removed and tells the player; nothing is stored for it
   * from then on. Unknown (storage unreadable) is not a removal, and a
   * superseded game reports nothing — the mark belongs to the current
   * game's own checks.
   */
  async function projectRemoved(game: BootedGame, expectedEpoch?: string | null): Promise<boolean> {
    if (game.installed || !game.projectId) return false;
    if (game.removed) return true;
    const expected = expectedEpoch !== undefined ? expectedEpoch : game.historyLifetime;
    const live = await readHistoryLifetime(game.projectId).catch(() => undefined);
    if (live !== null && (expected === undefined || live === expected)) return false;
    if (live === undefined) return false;
    if (ctx.getBootedGame() !== game) return true;
    if (markRemoved(game)) ctx.onRemoved?.();
    return true;
  }

  /**
   * The preview of this game's newest checkpoint, read under its own
   * physical address with the full ownership predicate — same domain, same
   * embedded project and revision. A released spelling's record may be
   * another instance's picture (two folders can share one hash), so legacy
   * keys are never a preview source here.
   */
  function targetAutosavePreview(target: ProgressTarget): string | undefined {
    return readGameProgress(localStorage, target).autosave?.preview;
  }

  async function storeAutosave(
    msg: {
      image: string;
      revision?: ResourceRevision;
      preview?: unknown;
      menus?: EngineMenuState;
      cycle: number;
      room: number;
      files?: Record<string, Uint8Array>;
    },
    captured: { game: BootedGame | null; worker: Worker | null; run: string | undefined },
  ): Promise<boolean> {
    try {
      const booted = ctx.getBootedGame();
      if (
        !booted ||
        booted !== captured.game ||
        ctx.getWorker() !== captured.worker ||
        ctx.getRunScope?.() !== captured.run
      )
        return false;
      const game = booted;
      // The one physical address every read and write below answers to,
      // resolved before the body, files and progress it may touch — a
      // removed body and a game that never bound a target both refuse
      // before anything is stored.
      let target = resolveProgressTarget(game);
      // The incarnation this boot may write into: its captured lifetime
      // receipt, else the bound target's own epoch for a game carrying the
      // binding alone.
      const expectedEpoch =
        game.historyLifetime ?? (target?.kind === "project" ? target.bodyEpoch : undefined);
      // A removed project stores nothing: a checkpoint would bring its key
      // back, and Home would offer a game that no longer exists.
      if (await projectRemoved(game, expectedEpoch)) return false;
      if (msg.files === undefined && msg.revision !== undefined && game.revision !== msg.revision)
        return false;
      if (target === null) {
        ctx.logAgent("log", "autosave skipped: the game has no resolvable progress target");
        return false;
      }
      if (msg.files) {
        if (booted.installed) return false;
        // Behind storage (a Keep saved but not installed, a newer write from
        // elsewhere) the running game's files are older than the record:
        // nothing is written over it until the game reloads from storage.
        if (booted.behindStorage) return false;
        // Conditional, as every project write is: only over the revision and
        // the live body epoch this game booted on (or a body already holding
        // these files). A newer save elsewhere — or a recreated body — refuses:
        // the game is behind storage from then on, and the reload it needs is
        // offered once.
        const current = await gameRevision(msg.files);
        if (ctx.getBootedGame() !== game) return false;
        const outcome = await updateAuthoredGameFilesAt(game.projectId!, msg.files, {
          revision: game.revision,
          current,
          ...(expectedEpoch !== undefined ? { lifetime: expectedEpoch } : {}),
        });
        if (outcome === "stale") {
          if (ctx.getBootedGame() === game && markBehindStorage(game)) ctx.onBehindStorage?.();
          return false;
        }
        if (outcome !== "saved" || ctx.getBootedGame() !== game) return false;
        await updateBootedResources(game, msg.files);
        if (ctx.getBootedGame() !== game) return false;
        // The installed bytes moved the revision: the checkpoint writes
        // under the rebound target so the record names what it stores.
        const rebound = bindProgressTarget(game);
        if (rebound === null) return false;
        target = rebound;
      }
      // A checkpoint names the revision this game runs. Once storage holds
      // another one (a Keep in another tab, which took its own checkpoint),
      // this one could never resume and would bury that tab's: skip it.
      if (
        storageMovedPast(game) ||
        (msg.revision !== undefined &&
          (game.revision !== msg.revision || target.identity.revision !== msg.revision))
      )
        return false;
      // A snapshot without its own picture (the worker sends none for a black
      // screen) keeps the card's previous one — only this game's own
      // physical record supplies it.
      const preview = isProgressPreview(msg.preview) ? msg.preview : targetAutosavePreview(target);
      const record: AutosaveRecord = {
        format: "monotio.agi.autosave",
        version: 1,
        image: String(msg.image),
        ...(preview !== undefined ? { preview } : {}),
        ...(msg.menus ? { menus: msg.menus } : {}),
        cycle: Number(msg.cycle),
        room: Number(msg.room),
        savedAt: Date.now(),
        game: {
          installed: game.installed,
          identity: target.identity,
        },
      };
      if (
        ctx.getBootedGame() !== game ||
        ctx.getWorker() !== captured.worker ||
        ctx.getRunScope?.() !== captured.run
      )
        return false;
      const stored = writeAutosave(localStorage, target, record);
      traceCheckpoint("stored", {
        cycle: msg.cycle,
        identity: stored?.game.identity,
        lifetime: expectedEpoch,
      });
      if (!stored) {
        ctx.logAgent("log", "autosave failed: browser storage rejected the save record");
        return false;
      }
      // The resume pointer moves only to the physical address this game
      // actually wrote under; an old tab's lastGame write cannot follow it.
      if (!writeResumePointer(localStorage, target.locator)) {
        ctx.logAgent("log", "autosave resume pointer failed: browser storage refused");
      }
      // Removed while this checkpoint was written: the removing tab cleared
      // the key before it, or this lifetime check sees the receipt now.
      if (ctx.getBootedGame() === game && (await projectRemoved(game, expectedEpoch))) {
        clearCheckpointBytes(target.locator);
        return false;
      }
      // A document edit can land while the lifetime read waits. Re-prove its
      // owner before acknowledging a cycle as durable for the current project.
      const ownership = await ctx.prepareCheckpoint?.(
        game,
        undefined,
        stored.game.identity.revision,
      );
      if (ownership === "not_ready") preparationNotReady = true;
      if (
        ownership === "refused" ||
        ownership === "not_ready" ||
        ctx.getBootedGame() !== game ||
        game.revision !== stored.game.identity.revision ||
        ctx.getWorker() !== captured.worker ||
        ctx.getRunScope?.() !== captured.run
      )
        return false;
      ctx.onAutosaveStored?.(stored.cycle);
      lastAutosave = stored;
      lastAutosaveScope = {
        game,
        worker: captured.worker,
        lifetime: game.historyLifetime,
        run: captured.run,
      };
      return true;
    } catch (error) {
      ctx.logAgent("log", `autosave failed: ${String(error)}`);
      return false;
    }
  }

  function handleAutosave(msg: {
    image: string;
    revision?: ResourceRevision;
    preview?: unknown;
    menus?: EngineMenuState;
    cycle: number;
    room: number;
    files?: Record<string, Uint8Array>;
  }): void {
    const game = ctx.getBootedGame();
    invalidateOldCheckpoint();
    const revision = msg.revision ?? game?.revision;
    const captured = { game, worker: ctx.getWorker(), run: ctx.getRunScope?.() };
    traceCheckpoint("captured", {
      cycle: msg.cycle,
      workerRevision: revision,
      project: game?.projectId,
      lifetime: game?.historyLifetime,
    });
    autosaveWrite = autosaveWrite
      .then(async () => {
        if (
          game === null ||
          ctx.getBootedGame() !== game ||
          ctx.getWorker() !== captured.worker ||
          ctx.getRunScope?.() !== captured.run
        )
          return false;
        const ownership =
          (await ctx.prepareCheckpoint?.(game, msg.files, msg.revision)) ?? "legacy";
        preparationNotReady = ownership === "not_ready";
        traceCheckpoint("prepared", {
          cycle: msg.cycle,
          ownership,
          workerRevision: revision,
          runningRevision: game.revision,
        });
        if (ownership === "refused" || ownership === "not_ready" || ctx.getBootedGame() !== game)
          return false;
        if (ownership === "owned") {
          if (game.revision !== revision) return false;
          const { files: _files, ...checkpoint } = msg;
          const target = resolveProgressTarget(game);
          return target === null
            ? false
            : withCheckpointLock(target.locator, () =>
                storeAutosave({ ...checkpoint, revision: revision! }, captured),
              );
        }
        const target = resolveProgressTarget(game);
        if (target === null)
          ctx.logAgent("log", "autosave skipped: the game has no resolvable progress target");
        return target === null
          ? false
          : withCheckpointLock(target.locator, () => storeAutosave(msg, captured));
      })
      .catch(() => false);
  }

  function handleFlushed(msg: { id: number; taken: boolean; cycle?: number | undefined }): void {
    const cycle = Number(msg.cycle ?? lastSeenCycle);
    lastSeenCycle = cycle;
    const simpleResolve = flushWaiters.get(Number(msg.id));
    const detailedResolve = flushDetailedWaiters.get(Number(msg.id));

    if (msg.taken) {
      void autosaveWrite.then((saved) => {
        simpleResolve?.(saved);
        if (saved) {
          detailedResolve?.({ status: "saved", cycle });
        } else {
          detailedResolve?.({ status: preparationNotReady ? "not_ready" : "storage_failure" });
        }
      });
      return;
    }

    invalidateOldCheckpoint();
    const lastCycle = lastAutosave?.cycle;
    const isCleanOpening = cycle === 0;
    const game = ctx.getBootedGame();
    const target = game === null ? null : resolveProgressTarget(game);
    const isUnchanged =
      lastCycle !== undefined &&
      cycle <= lastCycle &&
      target !== null &&
      lastAutosave !== null &&
      autosaveMatches(lastAutosave.game, target.locator) &&
      lastAutosave.game.identity.revision === target.identity.revision &&
      lastAutosaveScope?.game === game &&
      lastAutosaveScope.worker === ctx.getWorker() &&
      lastAutosaveScope.lifetime === game?.historyLifetime &&
      lastAutosaveScope.run === ctx.getRunScope?.();

    if (isCleanOpening || isUnchanged) {
      simpleResolve?.(true);
      detailedResolve?.({ status: "already_durable", cycle });
      return;
    }

    simpleResolve?.(false);
    detailedResolve?.({ status: "not_checkpointable" });
  }

  function handleRestored(msg: {
    ok: boolean;
    room?: number;
    egoX?: number;
    egoY?: number;
    message?: string;
  }): void {
    const pending = pendingResume;
    const admitted = pending !== null && !pending.settled ? pending.admittedTo : undefined;
    // Only the armed candidate's own worker may settle its intent, and only
    // while that candidate still owns the slot — a superseded boot's
    // acknowledgement (however it arrived) is dead traffic.
    const owned = admitted !== undefined && ctx.getBootedGame() === admitted;
    if (owned && (admitted.removed || admitted.behindStorage)) {
      handleRecoveryError("The saved checkpoint's project changed during recovery.");
      return;
    }
    if (msg.ok) {
      if (!owned || pending === null) return;
      // The one acknowledgement a resume waits on: only now does it report
      // success — boot dispatch never certified it.
      pending.settle({ status: "restored" });
      if (pendingResume === pending) pendingResume = null;
      ctx.onAutosaveRestored?.(Number(msg.room), Number(msg.egoX), Number(msg.egoY));
      showResumeCaption();
      ctx.logAgent("log", `Resumed the autosave in room ${Number(msg.room)}.`);
      return;
    }
    if (!owned || pending === null || admitted === undefined) {
      ctx.logAgent(
        "log",
        `Autosave restore failed (${String(msg.message)}); no resume is pending for it.`,
      );
      return;
    }
    // A real refusal from the armed recovery worker: settle the intent,
    // then retire the worker synchronously — before its queued booted,
    // history or autosave messages can publish. The destination's
    // checkpoint, the resume pointer and every earlier source stay exactly
    // as they were; only the slot moves to the error surface.
    const message = `The saved checkpoint could not be restored: ${String(msg.message)}`;
    pending.settle({ status: "failed", message });
    if (pendingResume === pending) pendingResume = null;
    ctx.retireFailedRecovery(admitted, message);
    ctx.logAgent(
      "log",
      `Autosave restore failed (${String(msg.message)}); the checkpoint has been kept.`,
    );
  }

  function handleRecoveryError(message: string): boolean {
    const pending = pendingResume;
    const game = pending?.admittedTo;
    if (pending === null || pending.settled || game === undefined || ctx.getBootedGame() !== game)
      return false;
    pending.settle({ status: "failed", message });
    pendingResume = null;
    resumeGeneration++;
    ctx.retireFailedRecovery(game, message);
    return true;
  }

  function beginResumeBoot(carrier?: ResumeBootCarrier): boolean {
    if (carrier === undefined) {
      dropResumeIntent(true);
      return true;
    }
    return pendingResume?.carrier === carrier && carrier.isCurrent();
  }

  async function takeResumeState(
    boot: ResumeBootCandidate,
    carrier?: ResumeBootCarrier,
  ): Promise<ResumeAdmission> {
    if (carrier === undefined) return { status: "none" };
    return carrier.admit(boot);
  }

  async function admitResumeState(
    pending: PendingResumeIntent,
    boot: ResumeBootCandidate,
  ): Promise<ResumeAdmission> {
    const tombstone = (): ResumeAdmission => {
      if (pendingResume === pending) pendingResume = null;
      return {
        status: "aborted",
        ...(pending.failure !== undefined ? { message: pending.failure } : {}),
      };
    };
    const current = (): boolean => pending.carrier.isCurrent() && (boot.isCurrent?.() ?? true);
    const superseded = (): ResumeAdmission => {
      pending.settle({ status: "superseded" });
      return tombstone();
    };
    const fail = (message: string): ResumeAdmission => {
      pending.settle({ status: "failed", message });
      return tombstone();
    };
    if (!current()) return superseded();
    const matches =
      pending.folder !== undefined
        ? boot.game.installed && boot.game.folder === pending.folder
        : !boot.game.installed && boot.game.projectId === pending.project;
    if (!matches || pending.record.game.installed !== boot.game.installed)
      return fail("The checkpoint's destination changed during opening.");
    if (pending.admittedTo !== undefined)
      return fail("This recovery operation already opened its destination.");

    const native = resourceRevisionBytes(boot.files);
    const revision = await gameRevision(boot.files);
    if (!current()) return superseded();
    if (
      pending.record.game.identity.revision !== revision ||
      (pending.target !== undefined && pending.target.identity.revision !== revision)
    )
      return fail(
        "This play position belongs to an earlier version of the game. Your project is safe. Start the latest version? The old position is replaced when the new run saves.",
      );
    const profile = detectProfile(new Map(Object.entries(boot.files)), boot.profile).id;
    if (pending.profile !== undefined && pending.profile !== profile)
      return fail("The destination's interpreter changed during opening.");

    // The existing archive validator decodes and dry-runs this exact detached
    // record against the candidate's real native resources and interpreter.
    let validated: AutosaveRecord;
    try {
      const { readProgressEntries } = await import("./gameProgressImport.ts");
      if (!current()) return superseded();
      const checked = readProgressEntries(
        new Map([[AUTOSAVE_FILE, new TextEncoder().encode(JSON.stringify(pending.record))]]),
        "",
        boot.files,
        profile,
      )?.autosave;
      if (checked === undefined || checked === null)
        return fail("The checkpoint could not be read.");
      validated = checked;
    } catch (error) {
      return fail(`The checkpoint could not be restored: ${String(error)}`);
    }
    if (!current()) return superseded();

    if (!boot.game.installed) {
      const project = boot.game.projectId;
      if (project === undefined) return fail("The stored project's identity is missing.");
      const live = await loadAuthoredGameWithHistoryLifetime(project).catch(() => null);
      if (!current()) return superseded();
      if (live === null || live.lifetime === null || live.lifetime !== boot.game.historyLifetime)
        return fail("The stored copy changed during opening. Your checkpoint has been kept.");
      const latest = resourceRevisionBytes(live.data.files);
      if (
        latest.length !== native.length ||
        !latest.every((byte, index) => byte === native[index]) ||
        detectProfile(new Map(Object.entries(live.data.files)), live.data.library?.profile).id !==
          profile
      )
        return fail("The stored game's resources or interpreter changed during opening.");
    } else {
      const served = ctx.state.installedGames?.find((entry) => entry.folder === pending.folder);
      if (
        served !== undefined &&
        ((served.revision !== undefined && served.revision !== revision) ||
          (served.profile !== undefined && served.profile !== profile))
      )
        return fail("The installed edition changed during opening.");
    }
    // Final observed storage proof is followed only by synchronous checks and
    // installation. The same private candidate was hashed and dry-run.
    const posted = resourceRevisionBytes(boot.files);
    if (posted.length !== native.length || !posted.every((byte, index) => byte === native[index]))
      return fail("The prepared resources changed during opening.");
    boot.game.revision = revision;
    const target = bindProgressTarget(boot.game);
    if (
      target === null ||
      (pending.expectedLocator !== undefined && target.locator !== pending.expectedLocator) ||
      (pending.target !== undefined && target.identity.project !== pending.target.identity.project)
    )
      return fail("The game's current copy differs from the checkpoint's destination.");
    if (!current()) return superseded();
    pending.admittedTo = boot.game;
    pending.target = target;
    return {
      status: "restore",
      restoreImage: validated.image,
      ...(validated.menus !== undefined ? { restoreMenus: validated.menus } : {}),
    };
  }

  function flushAutosaveDetailed(timeoutMs = 2000): Promise<AutosaveFlushResult> {
    const worker = ctx.getWorker();
    if (!worker) return Promise.resolve({ status: "already_durable", cycle: 0 });
    return new Promise<AutosaveFlushResult>((resolve) => {
      const id = ++nextFlushQueryId;
      let settled = false;
      const done = (res: AutosaveFlushResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        flushWaiters.delete(id);
        flushDetailedWaiters.delete(id);
        resolve(res);
      };
      const timer = setTimeout(() => {
        done({ status: "timeout" });
      }, timeoutMs);
      flushDetailedWaiters.set(id, done);
      worker.postMessage({ type: "flush", id } satisfies WorkerInbound);
    });
  }

  async function flushAutosave(timeoutMs = 500): Promise<boolean> {
    const res = await flushAutosaveDetailed(timeoutMs);
    return res.status === "saved" || res.status === "already_durable";
  }

  function lastAutosaveRecord(): AutosaveRecord | null {
    invalidateOldCheckpoint();
    return lastAutosave;
  }

  function getAutosaveWrite(): Promise<boolean> {
    return autosaveWrite;
  }

  async function resumeLastGame(config: LlmConfig): Promise<boolean> {
    const operation = beginResumeOperation();
    const pointer = readResumePointer(localStorage);
    if (pointer === null) return false;
    const key = pointer.value;
    const locator = parseProgressLocator(key);
    if (!pointer.legacy && locator === null) {
      // A physical pointer that parses to nothing usable refuses — its
      // checkpoint stays stored, and the value never falls through to the
      // released alias/folder resolution a bare spelling would get.
      ctx.logAgent("log", `Autosave pointer "${key}" names no physical target; starting fresh.`);
      return false;
    }
    const record = readAutosave(key);
    if (!record) return false;
    let available: boolean;
    if (locator?.kind === "installed") {
      // A physical installed address resolves strictly by folder digest.
      available = resolveInstalledFolder(key, ctx.state.installedGames).status === "resolved";
    } else if (locator?.kind === "project") {
      // The pointer names one body incarnation: its epoch must still be the
      // live one — a delete-and-recreate under the same id left this
      // checkpoint behind with the removed body.
      const live = await readHistoryLifetime(locator.project).catch(() => undefined);
      available =
        live !== undefined &&
        live !== null &&
        live === locator.bodyEpoch &&
        getCachedGameMeta(locator.project) !== null;
    } else {
      available = record.game.installed
        ? ctx.isInstalledGame(record.game.identity.project)
        : Boolean(getCachedGameMeta(record.game.identity.project));
    }
    if (operation !== resumeGeneration) return false;
    if (!available) {
      // Unavailable evidence leaves the checkpoint and both pointer keys
      // byte-exact: a missing destination deletes nothing, adopts nothing
      // and never falls back to a legacy address.
      ctx.logAgent(
        "log",
        `Autosave for "${key}" has no game to boot; the checkpoint stays stored.`,
      );
      return false;
    }
    return resumePreparedRecord(record, config, locator !== null ? key : undefined, operation);
  }

  async function resumeFromRecord(
    record: AutosaveRecord,
    config: LlmConfig,
    resumeLocator?: string,
    isCurrent?: () => boolean,
  ): Promise<boolean> {
    return resumePreparedRecord(record, config, resumeLocator, beginResumeOperation(), isCurrent);
  }

  async function resumePreparedRecord(
    record: AutosaveRecord,
    config: LlmConfig,
    resumeLocator: string | undefined,
    operation: number,
    isCurrent?: () => boolean,
  ): Promise<boolean> {
    record = structuredClone(record);
    if (operation !== resumeGeneration || (isCurrent !== undefined && !isCurrent())) return false;
    const locator = resumeLocator !== undefined ? parseProgressLocator(resumeLocator) : null;
    if (record.game.installed) {
      if (resumeLocator !== undefined) {
        // A supplied physical installed address resolves strictly: the
        // folder by digest equality, and the record's embedded revision is
        // the one the address itself carries — mismatched evidence refuses
        // with the checkpoint and pointer exactly as stored.
        if (locator?.kind !== "installed") return false;
        if (record.game.identity.revision !== locator.revision) return false;
        const resolved = resolveInstalledFolder(resumeLocator, ctx.state.installedGames);
        if (resolved.status !== "resolved") return false;
        // The address names one exact build: a served descriptor carrying a
        // different revision means the build it named was replaced.
        const served = (ctx.state.installedGames ?? []).find(
          (entry) => (typeof entry === "string" ? entry : entry.folder) === resolved.folder,
        );
        if (
          typeof served !== "string" &&
          served?.revision !== undefined &&
          served.revision !== locator.revision
        )
          return false;
        const pending = installResumeIntent({
          operation,
          isCurrent,
          record,
          expectedLocator: resumeLocator,
          folder: resolved.folder,
          target:
            installedProgressTarget({ folder: resolved.folder }, locator.revision) ?? undefined,
        });
        const outcome = await runResumeIntent(pending, (carrier) =>
          ctx.bootGame(resolved.folder, carrier),
        );
        return outcome.status === "restored";
      }
      // Released spelling: no physical address was supplied, so the embedded
      // project's released resolution stands.
      if (!ctx.isInstalledGame(record.game.identity.project)) return false;
      const folder = findInstalledFolder(ctx.state.installedGames, record.game.identity.project);
      const pending = installResumeIntent({ operation, isCurrent, record, folder });
      const outcome = await runResumeIntent(pending, (carrier) => ctx.bootGame(folder, carrier));
      return outcome.status === "restored";
    }
    const project = record.game.identity.project;
    if (resumeLocator !== undefined) {
      // A supplied project address names one body incarnation: the live
      // epoch, bound atomically with the body, must be the pointer's — a
      // delete-and-recreate under the same id mints a new epoch the old
      // address can never satisfy.
      if (locator?.kind !== "project" || locator.project !== project) return false;
      const bound = await bindSavedProgressTarget(project);
      if (operation !== resumeGeneration || (isCurrent !== undefined && !isCurrent())) return false;
      if (
        bound === null ||
        bound.bodyEpoch !== locator.bodyEpoch ||
        bound.identity.revision !== record.game.identity.revision
      )
        return false;
      const pending = installResumeIntent({
        operation,
        isCurrent,
        record,
        expectedLocator: resumeLocator,
        project,
        target: bound,
      });
      const outcome = await runResumeIntent(pending, (carrier) =>
        ctx.bootAuthoredGame("", ctx.configForGame(project, config), {
          projectId: project,
          useCached: true,
          resumeCarrier: carrier,
        }),
      );
      return outcome.status === "restored";
    }
    if (!getCachedGameMeta(project)) return false;
    const pending = installResumeIntent({ operation, isCurrent, record, project });
    const outcome = await runResumeIntent(pending, (carrier) =>
      ctx.bootAuthoredGame("", ctx.configForGame(project, config), {
        projectId: project,
        useCached: true,
        resumeCarrier: carrier,
      }),
    );
    return outcome.status === "restored";
  }

  /**
   * Open a proven earlier checkpoint into its explicitly selected
   * destination. The PreparedEarlierCheckpoint is ordinary data — this
   * service re-proves it against the destination's live native evidence
   * (the saved body's atomic epoch, the bytes' own hash, the effective
   * interpreter, the served build's revision) before the pending intent is
   * armed and the ordinary boot carries it to the worker's real restore
   * acknowledgement. Restricted to an idle library: a running or departing
   * world refuses. No earlier history, saves, maps or conversation are
   * adopted — the restore records a fresh segment under the destination's
   * own physical target, and the source string is never written.
   */
  function recoverySlotBusy(): boolean {
    if (ctx.getBootedGame() !== null || ctx.getWorker() !== null) return true;
    return ctx.state.leaving === true;
  }

  async function resumeEarlierCheckpoint(
    prepared: PreparedEarlierCheckpoint,
    config: LlmConfig,
  ): Promise<ResumeOutcome> {
    prepared = structuredClone(prepared);
    const refuse = (message: string): ResumeOutcome => ({ status: "refused", message });
    if (recoverySlotBusy())
      return refuse("A game is still open; leave it before opening an earlier checkpoint.");
    const operation = beginResumeOperation();
    const target = prepared.target;
    if (target.kind === "installed") {
      const resolved = resolveInstalledFolder(target.locator, ctx.state.installedGames);
      if (resolved.status !== "resolved")
        return refuse("The destination edition is not served in this library.");
      const served = (ctx.state.installedGames ?? []).find(
        (entry) => (typeof entry === "string" ? entry : entry.folder) === resolved.folder,
      );
      if (
        typeof served !== "string" &&
        served?.revision !== undefined &&
        served.revision !== target.identity.revision
      )
        return refuse("The destination's served build changed since the checkpoint was prepared.");
      const pending = installResumeIntent({
        operation,
        record: prepared.record,
        expectedLocator: target.locator,
        folder: resolved.folder,
        profile: prepared.profile,
        target,
      });
      return runResumeIntent(pending, (carrier) => ctx.bootGame(resolved.folder, carrier));
    }
    let loaded: Awaited<ReturnType<typeof loadAuthoredGameWithHistoryLifetime>>;
    try {
      loaded = await loadAuthoredGameWithHistoryLifetime(target.project);
    } catch (error) {
      return operation === resumeGeneration
        ? {
            status: "failed",
            message: `The checkpoint's project could not be read: ${String(error)}`,
          }
        : { status: "superseded" };
    }
    if (operation !== resumeGeneration) return { status: "superseded" };
    if (recoverySlotBusy()) return refuse("A game opened while the checkpoint was being prepared.");
    if (loaded === null || loaded.lifetime !== target.bodyEpoch)
      return refuse("The destination's stored copy changed since the checkpoint was prepared.");
    let revision: ResourceRevision;
    try {
      revision = await gameRevision(loaded.data.files);
    } catch (error) {
      return operation === resumeGeneration
        ? {
            status: "failed",
            message: `The checkpoint's files could not be checked: ${String(error)}`,
          }
        : { status: "superseded" };
    }
    if (operation !== resumeGeneration) return { status: "superseded" };
    if (recoverySlotBusy()) return refuse("A game opened while the checkpoint was being prepared.");
    if (
      revision !== target.identity.revision ||
      revision !== prepared.record.game.identity.revision
    )
      return refuse("The destination's current files do not match the proven bytes.");
    const effective = detectProfile(
      new Map(Object.entries(loaded.data.files)),
      loaded.data.library?.profile,
    ).id;
    if (effective !== prepared.profile)
      return refuse("The destination's interpreter changed since the checkpoint was prepared.");
    const pending = installResumeIntent({
      operation,
      record: prepared.record,
      expectedLocator: target.locator,
      project: target.project,
      profile: prepared.profile,
      target,
    });
    return runResumeIntent(pending, (carrier) =>
      ctx.bootAuthoredGame("", ctx.configForGame(target.project, config), {
        projectId: target.project,
        useCached: true,
        resumeCarrier: carrier,
      }),
    );
  }

  function pendingProgressTarget(): ProgressTarget | null {
    const pending = pendingResume;
    return pending !== null && !pending.settled ? (pending.target ?? null) : null;
  }

  /**
   * Drop the selected checkpoint and its resume state, then report what was
   * read for the startOver log line. Returns the record the selection held.
   */
  async function discardCheckpoint(targetKey: string): Promise<AutosaveRecord | null> {
    const record = readAutosave(targetKey);
    await clearAutosave(targetKey);
    dropResumeIntent(true);
    ctx.state.resumed = false;
    if (resumeCaptionTimer !== null) {
      clearTimeout(resumeCaptionTimer);
      resumeCaptionTimer = null;
    }
    if (!record) {
      ctx.logAgent("log", `startOver: no autosave found for "${targetKey}"; continuing`);
    }
    return record;
  }

  /**
   * The installed fresh commit's strict clear: only the selected physical
   * autosave key — never the resolved-hash or legacy spellings — and every
   * storage read or removal surfaces its failure to the caller while the
   * checkpoint, the resume pointer and this operation's resume state still
   * stand. A denied read is never absence, and a raw value that reads but
   * is not a checkpoint this selection owns (unreadable format, another
   * build's identity) refuses rather than being removed as if absent. The
   * resume pointer follows only when it names this exact locator — the same
   * conditional the legacy clear applies — and its keys are read strictly
   * too: a failure there propagates, since nothing is discarded over a
   * checkpoint that could not be removed.
   */
  function discardSelectedCheckpoint(locator: string): AutosaveRecord | null {
    const key = autosaveKey(locator);
    const raw = localStorage.getItem(key);
    const record = raw === null ? null : parseAutosaveRecord(raw);
    if (raw !== null && (record === null || !autosaveMatches(record.game, locator))) {
      throw new Error(
        `startOver: the value under "${locator}" is not a checkpoint this selection owns`,
      );
    }
    // The pointer keys are read with readResumePointer's precedence but
    // strictly: a denied read reaches the caller instead of passing as "no
    // pointer" and leaving a stale pointer behind a removed checkpoint.
    const current = localStorage.getItem(RESUME_POINTER_KEY);
    const pointer = current ?? localStorage.getItem(LEGACY_LAST_GAME_KEY);
    localStorage.removeItem(key);
    if (pointer === locator) {
      localStorage.removeItem(current !== null ? RESUME_POINTER_KEY : LEGACY_LAST_GAME_KEY);
    }
    dropResumeIntent();
    ctx.state.resumed = false;
    if (resumeCaptionTimer !== null) {
      clearTimeout(resumeCaptionTimer);
      resumeCaptionTimer = null;
    }
    if (record === null) {
      ctx.logAgent("log", `startOver: no autosave found for "${locator}"; continuing`);
    }
    return record;
  }

  /**
   * The physical target a released storage spelling selects, when one can
   * be proven: the running game's bound target when the key names it, else
   * the single folder it resolves to, else the project's live body address.
   * Null when the spelling names nothing current — its checkpoint then
   * exists only under the spelling itself.
   */
  async function selectedProgressTarget(targetKey: string): Promise<SelectedProgressTarget | null> {
    const booted = ctx.getBootedGame();
    if (booted !== null && gameStorageKey(booted) === targetKey) {
      const bound = resolveProgressTarget(booted);
      if (bound !== null) {
        if (bound.kind === "installed")
          return { kind: "installed", locator: bound.locator, folder: bound.folder };
        // A running project's bound epoch is a captured receipt, not live
        // evidence: the selection resolves to the live body — one recreated
        // underneath the caller names another incarnation's epoch, and the
        // operation that captured the old address can never be re-admitted.
        const live = await bindSavedProgressTarget(bound.project);
        return live === null
          ? null
          : { kind: "project", locator: live.locator, project: live.project };
      }
    }
    if (ctx.isInstalledGame(targetKey)) {
      // A convenience spelling resolves to its single instance's folder —
      // an ambiguous spelling returned the query itself, which owns no
      // locator and selects nothing.
      const folder = findInstalledFolder(ctx.state.installedGames, targetKey);
      // The physical address needs the build the folder currently serves:
      // the served descriptor's revision, never the spelling's own guess.
      const descriptor = (ctx.state.installedGames ?? []).find(
        (entry) => (typeof entry === "string" ? entry : entry.folder) === folder,
      );
      const target =
        descriptor !== undefined &&
        typeof descriptor !== "string" &&
        descriptor.revision !== undefined
          ? installedProgressTarget(descriptor, descriptor.revision)
          : null;
      if (target === null) return null;
      const resolved = resolveInstalledFolder(target.locator, ctx.state.installedGames);
      if (resolved.status !== "resolved") return null;
      return { kind: "installed", locator: target.locator, folder: resolved.folder };
    }
    const id = projectId(targetKey);
    if (id === null) return null;
    const bound = await bindSavedProgressTarget(id);
    return bound === null
      ? null
      : { kind: "project", locator: bound.locator, project: bound.project };
  }

  /**
   * Resolve one selection spelling or physical locator to the physical
   * target it names. Shared by the pre-capture path and the boot itself so
   * the two resolve identically: physical locators by digest/epoch evidence,
   * released spellings through `selectedProgressTarget`.
   */
  async function resolveSelectedTarget(targetKey: string): Promise<SelectedProgressTarget | null> {
    const locator = parseProgressLocator(targetKey);
    if (locator?.kind === "installed") {
      const resolved = resolveInstalledFolder(targetKey, ctx.state.installedGames);
      if (resolved.status !== "resolved") return null;
      // The address names one exact build: a served descriptor carrying a
      // different revision means the build it named was replaced — the
      // address selects nothing rather than claiming the folder's current
      // build. String entries and revision-free descriptors carry no
      // evidence and admit the resolved folder as before.
      const served = (ctx.state.installedGames ?? []).find(
        (entry) => (typeof entry === "string" ? entry : entry.folder) === resolved.folder,
      );
      if (
        typeof served !== "string" &&
        served?.revision !== undefined &&
        served.revision !== locator.revision
      ) {
        return null;
      }
      return { kind: "installed", locator: targetKey, folder: resolved.folder };
    }
    if (locator?.kind === "project") {
      const bound = await bindSavedProgressTarget(locator.project);
      return bound !== null && bound.bodyEpoch === locator.bodyEpoch
        ? { kind: "project", locator: bound.locator, project: bound.project }
        : null;
    }
    return selectedProgressTarget(targetKey);
  }

  async function selectProgressTarget(
    targetKey: string,
    booted: BootedGame | null,
  ): Promise<SelectedProgressTarget | null> {
    // The selection's evidence is read against the caller's captured world:
    // a slot that moved before the proof started, or while a body bound,
    // selects nothing for this caller.
    if (ctx.getBootedGame() !== booted) return null;
    const selected = await resolveSelectedTarget(targetKey);
    if (ctx.getBootedGame() !== booted) return null;
    return selected;
  }

  async function startOver(
    targetKey: string,
    config: LlmConfig,
    admission?: StartOverAdmission,
  ): Promise<StartOverOutcome> {
    const locator = parseProgressLocator(targetKey);
    // A physical address names its evidence exactly — an installed one its
    // folder by digest and the build it still serves, a project one the
    // live body's epoch; a released spelling resolves to its running,
    // served or live-body target. A selection naming nothing current
    // refuses before anything is cleared — including a bare legacy record
    // stored under the spelling itself: that record is Earlier progress
    // read context, never this selected target's to delete, even when its
    // embedded identity matches the current build.
    const selected =
      locator !== null
        ? await resolveSelectedTarget(targetKey)
        : await selectedProgressTarget(targetKey);
    if (selected === null) {
      ctx.logAgent(
        "log",
        locator === null
          ? `startOver: "${targetKey}" names no current game`
          : locator.kind === "installed"
            ? `startOver: "${targetKey}" names no current installed game`
            : `startOver: "${targetKey}" names a project body that is gone`,
      );
      return { status: "refused" };
    }
    // Immediately after the last awaited binding step, before any clear or
    // boot: the operation that captured this selection must still own the
    // slot, and the incarnation that just resolved must be the one it named.
    if (admission !== undefined && !admission.admitted(selected)) {
      return { status: "superseded" };
    }
    if (selected.kind === "installed") {
      // The fresh boot owns fetch, proof, clear and install as one
      // admission. Without the seam there is no honest order left: clearing
      // first would delete the checkpoint before the served bytes prove
      // anything, and the ordinary boot's void return cannot say the
      // install landed. Refuse with the world intact.
      if (ctx.bootInstalledFresh === undefined) {
        ctx.logAgent(
          "log",
          `startOver: "${targetKey}" names an installed game, but no fresh boot seam is wired`,
        );
        return { status: "refused" };
      }
      // The fresh boot fetches and prepares the served build once into a
      // private candidate, then — after its last await — re-proves this
      // operation and the candidate's actual locator before the selected
      // physical checkpoint clears and the same candidate installs. A
      // replaced build or a moved slot clears and boots nothing.
      return await ctx.bootInstalledFresh(selected, {
        admitted: (landed) => admission === undefined || admission.admitted(landed),
        commit: () => {
          discardSelectedCheckpoint(selected.locator);
        },
      });
    }
    await discardCheckpoint(selected.locator);
    await ctx.bootAuthoredGame("", ctx.configForGame(selected.project, config), {
      projectId: selected.project,
      useCached: true,
    });
    return { status: "completed" };
  }

  /**
   * Boot the running project again from browser storage, when storage moved
   * past the running game: another tab kept an edit, or a kept edit never
   * reached the live game. Nothing is flushed first — the running game's
   * checkpoint would name bytes storage no longer holds. The stored
   * checkpoint resumes only when it belongs to the live body's epoch and
   * names the stored revision (another tab's Keep takes a fresh one);
   * otherwise the game starts from the top rather than refusing the
   * mismatch. False when the running game is no stored project; a removed
   * one is marked so and told (`onRemoved`).
   */
  async function reloadFromStorage(config: LlmConfig): Promise<boolean> {
    const game = ctx.getBootedGame();
    const id = game?.installed ? undefined : game?.projectId;
    if (!game || !id) return false;
    // Body and lifetime in one snapshot: the incarnation this answers is
    // the one the checkpoint probe and the fresh boot both see.
    const stored = getCachedGameMeta(id) ? await loadAuthoredGameWithHistoryLifetime(id) : null;
    if (!stored || stored.lifetime === null) {
      // Nothing to reload: the project was removed. Say so every time it
      // is asked for, so the reload never silently does nothing.
      markRemoved(game);
      ctx.onRemoved?.();
      return false;
    }
    // The stored incarnation's own checkpoint sits under its live epoch's
    // locator with the full ownership predicate; a released spelling belongs
    // to progress written before the body was addressed, which a recreated
    // body cannot claim.
    const storedRevision = await gameRevision(stored.data.files);
    const target = projectProgressTarget(id, storedRevision, stored.lifetime);
    const record = target !== null ? readGameProgress(localStorage, target).autosave : null;
    if (target !== null && record && record.game.identity.revision === storedRevision)
      return resumeFromRecord(record, config, target.locator);
    await ctx.bootAuthoredGame("", ctx.configForGame(id, config), {
      projectId: id,
      useCached: true,
    });
    return true;
  }

  function drainFlushWaiters(): void {
    for (const done of flushWaiters.values()) done(false);
    for (const done of flushDetailedWaiters.values()) done({ status: "timeout" });
    flushWaiters.clear();
    flushDetailedWaiters.clear();
    dropResumeIntent(true);
  }

  function resetScreen(): void {
    lastAutosave = null;
    lastAutosaveScope = null;
    checkpointTraceCount = 0;
    ctx.state.resumed = false;
    if (resumeCaptionTimer !== null) {
      clearTimeout(resumeCaptionTimer);
      resumeCaptionTimer = null;
    }
    // A worker replacement under an armed resume: the boot its intent armed
    // still owns the slot, and the worker about to replace it can never
    // deliver that intent's acknowledgement — the resume is superseded by
    // whoever spawned. A resume's own boot arrives here before its
    // candidate installs, so it never matches the armed owner.
    const pending = pendingResume;
    if (
      pending !== null &&
      !pending.settled &&
      pending.admittedTo !== undefined &&
      ctx.getBootedGame() === pending.admittedTo
    ) {
      pending.settle({ status: "superseded" });
    }
  }

  function reset(): void {
    dropResumeIntent(true);
    resetScreen();
  }

  return {
    readAutosave,
    clearAutosave,
    lastAutosaveRecord,
    getAutosaveWrite,
    flushAutosave,
    flushAutosaveDetailed,
    handleAutosave,
    handleFlushed,
    handleRestored,
    handleRecoveryError,
    beginResumeBoot,
    takeResumeState,
    resumeLastGame,
    resumeFromRecord,
    pendingProgressTarget,
    resumeEarlierCheckpoint,
    selectProgressTarget,
    startOver,
    reloadFromStorage,
    drainFlushWaiters,
    reset,
    resetScreen,
  };
}
