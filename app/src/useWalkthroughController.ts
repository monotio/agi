import type { AgiAudio } from "./audio/AgiAudio.ts";
import type {
  ReplayCheckpointEvent,
  ReplayDriver,
  ReplayObservation,
  ReplayProgressEvent,
} from "./replay.ts";
import { extractCheckpoints, loadWalkthrough, type WalkthroughCheckpoint } from "./walkthrough.ts";
import { findInstalledFolder, type InstalledGameDescriptor } from "./gameTypes.ts";
import type { AgentLogEntry } from "./agent/agentLog.ts";
import type { LlmConfig } from "./agent/llmClient.ts";
import { getCachedGameMeta, type ProjectId } from "./gameStorage.ts";

export interface WalkthroughUiState {
  active: boolean;
  alias: string | null;
  speed: number;
  pauseOnDialog: boolean;
  label: string | null;
  checkpointIndex: number;
  totalCheckpoints: number;
  checkpoints: WalkthroughCheckpoint[];
  room: number | null;
  score: number | null;
  tick: number;
  requestedTick: number;
  totalTicks: number;
  percent: number;
  status: "idle" | "playing" | "paused" | "completed" | "stopped" | "error";
  seeking: boolean;
  scrubbing: boolean;
  error: string;
}

export function createInitialWalkthroughState(): WalkthroughUiState {
  return {
    active: false,
    alias: null,
    speed: 1,
    pauseOnDialog: false,
    label: null,
    checkpointIndex: 0,
    totalCheckpoints: 0,
    checkpoints: [],
    room: null,
    score: null,
    tick: 0,
    requestedTick: 0,
    totalTicks: 0,
    percent: 0,
    status: "idle",
    seeking: false,
    scrubbing: false,
    error: "",
  };
}

export interface WalkthroughControllerContext {
  readonly state: {
    readonly walkthrough: WalkthroughUiState;
    readonly phase: "idle" | "loading" | "running" | "error";
    readonly error: string;
    readonly installedGames?: readonly (string | InstalledGameDescriptor)[] | null | undefined;
    soundPlaying: boolean;
    resumed: boolean;
  };
  readonly audio: AgiAudio;
  readonly replayDriver: ReplayDriver;
  readonly getWorker: () => Worker | null;
  readonly isCurrentGame: (targetGame: string) => boolean;
  readonly nextSessionId: () => number;
  readonly getActiveSessionId: () => number;
  readonly setActiveReplaySeed: (seed: number | null) => void;
  readonly observationListeners: Set<(obs: ReplayObservation) => void>;
  readonly cancelPendingBridgeWaits: () => void;
  readonly drainPendingQueries: (err: Error) => void;
  readonly bootGame: (targetFolder: string) => Promise<void>;
  readonly bootAuthoredGame: (
    prompt: string,
    config: LlmConfig,
    options?: { projectId?: ProjectId; title?: string; useCached?: boolean },
  ) => Promise<void>;
  readonly configForGame: (projectId: ProjectId, config: LlmConfig) => LlmConfig;
  readonly ejectGame: () => Promise<void>;
  readonly sendDirection: (dir: number) => void;
  readonly logAgent: (kind: AgentLogEntry["kind"], message: string, details?: unknown) => void;
  readonly isInstalledGame: (targetGame: string) => boolean;
  readonly onWalkthroughReset: () => void;
}

export interface WalkthroughController {
  startWalkthrough(
    targetGame: string,
    options?: { speed?: number; initialTick?: number; keepPaused?: boolean } | number,
  ): Promise<void>;
  stopWalkthrough(takeControl?: boolean): Promise<void>;
  seekToTick(targetTick: number, options?: { keepPaused?: boolean }): Promise<void>;
  seekToCheckpoint(cp: WalkthroughCheckpoint): Promise<void>;
  pauseWalkthrough(): void;
  resumeWalkthrough(): void;
  toggleWalkthroughPause(): void;
  setWalkthroughSpeed(speed: number): void;
  toggleWalkthroughPauseOnDialog(): void;
  advanceDialog(): boolean;
  abort(): void;
}

export function useWalkthroughController(ctx: WalkthroughControllerContext): WalkthroughController {
  const { state, audio, replayDriver } = ctx;
  let walkthroughAbortController: AbortController | null = null;
  let seekTargetTick: number | null = null;
  const resumeWaiters = new Set<() => void>();
  let skipDialogDwell: (() => void) | null = null;

  function advanceDialog(): boolean {
    if (skipDialogDwell) {
      const skip = skipDialogDwell;
      skipDialogDwell = null;
      skip();
      return true;
    }
    return false;
  }

  function notifyResume(): void {
    const waiters = Array.from(resumeWaiters);
    resumeWaiters.clear();
    for (const waiter of waiters) waiter();
    if (skipDialogDwell) {
      const skip = skipDialogDwell;
      skipDialogDwell = null;
      skip();
    }
  }

  function abort(): void {
    if (walkthroughAbortController) {
      walkthroughAbortController.abort();
      walkthroughAbortController = null;
    }
  }

  async function startWalkthrough(
    targetGame: string,
    options?: { speed?: number; initialTick?: number; keepPaused?: boolean } | number,
  ): Promise<void> {
    abort();
    ctx.cancelPendingBridgeWaits();
    ctx.drainPendingQueries(new DOMException("Walkthrough reset", "AbortError"));

    const sessionId = ctx.nextSessionId();
    state.walkthrough.error = "";

    // Load artifact (memoized with validation and failure eviction)
    const artifact = await loadWalkthrough(targetGame);
    if (ctx.getActiveSessionId() !== sessionId) return;

    if (!artifact) {
      state.walkthrough.error = `No walkthrough found for "${targetGame}".`;
      state.walkthrough.status = "error";
      return;
    }

    const abortController = new AbortController();
    walkthroughAbortController = abortController;

    const speed =
      typeof options === "number" ? options : (options?.speed ?? state.walkthrough.speed ?? 1);
    const initialTick = typeof options === "object" ? (options.initialTick ?? 0) : 0;
    const keepPaused = typeof options === "object" ? Boolean(options.keepPaused) : false;
    const checkpoints = extractCheckpoints(artifact.actions, artifact.virtualTicks);
    const target = seekTargetTick ?? initialTick;
    const targetCp = target > 0 ? [...checkpoints].reverse().find((c) => c.tick <= target) : null;

    state.walkthrough.active = true;
    state.walkthrough.alias = artifact.game;
    state.walkthrough.speed = speed;
    state.walkthrough.status = keepPaused ? "paused" : "playing";
    state.walkthrough.error = "";
    state.walkthrough.label = targetCp ? targetCp.label : "Starting…";
    state.walkthrough.checkpointIndex = targetCp ? targetCp.index : 0;
    state.walkthrough.totalCheckpoints = checkpoints.length;
    state.walkthrough.checkpoints = checkpoints;
    state.walkthrough.totalTicks = artifact.virtualTicks;
    state.walkthrough.requestedTick = target;
    const initialObservedTick = target > 0 ? (replayDriver.latest?.tick ?? 0) : 0;
    state.walkthrough.tick = initialObservedTick;
    state.walkthrough.percent =
      artifact.virtualTicks > 0 && initialObservedTick > 0
        ? Math.min(100, Math.round((initialObservedTick / artifact.virtualTicks) * 100))
        : 0;
    state.walkthrough.room = targetCp ? targetCp.room : null;
    state.walkthrough.score = targetCp ? targetCp.score : null;

    if (target > 0) {
      seekTargetTick = target;
      state.walkthrough.seeking = true;
    } else {
      seekTargetTick = null;
      state.walkthrough.seeking = false;
    }

    state.soundPlaying = false;
    audio.stop();
    if (target > 0 || keepPaused) {
      audio.setPaused(true);
    }

    ctx.setActiveReplaySeed(artifact.seed);
    ctx.onWalkthroughReset();

    // Clear stale replay observation and prepare to wait for tick 0
    replayDriver.latest = null;
    const observationPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ctx.observationListeners.delete(listener);
        reject(new Error("Timeout waiting for game replay to initialize"));
      }, 15_000);
      const listener = (obs: ReplayObservation) => {
        if (ctx.getActiveSessionId() !== sessionId || abortController.signal.aborted) {
          clearTimeout(timeout);
          ctx.observationListeners.delete(listener);
          return;
        }
        if (obs.sessionId === sessionId && obs.tick === 0) {
          clearTimeout(timeout);
          ctx.observationListeners.delete(listener);
          resolve();
        }
      };
      ctx.observationListeners.add(listener);
      abortController.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          ctx.observationListeners.delete(listener);
          reject(new DOMException("Walkthrough aborted", "AbortError"));
        },
        { once: true },
      );
    });

    // Boot game with the seed (or fast reset if already booted in worker)
    const worker = ctx.getWorker();
    if (ctx.isCurrentGame(targetGame) && worker) {
      worker.postMessage({
        type: "resetReplay",
        seed: artifact.seed,
        seeking: Boolean(target > 0),
        sessionId,
      });
    } else if (ctx.isInstalledGame(targetGame)) {
      await ctx.bootGame(findInstalledFolder(ctx.state.installedGames, targetGame));
    } else if (getCachedGameMeta(targetGame)) {
      await ctx.bootAuthoredGame(
        "",
        ctx.configForGame(targetGame, {
          provider: "stub",
          apiKey: "",
          model: "offline-stub",
        }),
        { projectId: targetGame, useCached: true },
      );
    } else {
      await ctx.bootGame(findInstalledFolder(ctx.state.installedGames, targetGame));
    }

    if (ctx.getActiveSessionId() !== sessionId || abortController.signal.aborted) return;

    if (state.phase === "error") {
      state.walkthrough.status = "error";
      state.walkthrough.error = state.error || "Failed to boot game for walkthrough.";
      return;
    }

    try {
      await observationPromise;
    } catch (e) {
      if (ctx.getActiveSessionId() !== sessionId || abortController.signal.aborted) return;
      throw e;
    }
    if (ctx.getActiveSessionId() !== sessionId || abortController.signal.aborted) return;

    // Run the batch!
    try {
      await replayDriver.playBatch(artifact.actions, {
        sessionId,
        isCurrentSession: () => ctx.getActiveSessionId() === sessionId,
        speed: () => state.walkthrough.speed,
        isPaused: () => state.walkthrough.scrubbing || state.walkthrough.status === "paused",
        waitForResume: () =>
          new Promise<void>((resolve) => {
            if (!state.walkthrough.scrubbing && state.walkthrough.status !== "paused") {
              resolve();
              return;
            }
            const onResume = () => {
              cleanup();
              resolve();
            };
            const onAbort = () => {
              cleanup();
              resolve();
            };
            const cleanup = () => {
              resumeWaiters.delete(onResume);
              abortController.signal.removeEventListener("abort", onAbort);
            };
            resumeWaiters.add(onResume);
            abortController.signal.addEventListener("abort", onAbort, { once: true });
          }),
        getSeekTarget: () => seekTargetTick,
        onSeekComplete: () => {
          if (ctx.getActiveSessionId() !== sessionId || abortController.signal.aborted) return;
          seekTargetTick = null;
          state.walkthrough.seeking = false;
          if (replayDriver.latest) {
            state.walkthrough.tick = replayDriver.latest.tick;
            state.walkthrough.requestedTick = replayDriver.latest.tick;
            state.walkthrough.room = replayDriver.latest.state.room;
            state.walkthrough.score = replayDriver.latest.state.vars[3] ?? 0;
            if (artifact.virtualTicks > 0) {
              state.walkthrough.percent = Math.min(
                100,
                Math.round((replayDriver.latest.tick / artifact.virtualTicks) * 100),
              );
            }
            const cp = [...state.walkthrough.checkpoints]
              .reverse()
              .find((c) => c.tick <= replayDriver.latest!.tick);
            if (cp) {
              state.walkthrough.label = cp.label;
              state.walkthrough.checkpointIndex = cp.index;
            }
          }
          if (state.walkthrough.status === "playing" && !state.walkthrough.scrubbing) {
            audio.setPaused(false);
          } else {
            state.soundPlaying = false;
            audio.stop();
            audio.setPaused(true);
          }
          ctx.getWorker()?.postMessage({ type: "renderFrame" });
        },
        signal: abortController.signal,
        pauseOnDialog: () => state.walkthrough.pauseOnDialog,
        onDialogPause: () => {
          pauseWalkthrough();
        },
        dwellOnDialog: (ms: number) =>
          new Promise<void>((resolve) => {
            if (
              abortController.signal.aborted ||
              ctx.getActiveSessionId() !== sessionId ||
              state.walkthrough.seeking ||
              state.walkthrough.speed <= 0
            ) {
              resolve();
              return;
            }
            let timer: number | null = null;
            const finish = () => {
              if (timer !== null) {
                clearTimeout(timer);
                timer = null;
              }
              if (skipDialogDwell === finish) {
                skipDialogDwell = null;
              }
              abortController.signal.removeEventListener("abort", finish);
              resolve();
            };
            skipDialogDwell = finish;
            timer = window.setTimeout(finish, ms);
            abortController.signal.addEventListener("abort", finish, { once: true });
          }),
        onCheckpoint: (cp: ReplayCheckpointEvent) => {
          if (ctx.getActiveSessionId() !== sessionId || abortController.signal.aborted) return;
          if (state.walkthrough.seeking) return;
          state.walkthrough.checkpointIndex++;
          state.walkthrough.label = cp.label;
          state.walkthrough.room = cp.room;
          state.walkthrough.score = cp.score;
        },
        onAcceptedInput: (text: string) => {
          if (!state.walkthrough.seeking) ctx.logAgent("input", text);
        },
        onProgress: (prog: ReplayProgressEvent) => {
          if (ctx.getActiveSessionId() !== sessionId || abortController.signal.aborted) return;
          if (state.walkthrough.seeking) return;
          state.walkthrough.tick = prog.tick;
          state.walkthrough.requestedTick = prog.tick;
          state.walkthrough.room = prog.room;
          state.walkthrough.score = prog.score;
          if (artifact.virtualTicks > 0) {
            state.walkthrough.percent = Math.min(
              100,
              Math.round((prog.tick / artifact.virtualTicks) * 100),
            );
          }
        },
      });
      if (ctx.getActiveSessionId() === sessionId && !abortController.signal.aborted) {
        state.walkthrough.status = "completed";
        state.walkthrough.percent = 100;
        state.soundPlaying = false;
        audio.stop();
      }
    } catch (err) {
      if (ctx.getActiveSessionId() !== sessionId) {
        return;
      }
      if (
        abortController.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        state.walkthrough.status = "stopped";
      } else {
        state.walkthrough.status = "error";
        state.walkthrough.error = String(err);
      }
      state.soundPlaying = false;
      audio.stop();
    }
  }

  async function stopWalkthrough(takeControl = false): Promise<void> {
    abort();
    ctx.cancelPendingBridgeWaits();
    ctx.drainPendingQueries(new DOMException("Walkthrough stopped", "AbortError"));
    ctx.nextSessionId();
    state.walkthrough.active = false;
    state.walkthrough.error = "";
    ctx.setActiveReplaySeed(null);
    seekTargetTick = null;
    state.walkthrough.seeking = false;
    state.soundPlaying = false;
    audio.stop();
    notifyResume();
    if (takeControl) {
      state.walkthrough.status = "stopped";
      ctx.getWorker()?.postMessage({ type: "exitReplay" });
      // A replay halted mid-hold must not carry ego's heading into live play.
      ctx.sendDirection(0);
    } else {
      state.walkthrough.status = "stopped";
      await ctx.ejectGame();
    }
  }

  async function seekToTick(targetTick: number, options?: { keepPaused?: boolean }): Promise<void> {
    const clamped = Math.max(0, Math.min(state.walkthrough.totalTicks, Math.round(targetTick)));
    const engineTick = replayDriver.latest?.tick ?? state.walkthrough.tick;
    const currentTick = Math.max(state.walkthrough.tick, engineTick);
    const currentAlias = state.walkthrough.alias;
    if (!currentAlias || !state.walkthrough.active) return;
    const wasPaused = options?.keepPaused ?? state.walkthrough.status === "paused";

    seekTargetTick = clamped;
    state.walkthrough.seeking = true;
    state.walkthrough.requestedTick = clamped;
    notifyResume();
    if (state.walkthrough.totalTicks > 0) {
      state.walkthrough.percent = Math.min(
        100,
        Math.round((clamped / state.walkthrough.totalTicks) * 100),
      );
    }
    const targetCp = [...state.walkthrough.checkpoints].reverse().find((c) => c.tick <= clamped);
    if (targetCp) {
      state.walkthrough.label = targetCp.label;
      state.walkthrough.checkpointIndex = targetCp.index;
      state.walkthrough.room = targetCp.room;
      state.walkthrough.score = targetCp.score;
    }
    state.soundPlaying = false;
    audio.stop();
    audio.setPaused(true);

    if (clamped < currentTick || state.walkthrough.status === "completed") {
      void startWalkthrough(currentAlias, {
        speed: state.walkthrough.speed,
        initialTick: clamped,
        keepPaused: wasPaused,
      });
    }
  }

  async function seekToCheckpoint(cp: WalkthroughCheckpoint): Promise<void> {
    await seekToTick(cp.tick);
  }

  function pauseWalkthrough(): void {
    if (state.walkthrough.active && state.walkthrough.status === "playing") {
      state.walkthrough.status = "paused";
      state.soundPlaying = false;
      audio.stop();
      audio.setPaused(true);
      if (skipDialogDwell) {
        const skip = skipDialogDwell;
        skipDialogDwell = null;
        skip();
      }
    }
  }

  function resumeWalkthrough(): void {
    if (state.walkthrough.active && state.walkthrough.status === "paused") {
      state.walkthrough.status = "playing";
      audio.setPaused(false);
      notifyResume();
    }
  }

  function toggleWalkthroughPause(): void {
    if (state.walkthrough.status === "paused") {
      resumeWalkthrough();
    } else if (state.walkthrough.status === "playing") {
      pauseWalkthrough();
    } else if (state.walkthrough.status === "completed" && state.walkthrough.alias) {
      void startWalkthrough(state.walkthrough.alias, { speed: state.walkthrough.speed });
    }
  }

  function setWalkthroughSpeed(speed: number): void {
    state.walkthrough.speed = Math.max(0.1, speed);
  }

  function toggleWalkthroughPauseOnDialog(): void {
    state.walkthrough.pauseOnDialog = !state.walkthrough.pauseOnDialog;
  }

  return {
    startWalkthrough,
    stopWalkthrough,
    seekToTick,
    seekToCheckpoint,
    pauseWalkthrough,
    resumeWalkthrough,
    toggleWalkthroughPause,
    setWalkthroughSpeed,
    toggleWalkthroughPauseOnDialog,
    advanceDialog,
    abort,
  };
}
