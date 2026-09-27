/**
 * The project transaction boundary. Every write that puts a running game's
 * work into browser storage — a Studio Keep, an AI remix, a room built from
 * the map or written mid-play, a conversation, settings or history-adoption
 * save, an autosave — depends on four answers, and this module owns them:
 *
 * 1. What base was the edit made from? The resource revision the running
 *    game confirmed (`BootedGame.revision`), and the authoring fingerprint
 *    of the authoring state this tab holds for the game (`hydrateAuthoring`
 *    records it; the tab's own writes move it on with `advanceAuthoring`).
 * 2. What was saved? `readSaved`: the stored record with its resource
 *    revision, authoring fingerprint, storage generation and history
 *    lifetime, read in one snapshot.
 * 3. What did the running game confirm it installed? Only an acknowledged
 *    install (`installPatch`, `installSaved`, `confirmSaved`) moves the
 *    booted game to a saved revision. One that is refused, never
 *    acknowledged or overtaken by a replaced worker leaves the game behind
 *    storage instead, so nothing writes its older files over the save.
 * 4. What may still write? `requireSaved` (and `writeOverSaved` around a
 *    write) refuses as `stale` unless storage still holds the edit's base in
 *    the game's lifetime; `needsReload` says the game may write nothing more
 *    over storage, and `watchProjectWrites` learns it from other tabs early.
 *
 * Four identities, each with one job, never standing in for another:
 * - the resource revision names the playable bytes (gameMetadata.ts);
 * - the authoring fingerprint names the editable authoring content — plan,
 *   bindings, labels, locks, annotations, sources — so an edit that leaves
 *   the bytes alone is still seen (gameStorage.ts computes it, never stores
 *   it);
 * - the storage generation is the compare-and-set every project write makes;
 * - the history lifetime tells a deleted-and-recreated project apart.
 *
 * The authoring base belongs to the booted game, not to a session: the tab
 * holds one authoring state per game at a time — its live session, or,
 * without one, the booted record Room Studio opens a draft on — and every
 * session a game gets hydrates from the same record.
 */
import { resourceCacheHint } from "../../src/agent/authoringState.ts";
import type { ProjectId, ResourceRevision } from "../../src/gameIdentity.ts";
import { gameRevision, updateBootedResources } from "./gameMetadata.ts";
import {
  authoringFingerprint,
  generationOf,
  lifetimeHolds,
  loadAuthoredGameWithHistoryLifetime,
  type AuthoringFingerprint,
  type CachedGameData,
} from "./gameStorage.ts";
import type { BootedGame } from "./gameTypes.ts";
import { listenForProjectWrites, type NoticeChannel } from "./projectBroadcast.ts";
import type { PatchResource, WorkerInbound, WorkerQueryFn } from "./workerProtocol.ts";
import type { AwaitPatchedFn } from "./workerQueries.ts";

/** Why a project transaction refused or failed; `code` picks the UI's wording. */
export type ResourceCommitErrorCode =
  /** An agent turn, a history adoption or another commit owns the session. */
  | "busy"
  /** The booted, stored or running game is not at the edit's base. */
  | "stale"
  /** The edit itself is unusable (its source does not compile to its bytes). */
  | "invalid"
  /** Browser storage refused the conditional write; nothing changed. */
  | "storage"
  /** The edit is saved, but the running game did not install it. */
  | "install";

export class ResourceCommitError extends Error {
  readonly code: ResourceCommitErrorCode;
  /** The project the edit was saved to — set on `install` failures. */
  readonly projectId: ProjectId | undefined;
  /**
   * The stored project moved past the running game (another tab kept an
   * edit): reopening on the running game would edit bytes or authoring
   * storage no longer holds, so only reloading the game from storage
   * continues.
   */
  readonly behindStorage: boolean;
  constructor(
    code: ResourceCommitErrorCode,
    message: string,
    detail: { savedTo?: ProjectId | undefined; behindStorage?: boolean } = {},
  ) {
    super(message);
    this.name = "ResourceCommitError";
    this.code = code;
    this.projectId = detail.savedTo;
    this.behindStorage = detail.behindStorage === true;
  }
}

// ---------- 1. the base ----------

/** The authoring content a game's in-tab state was hydrated from, and whether storage moved past it. */
interface AuthoringBase {
  fingerprint: AuthoringFingerprint;
  /** Another tab changed the authoring content: no authoring write lands until a reload. */
  stale: boolean;
}

const authoringBases = new WeakMap<BootedGame, AuthoringBase>();

/**
 * The tab read `authoringState` for `game` — at boot, when a session
 * hydrates, when a Keep reads the record. The first read is the base; a
 * later one holding other content means another tab changed it since, and
 * the game is stale for authoring writes from then on. False while it is.
 */
export function hydrateAuthoring(
  game: BootedGame,
  authoringState: Record<string, unknown> | undefined,
): boolean {
  const fingerprint = authoringFingerprint(authoringState);
  const base = authoringBases.get(game);
  if (base === undefined) authoringBases.set(game, { fingerprint, stale: false });
  else if (base.fingerprint !== fingerprint) base.stale = true;
  return base?.stale !== true;
}

/** The tab's own write stored `authoringState` for `game`: the base moves with it. */
export function advanceAuthoring(
  game: BootedGame,
  authoringState: Record<string, unknown> | undefined,
): void {
  const fingerprint = authoringFingerprint(authoringState);
  const base = authoringBases.get(game);
  if (base === undefined) authoringBases.set(game, { fingerprint, stale: false });
  else base.fingerprint = fingerprint;
}

/** The fingerprint of the authoring state the tab holds for `game`, once it read one. */
export function authoringBaseOf(game: BootedGame): AuthoringFingerprint | undefined {
  return authoringBases.get(game)?.fingerprint;
}

/**
 * A Studio draft opens on the authoring content the tab holds for `game` —
 * its live session's, or the booted record's — and keeps against it: the
 * draft's own base, which its Keeps carry and advance (resourceCommit.ts).
 * Undefined for a game with no authoring read yet, such as an installed
 * edition's, whose draft opens on no authored text.
 */
export function openDraft(game: BootedGame): AuthoringFingerprint | undefined {
  if (!authoringBases.has(game) && game.authoredGame)
    hydrateAuthoring(game, game.authoredGame.authoringState);
  return authoringBaseOf(game);
}

// ---------- 2. what was saved ----------

/** A stored project and its identities, read in one snapshot. */
export interface SavedProject {
  readonly data: CachedGameData;
  /** The resource revision of the stored files. */
  readonly revision: ResourceRevision;
  readonly fingerprint: AuthoringFingerprint;
  /** The generation a write over this record must expect. */
  readonly generation: number;
  /** The live history lifetime; null once the project was removed. */
  readonly lifetime: string | null;
}

async function readSaved(projectId: ProjectId): Promise<SavedProject | null> {
  const captured = await loadAuthoredGameWithHistoryLifetime(projectId);
  if (!captured) return null;
  const { data, lifetime } = captured;
  return {
    data,
    lifetime,
    revision: await gameRevision(data.files),
    fingerprint: authoringFingerprint(data.authoringState),
    generation: generationOf(data),
  };
}

// ---------- 3. what the running game confirmed ----------

/**
 * How long a transaction waits for the running game to acknowledge
 * installed bytes. The edit is already saved by then; a missing ack becomes
 * an `install` failure and its reload, never an endless wait.
 */
const PATCH_ACK_TIMEOUT_MS = 10_000;

/** Installs of saved bytes still waiting for the running game; a gate waits them out. */
const installing = new WeakMap<BootedGame, Promise<unknown>>();

/**
 * Install `resources` in `worker` as one all-or-nothing patch and wait for
 * the acknowledgement naming each resource's bytes; the waiter is armed
 * before the post. Rejects when the worker refuses the set, holds other
 * bytes, is replaced (the link drains its waiters) or stays silent past
 * `timeoutMs` — a silent install may still land later.
 */
export async function installPatch(
  worker: Worker,
  awaitPatched: AwaitPatchedFn,
  resources: readonly PatchResource[],
  timeoutMs = PATCH_ACK_TIMEOUT_MS,
): Promise<void> {
  const acked = awaitPatched(
    resources.map(({ kind, num, payload }) => ({ kind, num, hint: resourceCacheHint(payload) })),
    timeoutMs,
  );
  const copies = resources.map(({ kind, num, payload }) => ({
    kind,
    num,
    payload: new Uint8Array(payload),
  }));
  worker.postMessage(
    { type: "patch", resources: copies } satisfies WorkerInbound,
    copies.map(({ payload }) => payload.buffer),
  );
  await acked;
}

/** The running game a transaction installs into, as it stood when the transaction began. */
export interface RunningGame {
  /** The booted game that owns the saved record (a fork's new remix). */
  readonly game: BootedGame;
  /** The worker running it; null when none is left to install into. */
  readonly worker: Worker | null;
  readonly awaitPatched: AwaitPatchedFn;
  readonly query: WorkerQueryFn;
  /** False once the game, its worker or its session was replaced. */
  readonly current: () => boolean;
}

/** Saved files, durable before any install begins. */
export interface SavedFiles {
  readonly files: Record<string, Uint8Array>;
}

/**
 * Bring the running game to saved files: the auxiliary files first, then
 * the changed resources under one acknowledgement, then the running game's
 * files are read back and must be exactly the saved revision. Only then does
 * the booted game follow; anything else throws `install` and leaves the game
 * behind storage.
 */
export function installSaved(
  running: RunningGame,
  saved: SavedFiles,
  change: {
    resources: readonly PatchResource[];
    metadata?: Partial<Record<"WORDS.TOK" | "OBJECT" | "TESTS.JSON", Uint8Array>> | undefined;
  },
  what: string,
): Promise<void> {
  return settleInstall(running, what, async () => {
    const { worker } = running;
    if (!worker) throw new Error(NO_WORKER);
    if (change.metadata)
      worker.postMessage({ type: "patchMetadata", files: change.metadata } satisfies WorkerInbound);
    if (change.resources.length > 0)
      await installPatch(worker, running.awaitPatched, change.resources);
    await confirmFiles(running, saved);
  });
}

/**
 * The same confirmation when the running game installs saved files itself —
 * a room written mid-play arrives as the worker's answer to its own request.
 * `delivered` resolves once that answer is posted (and rejects when the game
 * is left first); the running game's files are read back after it.
 */
export function confirmSaved(
  running: RunningGame,
  saved: SavedFiles,
  delivered: Promise<void>,
  what: string,
): Promise<void> {
  return settleInstall(running, what, async () => {
    await delivered;
    await confirmFiles(running, saved);
  });
}

const NO_WORKER = "no running game is left to load them";

async function confirmFiles(running: RunningGame, saved: SavedFiles): Promise<void> {
  if (!running.worker) throw new Error(NO_WORKER);
  const [held, expected] = await Promise.all([
    running.query("exportFiles", {}, PATCH_ACK_TIMEOUT_MS),
    gameRevision(saved.files),
  ]);
  if (!running.current()) throw new Error("the game changed before it could load them");
  if (!held || (await gameRevision(held)) !== expected)
    throw new Error("the running game holds other files than were saved");
  await updateBootedResources(running.game, saved.files);
}

async function settleInstall(
  running: RunningGame,
  what: string,
  install: () => Promise<void>,
): Promise<void> {
  const { game } = running;
  const outcome = install();
  const settled = outcome.catch(() => {});
  installing.set(game, settled);
  void settled.then(() => {
    if (installing.get(game) === settled) installing.delete(game);
  });
  try {
    await outcome;
  } catch (error) {
    markBehindStorage(game);
    throw new ResourceCommitError(
      "install",
      `${what} was saved, but the running game could not load it (${error instanceof Error ? error.message : String(error)}). Reload the game to continue from the saved project.`,
      { savedTo: game.projectId },
    );
  }
}

// ---------- 4. what may still write ----------

/**
 * Storage holds bytes newer than the running game: nothing writes the
 * game's files over them until it reloads from storage, which boots a fresh
 * BootedGame. True when this call made the mark, so callers tell the
 * player once.
 */
export function markBehindStorage(game: BootedGame): boolean {
  if (game.behindStorage) return false;
  game.behindStorage = true;
  return true;
}

/** Nothing the running game holds may be written over storage any more; only a reload continues. */
export function needsReload(game: BootedGame): boolean {
  return game.behindStorage === true || authoringBases.get(game)?.stale === true;
}

/** What a conditional project write must still find in storage. */
export interface SavedBase {
  /**
   * The resource revision the write was made against; omitted, the one the
   * running game confirmed once any install in flight settled.
   */
  readonly revision?: ResourceRevision | undefined;
  /**
   * An authoring write — plan, bindings, sources — must also find the
   * authoring content this tab holds; a conversation write needs only the
   * bytes.
   */
  readonly authoring: boolean;
  /** The refusal, in the words of the surface that asked. */
  readonly message: string;
  /** The refusal when the project was removed or replaced; `message` otherwise. */
  readonly removedMessage?: string | undefined;
}

/**
 * The gate every conditional write over a stored project passes: storage
 * must hold `base` in this game's lifetime. A pending install settles first.
 * Refuses as `stale` (only a reload continues) when the project is gone or
 * replaced, or holds another revision — the game is then behind storage —
 * or, for an authoring write, other authoring content — the game is then
 * stale for authoring writes. Returns the record; the write that follows
 * expects its generation.
 */
export async function requireSaved(game: BootedGame, base: SavedBase): Promise<SavedProject> {
  await installing.get(game);
  const stale = (message = base.message) =>
    new ResourceCommitError("stale", message, { behindStorage: true });
  if (base.authoring && authoringBases.get(game)?.stale) throw stale();
  const saved = await readSaved(game.projectId!);
  if (!saved || !lifetimeHolds(game.historyLifetime, saved.lifetime)) {
    markBehindStorage(game);
    throw stale(base.removedMessage);
  }
  if (saved.revision !== (base.revision ?? game.revision)) {
    markBehindStorage(game);
    throw stale();
  }
  if (base.authoring && !hydrateAuthoring(game, saved.data.authoringState)) throw stale();
  return saved;
}

/**
 * One conditional project write: `write` runs with the record the gate read
 * and returns whether storage took it. A refused write meets the gate again,
 * so losing the race to a newer save refuses as `stale`; false means storage
 * itself failed.
 */
export async function writeOverSaved(
  game: BootedGame,
  base: SavedBase,
  write: (saved: SavedProject) => Promise<boolean>,
): Promise<boolean> {
  if (await write(await requireSaved(game, base))) return true;
  await requireSaved(game, base);
  return false;
}

export interface ProjectWriteWatch {
  readonly getBootedGame: () => BootedGame | null;
  /** The running game fell behind another tab's write; called once per game. */
  readonly onBehindStorage: () => void;
}

/**
 * Apply other tabs' project writes to the running game at once, not at its
 * next refused write: another revision puts it behind storage, another
 * authoring fingerprint makes it stale for authoring writes. The player may
 * keep playing until they reload. Returns the unsubscribe.
 */
export function watchProjectWrites(
  watch: ProjectWriteWatch,
  channel?: NoticeChannel | null,
): () => void {
  return listenForProjectWrites((notice) => {
    const game = watch.getBootedGame();
    if (!game || game.installed || game.projectId !== notice.projectId || needsReload(game)) return;
    if (notice.revision !== game.revision) markBehindStorage(game);
    const base = authoringBases.get(game);
    if (base && notice.fingerprint !== undefined && notice.fingerprint !== base.fingerprint)
      base.stale = true;
    if (needsReload(game)) watch.onBehindStorage();
  }, channel);
}
