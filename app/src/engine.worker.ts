/// <reference types="vite/client" />
/**
 * Engine worker: hosts the authentic interpreter off the main thread.
 *
 * Messages in:
 *   { type: "boot", files, words, sab, autosaveMs?, autosaveFiles?, restoreImage? }
 *   { type: "input", text: string }        player pressed Enter on the input line
 *   { type: "direction", dir: number }     movement key press (0 = tracked key release)
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
 * Blocking (SAB bridge, see agent/sabBridge.ts):
 *   op "getnum" / "getstring"              0x76 / 0x73 modal input prompts
 *   op "restore"                           0x7e fetch a base64 save image, or "" for none
 */
import { prepareRoomPatch } from "../../src/agent/roomPatch.ts";
import { buildWordsTok, parseWordsTok } from "../../src/logic/words.ts";
import { openContainer } from "../../src/container/container.ts";
import { Engine, type EngineHost, type EngineMenuState } from "../../src/runtime/engine.ts";
import { BRIDGE_HEADER_BYTES, BRIDGE_PAUSE_SLOT } from "./agent/sabBridge.ts";
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
let authorRooms = false;
let selectedSoundDevice = 1;
let liveDictionary = new Map<string, number>();
let authoredWords: Uint8Array | null = null;
let inputBuffer: string[] = [];
let keyBuffer: number[] = [];
/** Admitted walking releases and later walking keys wait for ordinary input. */
const deferredMovement: number[] = [];
let lastKeyId = 0;
let timer: number | null = null;
let soundTimer: number | null = null;
const soundClock = new SoundClock(performance.now());
const cycleClock = new CycleClock(performance.now());
/** Poll input/modal services at display cadence; v10 separately gates logic cycles. */
const HOST_POLL_MS = 1000 / 60;
let replay: { tick: number; revision: number; random: number; yielded: boolean } | null = null;
let replayRequest: number | null = null;

function postReplay(blocked: string | null): void {
  if (!replay || !engine) return;
  const observation: ReplayObservation = {
    revision: ++replay.revision,
    tick: replay.tick,
    cycle: cycleCount,
    blocked,
    state: engine.readState(),
    rows: Array.from({ length: 25 }, (_, row) => engine!.textRow(row)),
    egoView: engine.screenObjects[0]!.view,
  };
  self.postMessage({ type: "replay", id: replayRequest, observation });
  replayRequest = null;
}

function flushDeferredMovement(): void {
  if (!engine || engine.modalKind !== null || engine.continuationPending) return;
  for (const key of deferredMovement.splice(0)) {
    if (key === 0) engine.releaseTrackedKey(true);
    else keyBuffer.push(key);
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
    self.postMessage({ type: "log", text: `Autosave snapshot failed: ${String(error)}` });
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
    const frame = engine.getFrame();
    msg["preview"] = createProgressPreview({
      visual: frame.visual,
      text: engine.textCells,
      picRow: engine.displayBase,
    });
  } catch (error) {
    self.postMessage({ type: "log", text: `Autosave preview skipped: ${String(error)}` });
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
  self.postMessage(msg);
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
    engine?.advanceClock(1000 / 60);
    engine?.soundTick();
  }
}

function bridgeCall(op: string, context: string): string {
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
  if (authoring) self.postMessage({ type: "soundPaused", paused: true });
  try {
    // The main thread may claim state 1 as state 3 before we reach the wait.
    // Wait through either state, never decode our own request.
    for (;;) {
      const state = Atomics.load(bridge.i32, 0);
      if (state === 2) break;
      // Timer callbacks cannot run inside Atomics.wait. Wake once per sound
      // interval so host prompts keep producing audio and completion flags.
      Atomics.wait(bridge.i32, 0, state, 1000 / 60);
      advanceSoundClock(authoring);
    }
    advanceSoundClock(authoring);
    const len = Atomics.load(bridge.i32, 1);
    const response = new TextDecoder().decode(bridge.bytes.slice(0, len));
    Atomics.store(bridge.i32, 0, 0); // reset for the next call
    return response;
  } finally {
    if (authoring) {
      cycleClock.reset(replay ? (replay.tick * 1000) / 60 : performance.now());
      self.postMessage({ type: "soundPaused", paused: false });
    }
  }
}

const host: EngineHost = {
  randomWord() {
    if (!replay) return Math.floor(Math.random() * 65536);
    replay.random = (Math.imul(replay.random, 1664525) + 1013904223) >>> 0;
    return replay.random >>> 16;
  },
  print(text) {
    self.postMessage({ type: "print", text });
  },
  displayAt(row, col, text) {
    self.postMessage({ type: "display", row, col, text });
  },
  clearText() {
    self.postMessage({ type: "clearText" });
  },
  clearLines(fromRow, toRow, color) {
    self.postMessage({ type: "clearLines", fromRow, toRow, color });
  },
  setTextMode(active) {
    self.postMessage({ type: "textMode", active });
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
      if (buffered !== undefined) return buffered;
      const res = bridgeCall("waitkey", "{}");
      if (res.startsWith("{")) {
        const key = JSON.parse(res) as { id: number; code: number };
        if (key.id <= lastKeyId) continue;
        lastKeyId = key.id;
        self.postMessage({ type: "keyAccepted", id: key.id });
        return key.code & 0xffff;
      }
      // Direct host/test bridges retain the original numeric reply contract.
      const code = Number.parseInt(res, 10);
      return Number.isFinite(code) ? code : 0x000d;
    }
  },
  statusLine(text) {
    self.postMessage({ type: "status", text });
  },
  takeInputLine() {
    return inputBuffer.shift() ?? null;
  },
  takeKeys() {
    return keyBuffer.splice(0);
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
      self.postMessage({ type: "log", text: `Room ${room} authoring failed: ${String(error)}` });
      return false;
    }
  },
  /** 0x6e shake.screen: cosmetic jitter on the main thread. */
  shakeScreen(count) {
    self.postMessage({ type: "shake", count });
  },
  /** 0x81/0xa2 show.obj: modal view popup (engine pauses via printsPending). */
  showObj(viewNum) {
    self.postMessage({ type: "showObj", viewNum });
  },
  /** 0x1d show.pri.screen: modal priority-surface view. */
  showPriScreen() {
    self.postMessage({ type: "showPri" });
  },
  /** 0x7c status: modal inventory list. */
  statusScreen(items) {
    self.postMessage({ type: "statusScreen", items });
  },
  /** 0x76 get.num: blocking prompt through the SAB bridge; edited at (row, col). */
  promptNumber(prompt, row, col) {
    const response = bridgeCall("getnum", JSON.stringify({ prompt, row, col }));
    const n = Number.parseInt(response, 10);
    return Number.isFinite(n) ? n : 0;
  },
  /** 0x73 get.string: blocking prompt through the SAB bridge; edited at (row, col). */
  promptString(prompt, maxLen, row, col) {
    return bridgeCall("getstring", JSON.stringify({ prompt, maxLen, row, col })).slice(0, maxLen);
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
    self.postMessage({ type: "log", text });
  },
  /** 0x8d version: stored into a string slot by the engine. */
  versionString() {
    return engine ? `AGI ${engine.profile.id}` : "AGI IS HERE";
  },
  quit() {
    clearInterval(timer ?? undefined);
    clearInterval(soundTimer ?? undefined);
    self.postMessage({ type: "quit" });
  },
  /** Playback state only; the engine emits scheduled audio commands separately. */
  playSound(soundNum) {
    self.postMessage({ type: "sound", soundNum });
  },
  soundDevice() {
    return selectedSoundDevice;
  },
  soundOutput(output) {
    self.postMessage({ type: "soundOutput", output });
  },
  /** 0x64 stop.sound: silence playback on the main thread. */
  stopSound() {
    self.postMessage({ type: "stopSound" });
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
  if (!engine) return;
  const enabled = engine.flags[9] !== 0;
  if (enabled !== lastSoundEnabled) {
    lastSoundEnabled = enabled;
    self.postMessage({ type: "soundEnabled", enabled });
  }
  const controls = engine.readControls();
  const serialized = JSON.stringify(controls);
  if (serialized !== lastControls) {
    lastControls = serialized;
    self.postMessage({ type: "controls", controls });
  }
  if (engine.inputEdit !== lastInputEdit) {
    lastInputEdit = engine.inputEdit;
    self.postMessage({ type: "inputEdit", text: lastInputEdit });
  }
  const frame = engine.getPresentation();
  if (capture) captureFrame(frame);
  const modal = engine.modalKind;
  const textCells = frame.text;
  // Repeated display/trace opcodes can mark text dirty without changing a cell.
  // Sending those frames floods software GPU renderers and delays user input.
  let same =
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
  lastReleaseGate = engine.releaseGate;
  lastModal = modal;
  const text = textCells.slice();
  self.postMessage(
    {
      type: "frame",
      visual: frame.visual,
      priority: frame.priority,
      text,
      picRow: engine.displayBase,
      modal,
      textMode: engine.textModeActive,
      inputEnabled: engine.inputEnabled,
      holdToMove: engine.releaseGate !== 0,
      edit: engine.inputEdit,
    },
    [frame.visual.buffer, frame.priority.buffer, text.buffer],
  );
}

/** Copy the same presentation into the rings before postFrame transfers its buffers. */
function captureFrame(frame: ReturnType<Engine["getPresentation"]>): void {
  if (!engine) return;
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
  self.postMessage(
    { type: "frames", id, source: useHistory ? "history" : "recent", frames },
    transfer,
  );
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === "replayAdvance" && replay && engine) {
      const ticks = Number(msg.ticks);
      if (!Number.isInteger(ticks) || ticks < 1 || ticks > 100_000)
        throw new Error("Replay advance requires 1..100000 virtual ticks.");
      replayRequest = Number(msg.id);
      replay.yielded = false;
      for (let i = 0; i < ticks; i++) {
        replay.tick++;
        engine.advanceClock(1000 / 60);
        engine.soundTick();
        if (engine.modalKind !== null || engine.continuationPending) engine.tick();
        else if (cycleClock.poll((replay.tick * 1000) / 60, engine.vars[10]!)) {
          flushDeferredMovement();
          engine.tick();
          cycleCount++;
        }
        if (replay.yielded) break;
      }
      postFrame();
      postReplay(null);
      return;
    }
    if (msg.type === "frames") {
      serveFrames(msg.id, Number(msg.count ?? 1), Number(msg.stride ?? 1), msg.since ?? null);
      return;
    }
    if (msg.type === "state") {
      self.postMessage({
        type: "engineState",
        id: msg.id,
        state: engine ? engine.readState() : null,
      });
      return;
    }
    if (msg.type === "objects") {
      self.postMessage({
        type: "objects",
        id: msg.id,
        objects: engine ? engine.readObjects() : [],
      });
      return;
    }
    if (msg.type === "exportFiles") {
      // Explicit local downloads work even while a print window is open.
      const files: Record<string, Uint8Array> | null = engine ? {} : null;
      if (files && engine) {
        for (const [name, bytes] of engine.containerFiles) files[name] = bytes.slice();
        if (authoredWords) files["WORDS.TOK"] = authoredWords;
      }
      self.postMessage({ type: "exportFiles", id: msg.id, files });
      return;
    }
    if (msg.type === "reenter" && engine) {
      // Live patch landed: re-enter the room so the new resources take effect.
      // An open message window blocks the cycle, and bytecode can never issue
      // new.room while one is up, so the harness acknowledges them first —
      // otherwise the re-entered room would sit behind an invisible window.
      for (let guard = 0; engine.modalKind !== null && guard < 16; guard++) engine.ackPrint();
      engine.reenterRoom(typeof msg.room === "number" ? msg.room : undefined);
      postFrame(true);
      self.postMessage({ type: "reentered", room: engine.vars[0] });
      return;
    }
    if (msg.type === "boot") {
      const boot = msg as BootMsg;
      replay =
        import.meta.env.MODE === "test" && Number.isInteger(boot.replaySeed)
          ? { tick: 0, revision: 0, random: boot.replaySeed! >>> 0, yielded: false }
          : null;
      bridge = {
        i32: new Int32Array(boot.sab, 0, 4),
        bytes: new Uint8Array(boot.sab, BRIDGE_HEADER_BYTES),
      };
      const files = new Map<string, Uint8Array>(Object.entries(boot.files));
      liveDictionary = new Map<string, number>(boot.words);
      authoredWords = null;
      authorRooms = boot.authorRooms === true;
      selectedSoundDevice = boot.soundDevice === 0 ? 0 : 1;
      engine = new Engine(openContainer(files), host, liveDictionary);
      // Browser sessions start with game sound enabled; saved games restore their own flag.
      engine.flags[9] = 1;
      inputBuffer = [];
      keyBuffer = [];
      deferredMovement.length = 0;
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
      clearInterval(timer ?? undefined);
      clearInterval(soundTimer ?? undefined);
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
          self.postMessage({
            type: "restored",
            ok: true,
            room: restored.room,
            egoX: restored.egoX,
            egoY: restored.egoY,
          });
        } catch (e) {
          self.postMessage({ type: "restored", ok: false, message: String(e) });
        }
      }
      if (!replay)
        soundTimer = setInterval(() => {
          try {
            advanceSoundClock();
          } catch (error) {
            self.postMessage({ type: "error", message: String(error) });
            clearInterval(soundTimer ?? undefined);
            clearInterval(timer ?? undefined);
          }
        }, 1000 / 60) as unknown as number;
      if (!replay)
        timer = setInterval(() => {
          try {
            // Remix freeze: the interpreter parks BETWEEN cycles, so the
            // world stops mid-step and resumes on exactly the state it left.
            // The worker deliberately stays responsive while parked: read_frames,
            // read_state and patch all have to work on a frozen game.
            const now = performance.now();
            if (bridge && Atomics.load(bridge.i32, BRIDGE_PAUSE_SLOT) === 1) {
              cycleClock.poll(now, engine!.vars[10]!, true);
              return;
            }
            advanceSoundClock();
            if (engine!.modalKind !== null || engine!.continuationPending) {
              // Acknowledgement resumes the suspended instruction's call stack.
              // Let timer increments accumulate while a normal game modal is open.
              engine!.tick();
              postFrame();
            } else if (cycleClock.poll(now, engine!.vars[10]!)) {
              flushDeferredMovement();
              engine!.tick();
              cycleCount++;
              postFrame(true);
            }
            // Liveness heartbeat. Frames are posted only when the screen
            // changes, so a static room posts nothing and the host cannot tell
            // "parked" from "nothing moved". This counter always advances while
            // the interpreter is cycling and stops dead the moment it parks.
            if (now - lastCycleReportAt >= CYCLE_REPORT_MS) {
              lastCycleReportAt = now;
              // The heartbeat carries the scalars a host (and a proof run) needs
              // to say WHERE the game is, not just that it is alive: a resumed
              // game has to land in the room and on the spot it left.
              const scalars = engine!.readState();
              self.postMessage({
                type: "cycle",
                cycle: cycleCount,
                room: scalars.room,
                egoX: scalars.egoX,
                egoY: scalars.egoY,
              });
            }
            // Autosave: on the cadence, and always between cycles rather than
            // inside one. A boundary the engine refuses (an open window, a text
            // screen) is simply skipped and retried on the next tick, which is
            // why this is a poll and not a timer of its own.
            if (Date.now() - lastAutosaveAt >= autosaveIntervalMs) autosave(false);
          } catch (e) {
            self.postMessage({ type: "error", message: String(e) });
            clearInterval(timer ?? undefined);
            clearInterval(soundTimer ?? undefined);
          }
        }, HOST_POLL_MS) as unknown as number;
      self.postMessage({ type: "booted", profile: engine.profile.id });
      postReplay(null);
      return;
    }
    if (msg.type === "flush") {
      // The page is going away (hidden / pagehide / an HMR reload). The
      // autosave is posted first, so a host that awaits the acknowledgement
      // can await browser storage before resolving this request.
      const taken = autosave(true);
      self.postMessage({ type: "flushed", id: msg.id, taken });
      return;
    }
    if (msg.type === "patchMetadata" && engine) {
      const files = msg.files as Partial<Record<"WORDS.TOK" | "OBJECT" | "TESTS.JSON", Uint8Array>>;
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
      self.postMessage({ type: "metadataPatched" });
      return;
    }
    if (msg.type === "patch" && engine) {
      engine.patchResource(msg.kind, msg.num, new Uint8Array(msg.payload));
      return;
    }
    if (msg.type === "soundEnabled" && engine) {
      engine.setSoundEnabled(msg.enabled);
      postFrame();
      return;
    }
    if (msg.type === "soundDevice") {
      const device = msg.device === 0 ? 0 : 1;
      if (device !== selectedSoundDevice) engine?.stopSoundPlayback();
      selectedSoundDevice = device;
      if (engine) engine.vars[22] = device === 0 ? 1 : 3;
      return;
    }
    if (msg.type === "input") {
      inputBuffer.push(String(msg.text));
      return;
    }
    if (msg.type === "edit" && engine) {
      // Live mirror of the host's input widget onto the engine's input row.
      engine.setEditLine(String(msg.text));
      // Host typing is already in the input widget. Publish only edits made by game logic.
      lastInputEdit = engine.inputEdit;
      postFrame();
      return;
    }
    if (msg.type === "dismissPrint" && engine) {
      engine.ackPrint();
      postFrame();
      return;
    }
    if (msg.type === "key") {
      if (typeof msg.id === "number") {
        if (msg.id <= lastKeyId) return;
        lastKeyId = msg.id;
        self.postMessage({ type: "keyAccepted", id: msg.id });
      }
      flushDeferredMovement();
      const key = Number(msg.code) & 0xffff;
      if (
        deferredMovement.length > 0 &&
        engine?.modalKind === null &&
        [0x4800, 0x4900, 0x4d00, 0x5100, 0x5000, 0x4f00, 0x4b00, 0x4700].includes(key)
      ) {
        if (deferredMovement.length < 19) deferredMovement.push(key);
      } else keyBuffer.push(key);
      return;
    }
    if (msg.type === "direction" && engine) {
      const dir = Number(msg.dir) & 0xff;
      if (dir === 0) {
        // The main thread captures the gate even while save/restore blocks us.
        const eligible =
          typeof msg.releaseEligible === "boolean" ? msg.releaseEligible : engine.releaseGate !== 0;
        if (eligible && deferredMovement.length < 19) deferredMovement.push(0);
        flushDeferredMovement();
        return;
      }
      if (engine.modalKind !== null) {
        // Arrows steer the open modal (inventory selection, menu) instead of ego.
        if (dir !== 0) {
          engine.modalNavigate(dir);
          postFrame();
        }
        return;
      }
      flushDeferredMovement();
      const key = [0, 0x4800, 0x4900, 0x4d00, 0x5100, 0x5000, 0x4f00, 0x4b00, 0x4700][dir];
      if (key !== undefined) {
        if (deferredMovement.length > 0) {
          if (deferredMovement.length < 19) deferredMovement.push(key);
        } else keyBuffer.push(key);
      }
      return;
    }
  } catch (e) {
    self.postMessage({ type: "error", message: String(e) });
  }
};
