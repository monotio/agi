import type { AgentSession } from "../agent/agentSession.ts";
import type { LlmConfig } from "../agent/llmClient.ts";
import {
  buildRecordedTest,
  type AssertionSuggestion,
  type RecordingSnapshot,
} from "./gameRecording.ts";
import type { BootedGame } from "../project/gameTypes.ts";
import type { LogAgentFn } from "../play/useInputController.ts";
import type { WorkerInbound, WorkerQueryFn } from "../worker/workerProtocol.ts";

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
  readonly query: WorkerQueryFn;
  readonly logAgent: LogAgentFn;
  readonly getBootedGame: () => BootedGame | null;
  readonly getOrCreateSession: (game: BootedGame, config: LlmConfig) => Promise<AgentSession>;
  /** Store TESTS.JSON, then install it in the session and the running game (the controller's commitTestsFile). */
  readonly commitTestsFile: (
    game: BootedGame,
    author: AgentSession,
    tests: Uint8Array,
  ) => Promise<void>;
  readonly flushAutosave: (waitMs?: number) => Promise<unknown>;
}

type RecordingStopResult = RecordingSnapshot | { readonly endedBy: "restart" } | null;

export interface TestRecorderController {
  startTestRecording(): Promise<void>;
  stopTestRecording(): Promise<RecordingStopResult>;
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
  let generation = 0;
  let recordingStart: RecordingSnapshot["start"] | null = null;

  function reset(): void {
    generation++;
    recordingStart = null;
    state.recording.active = false;
    state.recording.starting = false;
    state.recording.error = "";
  }

  /**
   * Start capturing player actions for a stored game test. The worker takes
   * the record-start save image at a safe cycle boundary — a parked window or
   * key wait rides the image's continuation — and stamps every later action
   * with the interpreter cycle; refusal (a live prompt, a text screen) lands
   * in state.recording.error.
   */
  async function startTestRecording(): Promise<void> {
    state.recording.error = "";
    const worker = getWorker();
    if (!worker || state.phase !== "running") return;
    // Parked windows and key waits record fine — the setup's continuation
    // resumes them. What still blocks a recording is a live host request: a
    // prompt, the save/restore selector, or the assistant.
    if (
      state.powerUp.open ||
      state.powerUp.busy ||
      state.modal === "save" ||
      state.modal === "restore" ||
      state.prompt !== null
    ) {
      state.recording.error = "Close the open prompt or assistant before recording a game test.";
      return;
    }
    state.recording.starting = true;
    try {
      const reply = await query("startRecording");
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

  /** Stop capturing, reporting a replaced run separately from a recording snapshot. */
  async function stopTestRecording(): Promise<RecordingStopResult> {
    if (!state.recording.active || !recordingStart) return null;
    const start = recordingStart;
    const stoppedGeneration = generation;
    const reply = await query("stopRecording");
    if (generation !== stoppedGeneration) return { endedBy: "restart" };
    if (recordingStart !== start) return null;
    state.recording.active = false;
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
    };
  }

  /** Discard the active recording without saving anything. */
  function cancelTestRecording(): void {
    if (!state.recording.active) return;
    getWorker()?.postMessage({ type: "cancelRecording" } satisfies WorkerInbound);
    state.recording.active = false;
    recordingStart = null;
    logAgent("log", "Game test recording discarded.");
  }

  /**
   * Store a recorded test through the SAME write path write_game_tests uses
   * (validation, dictionary probe, TESTS.JSON serialization) on a fork of
   * the session, then commit the file exactly like a remix: storage first,
   * and only then the session and the running game. A refusal — a project
   * saved elsewhere since boot — leaves both as they were and answers in
   * the remix's own words. On an installed or catalog game this is the
   * established remix conversion: the project becomes a writable project
   * copy, since originals cannot store tests.
   */
  async function saveRecordedTest(
    snapshot: RecordingSnapshot,
    name: string,
    selected: readonly AssertionSuggestion[],
    config: LlmConfig,
  ): Promise<{ ok: boolean; message: string }> {
    const game = options.getBootedGame();
    if (!game || !getWorker()) return { ok: false, message: "No game is running." };
    if (snapshot.tainted) return { ok: false, message: snapshot.tainted };

    const author = await options.getOrCreateSession(game, config);
    const { executeAgentTool, forkAgentState } = await (
      await import("../agent/authoringLoader.ts")
    ).loadAuthoringStack();
    const staged = forkAgentState(author.state);
    const result = executeAgentTool(staged, "write_game_tests", {
      mode: "merge",
      names: null,
      tests: [buildRecordedTest(name, snapshot, selected)],
    });
    if (!result.success || !staged.testsPayload)
      return { ok: false, message: result.error ?? "The recorded test was rejected." };
    try {
      await options.commitTestsFile(game, author, staged.testsPayload);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
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
