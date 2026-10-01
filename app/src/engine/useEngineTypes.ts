/**
 * The engine's shared state types, re-exported through useEngine.ts so the
 * public surface is unchanged. Kept apart from the composition root so the
 * worker link and lifecycle composables can type their options without an
 * import cycle.
 */
import type { AgentRunState } from "../agent/agentRun.ts";
import type { AgentLogEntry } from "../agent/agentLog.ts";
import type {
  GameControlBinding,
  ScreenObjectState,
  TraceRecord,
} from "../../../src/runtime/engine.ts";
import type { AudioMode } from "../audio/AgiAudio.ts";
import type { RoomTransitionNotice } from "../worker/workerProtocol.ts";
import type { InstalledGameDescriptor } from "../project/gameTypes.ts";
import type { ProgressTarget } from "../project/progressTarget.ts";
import type { PowerUpUiState } from "../authoring/useAuthoringController.ts";
import type { PromptState } from "../play/usePromptController.ts";
import type { WalkthroughUiState } from "../walkthrough/useWalkthroughController.ts";
import type { HistoryViewMark } from "../history/useHistoryView.ts";
import type { HistoryBlock, HistoryRetry } from "../history/useHistoryController.ts";
import type { GenesisStarterOffer } from "../authoring/genesisStarterRecovery.ts";
import type { ProfileDetectionKind } from "../../../src/runtime/profile.ts";

export function freshHistoryView(): HistoryViewUiState {
  return {
    active: false,
    loading: false,
    parked: false,
    seeking: false,
    playing: false,
    watching: false,
    scrubbing: false,
    speed: 1,
    segment: 0,
    generation: 0,
    segmentCount: 0,
    tick: 0,
    seq: 0,
    room: 0,
    score: 0,
    marks: [],
    canResume: false,
    branches: 0,
    pendingSwaps: 0,
    dropped: 0,
    diverged: null,
    error: "",
  };
}

/** Engine modal kinds (the engine draws them on its text surface). */
export type ModalKind = "print" | "inventory" | "menu" | "showObj" | "showPri" | "save" | "restore";

/** Test/debug hook mirrored onto window.__AGI_TEXT__ every frame. */
export interface TextHook {
  rows: string[];
  modal: ModalKind | null;
  textMode: boolean;
  /** Interpreter profile the engine detected for the booted game, e.g. "2.917". */
  profile: string | null;
  /** Detection kind of the interpreter profile: "binary", "catalog", or "default". */
  profileKind?: ProfileDetectionKind | null;
  /** The interpreter is parked between cycles (remix freeze). */
  paused: boolean;
  /** Interpreter cycles completed since boot; stops advancing while paused. */
  cycle: number;
  /**
   * Frames presented on the probe canvas since boot. Monotonic; the counter
   * ticks only after the frame has been composited and drawn, so a test that
   * waits for it to advance is reading painted pixels, never a blank canvas.
   */
  frame: number;
  /**
   * Interpreter cycle of the newest autosave the host has STORED, or -1 when
   * this session has stored none. A reload is only safe to trust once this has
   * passed the cycle whose state you want back.
   */
  autosave: number;
  /** Current room and ego's position, from the worker's cycle heartbeat. */
  room: number;
  egoX: number;
  egoY: number;
}

/** The transport's UI state: the always-on bar plus the recorded-session view. */
export interface HistoryViewUiState {
  /** A view session is open — the transport shows recorded history. */
  active: boolean;
  /** Opening: the tape is loading / the first drive is warming up. */
  loading: boolean;
  /**
   * The transport holds the live session parked at LIVE without the tape
   * open — the paused-at-the-present state a timeline touch produces.
   */
  parked: boolean;
  /** A seek is in flight. */
  seeking: boolean;
  /** Watch mode: paced advance is running. */
  playing: boolean;
  /**
   * The explicit Watch action inside the view — keeps the speed and
   * pause-on-dialogue controls visible while it is on.
   */
  watching: boolean;
  /** The user is dragging the thumb. */
  scrubbing: boolean;
  /** Watch speed multiplier (1/2/4/8). */
  speed: number;
  /** Which segment of the recording is under view (index). */
  segment: number;
  /** The worker's view-session serial — echoed back on Resume from here. */
  generation: number;
  segmentCount: number;
  /** Viewed position within the current segment. */
  tick: number;
  seq: number;
  /** The viewed moment's room and score, for the transport readout. */
  room: number;
  score: number;
  marks: HistoryViewMark[];
  /** The viewed moment can become the live session (Resume from here). */
  canResume: boolean;
  /** Kept recovery branches — Undo rewind is offered while >0. */
  branches: number;
  /**
   * Staged swap candidates whose outcomes were never settled — the worker
   * may have adopted while the promotion write failed or its reply was
   * lost. They stay durable and settle themselves from tape evidence; the
   * bar shows a quiet status, never a keep/release vote.
   */
  pendingSwaps: number;
  /** Segments the retention bound evicted before this tape was opened. */
  dropped: number;
  diverged: { tick: number; detail: string } | null;
  error: string;
}

export interface EngineState {
  agentTask: AgentRunState | null;
  /**
   * The game the loading phase is opening. `generating` marks an agent
   * writing a new adventure; a plain boot is quick, so its splash stays out
   * of sight unless the load turns out slow.
   */
  loading: { title: string; generating: boolean } | null;
  leaving: boolean;
  controls: GameControlBinding[];
  inputEnabled: boolean;
  /** The worker has started logic and published its input mode. */
  inputReady: boolean;
  holdToMove: boolean;
  waitingForKey: boolean;
  gameEdit: { text: string } | null;
  phase: "idle" | "loading" | "running" | "error";
  error: string;
  /**
   * A provider-driven Create that ended before finish keeps its prepared
   * canonical Starter on offer: Home's error surface shows "Open starter"
   * while this is set. Ephemeral — never stored, retired by the next boot.
   */
  genesisStarter: GenesisStarterOffer | null;
  /** Status line text as the engine last reported it (debug/test aid). */
  status: string;
  /** Full-screen text mode (0x6a text.screen / 0x6b graphics) */
  textMode: boolean;
  /** The engine's open modal, or null while the interpreter runs. */
  modal: ModalKind | null;
  /** View the show.obj modal previews, or null when none is open. */
  showObjView: number | null;
  /** Text rows of the engine's surface (transparent cells read as spaces). */
  rows: string[];
  /** Installed games autodiscovered under games/. */
  installedGames: InstalledGameDescriptor[] | null;
  /** Interpreter profile the engine detected for the booted game, e.g. "2.917". */
  profile: string | null;
  /** Detection kind of the interpreter profile: "binary", "catalog", or "default". */
  profileKind: ProfileDetectionKind | null;
  /** Debug screen: live agent activity (requests, responses, patches). */
  agentLog: AgentLogEntry[];
  omittedLogEntries?: number;
  /** True while a shake.screen effect is animating. */
  shake: boolean;
  /** Active blocking prompt (0x76 get.num / 0x73 get.string), if any. */
  prompt: PromptState | null;
  /** Active sound playback state */
  soundPlaying: boolean;
  soundMuted: boolean;
  soundMode: AudioMode;
  /** The interpreter is parked between cycles (remix mode). */
  paused: boolean;
  /** The remix bubble. */
  powerUp: PowerUpUiState;
  /** This boot restored an autosave: the resume caption is showing. */
  resumed: boolean;
  /**
   * A Start over left earlier sessions on the timeline: the stage's note
   * offers Undo start over until the new run is under way.
   */
  startOverNote: boolean;
  /**
   * The last game ran `quit` and play returned Home: Home says so, with Play
   * again and (when progress was saved before the quit) Continue. A new game
   * session clears it.
   */
  gameEnded: {
    projectId: string;
    title: string;
    /** The ended game's physical progress binding, when it held one. */
    progressTarget?: ProgressTarget | undefined;
  } | null;
  /**
   * Storage moved past the running game (another tab committed a newer
   * revision): the stage's note offers Reload game until dismissed.
   */
  staleTab: boolean;
  /**
   * The running game's project was removed in another tab: nothing is stored
   * for it any more, and the stage's note offers Download game and Back to
   * games until dismissed. A reload asked for says it again.
   */
  projectRemoved: boolean;
  /** Player-action recording for a stored game test. */
  recording: { active: boolean; starting: boolean; error: string };
  /** History batches committed-or-in-flight to storage; >0 means unsaved tape. */
  historyPending: number;
  /**
   * Batches the storage layer refused, tracked apart from in-flight work:
   * the worker keeps and resends them, but the tape's durability lag is
   * visible — "history not saved since …" with a retry.
   */
  historyUnsaved: { batches: number; since: number } | null;
  /**
   * The stored tape is in a format this version cannot extend: the game
   * saves, this session's timeline cannot. Permanent — no retry reaches it;
   * the banner offers a new timeline beside the old one.
   */
  historyBlocked: HistoryBlock | null;
  /** The unsaved banner's Try now: Saving…, then Saved or the plain reason. */
  historyRetry: HistoryRetry | null;
  /** The history transport: paused live session plus a scratch replay under it. */
  historyView: HistoryViewUiState;
  /** Real-time walkthrough playback. */
  walkthrough: WalkthroughUiState;
  /** Live screen-object table while the objects debug channel is armed. */
  debugObjects: ScreenObjectState[];
  /** Structured instruction records while the trace debug channel is armed. */
  debugTrace: (TraceRecord & { seq: number; cycle: number })[];
  /** Trace records the worker evicted while the host was stalled. */
  debugTraceDropped: number;
  /**
   * The world-map journal: every room transition the worker observed, in
   * order. Entries carry the session and resource revision they were made
   * under; useRoomMap keys them to the game identity and owns the durable
   * per-game journal.
   */
  roomJournal: RoomTransitionNotice[];
  /**
   * Bumped when the worker reports a resource patch — surfaces that cache a
   * scan of the booted resources (the world map) subscribe to re-derive.
   */
  patchTick: number;
  /**
   * Bumped when the session's authoring world may have changed — a turn's
   * adoption, a tape checkpoint post, a session-state adoption. Plan surfaces
   * re-read the world on this tick even when no resource moved.
   */
  worldTick: number;
  /**
   * The world revision of the last confirmed durable write — set by every
   * path that persists the authoring state (map edits, turn commits,
   * adoptions). The map's dirty flag compares the live revision against it;
   * "" means no write has been reported this session.
   */
  planDurableRev: string;
  /** Debug channels the app has armed on the worker. */
  debugChannels: { ownership: boolean; objects: boolean; trace: boolean; picture: boolean };
  /**
   * Inspector surfaces that need debug payloads; the armed channels are the
   * union of their needs, derived in one place so no control disarms a
   * channel another consumer still uses (e.g. exploded Layers need
   * picture/ownership even when Objects and Inspect are off).
   */
  debugConsumers: {
    dock: boolean;
    overlay: boolean;
    inspect: boolean;
    exploded: boolean;
    trace: boolean;
  };
}
