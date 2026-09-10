import { AgentSession } from "./agent/agentSession.ts";
import type { AgentRunState } from "./agent/agentRun.ts";
import type { AgentLogEntry } from "./agent/agentLog.ts";
import type { LlmConfig } from "./agent/llmClient.ts";
import type { AgentFrame, FrameRequest } from "../../src/agent/frames.ts";
import { continuationTranscript } from "./projectArchive.ts";
import { gameRevision } from "./gameMetadata.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
import {
  getCachedGameMeta,
  loadAuthoredGame,
  loadGameConversation,
  saveAuthoredGame,
  saveGameConversation,
  updateGameConversation,
  type CachedGameData,
} from "./gameStorage.ts";
import type { BootedGame } from "./useEngine.ts";
import type { LogAgentFn } from "./useInputController.ts";

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
  };
  readonly getWorker: () => Worker | null;
  readonly query: <T>(type: string, extra?: Record<string, unknown>) => Promise<T>;
  readonly logAgent: LogAgentFn;
  readonly readFrames: (req: FrameRequest) => Promise<AgentFrame[]>;
  readonly pauseEngine: () => void;
  readonly resumeEngine: () => void;
  readonly getBootedGame: () => BootedGame | null;
  readonly setBootedGame: (game: BootedGame | null) => void;
  readonly flushAutosave: (timeoutMs?: number) => Promise<unknown>;
  readonly getAutosaveWrite: () => Promise<boolean>;
  readonly clearAutosave: (targetKey: string) => void;
  readonly onRemixCreated?: ((remixProjectId: string) => void) | undefined;
}

export interface AuthoringController {
  openPowerUp(config: LlmConfig): Promise<void>;
  closePowerUp(): void;
  submitPowerUp(instruction: string): Promise<void>;
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
  } = options;

  let session: AgentSession | null = null;
  let remixNeedsSave = false;

  const engineSource = {
    objects: () => query<unknown>("objects"),
    state: () => query<unknown>("state"),
  };

  async function createGameSession(game: BootedGame, config: LlmConfig): Promise<AgentSession> {
    const cached = game.installed
      ? await loadGameConversation(game.hash ?? game.alias ?? "installed")
      : await loadAuthoredGame(game.projectId!);
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
    );
  }

  function attachSessionRuntime(
    s: AgentSession,
    game: BootedGame,
    profile = state.profile ?? "unknown",
  ): void {
    s.setRuntime({ frames: { read: readFrames }, engine: engineSource });
    if (game.installed || (game.projectId && getCachedGameMeta(game.projectId)?.imported)) {
      s.setOrientation({
        game: game.alias ?? game.projectId ?? game.hash ?? "game",
        profile,
      });
    }
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
    remixNeedsSave = false;
  }

  /**
   * Enter remix mode: pause the interpreter, freeze ego in place, and open
   * the assistant bubble for the current room.
   */
  async function openPowerUp(config: LlmConfig): Promise<void> {
    if (state.powerUp.open && state.powerUp.mode === "room") return;
    if (state.powerUp.mode === "room") state.powerUp.mode = "remix";
    pauseEngine();
    state.powerUp.open = true;
    state.powerUp.busy = true;
    state.powerUp.reply = "";
    state.powerUp.error = "";
    state.powerUp.needsConfig = false;
    state.powerUp.feedStart = state.agentLog.length;
    try {
      const engineState = await query<{ room: number; profile: string } | null>("state");
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
      replacement.setRuntime({ frames: { read: readFrames }, engine: engineSource });
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
    resumeEngine();
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
    if (game.installed || catalogChanged) {
      const remixProjectId = `remix-${crypto.randomUUID()}`;
      const parentProjectId = original?.projectId ?? game.projectId;
      const data: Omit<CachedGameData, "projectId" | "authoredAt"> = {
        title: `${original?.title ?? game.title} Remix`,
        library: {
          ...original?.library,
          version: 1,
          alias: undefined,
          revision,
          source: "remix",
          catalog: undefined,
          preview: undefined,
          parent: {
            ...(parentProjectId ? { projectId: parentProjectId } : {}),
            ...(game.alias ? { alias: game.alias } : {}),
            revision: original?.library?.revision ?? (await gameRevision(game.files)),
          },
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
      if (!(await saveAuthoredGame(remixProjectId, data)))
        throw new Error(
          "Browser storage could not save this remix. Use Game actions → Project to keep it.",
        );
      // The checkpoint moves with the progress: the original card must never
      // offer a snapshot taken under resources its own container does not have.
      clearAutosave(game.installed ? (game.hash ?? game.alias!) : game.projectId!);
      if (game.installed && game.alias) clearAutosave(game.alias);
      const newBooted: BootedGame = {
        installed: false,
        projectId: remixProjectId,
        alias: original?.library?.alias ?? game.alias,
        title: `${original?.title ?? game.title} Remix`,
        revision,
        files,
        words,
        authoredGame: { ...data, projectId: remixProjectId, authoredAt: new Date().toISOString() },
      };
      setBootedGame(newBooted);
      onRemixCreated?.(remixProjectId);
    } else if (
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
        "Browser storage could not save this remix. Use Game actions → Project to keep it.",
      );
    }
    game.files = files;
    game.words = words;
    remixNeedsSave = false;
  }

  /**
   * Run one remix turn: the agent loops over its tools (streamed into the
   * bubble through logAgent), then everything it patched goes into the live
   * container, the room re-enters if the current room changed underneath the
   * player, and the interpreter resumes on exactly the cycle it parked on.
   */
  async function submitPowerUp(instruction: string): Promise<void> {
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
      if (state.powerUp.mode === "ask") {
        const text = await session.runAsk(instruction, room);
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
              "Conversation could not be saved. Use Game actions → Project to keep it.",
            );
        }
        return;
      }
      const { text, patched, files } = await session.runPowerUp(instruction, room);
      state.powerUp.reply = text;
      state.powerUp.messages.push({ role: "assistant", text });
      remixNeedsSave = true;
      const worker = getWorker();
      if (files) worker?.postMessage({ type: "patchMetadata", files });
      for (const res of patched) {
        const payload = new Uint8Array(res.payload);
        worker?.postMessage(
          { type: "patch", kind: res.kind, num: res.num, payload: payload.buffer },
          [payload.buffer],
        );
      }
      // Worker messages are ordered: snapshot after every patch has landed, before persisting the matching conversation.
      if (booted) {
        const game = booted;
        const currentFiles = await query<Record<string, Uint8Array> | null>("exportFiles");
        if (!currentFiles) throw new Error("The remixed game snapshot is unavailable.");
        await persistRemix(game, session, currentFiles);
      }
      const touchedRoom = patched.some(
        (p) =>
          ((p.kind === "logic" || p.kind === "picture") && p.num === room) || p.kind === "view",
      );
      if (touchedRoom) {
        logAgent("log", `Re-entering room ${room} so the patch takes effect.`);
        worker?.postMessage({ type: "reenter", room });
      }
      await flushAutosave(2000);
      state.powerUp.open = false;
      resumeEngine();
    } catch (e) {
      state.powerUp.error = String(e);
    } finally {
      state.powerUp.busy = false;
    }
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
  };
}
