import type { RecordedOperation } from "../../src/agent/recordedReplay.ts";
import type { EngineReplayState } from "../../src/runtime/replayState.ts";
import { executeAgentTool } from "../../src/agent/tools.ts";
import type { AgentSession } from "./agent/agentSession.ts";
import type { LlmConfig } from "./agent/llmClient.ts";
import {
  buildRecordedTest,
  type AssertionSuggestion,
  type RecordedEvent,
  type RecorderStateSnapshot,
  type RecordingSnapshot,
} from "./gameRecording.ts";
import type { BootedGame } from "./gameTypes.ts";
import type { LogAgentFn } from "./useInputController.ts";

export interface TestRecorderState {
  readonly phase: string;
  readonly recording: { active: boolean; starting: boolean; error: string };
  readonly powerUp: { open: boolean; busy: boolean };
  readonly modal: unknown;
  readonly prompt: unknown;
  readonly waitingForKey: boolean;
}

export interface TestRecorderOptions {
  readonly state: TestRecorderState;
  readonly getWorker: () => Worker | null;
  readonly query: <T>(type: string, extra?: Record<string, unknown>) => Promise<T>;
  readonly logAgent: LogAgentFn;
  readonly getBootedGame: () => BootedGame | null;
  readonly getOrCreateSession: (game: BootedGame, config: LlmConfig) => Promise<AgentSession>;
  readonly markRemixNeedsSave: () => void;
  readonly persistRemix: (
    game: BootedGame,
    author: AgentSession,
    files: Record<string, Uint8Array>,
  ) => Promise<void>;
  readonly flushAutosave: (waitMs?: number) => Promise<unknown>;
}

export interface TestRecorderController {
  startTestRecording(): Promise<void>;
  stopTestRecording(): Promise<RecordingSnapshot | null>;
  cancelTestRecording(): void;
  saveRecordedTest(
    snapshot: RecordingSnapshot,
    name: string,
    selected: readonly AssertionSuggestion[],
    config: LlmConfig,
  ): Promise<{ ok: boolean; message: string }>;
  reset(): void;
}

/**
 * Composable managing in-game test recording, snapshots, worker sync,
 * and persisting recorded tests to the game project.
 */
export function useTestRecorder(options: TestRecorderOptions): TestRecorderController {
  const { state, getWorker, query, logAgent } = options;
  let recordingStart: RecordingSnapshot["start"] | null = null;

  function reset(): void {
    recordingStart = null;
    state.recording.active = false;
    state.recording.starting = false;
    state.recording.error = "";
  }

  /**
   * Start capturing player actions for a stored game test. The worker takes
   * the record-start save image at a safe cycle boundary and stamps every
   * later action with the interpreter cycle; refusal (an open window, a text
   * screen, a blocking prompt) lands in state.recording.error.
   */
  async function startTestRecording(): Promise<void> {
    state.recording.error = "";
    const worker = getWorker();
    if (!worker || state.phase !== "running") return;
    if (
      state.powerUp.open ||
      state.powerUp.busy ||
      state.modal !== null ||
      state.prompt !== null ||
      state.waitingForKey
    ) {
      state.recording.error =
        "Close the open window, prompt or assistant before recording a game test.";
      return;
    }
    state.recording.starting = true;
    try {
      const reply = await query<{
        ok: boolean;
        image?: string;
        replayState?: EngineReplayState;
        cycle?: number;
        state?: RecorderStateSnapshot;
        error?: string;
      }>("startRecording");
      if (
        !reply.ok ||
        !reply.image ||
        !reply.replayState ||
        reply.cycle === undefined ||
        !reply.state
      ) {
        state.recording.error = String(reply.error ?? "Recording could not start.");
        return;
      }
      recordingStart = {
        image: reply.image,
        cycle: reply.cycle,
        state: reply.state,
        replayState: reply.replayState,
      };
      state.recording.active = true;
      logAgent("log", `Recording a game test from room ${reply.state.room}, cycle ${reply.cycle}.`);
    } finally {
      state.recording.starting = false;
    }
  }

  /** Stop capturing and return everything the worker recorded, or null. */
  async function stopTestRecording(): Promise<RecordingSnapshot | null> {
    if (!state.recording.active || !recordingStart) return null;
    const reply = await query<{
      operations?: RecordedOperation[];
      events?: RecordedEvent[];
      printed?: string[];
      tainted?: string | null;
      usedGetnum?: boolean;
      cycle?: number;
      state?: RecorderStateSnapshot | null;
    }>("stopRecording");
    state.recording.active = false;
    const start = recordingStart;
    recordingStart = null;
    if (!reply.state || reply.cycle === undefined) return null;
    return {
      start,
      operations: reply.operations ?? [],
      events: reply.events ?? [],
      printed: reply.printed ?? [],
      endState: reply.state,
      endCycle: reply.cycle,
      tainted: reply.tainted ?? null,
      usedGetnum: Boolean(reply.usedGetnum),
    };
  }

  /** Discard the active recording without saving anything. */
  function cancelTestRecording(): void {
    if (!state.recording.active) return;
    getWorker()?.postMessage({ type: "cancelRecording" });
    state.recording.active = false;
    recordingStart = null;
    logAgent("log", "Game test recording discarded.");
  }

  /**
   * Store a recorded test through the SAME write path write_game_tests uses
   * (validation, dictionary probe, TESTS.JSON serialization), then ship and
   * persist the updated file exactly like a remix. On an installed or catalog
   * game this is the established remix conversion: the project becomes a
   * writable project copy, since originals cannot store tests.
   */
  async function saveRecordedTest(
    snapshot: RecordingSnapshot,
    name: string,
    selected: readonly AssertionSuggestion[],
    config: LlmConfig,
  ): Promise<{ ok: boolean; message: string }> {
    const game = options.getBootedGame();
    const worker = getWorker();
    if (!game || !worker) return { ok: false, message: "No game is running." };
    if (snapshot.tainted) return { ok: false, message: snapshot.tainted };

    const author = await options.getOrCreateSession(game, config);
    const result = executeAgentTool(author.state, "write_game_tests", {
      mode: "merge",
      names: null,
      tests: [buildRecordedTest(name, snapshot, selected)],
    });
    if (!result.success)
      return { ok: false, message: result.error ?? "The recorded test was rejected." };
    options.markRemixNeedsSave();
    worker.postMessage({
      type: "patchMetadata",
      files: { "TESTS.JSON": new Uint8Array(author.state.testsPayload!) },
    });
    const files = await query<Record<string, Uint8Array> | null>("exportFiles");
    if (!files || options.getBootedGame() !== game)
      return { ok: false, message: "The game changed while saving the recording. Try again." };
    await options.persistRemix(game, author, files);
    await options.flushAutosave(2000);
    logAgent("response", `[Record] ${result.message}`, {
      tool: "write_game_tests",
      args: { name },
    });
    return { ok: true, message: result.message ?? "Recorded test stored." };
  }

  return {
    startTestRecording,
    stopTestRecording,
    cancelTestRecording,
    saveRecordedTest,
    reset,
  };
}
