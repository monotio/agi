import type { ProjectSession } from "../project/projectSession.ts";
import type { saveTests } from "./saveTests.ts";
import type { runTestsInWorker } from "../studio/testsRunner.ts";
import type { GameTestsEditOperation } from "../../../src/agent/gameTestsEdit.ts";
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
  readonly getProjectSession: () => ProjectSession | null;
  /** Tests inject the same save contract without loading the browser's storage. */
  readonly saveTests?: typeof saveTests;
  readonly flushAutosave: (waitMs?: number) => Promise<unknown>;
}

type RecordingStopResult = RecordingSnapshot | { readonly endedBy: "replacement" } | null;

export interface TestRecorderController {
  startTestRecording(): Promise<void>;
  stopTestRecording(): Promise<RecordingStopResult>;
  cancelTestRecording(): void;
  saveRecordedTest(
    snapshot: RecordingSnapshot,
    name: string,
    selected: readonly AssertionSuggestion[],
  ): Promise<{ ok: boolean; message: string }>;
  runTests(options?: Parameters<typeof runTestsInWorker>[1]): ReturnType<typeof runTestsInWorker>;
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
    if (generation !== stoppedGeneration) return { endedBy: "replacement" };
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

  /** Save a recorded test as an ordinary project edit, without an AI session. */
  async function saveRecordedTest(
    snapshot: RecordingSnapshot,
    name: string,
    selected: readonly AssertionSuggestion[],
  ): Promise<{ ok: boolean; message: string }> {
    const game = options.getBootedGame();
    if (!game || !getWorker()) return { ok: false, message: "No game is running." };
    if (snapshot.tainted) return { ok: false, message: snapshot.tainted };
    try {
      const save = options.saveTests ?? (await import("./saveTests.ts")).saveTests;
      const op: GameTestsEditOperation = {
        kind: "merge",
        tests: [buildRecordedTest(name, snapshot, selected)],
      };
      const edited = await save(options.getProjectSession(), op, {
        beforeCommit() {
          if (options.getBootedGame() !== game)
            throw new Error("The game changed while saving the recording. Try again.");
        },
      });
      const message = `${edited.tests.length} game test${edited.tests.length === 1 ? "" : "s"} stored in TESTS.JSON.`;
      logAgent("response", `[Record] ${message}`);
      return { ok: true, message };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The Tests panel runs committed documents in a disposable worker. */
  async function runTests(runOptions?: Parameters<typeof runTestsInWorker>[1]) {
    const project = options.getProjectSession();
    if (!project) throw new Error("Open Create before running tests.");
    const { runTestsInWorker } = await import("../studio/testsRunner.ts");
    return runTestsInWorker(project, runOptions);
  }

  return {
    runTests,
    startTestRecording,
    stopTestRecording,
    cancelTestRecording,
    saveRecordedTest,
    reset,
  };
}
