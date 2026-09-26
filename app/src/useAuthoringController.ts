import { AgentSession } from "./agent/agentSession.ts";
import type { AgentHandler, LlmRequest } from "./agent/hostRequests.ts";
import type { AgentRunState } from "./agent/agentRun.ts";
import type { AgentLogEntry } from "./agent/agentLog.ts";
import type { LlmConfig } from "./agent/llmClient.ts";
import type { AgentFrame, FrameRequest } from "../../src/agent/frames.ts";
import { continuationTranscript } from "./projectArchive.ts";
import { gameRevision, updateBootedResources } from "./gameMetadata.ts";
import { buildWordsTok, parseWordsTok } from "../../src/logic/words.ts";
import { openContainer } from "../../src/container/container.ts";
import { prepareRoomPatch } from "../../src/agent/roomPatch.ts";
import {
  createResourceCommit,
  pictureEdit,
  stagedViewEdit,
  type PictureEdit,
  type ResourceCommitResult,
} from "./resourceCommit.ts";
import {
  getCachedGameMeta,
  loadAuthoredGame,
  loadGameConversation,
  saveAuthoredGameWithLifetime,
  saveGameConversation,
  updateAuthoredReferences,
  updateGameConversation,
  type CachedGameData,
} from "./gameStorage.ts";
import {
  REFERENCE_COUNT_LIMIT,
  referenceAgentImages,
  roomReference,
  stageCharacterView,
  type DecodedImage,
  type StoredReference,
} from "./referenceArt.ts";
import type { CharacterSheetSpec, SheetFacing } from "../../src/view/characterSheet.ts";
import { worldRevision } from "../../src/agent/worldPlan.ts";
import { gameStorageKey, type BootedGame } from "./gameTypes.ts";
import { projectId, requireProjectId, type ProjectId } from "../../src/gameIdentity.ts";
import type { LogAgentFn } from "./useInputController.ts";
import type { WorkerInbound, WorkerQueryFn } from "./workerProtocol.ts";
import type { AwaitPatchedFn } from "./workerQueries.ts";
import type { HistoryBoot } from "../../src/agent/history.ts";
import { base64ToBytes } from "./bytes.ts";
import { pendingReferences, removePendingReference } from "./referenceUploadState.ts";

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
}

export interface AuthoringController {
  openPowerUp(config: LlmConfig): Promise<void>;
  closePowerUp(): void;
  submitPowerUp(instruction: string, referenceIds?: readonly string[]): Promise<void>;
  updateAiConfig(config: LlmConfig): Promise<void>;
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
  /** Author one planned room's resources into the running game (map build). */
  buildRoomFromMap(room: number, from: number, notes: string[], exitName?: string): Promise<void>;
  /** Persist the session's authoring state; false when storage refused or
   *  there is no project to write to. */
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
   */
  keepStagedView(id: string): Promise<void>;
  /**
   * Commit Room Studio's picture edit — bytes plus the source that compiles
   * to them — to storage and the running game as one transaction. Throws a
   * ResourceCommitError; "unchanged" when there was nothing to write.
   */
  commitPictureEdit(edit: PictureEdit): Promise<ResourceCommitResult>;
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
  } = options;

  let session: AgentSession | null = null;
  let remixNeedsSave = false;

  const commitResourceEdit = createResourceCommit({
    ...options,
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

  async function createGameSession(game: BootedGame, config: LlmConfig): Promise<AgentSession> {
    const authored = game.installed ? null : await loadAuthoredGame(game.projectId!);
    const cached = game.installed
      ? await loadGameConversation(game.hash ?? game.alias ?? "installed")
      : authored;
    return AgentSession.fromAuthoredData(
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
    state.powerUp.error = "";
    state.powerUp.needsConfig = false;
    state.powerUp.feedStart = state.agentLog.length;
    state.powerUp.feedStartSeq = (state.agentLog.at(-1)?.seq ?? 0) + 1;
    try {
      const engineState = await query("state");
      state.powerUp.room = Number(engineState?.room ?? 0);
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
    const context = replacement.getProviderContext();
    try {
      if (game.installed) {
        await saveGameConversation(game.hash ?? game.alias ?? "installed", {
          ...context,
          transcript: replacement.getTranscript(),
          sessionId: replacement.getSessionId(),
          authoringState: replacement.getAuthoringState(),
        });
      } else if (
        !(await updateGameConversation(
          game.projectId!,
          replacement.getTranscript(),
          replacement.getSessionId(),
          replacement.getAuthoringState(),
          context.provider,
          context.model,
        ))
      ) {
        logAgent("error", "Browser storage could not save the updated AI session.");
      }
    } catch {
      logAgent("error", "Browser storage could not save the updated AI session.");
    }
  }

  /** Close the bubble without asking for anything; the world resumes untouched. */
  function closePowerUp(): void {
    if (state.powerUp.busy) return;
    state.powerUp.open = false;
    state.powerUp.busy = false;
    resumeEngine("powerUp");
  }

  /** Persist resource bytes and their matching authoring history as one project snapshot. */
  async function persistRemix(
    game: BootedGame,
    author: AgentSession,
    files: Record<string, Uint8Array>,
  ): Promise<void> {
    await getAutosaveWrite();
    if (getBootedGame() !== game) throw new Error("The game changed while saving the remix.");
    const context = author.getProviderContext();
    const words = files["WORDS.TOK"]
      ? parseWordsTok(files["WORDS.TOK"]).map(({ word, id }) => [word, id] as [string, number])
      : game.words;
    const original = game.installed ? null : await loadAuthoredGame(game.projectId!);
    const revision = await gameRevision(files);
    const catalogChanged =
      original?.library?.source === "catalog" && original.library.revision !== revision;
    let writtenRev: string;
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
        authoringState: author.getAuthoringState(),
        imported: true,
        roomGeneration: false,
      };
      writtenRev = planRevisionOf(author);
      const historyLifetime = await saveAuthoredGameWithLifetime(remixProjectId, data);
      if (historyLifetime === null)
        throw new Error(
          "Browser storage could not save this remix. Use Game → Download game… to keep it.",
        );
      // The checkpoint moves with the progress: the original card must never
      // offer a snapshot taken under resources its own container does not have.
      clearAutosave(gameStorageKey(game));
      const newBooted: BootedGame = {
        installed: false,
        projectId: remixProjectId,
        historyLifetime,
        alias: game.alias,
        title: `${original?.title ?? game.title} Remix`,
        revision,
        files,
        words,
        authoredGame: { ...data, projectId: remixProjectId, authoredAt: new Date().toISOString() },
      };
      setBootedGame(newBooted);
      onRemixCreated?.(remixProjectId);
    } else {
      writtenRev = planRevisionOf(author);
      if (
        !(await updateGameConversation(
          game.projectId!,
          author.getTranscript(),
          author.getSessionId(),
          author.getAuthoringState(),
          context.provider,
          context.model,
          files,
        ))
      ) {
        throw new Error(
          "Browser storage could not save this remix. Use Game → Download game… to keep it.",
        );
      }
    }
    await updateBootedResources(game, files, words);
    remixNeedsSave = false;
    reportPlanSaved(writtenRev);
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
    state.powerUp.messages.push({ role: "user", text: instruction });
    try {
      const room = state.powerUp.room;
      const booted = getBootedGame();
      // Attached references ride the turn as image blocks: the model sees
      // the player's own art, captioned with target and brief.
      const selectedIds =
        referenceIds ??
        pendingReferences
          .filter((reference) => reference.project === booted?.projectId)
          .map((reference) => reference.id);
      const images = selectedIds.length
        ? (await listReferences())
            .filter((reference) => selectedIds.includes(reference.id))
            .flatMap((reference) => referenceAgentImages(reference))
        : undefined;
      for (const id of selectedIds) removePendingReference(id);
      if (state.powerUp.mode === "ask") {
        const text = await session.runAsk(instruction, room, images);
        state.powerUp.reply = text;
        state.powerUp.messages.push({ role: "assistant", text });
        if (booted?.installed) {
          const key = booted.hash ?? booted.alias ?? "installed";
          await saveGameConversation(key, {
            ...session.getProviderContext(),
            transcript: session.getTranscript(),
            sessionId: session.getSessionId(),
            authoringState: session.getAuthoringState(),
          });
        }
        if (booted && !booted.installed) {
          const context = session.getProviderContext();
          const writtenRev = planRevisionOf(session);
          if (
            !(await updateGameConversation(
              booted.projectId!,
              session.getTranscript(),
              session.getSessionId(),
              session.getAuthoringState(),
              context.provider,
              context.model,
            ))
          )
            throw new Error(
              "Conversation could not be saved. Use Game → Download game… to keep it.",
            );
          reportPlanSaved(writtenRev);
        }
        return;
      }
      const { text, patched, files } = await session.runPowerUp(instruction, room, images);
      state.powerUp.reply = text;
      state.powerUp.messages.push({ role: "assistant", text });
      remixNeedsSave = true;
      const worker = getWorker();
      if (files) worker?.postMessage({ type: "patchMetadata", files } satisfies WorkerInbound);
      for (const res of patched) {
        const payload = new Uint8Array(res.payload);
        worker?.postMessage(
          { type: "patch", kind: res.kind, num: res.num, payload } satisfies WorkerInbound,
          [payload.buffer],
        );
      }
      // The tape checkpoint rides the same ordered queue: it lands after
      // the commit's patches, so a take between them restores the state
      // that produced them.
      postSessionSnapshot();
      // Worker messages are ordered: snapshot after every patch has landed, before persisting the matching conversation.
      if (booted) {
        const game = booted;
        const currentFiles = await query("exportFiles");
        if (!currentFiles) throw new Error("The remixed game snapshot is unavailable.");
        await persistRemix(game, session, currentFiles);
      }
      const touchedRoom = patched.some(
        (p) =>
          ((p.kind === "logic" || p.kind === "picture") && p.num === room) || p.kind === "view",
      );
      if (touchedRoom) {
        logAgent("log", `Re-entering room ${room} so the patch takes effect.`);
        worker?.postMessage({ type: "reenter", room } satisfies WorkerInbound);
      }
      await flushAutosave(2000);
      state.powerUp.open = false;
      resumeEngine("powerUp");
    } catch (e) {
      state.powerUp.error = String(e);
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
    if (!author && game && !game.installed && game.projectId) {
      const meta = getCachedGameMeta(game.projectId);
      if (meta?.roomGeneration && configForGame && getLlmConfig) {
        const config = configForGame(game.projectId, getLlmConfig());
        if (config.provider === "stub" || Boolean(config.apiKey.trim())) {
          author = await createGameSession(game, config);
          attachSessionRuntime(author, game);
          setSession(author);
        }
      }
    }
    if (!author) {
      state.powerUp.needsConfig = true;
      throw new Error("The next room could not be created. Connect your model and try again.");
    }
    state.powerUp = {
      mode: "room",
      messages: author.getMessages(),
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
      const result = await agent.handle(req);
      if (!result)
        throw new Error("The next room could not be created. Connect your model and try again.");
      if (state.powerUp === progress) {
        state.powerUp.open = false;
        if (game && getBootedGame() === game && author && game.projectId) {
          const writtenRev = planRevisionOf(author);
          const saved = await updateGameConversation(
            game.projectId,
            author.getTranscript(),
            author.getSessionId(),
            author.getAuthoringState(),
            author.getProviderContext().provider,
            author.getProviderContext().model,
            Object.fromEntries(author.state.getFiles()),
          );
          if (saved) reportPlanSaved(writtenRev);
          else logAgent("error", "Browser storage could not save the room conversation.");
        }
      }
      return result;
    } catch (error) {
      if (state.powerUp === progress) state.powerUp.error = String(error);
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
      logAgent("request", `[Map build] room ${room} from room ${from}`, { room, from, notes });
      const response = await author.handle({
        op: "room",
        context: {
          room,
          from,
          state: await query("state"),
          objects: await query("objects"),
          ...(notes.length ? { playerNotes: notes } : {}),
          ...(exitName ? { plannedExit: exitName } : {}),
        },
      });
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
      const compiled = prepareRoomPatch(
        container,
        room,
        response,
        dictionary,
        author.state.profile,
      );
      const worker = getWorker();
      worker?.postMessage({
        type: "patchMetadata",
        files: {
          "WORDS.TOK": buildWordsTok(compiled.words.map(([word, id]) => ({ word, id }))),
          ...(compiled.objects ? { OBJECT: compiled.objects } : {}),
          ...(compiled.tests ? { "TESTS.JSON": compiled.tests } : {}),
        },
      } satisfies WorkerInbound);
      for (const res of compiled.resources) {
        const payload = new Uint8Array(res.payload);
        worker?.postMessage(
          { type: "patch", kind: res.kind, num: res.num, payload } satisfies WorkerInbound,
          [payload.buffer],
        );
      }
      postSessionSnapshot(author);
      const currentFiles = await query("exportFiles");
      if (!currentFiles || getBootedGame() !== game)
        throw new Error("The game changed while the room was being authored.");
      await persistRemix(game, author, currentFiles);
    } finally {
      resumeEngine("mapBuild");
    }
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
    const context = author.getProviderContext();
    const writtenRev = planRevisionOf(author);
    const saved = await updateGameConversation(
      game.projectId,
      author.getTranscript(),
      author.getSessionId(),
      author.getAuthoringState(),
      context.provider,
      context.model,
    );
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
        const context = author.getProviderContext();
        const writtenRev = planRevisionOf(author);
        const saved = await updateGameConversation(
          game.projectId,
          author.getTranscript(),
          author.getSessionId(),
          author.getAuthoringState(),
          context.provider,
          context.model,
          files,
        );
        if (saved) reportPlanSaved(writtenRev);
        else logAgent("error", "Browser storage could not save the adopted session state.");
      }
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
  async function keepStagedView(id: string): Promise<void> {
    await commitResourceEdit(stagedViewEdit(requireAuthoredBoot(), id));
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
  };
}
