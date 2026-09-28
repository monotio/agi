import type { AgentSession } from "../agent/agentSession.ts";
import { loadAuthoringStack, type AuthoringLoader } from "../agent/authoringLoader.ts";
import type { AgentHandler, LlmRequest } from "../agent/hostRequests.ts";
import type { AgentRunState } from "../agent/agentRun.ts";
import type { StudioAssistRequest, StudioAssistResult } from "../agent/studioAssist.ts";
import type { AgentLogEntry } from "../agent/agentLog.ts";
import type { LlmConfig } from "../agent/llmClient.ts";
import type { AgentFrame, FrameRequest } from "../../../src/agent/frames.ts";
import { continuationTranscript } from "../archive/projectArchive.ts";
import { gameRevision, updateBootedResources } from "../project/gameMetadata.ts";
import { buildWordsTok, parseWordsTok } from "../../../src/logic/words.ts";
import { openContainer } from "../../../src/container/container.ts";
import {
  createResourceCommit,
  pictureEdit,
  roomEdit,
  stagedViewEdit,
  viewEdit,
  type PictureEdit,
  type RoomEdit,
  type ResourceCommitResult,
  type ViewEdit,
} from "../project/resourceCommit.ts";
import {
  getCachedGameMeta,
  loadAuthoredGame,
  loadGameConversation,
  saveAuthoredGameWithLifetime,
  saveGameConversationUpdate,
  updateAuthoredGameFiles,
  updateAuthoredReferences,
  updateGameConversation,
  updateProjectConversation,
  type CachedGameData,
  type ConversationUpdate,
} from "../project/gameStorage.ts";
import {
  advanceAuthoring,
  confirmSaved,
  hydrateAuthoring,
  installSaved,
  needsReload,
  requireSaved,
  ResourceCommitError,
  writeOverSaved,
  type RunningGame,
  type SavedBase,
  type SavedFiles,
} from "../project/projectTransaction.ts";
import {
  REFERENCE_COUNT_LIMIT,
  roomReference,
  stageCharacterView,
  type DecodedImage,
  type StoredReference,
} from "../references/referenceArt.ts";
import type { CharacterSheetSpec, SheetFacing } from "../../../src/view/characterSheet.ts";
import { worldRevision } from "../../../src/agent/worldPlan.ts";
import { gameStorageKey, type BootedGame } from "../project/gameTypes.ts";
import { projectId, requireProjectId, type ProjectId } from "../../../src/gameIdentity.ts";
import type { LogAgentFn } from "../play/useInputController.ts";
import type { WorkerInbound, WorkerQueryFn } from "../worker/workerProtocol.ts";
import type { AwaitPatchedFn } from "../engine/workerQueries.ts";
import type { HistoryBoot } from "../../../src/agent/history.ts";
import { base64ToBytes } from "../project/bytes.ts";
import { pendingReferences, removePendingReference } from "../references/referenceUploadState.ts";

/** Remix bubble state; the transcript slice is the live tool-call feed. */
export interface PowerUpUiState {
  mode: "ask" | "remix" | "room";
  messages: { role: "user" | "assistant"; text: string }[];
  open: boolean;
  needsConfig: boolean;
  /** An agent turn is in flight; the prompt line is disabled. */
  busy: boolean;
  /** Index into agentLog where this remix turn's feed begins. */
  feedStart: number;
  /** Sequence cursor in agentLog where this remix turn's feed begins. */
  feedStartSeq?: number;
  /** The agent's closing sentence, once it has one. */
  reply: string;
  /** Room the world froze in. */
  room: number;
  error: string;
  /** Storage moved past the running game: the panel offers a reload from storage. */
  offerReload?: boolean;
}

/**
 * The refusal a stale authoring turn ends with — plain text for the
 * assistant panel, matching the wording a Keep's `behindStorage` refusal
 * points at: only reloading the game from storage continues.
 */
const STALE_TURN_MESSAGE =
  "The game was changed elsewhere while the assistant worked, so nothing was applied. Reload the game, then ask again.";

/**
 * The refusal of a conversation or session save whose project moved past
 * the running game: nothing was written over the newer save, and only
 * reloading the game from storage continues.
 */
export const STALE_SAVE_MESSAGE =
  "The game was changed elsewhere, so this conversation was not saved over it. Reload the game to continue from the saved project.";

/** The conversation half of `author`'s record: what a turn that wrote no resources grew. */
function conversationOf(author: AgentSession): ConversationUpdate {
  return {
    ...author.getProviderContext(),
    transcript: author.getTranscript(),
    sessionId: author.getSessionId(),
    chat: author.getMessages(),
  };
}

export interface AuthoringControllerOptions {
  readonly state: {
    phase: "idle" | "loading" | "running" | "error";
    powerUp: PowerUpUiState;
    agentTask: AgentRunState | null;
    readonly agentLog: readonly AgentLogEntry[];
    readonly profile: string | null;
    /** Bumped on each committed world change so plan surfaces re-derive. */
    worldTick: number;
    /** The world revision the last confirmed durable write carried. */
    planDurableRev: string;
  };
  readonly getWorker: () => Worker | null;
  readonly query: WorkerQueryFn;
  /** Settles when the worker acks a patch holding the named bytes. */
  readonly awaitPatched: AwaitPatchedFn;
  readonly logAgent: LogAgentFn;
  readonly readFrames: (req: FrameRequest) => Promise<AgentFrame[]>;
  readonly pauseEngine: (owner: string) => void;
  readonly resumeEngine: (owner: string) => void;
  readonly getBootedGame: () => BootedGame | null;
  readonly setBootedGame: (game: BootedGame | null) => void;
  readonly flushAutosave: (timeoutMs?: number) => Promise<unknown>;
  readonly getAutosaveWrite: () => Promise<boolean>;
  readonly clearAutosave: (targetKey: string) => void;
  readonly onRemixCreated?: ((remixProjectId: ProjectId) => void) | undefined;
  readonly configForGame?: ((projectId: ProjectId, fallback: LlmConfig) => LlmConfig) | undefined;
  readonly getLlmConfig?: (() => LlmConfig) | undefined;
  /** Player intent pinned on the map for a room — attached to room requests. */
  readonly getRoomNotes?: ((room: number) => string[]) | undefined;
  /** Loads the AI authoring stack on first use; tests pass a fake. */
  readonly loadAuthoring?: AuthoringLoader | undefined;
  /**
   * A saved room the running game did not confirm installing: the game is
   * behind storage, and only a reload continues. No panel is waiting then.
   */
  readonly onBehindStorage?: (() => void) | undefined;
}

export interface AuthoringController {
  openPowerUp(config: LlmConfig): Promise<void>;
  closePowerUp(): void;
  submitPowerUp(instruction: string, referenceIds?: readonly string[]): Promise<void>;
  updateAiConfig(config: LlmConfig): Promise<void>;
  /**
   * Persist files the running game already holds (Exit, a recorded test)
   * with the session describing them; the booted game follows. Rejects as
   * stale when storage moved past the running game.
   */
  persistRemix(
    game: BootedGame,
    author: AgentSession,
    files: Record<string, Uint8Array>,
  ): Promise<void>;
  createGameSession(game: BootedGame, config: LlmConfig): Promise<AgentSession>;
  attachSessionRuntime(s: AgentSession, game: BootedGame, profile?: string): void;
  getOrCreateSession(game: BootedGame, config: LlmConfig): Promise<AgentSession>;
  getSession(): AgentSession | null;
  setSession(s: AgentSession | null): void;
  isRemixNeedsSave(): boolean;
  setRemixNeedsSave(value: boolean): void;
  resetSession(): void;
  handleRoomAuthoring(
    req: LlmRequest,
    agent: AgentHandler,
    sendDirection: (dir: number) => void,
  ): Promise<string>;
  /**
   * The link posted the answer to a room request: a saved room's install
   * confirmation proceeds, and the tape's checkpoint follows the answer.
   */
  roomAnswered(): void;
  /** Author one planned room's resources into the running game (map build). */
  buildRoomFromMap(room: number, from: number, notes: string[], exitName?: string): Promise<void>;
  /** Persist the session's authoring state; false when storage refused or
   *  there is no project to write to. Rejects as stale (STALE_SAVE_MESSAGE)
   *  when the project moved past the running game. */
  persistSessionState(): Promise<boolean>;
  /** Post the session's authoring state as a tape checkpoint. */
  postSessionSnapshot(author?: AgentSession | null): void;
  /**
   * The session leg of a history adoption: install the state belonging to
   * the adopted boot, then bring the booted game and stored project to the
   * same revision. A failure leaves the session's adoption hold set.
   */
  adoptSessionState(game: BootedGame, boot: HistoryBoot, snapshot: unknown): Promise<void>;
  assembleExportData(
    data: CachedGameData,
    game: BootedGame,
    session: AgentSession | null,
    files: Record<string, Uint8Array>,
  ): CachedGameData;
  /** Reference art stored with the booted project (empty for installed games). */
  listReferences(): Promise<StoredReference[]>;
  /** Store a decoded image as a room reference under the current identity. */
  attachRoomReference(decoded: DecodedImage, room: number, brief: string): Promise<StoredReference>;
  /**
   * Convert declared pose rows into the staged VIEW and store the reference.
   * Throws the converter's named constraint on unusable input — nothing is
   * stored when conversion fails.
   */
  attachCharacterReference(
    sheets: readonly { decoded: DecodedImage; facing: SheetFacing }[],
    spec: CharacterSheetSpec,
    view: number,
    brief: string,
  ): Promise<StoredReference>;
  /** Remove a stored reference; its bytes leave the project record. */
  detachReference(id: string): Promise<void>;
  /**
   * Commit a staged VIEW to the running game and the project record. Refuses
   * when the game's identity moved since the reference was attached.
   * `repaired` keeps Sprite Studio's repair of the candidate instead.
   */
  keepStagedView(
    id: string,
    repaired?: Pick<ViewEdit, "bytes" | "baseRevision" | "baseAuthoring">,
  ): Promise<ResourceCommitResult>;
  /**
   * Commit Room Studio's picture edit — bytes plus the source that compiles
   * to them — to storage and the running game as one transaction. Throws a
   * ResourceCommitError; "unchanged" when there was nothing to write.
   */
  commitPictureEdit(edit: PictureEdit): Promise<ResourceCommitResult>;
  /**
   * Commit Room Studio's combined Keep: the picture and the room's logic
   * (door rules and the bindings they reserved) in one transaction.
   */
  commitRoomEdit(edit: RoomEdit): Promise<ResourceCommitResult>;
  /** Commit Sprite Studio's VIEW edit the same way. */
  commitViewEdit(edit: ViewEdit): Promise<ResourceCommitResult>;
  /**
   * Ask the game's session about a Studio selection. Resolves with the
   * candidate (or none) and the model's sentence; rejects when stopped.
   */
  runStudioAssist(request: StudioAssistRequest, config: LlmConfig): Promise<StudioAssistResult>;
}

export function useAuthoringController(options: AuthoringControllerOptions): AuthoringController {
  const {
    state,
    getWorker,
    query,
    logAgent,
    readFrames,
    pauseEngine,
    resumeEngine,
    getBootedGame,
    setBootedGame,
    flushAutosave,
    getAutosaveWrite,
    clearAutosave,
    onRemixCreated,
    configForGame,
    getLlmConfig,
    getRoomNotes,
    loadAuthoring = loadAuthoringStack,
    onBehindStorage,
  } = options;

  let session: AgentSession | null = null;
  let remixNeedsSave = false;
  /** The room request whose saved room waits for the link to post its answer. */
  let roomDelivery: { resolve: () => void; reject: (error: Error) => void } | null = null;

  const commitResourceEdit = createResourceCommit({
    ...options,
    loadAuthoring,
    getSession: () => session,
    postSessionSnapshot: (author) => postSessionSnapshot(author),
    onCommitted: (author) => {
      remixNeedsSave = false;
      if (author) reportPlanSaved(planRevisionOf(author));
    },
  });

  const engineSource = {
    objects: () => query("objects"),
    state: () => query("state"),
  };
  const checkpointSource = () => query("checkpoint");

  /**
   * Capture the revision a turn builds on and return its commit gate: the
   * booted game must still be this one, and storage must still hold that
   * revision and the authoring content this tab holds (requireSaved) while
   * the staged result may land. A Keep saved elsewhere, or one whose install
   * never reached the running game, leaves the project ahead of the live
   * state; refusing there discards the turn like a failed one instead of
   * overwriting the saved edit. Installed editions have no project record
   * to protect.
   */
  function turnBaseGuard(game: BootedGame | null): () => Promise<void> {
    const revision = game?.revision;
    return async () => {
      if (getBootedGame() !== game)
        throw new ResourceCommitError("stale", STALE_TURN_MESSAGE, { behindStorage: true });
      if (!game || game.installed || !game.projectId) return;
      await requireSaved(game, { revision, authoring: true, message: STALE_TURN_MESSAGE });
    };
  }

  /** The record the running game confirmed, as a conversation or authoring write must still find it. */
  function sessionBase(authoring: boolean): SavedBase {
    return { authoring, message: STALE_SAVE_MESSAGE };
  }

  /**
   * Save `author`'s conversation and authoring state (its sources and
   * bindings describe the bytes) over the record this game runs — an
   * authoring write: storage must still hold this game's revision and the
   * authoring content this tab holds. A newer save (another tab, a Keep the
   * game never loaded) refuses as stale with STALE_SAVE_MESSAGE; `files` (a
   * history adoption's) ride the same write. False when storage itself
   * refused.
   */
  async function saveSessionRecord(
    game: BootedGame,
    author: AgentSession,
    files?: Record<string, Uint8Array>,
  ): Promise<boolean> {
    const authoringState = author.getAuthoringState();
    const { provider, model } = author.getProviderContext();
    const saved = await writeOverSaved(game, sessionBase(true), ({ generation }) =>
      updateGameConversation(
        game.projectId!,
        author.getTranscript(),
        author.getSessionId(),
        authoringState,
        provider,
        model,
        files,
        generation,
      ),
    );
    if (saved) advanceAuthoring(game, authoringState);
    return saved;
  }

  /**
   * Save only the conversation `author` grew (see ConversationUpdate) —
   * an Ask, a Studio assist request, an AI settings change. The stored
   * authoring content is left as it is, so another tab's label, lock or
   * binding survives it; the record must still hold this game's revision.
   */
  async function saveConversationRecord(game: BootedGame, author: AgentSession): Promise<boolean> {
    if (game.installed) {
      await saveGameConversationUpdate(
        game.hash ?? game.alias ?? "installed",
        conversationOf(author),
      );
      return true;
    }
    return writeOverSaved(game, sessionBase(false), ({ generation }) =>
      updateProjectConversation(game.projectId!, conversationOf(author), generation),
    );
  }

  async function createGameSession(game: BootedGame, config: LlmConfig): Promise<AgentSession> {
    const stack = await loadAuthoring();
    const authored = game.installed ? null : await loadAuthoredGame(game.projectId!);
    const cached = game.installed
      ? await loadGameConversation(game.hash ?? game.alias ?? "installed")
      : authored;
    // The session holds this record's authoring content from now on: one
    // another tab changed since boot leaves the game stale for authoring.
    hydrateAuthoring(game, cached?.authoringState);
    return stack.AgentSession.fromAuthoredData(
      config,
      logAgent,
      game.files,
      game.words,
      cached ? continuationTranscript(cached, config.provider, config.model) : undefined,
      cached?.provider === config.provider && cached.model === config.model
        ? cached.sessionId
        : undefined,
      cached?.authoringState,
      authored?.library?.profile,
    );
  }

  function attachSessionRuntime(
    s: AgentSession,
    game: BootedGame,
    profile = state.profile ?? "unknown",
  ): void {
    s.setRuntime({
      frames: { read: readFrames },
      engine: engineSource,
      checkpoint: checkpointSource,
      // Map-pinned intent is visible to read_room_context for any room the
      // agent inspects, not just the one a request names.
      roomNotes: (room) => getRoomNotes?.(room) ?? [],
      referenceArt: projectReferenceArt,
    });
    if (game.installed || (game.projectId && getCachedGameMeta(game.projectId)?.imported)) {
      s.setOrientation({
        game: game.alias ?? game.projectId ?? game.hash ?? "game",
        profile,
      });
    }
    // Baseline checkpoint: the tape names the state this session begins
    // from, so a rewind to before its first commit restores it intact.
    if (getBootedGame() === game) postSessionSnapshot(s);
  }

  async function getOrCreateSession(game: BootedGame, config: LlmConfig): Promise<AgentSession> {
    if (!session) {
      session = await createGameSession(game, config);
    }
    return session;
  }

  function getSession(): AgentSession | null {
    return session;
  }

  function setSession(s: AgentSession | null): void {
    session = s;
  }

  function isRemixNeedsSave(): boolean {
    return remixNeedsSave;
  }

  function setRemixNeedsSave(value: boolean): void {
    remixNeedsSave = value;
  }

  function resetSession(): void {
    session?.task.cancel();
    session = null;
    // A room answer the link will never post for this game: its install is
    // not confirmed, and nothing waits on it any longer.
    roomDelivery?.reject(new Error("the game was left before the room arrived"));
    roomDelivery = null;
    pendingReferences.splice(0);
    remixNeedsSave = false;
  }

  /**
   * Enter remix mode: pause the interpreter, freeze ego in place, and open
   * the assistant bubble for the current room.
   */
  async function openPowerUp(config: LlmConfig): Promise<void> {
    if (state.powerUp.busy) return;
    if (state.powerUp.open && state.powerUp.mode === "room") return;
    if (state.powerUp.mode === "room") state.powerUp.mode = "remix";
    pauseEngine("powerUp");
    state.powerUp.open = true;
    state.powerUp.busy = true;
    state.powerUp.reply = "";
    // A game behind a newer save keeps saying so until it reloads.
    const current = getBootedGame();
    const behind = current !== null && needsReload(current);
    state.powerUp.error = behind ? STALE_SAVE_MESSAGE : "";
    state.powerUp.offerReload = behind;
    // Whether a model is connected is known before the engine answers: the
    // drawer opens on Connect AI, never on a prompt line that then vanishes.
    state.powerUp.needsConfig = session
      ? !session.isConfigured()
      : getBootedGame() !== null && config.provider !== "stub" && !config.apiKey.trim();
    state.powerUp.feedStart = state.agentLog.length;
    state.powerUp.feedStartSeq = (state.agentLog.at(-1)?.seq ?? 0) + 1;
    try {
      const engineState = await query("state");
      state.powerUp.room = Number(engineState?.room ?? 0);
      // Re-decided below against the session and game as they stand now.
      state.powerUp.needsConfig = false;
      const booted = getBootedGame();
      if (!session && booted) {
        if (config.provider !== "stub" && !config.apiKey.trim()) {
          state.powerUp.needsConfig = true;
          return;
        }
        session = await createGameSession(booted, config);
      }
      if (!session) throw new Error("no game is running");
      state.powerUp.messages = session.getMessages();
      if (!session.isConfigured()) {
        state.powerUp.needsConfig = true;
        return;
      }
      attachSessionRuntime(
        session,
        booted!,
        String(engineState?.profile ?? state.profile ?? "unknown"),
      );
    } catch (e) {
      state.powerUp.error = String(e);
    } finally {
      state.powerUp.busy = false;
    }
  }

  /** Apply shared AI settings to the next turn without replacing authored game state. */
  async function updateAiConfig(config: LlmConfig): Promise<void> {
    if (state.powerUp.busy)
      throw new Error("Wait for the current agent task to finish before changing AI settings.");

    const current = session;
    let replacement: AgentSession;
    if (current) {
      replacement = current.reconfigure(config);
      replacement.setRuntime({
        frames: { read: readFrames },
        engine: engineSource,
        checkpoint: checkpointSource,
        referenceArt: projectReferenceArt,
      });
    } else {
      const game = getBootedGame();
      if (!game) return;
      replacement = await createGameSession(game, config);
      if (getBootedGame() !== game || session)
        throw new Error("The game changed while applying AI settings. Try again.");
      attachSessionRuntime(replacement, game);
    }

    session = replacement;
    state.agentTask = replacement.task.snapshot();
    state.powerUp.messages = replacement.getMessages();
    state.powerUp.needsConfig = !replacement.isConfigured();
    state.powerUp.error = "";

    const game = getBootedGame();
    if (!game) return;
    try {
      if (!(await saveConversationRecord(game, replacement)))
        logAgent("error", "Browser storage could not save the updated AI session.");
    } catch (error) {
      if (error instanceof ResourceCommitError && error.code === "stale") {
        // The settings apply; the newer save is left as it is.
        state.powerUp.error = error.message;
        state.powerUp.offerReload = true;
      } else logAgent("error", "Browser storage could not save the updated AI session.");
    }
  }

  /** Close the bubble without asking for anything; the world resumes untouched. */
  function closePowerUp(): void {
    if (state.powerUp.busy) return;
    state.powerUp.open = false;
    state.powerUp.busy = false;
    resumeEngine("powerUp");
  }

  /**
   * The durable half of an AI turn: `files` and the session describing them
   * as one project snapshot — over the record this game runs (an authoring
   * write: storage must still hold the game's revision and this tab's
   * authoring content), or as a new remix for an installed edition or a
   * changed catalog entry. Returns the booted game that owns the record now:
   * this one, or its remix, still at the revision the running game
   * confirmed. The caller moves it on once the running game holds `files`.
   */
  async function saveTurn(
    game: BootedGame,
    author: AgentSession,
    files: Record<string, Uint8Array>,
  ): Promise<BootedGame> {
    await getAutosaveWrite();
    if (getBootedGame() !== game) throw new Error("The game changed while saving the remix.");
    const context = author.getProviderContext();
    const words = files["WORDS.TOK"]
      ? parseWordsTok(files["WORDS.TOK"]).map(({ word, id }) => [word, id] as [string, number])
      : game.words;
    const authoringState = author.getAuthoringState();
    const writtenRev = planRevisionOf(author);
    const base: SavedBase = { authoring: true, message: STALE_TURN_MESSAGE };
    // A write landing since boot (a Keep whose install never arrived,
    // another tab) is newer than these files: refuse rather than overwrite
    // it, and let the write below stay conditional on this read.
    const saved = game.installed ? null : await requireSaved(game, base);
    const original = saved?.data ?? null;
    const revision = await gameRevision(files);
    const unavailable = new Error(
      "Browser storage could not save this remix. Use Settings → This game → Download game… to keep it.",
    );
    const catalogChanged =
      original?.library?.source === "catalog" && original.library.revision !== revision;
    let owner = game;
    if (game.installed || catalogChanged) {
      const remixProjectId = requireProjectId(`remix-${crypto.randomUUID()}`);
      // The parent's project is its own storage key: an authored entry's id,
      // an installed edition's folder/hash. When none resolves there is no
      // parent identity to record.
      const parentProject =
        original?.projectId ?? game.projectId ?? projectId(gameStorageKey(game)) ?? undefined;
      const data: Omit<CachedGameData, "projectId" | "authoredAt"> = {
        title: `${original?.title ?? game.title} Remix`,
        library: {
          ...original?.library,
          version: 1,
          revision,
          source: "remix",
          catalog: undefined,
          preview: undefined,
          parent: parentProject
            ? {
                project: parentProject,
                revision: original?.library?.revision ?? (await gameRevision(game.files)),
              }
            : undefined,
          validation: {
            status: "unverified",
            message: "Remixed resources. Check the opening to create a new preview.",
          },
        },
        files,
        words,
        ...context,
        transcript: author.getTranscript(),
        sessionId: author.getSessionId(),
        authoringState,
        imported: true,
        roomGeneration: false,
      };
      const historyLifetime = await saveAuthoredGameWithLifetime(remixProjectId, data);
      if (historyLifetime === null) throw unavailable;
      // The checkpoint moves with the progress: the original card must never
      // offer a snapshot taken under resources its own container does not have.
      clearAutosave(gameStorageKey(game));
      // The remix runs on in the same worker, on the bytes it confirmed.
      owner = {
        installed: false,
        projectId: remixProjectId,
        historyLifetime,
        alias: game.alias,
        title: data.title,
        revision: game.revision,
        files: game.files,
        words: game.words,
        authoredGame: { ...data, projectId: remixProjectId, authoredAt: new Date().toISOString() },
      };
      setBootedGame(owner);
      onRemixCreated?.(remixProjectId);
    } else if (
      !(await updateGameConversation(
        game.projectId!,
        author.getTranscript(),
        author.getSessionId(),
        authoringState,
        context.provider,
        context.model,
        files,
        saved!.generation,
      ))
    ) {
      // A write that won the race since the gate refuses as stale.
      await requireSaved(game, base);
      throw unavailable;
    }
    advanceAuthoring(owner, authoringState);
    remixNeedsSave = false;
    reportPlanSaved(writtenRev);
    return owner;
  }

  async function persistRemix(
    game: BootedGame,
    author: AgentSession,
    files: Record<string, Uint8Array>,
  ): Promise<void> {
    await updateBootedResources(await saveTurn(game, author, files), files);
  }

  /** The running game an install of `owner`'s saved files goes to, as it stands now. */
  function runningGame(owner: BootedGame, author: AgentSession): RunningGame {
    const worker = getWorker();
    return {
      game: owner,
      worker,
      awaitPatched: options.awaitPatched,
      query,
      current: () => getBootedGame() === owner && getWorker() === worker && session === author,
    };
  }

  /**
   * Save the conversation a turn that wrote no resources grew (Ask, a Studio
   * assist request) — never its authoring content. A project that moved past
   * the running game refuses as stale (STALE_SAVE_MESSAGE) and keeps its
   * newer save.
   */
  async function saveConversation(booted: BootedGame, author: AgentSession): Promise<void> {
    if (!(await saveConversationRecord(booted, author)))
      throw new Error(
        "Conversation could not be saved. Use Settings → This game → Download game… to keep it.",
      );
  }

  /**
   * One Studio assist request from Room Studio or Sprite Studio on the game's
   * session (created on first use, as the assistant's is). The candidate it
   * returns is data for the Studio to preview; no resource is written here.
   * A conversation that cannot be saved is logged, never a failed request —
   * except over a newer save: that refuses as stale (STALE_SAVE_MESSAGE),
   * the request's answer with it, and only a reload from storage continues.
   */
  async function runStudioAssist(
    request: StudioAssistRequest,
    config: LlmConfig,
  ): Promise<StudioAssistResult> {
    if (state.powerUp.busy) throw new Error("Wait for the current agent task to finish.");
    const booted = getBootedGame();
    if (!booted) throw new Error("No game is running.");
    if (!session) {
      if (config.provider !== "stub" && !config.apiKey.trim())
        throw new Error("Connect an API key in AI settings before asking the Studio assistant.");
      const created = await createGameSession(booted, config);
      if (getBootedGame() !== booted || session)
        throw new Error("The game changed while connecting the AI. Try again.");
      attachSessionRuntime(created, booted);
      session = created;
    }
    const author = session;
    const result = await author.runStudioAssist(request);
    if (getBootedGame() === booted && session === author)
      await saveConversation(booted, author).catch((error: unknown) => {
        if (error instanceof ResourceCommitError) throw error;
        logAgent(
          "error",
          `Browser storage could not save the Studio conversation: ${String(error)}`,
        );
      });
    return result;
  }

  /**
   * Run one remix turn: the agent loops over its tools (streamed into the
   * bubble through logAgent), then everything it patched goes into the live
   * container, the room re-enters if the current room changed underneath the
   * player, and the interpreter resumes on exactly the cycle it parked on.
   */
  async function submitPowerUp(
    instruction: string,
    referenceIds?: readonly string[],
  ): Promise<void> {
    if (!session || state.powerUp.busy || state.powerUp.mode === "room") return;
    if (!session.isConfigured()) {
      state.powerUp.needsConfig = true;
      return;
    }
    state.powerUp.busy = true;
    state.powerUp.error = "";
    state.powerUp.offerReload = false;
    state.powerUp.messages.push({ role: "user", text: instruction });
    try {
      const room = state.powerUp.room;
      const booted = getBootedGame();
      // Attached references ride the turn as handles: a manifest line and a
      // thumbnail each, marked attached; the agent views what it needs with
      // view_reference (the session's referenceArt source).
      const selectedIds =
        referenceIds ??
        pendingReferences
          .filter((reference) => reference.project === booted?.projectId)
          .map((reference) => reference.id);
      const attachments = { referenceIds: selectedIds };
      for (const id of selectedIds) removePendingReference(id);
      if (state.powerUp.mode === "ask") {
        const text = await session.runAsk(instruction, room, attachments);
        state.powerUp.reply = text;
        state.powerUp.messages.push({ role: "assistant", text });
        if (booted) await saveConversation(booted, session);
        return;
      }
      if (!booted) throw new Error("No game is running.");
      // The revision this turn builds on: the stored project must still hold
      // it when the staged result commits — the same gate a Keep applies.
      // A write already ahead fails fast, before the turn spends; the same
      // check inside the turn's commit gate catches one landing mid-turn.
      const turnBase = turnBaseGuard(booted);
      await turnBase();
      const { text, patched, files } = await session.runPowerUp(
        instruction,
        room,
        attachments,
        turnBase,
      );
      state.powerUp.reply = text;
      state.powerUp.messages.push({ role: "assistant", text });
      remixNeedsSave = true;
      // Storage is the source of truth, and the remixed file set the patch
      // traffic will produce is computed with the same container code — so
      // the durable write runs first: a refused save installs nothing, and
      // the running game follows only once it confirms the saved files.
      const currentFiles = await query("exportFiles");
      if (!currentFiles) throw new Error("The remixed game snapshot is unavailable.");
      const container = openContainer(new Map(Object.entries(currentFiles)));
      for (const res of patched) container.putResource(res.kind, res.num, res.payload);
      for (const name of ["WORDS.TOK", "OBJECT", "TESTS.JSON"] as const) {
        const payload = files?.[name];
        if (payload) container.putFile(name, payload);
      }
      const saved: SavedFiles = { files: Object.fromEntries(container.files) };
      const owner = await saveTurn(booted, session, saved.files);
      const running = runningGame(owner, session);
      await installSaved(running, saved, { resources: patched, metadata: files }, "The remix");
      // The tape checkpoint rides the same ordered queue: it lands after
      // the commit's patches, so a take between them restores the state
      // that produced them.
      postSessionSnapshot();
      const touchedRoom = patched.some(
        (p) =>
          ((p.kind === "logic" || p.kind === "picture") && p.num === room) || p.kind === "view",
      );
      if (touchedRoom) {
        logAgent("log", `Re-entering room ${room} so the patch takes effect.`);
        running.worker!.postMessage({ type: "reenter", room } satisfies WorkerInbound);
      }
      await flushAutosave(2000);
      state.powerUp.open = false;
      resumeEngine("powerUp");
    } catch (e) {
      if (e instanceof ResourceCommitError && (e.code === "stale" || e.code === "install")) {
        // A plain sentence for the panel, and the recovery it names: the
        // game reloads from the project storage holds.
        state.powerUp.error = e.message;
        state.powerUp.offerReload = true;
      } else {
        state.powerUp.error = String(e);
      }
    } finally {
      state.powerUp.busy = false;
    }
  }

  async function handleRoomAuthoring(
    req: LlmRequest,
    agent: AgentHandler,
    sendDirection: (dir: number) => void,
  ): Promise<string> {
    if (state.powerUp.busy) throw new Error("Wait for the current agent task to finish.");
    const game = getBootedGame();
    let author = getSession();
    // A game that writes its rooms creates its session on the first one;
    // the session (and the authoring stack it loads) comes up under the
    // room progress below.
    let sessionConfig: LlmConfig | null = null;
    if (!author && game && !game.installed && game.projectId) {
      const meta = getCachedGameMeta(game.projectId);
      if (meta?.roomGeneration && configForGame && getLlmConfig) {
        const config = configForGame(game.projectId, getLlmConfig());
        if (config.provider === "stub" || Boolean(config.apiKey.trim())) sessionConfig = config;
      }
    }
    if (!author && !sessionConfig) {
      state.powerUp.needsConfig = true;
      throw new Error("The next room could not be created. Connect your model and try again.");
    }
    state.powerUp = {
      mode: "room",
      messages: author?.getMessages() ?? [],
      open: true,
      needsConfig: false,
      busy: true,
      feedStart: state.agentLog.length,
      feedStartSeq: (state.agentLog.at(-1)?.seq ?? 0) + 1,
      reply: "",
      room: Number(req.context["room"]),
      error: "",
    };
    const progress = state.powerUp;
    sendDirection(0);
    // Map-pinned intent travels with the request: the room prompt carries it
    // and the request log shows what the player asked for.
    const notes = getRoomNotes?.(Number(req.context["room"])) ?? [];
    if (notes.length) req.context = { ...req.context, playerNotes: notes };
    try {
      if (!author) {
        author = await createGameSession(game!, sessionConfig!);
        attachSessionRuntime(author, game!);
        setSession(author);
        progress.messages = author.getMessages();
      }
      // The stored-project gate remix and map-build turns commit through:
      // refuse before the turn spends, and again before its staged room
      // lands in the session. A refusal rejects this request, so the worker
      // declines the room: the player stays put and play resumes.
      const turnBase = turnBaseGuard(game);
      await turnBase();
      const result = await agent.handle(req, turnBase);
      if (!result)
        throw new Error("The next room could not be created. Connect your model and try again.");
      if (state.powerUp === progress) {
        state.powerUp.open = false;
        if (game && getBootedGame() === game && author && game.projectId) {
          const writtenRev = planRevisionOf(author);
          const saved: SavedFiles = { files: Object.fromEntries(author.state.getFiles()) };
          const authoringState = author.getAuthoringState();
          const { provider, model } = author.getProviderContext();
          // Conditional on the generation that still holds the turn's base,
          // so a write landing after the gate refuses this one too; storage
          // failing leaves the room playable but unsaved.
          const base: SavedBase = { authoring: true, message: STALE_TURN_MESSAGE };
          const stored = await writeOverSaved(game, base, ({ generation }) =>
            updateGameConversation(
              game.projectId!,
              author!.getTranscript(),
              author!.getSessionId(),
              authoringState,
              provider,
              model,
              saved.files,
              generation,
            ),
          );
          if (stored) {
            advanceAuthoring(game, authoringState);
            reportPlanSaved(writtenRev);
            confirmRoom(runningGame(game, author), saved, Number(req.context["room"]));
          } else logAgent("error", "Browser storage could not save the room conversation.");
        }
      }
      return result;
    } catch (error) {
      if (state.powerUp === progress) {
        if (error instanceof ResourceCommitError && error.code === "stale") {
          // The sentence and recovery a refused remix turn offers.
          state.powerUp.error = error.message;
          state.powerUp.offerReload = true;
        } else state.powerUp.error = String(error);
      }
      throw error;
    } finally {
      if (state.powerUp === progress) state.powerUp.busy = false;
    }
  }

  /**
   * Extend the running game from the world map: author one planned room
   * through the same room turn just-in-time authoring uses, then apply the
   * response the way the worker's room path would — validate against the
   * live container, patch the running game, persist the project snapshot.
   * The build holds its own pause: closing the map mid-build must not let
   * play resume into a room whose authoring turn is still in flight.
   */
  async function buildRoomFromMap(
    room: number,
    from: number,
    notes: string[],
    exitName?: string,
  ): Promise<void> {
    const game = getBootedGame();
    if (!game || game.installed || !game.projectId)
      throw new Error("Building from the map extends a game authored here.");
    if (state.powerUp.busy) throw new Error("Wait for the current agent task to finish.");
    pauseEngine("mapBuild");
    try {
      const config =
        configForGame && getLlmConfig ? configForGame(game.projectId, getLlmConfig()) : null;
      if (!config || (config.provider !== "stub" && !config.apiKey.trim()))
        throw new Error("Connect your AI provider to build a room from the map.");
      const author = await getOrCreateSession(game, config);
      attachSessionRuntime(author, game);
      // The same stored-project gate a remix turn commits through: refuse
      // before the turn spends, and again before its staged room lands.
      const turnBase = turnBaseGuard(game);
      await turnBase();
      logAgent("request", `[Map build] room ${room} from room ${from}`, { room, from, notes });
      const response = await author.handle(
        {
          op: "room",
          context: {
            room,
            from,
            state: await query("state"),
            objects: await query("objects"),
            ...(notes.length ? { playerNotes: notes } : {}),
            ...(exitName ? { plannedExit: exitName } : {}),
          },
        },
        turnBase,
      );
      if (!response) throw new Error(`Room ${room} could not be created.`);
      const files = await query("exportFiles");
      if (!files || getBootedGame() !== game)
        throw new Error("The game changed while the room was being authored.");
      const container = openContainer(new Map(Object.entries(files)));
      const dictionary = new Map(
        parseWordsTok(files["WORDS.TOK"] ?? new Uint8Array()).map(
          (entry) => [entry.word, entry.id] as [string, number],
        ),
      );
      // The same gate the worker's suspended path applies: the whole staged
      // set is validated before anything lands — dictionary may only grow,
      // rewrites of other rooms' resources commit or fail as one transaction,
      // and the room needs logic plus picture.
      const { prepareRoomPatch } = await loadAuthoring();
      const compiled = prepareRoomPatch(
        container,
        room,
        response,
        dictionary,
        author.state.profile,
      );
      const wordsPayload = buildWordsTok(compiled.words.map(([word, id]) => ({ word, id })));
      const metadataFiles = {
        "WORDS.TOK": wordsPayload,
        ...(compiled.objects ? { OBJECT: compiled.objects } : {}),
        ...(compiled.tests ? { "TESTS.JSON": compiled.tests } : {}),
      };
      // Storage is the source of truth: the committed file set is computed
      // with the same container code the worker's patch handler runs, so the
      // durable write runs first — a refused save installs nothing.
      container.putFile("WORDS.TOK", wordsPayload);
      if (compiled.objects) container.putFile("OBJECT", compiled.objects);
      if (compiled.tests) container.putFile("TESTS.JSON", compiled.tests);
      for (const res of compiled.resources) container.putResource(res.kind, res.num, res.payload);
      const saved: SavedFiles = { files: Object.fromEntries(container.files) };
      const owner = await saveTurn(game, author, saved.files);
      await installSaved(
        runningGame(owner, author),
        saved,
        { resources: compiled.resources, metadata: metadataFiles },
        `Room ${room}`,
      );
      postSessionSnapshot(author);
    } finally {
      resumeEngine("mapBuild");
    }
  }

  /**
   * A room written mid-play reaches the running game as the worker's own
   * answer to its request, posted once this turn returns. The booted game
   * follows the saved room only when the running game confirms it holds it
   * (confirmSaved); a declined or lost answer leaves the game behind storage
   * and says so, since no panel waits for it by then.
   */
  function confirmRoom(running: RunningGame, saved: SavedFiles, room: number): void {
    const delivered = new Promise<void>((resolve, reject) => {
      roomDelivery = { resolve, reject };
    });
    confirmSaved(running, saved, delivered, `Room ${room}`).catch((error: unknown) => {
      logAgent("error", error instanceof Error ? error.message : String(error));
      onBehindStorage?.();
    });
  }

  function roomAnswered(): void {
    roomDelivery?.resolve();
    roomDelivery = null;
    postSessionSnapshot();
  }

  /** A write landed: record the revision it carried — captured before the
   *  persist, since the world can move while the write is in flight. */
  function reportPlanSaved(rev: string): void {
    if (rev) state.planDurableRev = rev;
  }

  /** The revision of the authoring state as it stands this tick. */
  function planRevisionOf(author: AgentSession): string {
    return worldRevision(author.state.authoring.world);
  }

  /**
   * Store the session's authoring state — plan edits the map committed.
   * The boolean is the durable outcome the map's dirty tracking needs:
   * false for a refused write and for a game with no project to write to
   * (installed/imported), so a newer edit is never labeled saved.
   */
  async function persistSessionState(): Promise<boolean> {
    const game = getBootedGame();
    const author = session;
    if (!game || game.installed || !game.projectId || !author) return false;
    const writtenRev = planRevisionOf(author);
    // A newer save refuses as stale (thrown): the plan edit stays unsaved.
    const saved = await saveSessionRecord(game, author);
    if (!saved) logAgent("error", "Browser storage could not save the updated world plan.");
    else reportPlanSaved(writtenRev);
    // The committed world plan is a tape checkpoint too: a Resume here
    // adoption installs the snapshot that belongs to the adopted bytes.
    postSessionSnapshot();
    return saved;
  }

  /**
   * The session's authoring state lands on the tape as an `authoring`
   * cause. Posted after every commit — the baseline at attach, each remix
   * patch, each room answer, each world-plan commit — so the tape always
   * names the state a take should restore. A no-op while no segment is
   * live; the adoption fallback (same-revision carry) covers that gap.
   */
  function postSessionSnapshot(author: AgentSession | null = session): void {
    if (!author) return;
    // The world may have moved — plan surfaces re-read it even when no
    // resource changed (a plan-only update_world produces no patch).
    state.worldTick++;
    getWorker()?.postMessage({
      type: "authoring",
      snapshot: author.snapshotAuthoring(),
    } satisfies WorkerInbound);
  }

  /**
   * The session leg of a history adoption, run after the worker acked: the
   * session rebuilds its state on the adopted boot (the tape's checkpoint,
   * the kept record's snapshot, or a same-revision carry), the booted game
   * and stored project follow to the same revision. A throw leaves the
   * session's adoption hold set — the next successful adoption releases it.
   */
  async function adoptSessionState(
    game: BootedGame,
    boot: HistoryBoot,
    snapshot: unknown,
  ): Promise<void> {
    const files: Record<string, Uint8Array> = {};
    for (const [name, data] of Object.entries(boot.files)) files[name] = base64ToBytes(data);
    const words = boot.dictionary;
    const author = getBootedGame() === game ? session : null;
    if (author) {
      // The bytes must equal the revision the worker reported adopting —
      // a mismatched install throws before touching the session.
      author.adoptAuthoredData(files, words, snapshot, boot.resourceSet);
      if (!game.installed && game.projectId) {
        const writtenRev = planRevisionOf(author);
        // Over the record this game booted on only: a newer save refuses
        // as stale and the adoption hold stays until a reload.
        const saved = await saveSessionRecord(game, author, files);
        if (saved) reportPlanSaved(writtenRev);
        else logAgent("error", "Browser storage could not save the adopted session state.");
      }
    } else if (getBootedGame() === game && !game.installed && game.projectId) {
      // No session: the adopted files alone follow, over the same revision.
      const saved = await writeOverSaved(game, sessionBase(false), ({ generation }) =>
        updateAuthoredGameFiles(game.projectId!, files, generation),
      );
      if (!saved) logAgent("error", "Browser storage could not save the adopted game.");
    }
    await updateBootedResources(game, files, words);
    // Both legs landed: the session describes the bytes the worker runs.
    author?.releaseAdoption();
    state.worldTick++;
  }

  function assembleExportData(
    data: CachedGameData,
    game: BootedGame,
    session: AgentSession | null,
    files: Record<string, Uint8Array>,
  ): CachedGameData {
    return {
      ...data,
      files,
      words: game.words,
      roomGeneration: data.roomGeneration ?? false,
      conversationHistory:
        session &&
        (data.provider !== session.getProviderContext().provider ||
          data.model !== session.getProviderContext().model) &&
        data.transcript?.length
          ? [
              ...(data.conversationHistory ?? []),
              { provider: data.provider, model: data.model, transcript: data.transcript },
            ]
          : data.conversationHistory,
      ...(session
        ? {
            transcript: session.getTranscript(),
            authoringState: session.getAuthoringState(),
            ...session.getProviderContext(),
          }
        : {}),
    };
  }

  /**
   * The project's stored references, freshest copy — the booted game's
   * authoredGame snapshot predates any attach in this session.
   */
  async function listReferences(): Promise<StoredReference[]> {
    const game = getBootedGame();
    if (!game || game.installed || !game.projectId) return [];
    const data = await loadAuthoredGame(game.projectId);
    return data?.references ?? game.authoredGame?.references ?? [];
  }

  /**
   * The booted project's reference art for one turn, as handles; `attached`
   * names the stored records the player attached to the request.
   */
  async function projectReferenceArt(attached: readonly string[]) {
    const references = await listReferences();
    if (!references.length) return undefined;
    const { referenceSource } = await loadAuthoring();
    return referenceSource(references, attached);
  }

  function requireAuthoredBoot(): BootedGame {
    const game = getBootedGame();
    if (!game || game.installed || !game.projectId)
      throw new Error("Reference art attaches to a game authored in this browser.");
    return game;
  }

  /**
   * Mutate the stored reference list atomically: the callback runs inside the
   * serialized write against the freshest read, so a concurrent attachment,
   * removal or stage-clear in another surface or tab cannot be lost.
   */
  async function writeReferences(
    game: BootedGame,
    mutate: (current: StoredReference[]) => StoredReference[] | null,
  ): Promise<void> {
    let applied: StoredReference[] | undefined;
    let overflow = false;
    const saved = await updateAuthoredReferences(game.projectId!, (current) => {
      const next = mutate(current);
      if (next === null) return null;
      if (next.length > REFERENCE_COUNT_LIMIT) {
        overflow = true;
        return null;
      }
      applied = next;
      return next;
    });
    if (overflow)
      throw new Error(
        `This project already has ${REFERENCE_COUNT_LIMIT} references. Remove one before attaching another.`,
      );
    if (!saved || applied === undefined)
      throw new Error(
        "Browser storage could not save the reference. Try again before closing this dialog.",
      );
    if (game.authoredGame) game.authoredGame = { ...game.authoredGame, references: applied };
  }

  async function referencesWithCapacity(): Promise<StoredReference[]> {
    const references = await listReferences();
    if (references.length >= REFERENCE_COUNT_LIMIT)
      throw new Error(
        `This project already has ${REFERENCE_COUNT_LIMIT} references. Remove one before attaching another.`,
      );
    return references;
  }

  async function attachRoomReference(
    decoded: DecodedImage,
    room: number,
    brief: string,
  ): Promise<StoredReference> {
    const game = requireAuthoredBoot();
    await referencesWithCapacity();
    const reference = roomReference(
      `ref-${crypto.randomUUID()}`,
      room,
      brief,
      { project: game.projectId!, revision: game.revision },
      decoded,
    );
    await writeReferences(game, (current) => [...current, reference]);
    pendingReferences.push({
      id: reference.id,
      project: game.projectId!,
      label: `${reference.kind === "room" ? "Room" : "View"} ${reference.target}${brief ? ` — ${brief}` : ""}`,
    });
    return reference;
  }

  async function attachCharacterReference(
    sheets: readonly { decoded: DecodedImage; facing: SheetFacing }[],
    spec: CharacterSheetSpec,
    view: number,
    brief: string,
  ): Promise<StoredReference> {
    const game = requireAuthoredBoot();
    await referencesWithCapacity();
    const reference = stageCharacterView(
      `ref-${crypto.randomUUID()}`,
      view,
      brief,
      { project: game.projectId!, revision: game.revision },
      sheets.map(({ decoded, facing }) => ({ decoded, facing })),
      spec,
    );
    await writeReferences(game, (current) => [...current, reference]);
    pendingReferences.push({
      id: reference.id,
      project: game.projectId!,
      label: `${reference.kind === "room" ? "Room" : "View"} ${reference.target}${brief ? ` — ${brief}` : ""}`,
    });
    return reference;
  }

  async function detachReference(id: string): Promise<void> {
    const game = requireAuthoredBoot();
    await writeReferences(game, (current) => current.filter((reference) => reference.id !== id));
    removePendingReference(id);
  }

  /** Keep resources, source and the consumed offer in one conditional durable write. */
  async function keepStagedView(
    id: string,
    repaired?: Pick<ViewEdit, "bytes" | "baseRevision" | "baseAuthoring">,
  ): Promise<ResourceCommitResult> {
    return commitResourceEdit(stagedViewEdit(requireAuthoredBoot(), id, repaired));
  }

  async function commitPictureEdit(edit: PictureEdit): Promise<ResourceCommitResult> {
    const result = await commitResourceEdit(pictureEdit(edit));
    if (result.status === "committed")
      logAgent(
        "log",
        `Room Studio kept picture ${edit.pictureNumber}${edit.reason ? `: ${edit.reason}` : ""}.`,
      );
    return result;
  }

  async function commitRoomEdit(edit: RoomEdit): Promise<ResourceCommitResult> {
    const result = await commitResourceEdit(roomEdit(edit));
    if (result.status === "committed")
      logAgent(
        "log",
        `Room Studio kept room ${edit.room}${edit.picture ? ` and picture ${edit.picture.pictureNumber}` : ""}${edit.reason ? `: ${edit.reason}` : ""}.`,
      );
    return result;
  }

  async function commitViewEdit(edit: ViewEdit): Promise<ResourceCommitResult> {
    const result = await commitResourceEdit(viewEdit(edit));
    if (result.status === "committed")
      logAgent(
        "log",
        `Sprite Studio kept view ${edit.viewNumber}${edit.reason ? `: ${edit.reason}` : ""}.`,
      );
    return result;
  }

  return {
    openPowerUp,
    closePowerUp,
    submitPowerUp,
    updateAiConfig,
    persistRemix,
    createGameSession,
    attachSessionRuntime,
    getOrCreateSession,
    getSession,
    setSession,
    isRemixNeedsSave,
    setRemixNeedsSave,
    resetSession,
    handleRoomAuthoring,
    roomAnswered,
    buildRoomFromMap,
    persistSessionState,
    postSessionSnapshot,
    adoptSessionState,
    assembleExportData,
    listReferences,
    attachRoomReference,
    attachCharacterReference,
    detachReference,
    keepStagedView,
    commitPictureEdit,
    commitRoomEdit,
    commitViewEdit,
    runStudioAssist,
  };
}
