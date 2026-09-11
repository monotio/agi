/// <reference types="vite/client" />
/**
 * Engine worker: hosts the authentic interpreter off the main thread.
 *
 * Messages in:
 *   { type: "boot", files, words, sab, autosaveMs?, autosaveFiles?, restoreImage? }
 *   { type: "input", text: string }        player pressed Enter on the input line
 *   { type: "direction", dir: number }     movement key press (0 = tracked key release)
 *   { type: "startRecording" / "stopRecording" / "cancelRecording", id }
 *                                          player-action capture for a stored game test
 *   { type: "flush" }                      take an autosave now (page is going away)
 *
 * Messages out:
 *   { type: "frame", visual, priority, text, picRow, modal, textMode, edit }
 *                                          transferable copies, sent when changed;
 *                                          text = 40x25 [char, attr] cells
 *   { type: "print", text }                modal message from the game
 *   { type: "status", text }               status line
 *   { type: "shake", count }               0x6e shake.screen
 *   { type: "showObj", viewNum }           0x81/0xa2 modal view popup
 *   { type: "showPri" }                    0x1d modal priority-surface view
 *   { type: "statusScreen", items }        0x7c modal inventory list
 *   { type: "autosave", image, preview?, cycle, room, files? }
 *                                          host-initiated snapshot (no save.game
 *                                          involved); `files` carries the live
 *                                          container only when a patch landed
 *                                          since the last one and the host asked
 *                                          for it (never for installed originals)
 *   { type: "restored", ok, message? }     outcome of a restoreImage request
 *   { type: "flushed", id, taken }         a flush request finished; `taken` is
 *                                          false when the boundary refused it
 *   { type: "log", text }                  0x90/0x85/0x87 debug log stream
 *   { type: "cycle", cycle, room, egoX, egoY }
 *                                          liveness heartbeat, approximately 4 Hz
 *   { type: "booted", profile }            first cycles completed
 *   { type: "error", message }
 *
 *   op "restore"                           0x7e fetch a base64 save image, or "" for none
 */
import { prepareRoomPatch } from "../../src/agent/roomPatch.ts";
import { buildWordsTok, parseWordsTok } from "../../src/logic/words.ts";
import { openContainer } from "../../src/container/container.ts";
import { OperationRecorder } from "../../src/agent/recordedReplay.ts";
import type { RecordedEvent } from "./gameRecording.ts";
import { Engine, type EngineHost, type EngineMenuState } from "../../src/runtime/engine.ts";
import { AGI_KEY, DIRECTION_KEYS, NAV_KEYS } from "../../src/runtime/keys.ts";
import {
  BRIDGE_HEADER_BYTES,
  BRIDGE_PAUSE_SLOT,
  BRIDGE_STATE_CANCELLED,
  WorkerBridgeAbortError,
} from "./agent/sabBridge.ts";
import { FrameRing } from "./frameRing.ts";
import { CycleClock } from "../../src/runtime/cycleClock.ts";
import { SoundClock } from "./soundClock.ts";
import type { ReplayObservation } from "./replay.ts";
import { createProgressPreview } from "./progressPreview.ts";

/** Save-file image as base64: the SAB bridge and localStorage both carry text. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked so a large image never overflows the argument list.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface BootMsg {
  type: "boot";
  files: Record<string, Uint8Array>;
  words: [string, number][];
  sab: SharedArrayBuffer;
  sessionId?: number;
  /** Browser-selected sound device: 0 speaker, 1 four-channel output. */
  soundDevice?: number;
  /** Autosave cadence override; the host owns the policy, the worker the timing. */
  autosaveMs?: number;
  /**
   * Ship the patched container along with an autosave when a patch landed.
   * Enabled for cached worlds, including locally imported ZIPs.
   * Explicit export uses a separate request and works for any loaded game.
   */
  autosaveFiles?: boolean;
  authorRooms?: boolean;
  /**
   * base64 save image to restore into the freshly booted engine (autosave
   * resume). Applied BEFORE the first cycle: the alternative, a message sent
   * once `booted` arrives, races the game's own first cycles — and a title
   * screen that parks on have.key() would block the worker before it could be
   * delivered at all.
   */
  restoreImage?: string;
  restoreMenus?: EngineMenuState;
  /** Test-mode host clock and reproducible random input. */
  replaySeed?: number;
}

let engine: Engine | null = null;
let isSeeking = false;
let currentSessionId = 0;

function sendControl(message: unknown, options?: unknown): void {
  if (message && typeof message === "object" && currentSessionId > 0 && !("sessionId" in message)) {
    (message as Record<string, unknown>)["sessionId"] = currentSessionId;
  }
  self.postMessage(message, options as StructuredSerializeOptions);
}

function sendPresentation(message: unknown, options?: unknown): void {
  if (isSeeking) return;
  if (message && typeof message === "object" && currentSessionId > 0 && !("sessionId" in message)) {
    (message as Record<string, unknown>)["sessionId"] = currentSessionId;
  }
  self.postMessage(message, options as StructuredSerializeOptions);
}

let authorRooms = false;
let selectedSoundDevice = 1;
let liveDictionary = new Map<string, number>();
let authoredWords: Uint8Array | null = null;
let inputBuffer: string[] = [];
let keyBuffer: number[] = [];
/** Admitted walking releases and later walking keys wait for ordinary input. */
const deferredMovement: number[] = [];

/**
 * The active player-action recording for a stored game test (see
 * gameRecording.ts): every player action the interpreter receives, stamped
 * with the interpreter cycle at the moment it arrives, plus the messages the
 * game printed while recording. null while not recording.
 */
let recording: {
  tape: OperationRecorder;
  events: RecordedEvent[];
  printed: string[];
  tainted: string | null;
  usedGetnum: boolean;
} | null = null;
function recordEvent(event: RecordedEvent): void {
  if (!recording) return;
  if (recording.events.length >= 5000) {
    recording.tainted = "Recording reached its action limit; record a shorter scenario.";
    return;
  }
  recording.events.push(event);
}
let initialLogicStarted = false;
let lastInputReady = false;
function tickEngine(): void {
  if (!engine) return;
  initialLogicStarted = true;
  if (recording) recording.tape.run("tick", () => engine!.tick());
  else engine.tick();
}
function recordedClock(): void {
  recording?.tape.clock();
  engine?.advanceClock(1000 / 60);
  engine?.soundTick();
}
let lastKeyId = 0;
let timer: number | null = null;
let soundTimer: number | null = null;
function stopTimers(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (soundTimer !== null) {
    clearInterval(soundTimer);
    soundTimer = null;
  }
}
const soundClock = new SoundClock(performance.now());
const cycleClock = new CycleClock(performance.now());
/** Poll input/modal services at display cadence; v10 separately gates logic cycles. */
const HOST_POLL_MS = 1000 / 60;
let replay: { tick: number; revision: number; random: number; yielded: boolean } | null = null;
let replayRequest: number | null = null;
let currentBootFiles: Map<string, Uint8Array> | null = null;
let currentDictionary: Map<string, number> | null = null;
let lastReplaySeed: number | null = null;

function postReplay(blocked: string | null, fullState = false): void {
  if (!replay || !engine) return;
  const isFull = fullState || blocked !== null;
  const state = isFull ? engine.readState() : engine.readLeanState();
  const rows = isFull ? Array.from({ length: 25 }, (_, row) => engine!.textRow(row)) : [];
  const observation: ReplayObservation = {
    sessionId: currentSessionId,
    revision: ++replay.revision,
    tick: replay.tick,
    cycle: cycleCount,
    blocked,
    state,
    rows,
    egoView: engine.screenObjects[0]!.view,
    releaseGate: engine.releaseGate,
  };
  sendControl({ type: "replay", sessionId: currentSessionId, id: replayRequest, observation });
  replayRequest = null;
}

function flushDeferredMovement(): void {
  if (!engine || engine.modalKind !== null || engine.continuationPending) return;
  for (const key of deferredMovement.splice(0)) {
    if (key === 0) {
      if (recording) recording.tape.run("release", () => engine!.releaseTrackedKey(true));
      else engine.releaseTrackedKey(true);
    } else keyBuffer.push(key);
  }
}
/** Interpreter cycles completed since boot; the frame ring's timeline. */
let cycleCount = 0;
/** Liveness observations stay responsive at slow game-selected cycle speeds. */
const CYCLE_REPORT_MS = 250;
let lastCycleReportAt = 0;
let lastHistoryAt = 0;

/**
 * Autosave cadence. Five seconds is the
 * cheapest interval that is still invisible: one snapshot is a serialize() of
 * a few kilobytes plus a base64 pass, well under a millisecond, and the
 * usual maximum a player can lose to a browser reload is
 * five seconds of walking. Tightening it further buys nothing a player would
 * notice; the flush on page-hide covers the tail.
 */
const AUTOSAVE_INTERVAL_MS = 5_000;
/** Effective cadence for this boot (host-configurable). */
let autosaveIntervalMs = AUTOSAVE_INTERVAL_MS;
/** Whether the host wants the patched container shipped with an autosave. */
let autosaveFiles = false;
/** Wall-clock of the last attempt, the cycle of the last image, and the last
 *  container patch generation the host has seen. */
let lastAutosaveAt = 0;
let lastAutosaveCycle = -1;
let lastPatchGeneration = 0;

/**
 * Take an autosave if this cycle boundary allows one and post it to the host.
 *
 * The engine refuses the snapshot while a window, a menu or a text screen owns
 * the surface, or before a room has drawn; the worker adds the cheap gate on
 * top: an image is encoded only when the interpreter actually advanced since
 * the last one, so a parked or idle game costs nothing.
 */
function autosave(force: boolean): boolean {
  if (!engine) return false;
  if (!force && cycleCount === lastAutosaveCycle) return false;
  let image: Uint8Array | null;
  try {
    image = engine.autosaveImage();
  } catch (error) {
    sendPresentation({ type: "log", text: `Autosave snapshot failed: ${String(error)}` });
    return false;
  }
  if (!image) return false;
  const msg: Record<string, unknown> = {
    type: "autosave",
    image: bytesToBase64(image),
    menus: engine.readMenuState(),
    cycle: cycleCount,
    room: engine.vars[0],
  };
  try {
    const presentation = engine.getPresentation();
    msg["preview"] = createProgressPreview({
      visual: presentation.visual,
      text: presentation.text,
      picRow: engine.displayBase,
    });
  } catch (error) {
    sendPresentation({ type: "log", text: `Autosave preview skipped: ${String(error)}` });
  }
  // The patched container travels only when a patch really landed since the
  // host last saw one: a resource snapshot on every tick would cost far more
  // than the save image it accompanies.
  if (autosaveFiles && engine.patchGeneration !== lastPatchGeneration) {
    const files: Record<string, Uint8Array> = {};
    for (const [name, bytes] of engine.containerFiles) files[name] = bytes.slice();
    if (authoredWords) files["WORDS.TOK"] = authoredWords;
    msg["files"] = files;
    lastPatchGeneration = engine.patchGeneration;
  }
  sendPresentation(msg);
  lastAutosaveCycle = cycleCount;
  lastAutosaveAt = Date.now();
  return true;
}

/**
 * Frame history for the agent's `read_frames` tool: the last 100 cycles plus
 * 60 history samples captured at most once per second. Both rings preallocate their typed arrays, so a cycle
 * costs three buffer copies and nothing else.
 */
const recentRing = new FrameRing(100);
const historyRing = new FrameRing(60);

/** LLM blocking bridge state (see app/src/agent/sabBridge.ts for layout). */
let bridge: { i32: Int32Array; bytes: Uint8Array } | null = null;

function advanceSoundClock(authoring = false): void {
  if (replay) return;
  const paused =
    authoring || (bridge !== null && Atomics.load(bridge.i32, BRIDGE_PAUSE_SLOT) === 1);
  const ticks = soundClock.advance(performance.now(), paused);
  for (let tick = 0; tick < ticks; tick++) {
    recordedClock();
  }
}

function bridgeCall(op: string, context: string): string {
  if (recording && !["getstring", "getnum", "waitkey"].includes(op))
    recording.tainted = `The recording used unsupported host service ${op}.`;
  if (!bridge) throw new Error("llm bridge not initialized");
  advanceSoundClock();
  // The interpreter is about to block: ship the frame that shows the prompt
  // (or the text screen) before the thread stops posting anything.
  postFrame();
  const payload = new TextEncoder().encode(JSON.stringify({ op, context: JSON.parse(context) }));
  if (payload.length > bridge.bytes.length) throw new Error("llm request too large for bridge");
  bridge.bytes.fill(0);
  bridge.bytes.set(payload);
  Atomics.store(bridge.i32, 1, payload.length);
  Atomics.store(bridge.i32, 0, 1); // request
  Atomics.notify(bridge.i32, 0);
  if (replay && ["waitkey", "getnum", "getstring", "saveDescription"].includes(op)) {
    replay.yielded = true;
    postReplay(op);
  }
  const authoring = op === "room";
  if (authoring) sendPresentation({ type: "soundPaused", paused: true });
  try {
    // The main thread may claim state 1 as state 3 before we reach the wait.
    // Wait through either state, never decode our own request.
    for (;;) {
      const state = Atomics.load(bridge.i32, 0);
      if (state === 2) break;
      if (state === BRIDGE_STATE_CANCELLED) {
        Atomics.store(bridge.i32, 0, 0);
        throw new WorkerBridgeAbortError();
      }
      // Timer callbacks cannot run inside Atomics.wait. Wake once per sound
      // interval so host prompts keep producing audio and completion flags.
      Atomics.wait(bridge.i32, 0, state, 1000 / 60);
      advanceSoundClock(authoring);
    }
    advanceSoundClock(authoring);
    const len = Atomics.load(bridge.i32, 1);
    const response = new TextDecoder().decode(bridge.bytes.slice(0, len));
    Atomics.store(bridge.i32, 0, 0); // reset for the next call
    if (recording && (op === "getstring" || op === "getnum")) {
      recording.usedGetnum ||= op === "getnum";
      recordEvent({ cycle: cycleCount, kind: "answer", text: response });
    } else if (recording && op === "restore" && response) {
      // A restore replaces the interpreter state mid-recording; the captured
      // steps no longer describe the live game.
      recording.tainted = "the game was restored mid-recording";
    }
    return response;
  } finally {
    if (authoring) {
      cycleClock.reset(replay ? (replay.tick * 1000) / 60 : performance.now());
      sendPresentation({ type: "soundPaused", paused: false });
    }
  }
}

const host: EngineHost = {
  randomWord() {
    let value: number;
    if (!replay) value = Math.floor(Math.random() * 65536);
    else {
      replay.random = (Math.imul(replay.random, 1664525) + 1013904223) >>> 0;
      value = replay.random >>> 16;
    }
    recording?.tape.host(["random", value]);
    return value;
  },
  print(text) {
    if (recording && recording.printed.length < 16) recording.printed.push(text.slice(0, 400));
    sendPresentation({ type: "print", text });
  },
  displayAt(row, col, text) {
    sendPresentation({ type: "display", row, col, text });
  },
  clearText() {
    sendPresentation({ type: "clearText" });
  },
  clearLines(fromRow, toRow, color) {
    sendPresentation({ type: "clearLines", fromRow, toRow, color });
  },
  setTextMode(active) {
    sendPresentation({ type: "textMode", active });
  },
  /**
   * Blocking key wait for have.key busy loops. The worker cannot receive key
   * messages while the interpreter spins, so the SAB bridge blocks the thread
   * until the main thread resolves the request; this applies in graphics mode
   * as well as in full text mode.
   */
  waitKey() {
    for (;;) {
      const buffered = keyBuffer.shift();
      if (buffered !== undefined) {
        recording?.tape.host(["waitKey", buffered]);
        return buffered;
      }
      const res = bridgeCall("waitkey", "{}");
      if (res.startsWith("{")) {
        const key = JSON.parse(res) as { id: number; code: number };
        if (key.id <= lastKeyId) continue;
        lastKeyId = key.id;
        sendControl({ type: "keyAccepted", id: key.id });
        const accepted = key.code & 0xffff;
        // A key claimed by the blocking wait never arrives as a key message.
        recordEvent({ cycle: cycleCount, kind: "key", code: accepted });
        recording?.tape.host(["waitKey", accepted]);
        return accepted;
      }
      // Direct host/test bridges retain the original numeric reply contract.
      const code = Number.parseInt(res, 10);
      if (Number.isFinite(code)) {
        recordEvent({ cycle: cycleCount, kind: "key", code });
        recording?.tape.host(["waitKey", code]);
        return code;
      }
      return 0;
    }
  },
  statusLine(text) {
    sendPresentation({ type: "status", text });
  },
  takeInputLine() {
    const line = inputBuffer.shift() ?? null;
    recording?.tape.host(["line", line]);
    return line;
  },
  takeKeys() {
    const keys = keyBuffer.splice(0);
    recording?.tape.host(["keys", keys.slice()]);
    return keys;
  },
  prepareRoom(room, from) {
    if (!authorRooms || !engine) return true;
    const container = openContainer(engine.containerFiles);
    if (container.getResource("logic", room)) return true;
    try {
      const response = bridgeCall(
        "room",
        JSON.stringify({
          room,
          from,
          edge: engine.vars[2],
          state: engine.readState(),
          objects: engine.readObjects(),
        }),
      );
      const patch = prepareRoomPatch(container, room, response, liveDictionary);
      const words = buildWordsTok(patch.words.map(([word, id]) => ({ word, id })));
      for (const resource of patch.resources)
        engine.patchResource(resource.kind, resource.num, resource.payload);
      liveDictionary.clear();
      for (const [word, id] of patch.words) liveDictionary.set(word, id);
      authoredWords = words;
      engine.patchAuxiliaryFiles({
        words,
        ...(patch.objects ? { objects: patch.objects } : {}),
        ...(patch.tests ? { tests: patch.tests } : {}),
      });
      return true;
    } catch (error) {
      sendPresentation({ type: "log", text: `Room ${room} authoring failed: ${String(error)}` });
      return false;
    }
  },
  /** 0x6e shake.screen: cosmetic jitter on the main thread. */
  shakeScreen(count) {
    sendPresentation({ type: "shake", count });
  },
  /** 0x81/0xa2 show.obj: modal view popup (engine pauses via printsPending). */
  showObj(viewNum) {
    sendPresentation({ type: "showObj", viewNum });
  },
  /** 0x1d show.pri.screen: modal priority-surface view. */
  showPriScreen() {
    sendPresentation({ type: "showPri" });
  },
  /** 0x7c status: modal inventory list. */
  statusScreen(items) {
    sendPresentation({ type: "statusScreen", items });
  },
  /** 0x76 get.num: blocking prompt through the SAB bridge; edited at (row, col). */
  promptNumber(prompt, row, col) {
    const response = bridgeCall("getnum", JSON.stringify({ prompt, row, col }));
    const n = Number.parseInt(response, 10);
    const value = Number.isFinite(n) ? n : 0;
    recording?.tape.host(["number", value]);
    return value;
  },
  /** 0x73 get.string: blocking prompt through the SAB bridge; edited at (row, col). */
  promptString(prompt, maxLen, row, col) {
    const value = bridgeCall("getstring", JSON.stringify({ prompt, maxLen, row, col })).slice(
      0,
      maxLen,
    );
    recording?.tape.host(["string", value]);
    return value;
  },
  /**
   * 0x7d save.game: the engine hands over the real save-file image (31-byte
   * description header plus the profile's length-prefixed blocks). The main
   * thread owns localStorage, and the bridge carries text, so the bytes travel
   * as base64 and are stored as base64 — never re-encoded as JSON.
   */
  listSaveGames() {
    const slots = JSON.parse(bridgeCall("saveList", "{}")) as { slot: number; image: string }[];
    return slots.map(({ slot, image }) => ({ slot, bytes: base64ToBytes(image) }));
  },
  promptSaveDescription(initial, maxLen, row, col) {
    const response = JSON.parse(
      bridgeCall("saveDescription", JSON.stringify({ initial, maxLen, row, col })),
    ) as { value: string | null };
    return response.value;
  },
  saveGame(bytes, slot = 1) {
    return (
      bridgeCall("saveWrite", JSON.stringify({ slot, image: bytesToBase64(bytes) })) === "true"
    );
  },
  /** 0x7e restore.game: blocking bridge lookup; null = cancelled or no save. */
  restoreGame(slot = 1) {
    const response = bridgeCall("restore", JSON.stringify({ slot }));
    if (!response) return null;
    try {
      return base64ToBytes(response);
    } catch {
      return null;
    }
  },
  /** 0x90 log / 0x85 obj.status.v / 0x87 show.mem: debug log stream. */
  logText(text) {
    sendPresentation({ type: "log", text });
  },
  /** 0x8d version: stored into a string slot by the engine. */
  versionString() {
    const value = engine ? `AGI ${engine.profile.id}` : "AGI IS HERE";
    recording?.tape.host(["version", value]);
    return value;
  },
  quit() {
    stopTimers();
    sendPresentation({ type: "quit" });
  },
  /** Playback state only; the engine emits scheduled audio commands separately. */
  playSound(soundNum) {
    sendPresentation({ type: "sound", soundNum });
  },
  soundDevice() {
    recording?.tape.host(["soundDevice", selectedSoundDevice]);
    return selectedSoundDevice;
  },
  soundOutput(output) {
    sendPresentation({ type: "soundOutput", output });
  },
  /** 0x64 stop.sound: silence playback on the main thread. */
  stopSound() {
    sendPresentation({ type: "stopSound" });
  },
};

let lastVisual: Uint8Array | null = null;
let lastText: Uint8Array | null = null;
let lastPicRow = -1;
let lastTextMode = false;
let lastInputEnabled = false;
let lastReleaseGate = 0;
let lastModal: string | null = null;
let lastControls = "";
let lastInputEdit = "";
let lastSoundEnabled: boolean | null = null;

function postFrame(capture = false): void {
  if (!engine || isSeeking) return;
  const enabled = engine.flags[9] !== 0;
  if (enabled !== lastSoundEnabled) {
    lastSoundEnabled = enabled;
    sendPresentation({ type: "soundEnabled", enabled });
  }
  const controls = engine.readControls();
  const serialized = JSON.stringify(controls);
  if (serialized !== lastControls) {
    lastControls = serialized;
    sendPresentation({ type: "controls", controls });
  }
  if (engine.inputEdit !== lastInputEdit) {
    lastInputEdit = engine.inputEdit;
    sendPresentation({ type: "inputEdit", text: lastInputEdit });
  }
  const frame = engine.getPresentation();
  if (capture) captureFrame(frame);
  const modal = engine.modalKind;
  const textCells = frame.text;
  // Repeated display/trace opcodes can mark text dirty without changing a cell.
  // Sending those frames floods software GPU renderers and delays user input.
  let same =
    lastInputReady === initialLogicStarted &&
    lastModal === modal &&
    lastPicRow === engine.displayBase &&
    lastTextMode === engine.textModeActive &&
    lastInputEnabled === engine.inputEnabled &&
    lastReleaseGate === engine.releaseGate &&
    lastText !== null;
  if (same && lastText) {
    for (let i = 0; i < textCells.length; i++) {
      if (textCells[i] !== lastText[i]) {
        same = false;
        break;
      }
    }
  }
  if (same && lastVisual) {
    for (let i = 0; i < frame.visual.length; i++) {
      if (frame.visual[i] !== lastVisual[i]) {
        same = false;
        break;
      }
    }
  } else if (!lastVisual) {
    same = false;
  }
  if (same) return;
  lastVisual = frame.visual.slice(); // retained copy, never transferred
  lastText = textCells.slice();
  lastPicRow = engine.displayBase;
  lastTextMode = engine.textModeActive;
  lastInputEnabled = engine.inputEnabled;
  lastInputReady = initialLogicStarted;
  lastReleaseGate = engine.releaseGate;
  lastModal = modal;
  const text = textCells.slice();
  sendPresentation(
    {
      type: "frame",
      visual: frame.visual,
      priority: frame.priority,
      text,
      picRow: engine.displayBase,
      modal,
      textMode: engine.textModeActive,
      inputEnabled: engine.inputEnabled,
      inputReady: initialLogicStarted,
      holdToMove: engine.releaseGate !== 0,
      edit: engine.inputEdit,
    },
    [frame.visual.buffer, frame.priority.buffer, text.buffer],
  );
}

/** Copy the same presentation into the rings before postFrame transfers its buffers. */
function captureFrame(frame: ReturnType<Engine["getPresentation"]>): void {
  if (!engine || replay !== null) return;
  recentRing.push(cycleCount, frame.visual, frame.priority, frame.text, engine.displayBase);
  const now = performance.now();
  if (now - lastHistoryAt >= 1000) {
    lastHistoryAt = now;
    historyRing.push(cycleCount, frame.visual, frame.priority, frame.text, engine.displayBase);
  }
}

/**
 * Serve a frames request. `stride` 1 reads the full-rate ring; anything
 * coarser than the full-rate ring's span falls back to the 1 Hz history.
 */
function serveFrames(id: unknown, count: number, stride: number, since: number | null): void {
  const n = Math.max(1, Math.min(64, Math.floor(count)));
  const step = Math.max(1, Math.floor(stride));
  const useHistory = step * n > recentRing.capacity;
  const frames = useHistory ? [] : recentRing.take(n, step, since);
  if (useHistory) {
    // History samples are timed rather than every fixed number of logic cycles.
    // Select by their actual cycle IDs so a v10 change cannot distort stride.
    const history = historyRing.take(historyRing.capacity, 1, since);
    let nextCycle = Infinity;
    for (let i = history.length - 1; i >= 0 && frames.length < n; i--) {
      const frame = history[i]!;
      if (frame.cycle > nextCycle) continue;
      frames.push(frame);
      nextCycle = frame.cycle - step;
    }
    frames.reverse();
  }
  const transfer = frames.flatMap((f) => [f.visual.buffer, f.priority.buffer, f.text.buffer]);
  sendControl({ type: "frames", id, source: useHistory ? "history" : "recent", frames }, transfer);
}

function startTimers(): void {
  if (soundTimer === null) {
    soundTimer = setInterval(() => {
      try {
        advanceSoundClock();
      } catch (error) {
        sendControl({ type: "error", message: String(error) });
        stopTimers();
      }
    }, 1000 / 60) as unknown as number;
  }
  if (timer === null) {
    timer = setInterval(() => {
      try {
        const now = performance.now();
        if (bridge && Atomics.load(bridge.i32, BRIDGE_PAUSE_SLOT) === 1) {
          cycleClock.poll(now, engine!.vars[10]!, true);
          return;
        }
        advanceSoundClock();
        if (engine!.modalKind !== null || engine!.continuationPending) {
          tickEngine();
          postFrame();
        } else if (cycleClock.poll(now, engine!.vars[10]!)) {
          flushDeferredMovement();
          tickEngine();
          cycleCount++;
          postFrame(true);
        }
        if (now - lastCycleReportAt >= CYCLE_REPORT_MS) {
          lastCycleReportAt = now;
          const scalars = engine!.readState();
          sendPresentation({
            type: "cycle",
            cycle: cycleCount,
            room: scalars.room,
            egoX: scalars.egoX,
            egoY: scalars.egoY,
          });
        }
        if (Date.now() - lastAutosaveAt >= autosaveIntervalMs) autosave(false);
      } catch (e) {
        stopTimers();
        if (e instanceof WorkerBridgeAbortError) {
          return;
        }
        sendControl({ type: "error", message: String(e) });
      }
    }, HOST_POLL_MS) as unknown as number;
  }
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === "replayAdvance" && replay && engine) {
      if (typeof msg.sessionId === "number") currentSessionId = msg.sessionId;
      const ticks = Number(msg.ticks);
      if (!Number.isInteger(ticks) || ticks < 0 || ticks > 100_000)
        throw new Error("Replay advance requires 0..100000 virtual ticks.");
      const seeking = Boolean(msg.seeking);
      const renderFinal = Boolean(msg.renderFinal);
      const fullState = Boolean(msg.fullState);
      isSeeking = seeking;
      replayRequest = Number(msg.id);
      replay.yielded = false;

      let remaining = ticks;
      const thisRequest = replayRequest;
      const thisSession = currentSessionId;

      const advanceChunk = () => {
        if (!replay || !engine) return;
        if (replayRequest !== thisRequest || currentSessionId !== thisSession) return;

        const startTime = performance.now();
        let chunkTicks = 0;
        const maxChunkTicks = seeking ? 2500 : 250;
        const maxChunkMs = seeking ? 16 : 12;
        try {
          while (remaining > 0 && chunkTicks < maxChunkTicks) {
            replay.tick++;
            remaining--;
            chunkTicks++;
            recordedClock();
            if (engine.modalKind !== null || engine.continuationPending) tickEngine();
            else if (cycleClock.poll((replay.tick * 1000) / 60, engine.vars[10]!)) {
              flushDeferredMovement();
              tickEngine();
              cycleCount++;
            }
            if (replay.yielded) break;
            if ((chunkTicks & 63) === 0 && performance.now() - startTime >= maxChunkMs) {
              break;
            }
          }
        } catch (e) {
          if (e instanceof WorkerBridgeAbortError) {
            isSeeking = false;
            replayRequest = null;
            return;
          }
          sendControl({ type: "error", id: thisRequest, message: String(e) });
          return;
        }

        if (remaining > 0 && !replay.yielded) {
          setTimeout(advanceChunk, 0);
          return;
        }

        if (!seeking || renderFinal) {
          isSeeking = false;
          postFrame();
        }
        postReplay(null, fullState);
      };

      advanceChunk();
      return;
    }
    if (msg.type === "renderFrame" && engine) {
      isSeeking = false;
      lastVisual = null;
      lastText = null;
      postFrame();
      return;
    }
    if (msg.type === "frames") {
      serveFrames(msg.id, Number(msg.count ?? 1), Number(msg.stride ?? 1), msg.since ?? null);
      return;
    }
    if (msg.type === "state") {
      sendControl({
        type: "engineState",
        id: msg.id,
        state: engine ? engine.readState() : null,
      });
      return;
    }
    if (msg.type === "objects") {
      sendControl({
        type: "objects",
        id: msg.id,
        objects: engine ? engine.readObjects() : [],
      });
      return;
    }
    if (msg.type === "startRecording") {
      if (!engine) {
        sendControl({
          type: "recordingStarted",
          id: msg.id,
          ok: false,
          error: "No game is running.",
        });
        return;
      }
      // The same safe-boundary gates an autosave uses: a modal window, a text
      // screen or the pre-first-room gap cannot resume from a save image.
      const hostImage = engine.recordingImage();
      if (!hostImage) {
        sendControl({
          type: "recordingStarted",
          id: msg.id,
          ok: false,
          error:
            "Recording needs a quiet moment: close the open window or text screen and let the room draw.",
        });
        return;
      }
      recording = {
        tape: new OperationRecorder(),
        events: [],
        printed: [],
        tainted: null,
        usedGetnum: false,
      };
      sendControl({
        type: "recordingStarted",
        id: msg.id,
        ok: true,
        image: bytesToBase64(hostImage),
        replayState: engine.captureReplayState(),
        cycle: cycleCount,
        state: engine.readState(),
      });
      return;
    }
    if (msg.type === "stopRecording") {
      const taken = recording;
      recording = null;
      sendControl({
        type: "recordingStopped",
        id: msg.id,
        operations: taken?.tape.operations ?? [],
        events: taken?.events ?? [],
        printed: taken?.printed ?? [],
        tainted: taken?.tainted ?? taken?.tape.error ?? null,
        usedGetnum: false,
        cycle: cycleCount,
        state: engine ? engine.readState() : null,
      });
      return;
    }
    if (msg.type === "cancelRecording") {
      recording = null;
      return;
    }
    if (msg.type === "exportFiles") {
      // Explicit local downloads work even while a print window is open.
      const files: Record<string, Uint8Array> | null = engine ? {} : null;
      if (files && engine) {
        for (const [name, bytes] of engine.containerFiles) files[name] = bytes.slice();
        if (authoredWords) files["WORDS.TOK"] = authoredWords;
      }
      sendControl({ type: "exportFiles", id: msg.id, files });
      return;
    }
    if (msg.type === "reenter" && engine) {
      if (recording) recording.tainted = "Game resources changed during recording.";
      // Live patch landed: re-enter the room so the new resources take effect.
      // An open message window blocks the cycle, and bytecode can never issue
      // new.room while one is up, so the harness acknowledges them first —
      // otherwise the re-entered room would sit behind an invisible window.
      for (let guard = 0; engine.modalKind !== null && guard < 16; guard++) engine.ackPrint();
      engine.reenterRoom(typeof msg.room === "number" ? msg.room : undefined);
      postFrame(true);
      sendControl({ type: "reentered", room: engine.vars[0] });
      return;
    }
    if (msg.type === "boot") {
      initialLogicStarted = false;
      const boot = msg as BootMsg;
      currentSessionId = typeof boot.sessionId === "number" ? boot.sessionId : 0;
      replay = Number.isInteger(boot.replaySeed)
        ? { tick: 0, revision: 0, random: boot.replaySeed! >>> 0, yielded: false }
        : null;
      bridge = {
        i32: new Int32Array(boot.sab, 0, 4),
        bytes: new Uint8Array(boot.sab, BRIDGE_HEADER_BYTES),
      };
      const files = new Map<string, Uint8Array>(Object.entries(boot.files));
      liveDictionary = new Map<string, number>(boot.words);
      currentBootFiles = files;
      currentDictionary = liveDictionary;
      lastReplaySeed = Number.isInteger(boot.replaySeed) ? boot.replaySeed! : null;
      authoredWords = null;
      authorRooms = boot.authorRooms === true;
      selectedSoundDevice = boot.soundDevice === 0 ? 0 : 1;
      engine = new Engine(openContainer(files), host, liveDictionary);
      // Browser sessions start with game sound enabled; saved games restore their own flag.
      engine.flags[9] = 1;
      inputBuffer = [];
      keyBuffer = [];
      deferredMovement.length = 0;
      recording = null;
      lastKeyId = 0;
      isSeeking = false;
      lastVisual = null;
      lastText = null;
      lastPicRow = -1;
      lastTextMode = false;
      lastInputEnabled = false;
      lastReleaseGate = 0;
      lastModal = null;
      lastControls = "";
      lastInputEdit = "";
      lastSoundEnabled = null;
      stopTimers();
      soundClock.reset(performance.now());
      cycleClock.reset(replay ? 0 : performance.now());
      lastCycleReportAt = performance.now();
      lastHistoryAt = performance.now();
      // v10 selects the number of 50ms timer increments between logic cycles.
      // Modal/input presentation remains responsive at the host polling cadence.
      cycleCount = 0;
      recentRing.reset();
      historyRing.reset();
      autosaveIntervalMs = Number(boot.autosaveMs ?? AUTOSAVE_INTERVAL_MS);
      autosaveFiles = boot.autosaveFiles === true;
      lastAutosaveAt = Date.now();
      lastAutosaveCycle = -1;
      lastPatchGeneration = engine.patchGeneration;
      // Autosave resume: replay the stored image into the engine before it has
      // run a single cycle, through the same restore path restore.game uses.
      // A corrupt or profile-mismatched image throws out of the decode with no
      // state touched, so the game just carries on with its normal boot.
      if (typeof boot.restoreImage === "string" && boot.restoreImage) {
        try {
          engine.restoreImage(base64ToBytes(boot.restoreImage));
          engine.restoreMenuState(boot.restoreMenus);
          const restored = engine.readState();
          sendControl({
            type: "restored",
            ok: true,
            room: restored.room,
            egoX: restored.egoX,
            egoY: restored.egoY,
          });
        } catch (e) {
          sendControl({ type: "restored", ok: false, message: String(e) });
        }
      }
      if (!replay) startTimers();
      sendControl({ type: "booted", profile: engine.profile.id });
      postReplay(null);
      return;
    }
    if (msg.type === "exitReplay") {
      replay = null;
      currentSessionId = 0;
      isSeeking = false;
      recentRing.reset();
      historyRing.reset();
      soundClock.reset(performance.now());
      cycleClock.reset(performance.now());
      lastCycleReportAt = performance.now();
      stopTimers();
      startTimers();
      postFrame();
      sendControl({ type: "exitedReplay" });
      return;
    }
    if (msg.type === "resetReplay" && currentBootFiles && currentDictionary) {
      if (typeof msg.sessionId === "number") currentSessionId = msg.sessionId;
      initialLogicStarted = false;
      isSeeking = Boolean(msg.seeking);
      if (engine) engine.stopSoundPlayback();
      const seed =
        typeof msg.seed === "number" ? msg.seed : lastReplaySeed !== null ? lastReplaySeed : 0;
      replay = { tick: 0, revision: 0, random: seed >>> 0, yielded: false };
      engine = new Engine(openContainer(currentBootFiles), host, currentDictionary);
      engine.flags[9] = 1;
      inputBuffer = [];
      keyBuffer = [];
      deferredMovement.length = 0;
      recording = null;
      lastKeyId = 0;
      lastVisual = null;
      lastText = null;
      lastPicRow = -1;
      lastTextMode = false;
      lastInputEnabled = false;
      lastReleaseGate = 0;
      lastModal = null;
      lastControls = "";
      lastInputEdit = "";
      lastSoundEnabled = null;
      stopTimers();
      soundClock.reset(performance.now());
      cycleClock.reset(0);
      lastCycleReportAt = performance.now();
      lastHistoryAt = performance.now();
      cycleCount = 0;
      recentRing.reset();
      historyRing.reset();
      if (!msg.seeking) {
        postFrame();
      }
      postReplay(null);
      return;
    }
    if (msg.type === "flush") {
      // The page is going away (hidden / pagehide / an HMR reload). The
      // autosave is posted first, so a host that awaits the acknowledgement
      // can await browser storage before resolving this request.
      const taken = autosave(true);
      sendControl({
        type: "flushed",
        id: msg.id,
        taken,
        cycle: cycleCount,
        hasEngine: Boolean(engine),
        modal: engine ? engine.modalOpen : false,
        textMode: engine ? engine.textModeActive : false,
        pictureShown: engine ? engine.isPictureShown : false,
      });
      return;
    }
    if (msg.type === "patchMetadata" && engine) {
      const files = msg.files as Partial<Record<"WORDS.TOK" | "OBJECT" | "TESTS.JSON", Uint8Array>>;
      if (recording && (files["WORDS.TOK"] || files["OBJECT"]))
        recording.tainted = "Game resources changed during recording.";
      const words = files["WORDS.TOK"] ? new Uint8Array(files["WORDS.TOK"]) : undefined;
      const objects = files["OBJECT"] ? new Uint8Array(files["OBJECT"]) : undefined;
      const tests = files["TESTS.JSON"] ? new Uint8Array(files["TESTS.JSON"]) : undefined;
      // Validate the dictionary before changing either the container or parser.
      const entries = words ? parseWordsTok(words) : undefined;
      engine.patchAuxiliaryFiles({
        ...(words ? { words } : {}),
        ...(objects ? { objects } : {}),
        ...(tests ? { tests } : {}),
      });
      if (entries && words) {
        liveDictionary.clear();
        for (const { word, id } of entries) liveDictionary.set(word, id);
        authoredWords = words;
      }
      sendControl({ type: "metadataPatched" });
      return;
    }
    if (msg.type === "patch" && engine) {
      if (recording) recording.tainted = "Game resources changed during recording.";
      engine.patchResource(msg.kind, msg.num, new Uint8Array(msg.payload));
      return;
    }
    if (msg.type === "soundEnabled" && engine) {
      recording?.tape.record(["soundEnabled", msg.enabled ? 1 : 0]);
      engine.setSoundEnabled(msg.enabled);
      postFrame();
      return;
    }
    if (msg.type === "soundDevice") {
      if (recording) recording.tainted = "The sound device changed during recording.";
      const device = msg.device === 0 ? 0 : 1;
      if (device !== selectedSoundDevice) engine?.stopSoundPlayback();
      selectedSoundDevice = device;
      if (engine) engine.vars[22] = device === 0 ? 1 : 3;
      return;
    }
    if (msg.type === "input") {
      const text = String(msg.text);
      recordEvent({ cycle: cycleCount, kind: "command", text });
      inputBuffer.push(text);
      return;
    }
    if (msg.type === "edit" && engine) {
      // Live mirror of the host's input widget onto the engine's input row.
      recording?.tape.record(["edit", String(msg.text)]);
      engine.setEditLine(String(msg.text));
      // Host typing is already in the input widget. Publish only edits made by game logic.
      lastInputEdit = engine.inputEdit;
      postFrame();
      return;
    }
    if (msg.type === "dismissPrint" && engine) {
      recording?.tape.record(["ack"]);
      recordEvent({ cycle: cycleCount, kind: "key", code: AGI_KEY.ENTER });
      engine.ackPrint();
      postFrame();
      return;
    }
    if (msg.type === "key") {
      if (
        replay &&
        typeof msg.sessionId === "number" &&
        msg.sessionId !== 0 &&
        msg.sessionId !== currentSessionId
      ) {
        return;
      }
      if (typeof msg.id === "number") {
        if (msg.id <= lastKeyId) return;
        lastKeyId = msg.id;
        sendControl({ type: "keyAccepted", id: msg.id });
      }
      flushDeferredMovement();
      const key = Number(msg.code) & 0xffff;
      recordEvent({ cycle: cycleCount, kind: "key", code: key });
      if (
        deferredMovement.length > 0 &&
        engine?.modalKind === null &&
        NAV_KEYS[key] !== undefined
      ) {
        if (deferredMovement.length < 19) deferredMovement.push(key);
      } else keyBuffer.push(key);
      return;
    }
    if (msg.type === "direction" && engine) {
      if (
        replay &&
        typeof msg.sessionId === "number" &&
        msg.sessionId !== 0 &&
        msg.sessionId !== currentSessionId
      ) {
        return;
      }
      const dir = Number(msg.dir) & 0xff;
      if (dir === 0) {
        // The main thread captures the gate even while save/restore blocks us.
        // In replay the tape's ordering is exact, so the engine's own gate is
        // truth; the mirrored holdToMove goes stale while frames are
        // suppressed during seeking.
        const eligible = replay
          ? engine.releaseGate !== 0
          : typeof msg.releaseEligible === "boolean"
            ? msg.releaseEligible
            : engine.releaseGate !== 0;
        if (eligible && deferredMovement.length < 19) deferredMovement.push(0);
        if (eligible) recordEvent({ cycle: cycleCount, kind: "release" });
        flushDeferredMovement();
        return;
      }
      const dirKey = DIRECTION_KEYS[dir];
      if (engine.modalKind !== null) {
        // Arrows steer the open modal (inventory selection, menu) instead of
        // ego; the direction key word replays the same navigation.
        if (dirKey !== undefined) recordEvent({ cycle: cycleCount, kind: "key", code: dirKey });
        recording?.tape.record(["navigate", dir]);
        engine.modalNavigate(dir);
        postFrame();
        return;
      }
      flushDeferredMovement();
      if (dirKey !== undefined) {
        // Hold-to-move games keep the heading until the release; tap games
        // toggle it with the key word itself, exactly as the runner replays.
        if (engine.releaseGate !== 0) recordEvent({ cycle: cycleCount, kind: "direction", dir });
        else recordEvent({ cycle: cycleCount, kind: "key", code: dirKey });
        if (deferredMovement.length > 0) {
          if (deferredMovement.length < 19) deferredMovement.push(dirKey);
        } else keyBuffer.push(dirKey);
      }
      return;
    }
  } catch (e) {
    if (e instanceof WorkerBridgeAbortError) {
      return;
    }
    sendControl({ type: "error", message: String(e) });
  }
};
