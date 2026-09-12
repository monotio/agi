/// <reference types="vite/client" />
/**
 * Engine worker: hosts the authentic interpreter off the main thread.
 *
 * Messages in:
 *   { type: "boot", files, words, autosaveMs?, autosaveFiles?, restoreImage? }
 *   { type: "pause", paused }              remix freeze; acknowledged by "paused"
 *   { type: "input", text: string }        player pressed Enter on the input line
 *   { type: "key", code }                  key press; answers a parked key wait
 *   { type: "direction", dir: number }     movement key press (0 = tracked key release)
 *   { type: "hostAnswer", id, response }   reply to a posted hostRequest
 *   { type: "startRecording" / "stopRecording" / "cancelRecording", id }
 *                                          player-action capture for a stored game test
 *   { type: "flush" }                      take an autosave now (page is going away)
 *   { type: "debug", channels }            arm inspector channels: ownership,
 *                                          objects, trace
 *   { type: "debugWrite", vars, flags }    apply [index, value] pairs at a
 *                                          cycle boundary (Sierra SET VAR /
 *                                          SET FLAG debug actions)
 *   { type: "debugEvents", id, since }     per-cycle var/flag diff ring
 *   { type: "debugTrace", id, since }      instruction trace ring
 *
 * Messages out:
 *   { type: "frame", visual, priority, text, picRow, modal, textMode, edit,
 *     cycle, ownership?, objects? }        transferable copies, sent when
 *                                          changed; text = 40x25 [char, attr]
 *                                          cells; ownership/objects only when
 *                                          the matching debug channel is armed
 *   { type: "trace", records }             batched structured instruction
 *                                          records while the trace channel
 *                                          is armed
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
 *   { type: "hostRequest", id, op, context }
 *                                          a suspended host service — prompt,
 *                                          save slot, restore, room authoring
 *   { type: "waitingForKey", waiting }     a parked key wait opened or closed
 *   { type: "paused", paused }             acknowledgement of a pause message
 *   { type: "booted", profile }            first cycles completed
 *   { type: "error", message }
 */
import { prepareRoomPatch } from "../../src/agent/roomPatch.ts";
import { buildWordsTok, parseWordsTok } from "../../src/logic/words.ts";
import { openContainer } from "../../src/container/container.ts";
import { OperationRecorder } from "../../src/agent/recordedReplay.ts";
import type { RecordedEvent } from "./gameRecording.ts";
import {
  Engine,
  HostWait,
  type EngineHost,
  type EngineMenuState,
  type TraceRecord,
} from "../../src/runtime/engine.ts";
import { AGI_KEY, DIRECTION_KEYS, NAV_KEYS } from "../../src/runtime/keys.ts";
import type { LlmRequest } from "./agent/hostRequests.ts";
import { FrameRing } from "./frameRing.ts";
import { CycleClock } from "../../src/runtime/cycleClock.ts";
import { SoundClock } from "./soundClock.ts";
import type { ReplayObservation } from "./replay.ts";
import { createProgressPreview } from "./progressPreview.ts";

/** Save-file image as base64: worker messages and localStorage both carry text. */
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
/**
 * Queued key presses. A parked key wait — have.key, a selector, a
 * confirmation — is answered straight from this queue by the arriving key
 * message; keys never cross a host request.
 */
let keyQueue: number[] = [];
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
  // A suspended interaction freezes the cycle until its answer lands — the
  // gate inside tick() is the same, but skipping here keeps the recorder's
  // operation list honest: a parked tick never runs.
  if (engine.hostInteractionPending && !engine.hostInteractionReady) return;
  if (recording) {
    recording.tape.run("tick", () => engine!.tick());
    // A tick that ended suspended stays one recorded operation: the resumed
    // answer and the calls it produces join the same list on the next tick.
    if (engine!.awaitingHostAnswer) recording.tape.holdTick();
  } else engine.tick();
}
function recordedClock(): void {
  recording?.tape.clock();
  engine?.advanceClock(1000 / 60);
  engine?.soundTick();
}
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
let replay: { tick: number; revision: number; random: number } | null = null;
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
    } else keyQueue.push(key);
  }
  // Keys flushed while an interaction is parked still feed its key wait.
  deliverQueuedKey();
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
 * The engine refuses the snapshot while a live host request owns the answer
 * (a prompt, the save/restore selector, a confirmation), while a text screen
 * owns the surface, or before a room has drawn; a parked window or key wait
 * serializes into the image's continuation instead. The worker adds the cheap
 * gate on top: an image is encoded only when the interpreter actually
 * advanced since the last one, so a parked or idle game costs nothing.
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
 * Frame history for the agent's `read_room_context` tool: the last 100 cycles plus
 * 60 history samples captured at most once per second. Both rings preallocate their typed arrays, so a cycle
 * costs three buffer copies and nothing else.
 */
const recentRing = new FrameRing(100);
const historyRing = new FrameRing(60);

/**
 * Inspector channels armed by the host. ownership/objects ride on frame
 * posts; trace streams structured instruction records. Each channel costs
 * real per-cycle work, so they stay disarmed until a debug view asks.
 */
const debug = { ownership: false, objects: false, trace: false, picture: false };

/** One observed interpreter-state write, attributed to a completed cycle. */
interface DebugEvent {
  seq: number;
  cycle: number;
  kind: "var" | "flag";
  index: number;
  from: number;
  to: number;
}
const DEBUG_EVENT_CAP = 4000;
const debugEvents: DebugEvent[] = [];
let debugEventSeq = 0;
let prevVars: Uint8Array | null = null;
let prevFlags: Uint8Array | null = null;

/**
 * Diff vars/flags against the previous completed cycle. The ring records
 * every write the interpreter made — the timeline lane's raw material —
 * whether or not an inspector view is currently open.
 */
function captureStateDiffs(): void {
  if (!engine) return;
  if (prevVars === null || prevFlags === null) {
    prevVars = engine.vars.slice();
    prevFlags = engine.flags.slice();
    return;
  }
  for (let i = 0; i < 256; i++) {
    const v = engine.vars[i]!;
    if (v !== prevVars[i])
      debugEvents.push({
        seq: ++debugEventSeq,
        cycle: cycleCount,
        kind: "var",
        index: i,
        from: prevVars[i]!,
        to: v,
      });
    const f = engine.flags[i]!;
    if (f !== prevFlags[i])
      debugEvents.push({
        seq: ++debugEventSeq,
        cycle: cycleCount,
        kind: "flag",
        index: i,
        from: prevFlags[i]!,
        to: f,
      });
  }
  prevVars.set(engine.vars);
  prevFlags.set(engine.flags);
  if (debugEvents.length > DEBUG_EVENT_CAP)
    debugEvents.splice(0, debugEvents.length - DEBUG_EVENT_CAP);
}

/** Trace records carry their interpreter cycle plus a stream sequence. */
type StampedTrace = TraceRecord & { seq: number; cycle: number };
const TRACE_CAP = 4000;
const TRACE_POST_MAX = 500;
const traceRing: StampedTrace[] = [];
let traceSeq = 0;
let pendingTrace: StampedTrace[] = [];

function applyTraceChannel(): void {
  engine?.setTraceListener(
    debug.trace
      ? (record) => {
          const stamped = { ...record, seq: ++traceSeq, cycle: cycleCount };
          traceRing.push(stamped);
          if (traceRing.length > TRACE_CAP) traceRing.splice(0, traceRing.length - TRACE_CAP);
          pendingTrace.push(stamped);
        }
      : null,
  );
}

/** Post accumulated trace records; sendPresentation drops them while seeking. */
function flushTraceBatch(): void {
  if (pendingTrace.length === 0) return;
  sendPresentation({ type: "trace", records: pendingTrace.splice(0, TRACE_POST_MAX) });
}

/** Completed interpreter cycle: count it, attribute state writes, ship trace. */
function finishCycle(): void {
  cycleCount++;
  captureStateDiffs();
  flushTraceBatch();
}

/**
 * The remix freeze. A `pause` message sets it; messages from one sender are
 * delivered in order, so a pause posted before a query is always applied
 * before the query is served — at most one more cycle runs first, and that
 * cycle is invisible since nobody reads state before the freeze lands.
 */
let paused = false;
/**
 * The host request currently in flight, or null when none is. The engine's
 * pendingInteraction armed before the request posted; the matching
 * { type: "hostAnswer" } message feeds `deliverHostResponse`, which hands it
 * to `engine.deliverHostAnswer` — the interpreter stays parked until then.
 */
let hostRequestSerial = 0;
let hostRequestOutstanding: { id: number; op: string; authoring: boolean } | null = null;
/** A reenter suspended on room authoring owes the host a `reentered`. */
let pendingReenter = false;
/** The suspended interaction waits on a player key, not a host request. */
let keyWaiting = false;

function setKeyWaiting(waiting: boolean): void {
  if (waiting === keyWaiting) return;
  keyWaiting = waiting;
  sendPresentation({ type: "waitingForKey", waiting });
}

function advanceSoundClock(authoring = false): void {
  if (replay) return;
  const frozen = authoring || paused;
  const ticks = soundClock.advance(performance.now(), frozen);
  for (let tick = 0; tick < ticks; tick++) {
    recordedClock();
  }
}

type HostRequestOp = LlmRequest["op"];

/**
 * Post a host-service request as an ordinary worker message and suspend the
 * interpreter pass that asked for it. runLogicStack parks the logic stack on
 * the thrown HostWait; the { type: "hostAnswer" } reply delivers the response
 * and resumes the parked pass — so the host keeps inspecting, saving and
 * editing while the game waits.
 */
function postHostRequest(op: HostRequestOp, context: Record<string, unknown>): never {
  if (recording && !["getstring", "getnum"].includes(op))
    recording.tainted = `The recording used unsupported host service ${op}.`;
  advanceSoundClock();
  // The interpreter is about to suspend: ship the frame that shows the
  // prompt (or the selector) the request belongs to.
  postFrame();
  const id = ++hostRequestSerial;
  const authoring = op === "room";
  hostRequestOutstanding = { id, op, authoring };
  sendControl({ type: "hostRequest", id, op, context });
  if (replay && ["getnum", "getstring", "saveDescription"].includes(op)) {
    postReplay(op);
  }
  if (authoring) sendPresentation({ type: "soundPaused", paused: true });
  throw new HostWait();
}

/** The request finished or was abandoned: release the authoring pause. */
function settleHostRequest(outstanding: { op: string; authoring: boolean }): void {
  if (!outstanding.authoring) return;
  cycleClock.reset(replay ? (replay.tick * 1000) / 60 : performance.now());
  sendPresentation({ type: "soundPaused", paused: false });
}

/**
 * A queued key answers a parked key wait: no host request was ever posted
 * for it, so the arriving key is its answer — applied at this message
 * boundary exactly like a host answer. Replay mode has no timer to pick it
 * up later.
 */
function deliverQueuedKey(): void {
  if (!engine?.awaitingKey) return;
  const queued = keyQueue.shift();
  if (queued === undefined) return;
  setKeyWaiting(false);
  if (recording) {
    // The answer and the resumed pass belong to one recorded operation —
    // the same shape a live suspension produces. Recording the delivery
    // inside the tick run keeps it in the list: outside a run, tape.host
    // drops calls, and a recording that started on this wait would lose it.
    recording.tape.run("tick", () => {
      recording!.tape.host(["waitKey", queued]);
      engine!.deliverHostAnswer(queued);
      engine!.tick();
    });
    if (engine.awaitingHostAnswer) recording.tape.holdTick();
  } else {
    engine.deliverHostAnswer(queued);
    if (engine.hostInteractionReady) tickEngine();
  }
  if (replay && !engine.awaitingHostAnswer) postReplay(null, true);
}

/**
 * Drop the in-flight host request and tell the main thread to resolve the
 * UI it opened — a superseded request's late answer is dropped by the id
 * check in the hostAnswer handler.
 */
function abandonHostRequest(): void {
  const outstanding = hostRequestOutstanding;
  if (outstanding === null) return;
  hostRequestOutstanding = null;
  settleHostRequest(outstanding);
  sendControl({ type: "interactionCancelled", id: outstanding.id, op: outstanding.op });
}

/** Hand a host answer to the suspended interaction it resolves. */
function deliverHostResponse(op: string, response: string): void {
  if (!engine) return;
  switch (op) {
    case "getnum": {
      const n = Number.parseInt(response, 10);
      const value = Number.isFinite(n) ? n : 0;
      if (recording) {
        recording.usedGetnum = true;
        recordEvent({ cycle: cycleCount, kind: "answer", text: response });
      }
      recording?.tape.host(["number", value]);
      engine.deliverHostAnswer(value);
      return;
    }
    case "getstring": {
      if (recording) recordEvent({ cycle: cycleCount, kind: "answer", text: response });
      recording?.tape.host(["string", response]);
      engine.deliverHostAnswer(response);
      return;
    }
    case "saveList": {
      // Anything unparseable ("storage-error", an empty cancel) is a failed
      // listing; the selector shows its own failure screen for null.
      let slots: { slot: number; bytes: Uint8Array }[] | null;
      try {
        const parsed = JSON.parse(response) as { slot: number; image: string }[];
        slots = parsed.map(({ slot, image }) => ({ slot, bytes: base64ToBytes(image) }));
      } catch {
        slots = null;
      }
      engine.deliverHostAnswer(slots);
      return;
    }
    case "saveDescription": {
      // A cancelled prompt resolves ""; the empty answer cancels the dialog.
      let value: string | null;
      try {
        value = (JSON.parse(response) as { value: string | null }).value;
      } catch {
        value = null;
      }
      engine.deliverHostAnswer(value);
      return;
    }
    case "saveWrite":
      engine.deliverHostAnswer(response === "true");
      return;
    case "restore": {
      let bytes: Uint8Array | null = null;
      if (response) {
        try {
          bytes = base64ToBytes(response);
        } catch {
          bytes = null;
        }
      }
      if (bytes && recording) {
        // A restore replaces the interpreter state mid-recording; the captured
        // steps no longer describe the live game.
        recording.tainted = "the game was restored mid-recording";
      }
      engine.deliverHostAnswer(bytes);
      return;
    }
    case "room": {
      // Apply the authored patch the agent produced, then deliver the outcome.
      const request = engine.hostInteraction;
      const room = request?.kind === "room" ? request.room : -1;
      let prepared = false;
      if (room >= 0) {
        try {
          const container = openContainer(engine.containerFiles);
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
          prepared = true;
        } catch (error) {
          sendPresentation({
            type: "log",
            text: `Room ${room} authoring failed: ${String(error)}`,
          });
        }
      }
      engine.deliverHostAnswer(prepared);
      return;
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
   * Key wait for have.key busy loops, selectors and confirmations. Queued
   * keys answer synchronously; otherwise the engine suspends on the thrown
   * HostWait and the next key message delivers the answer — the worker keeps
   * serving application messages meanwhile.
   */
  waitKey() {
    const buffered = keyQueue.shift();
    if (buffered !== undefined) {
      recording?.tape.host(["waitKey", buffered]);
      return buffered;
    }
    setKeyWaiting(true);
    if (replay) postReplay("waitkey");
    throw new HostWait();
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
    const keys = keyQueue.splice(0);
    recording?.tape.host(["keys", keys.slice()]);
    return keys;
  },
  prepareRoom(room, from) {
    if (!authorRooms || !engine) return true;
    const container = openContainer(engine.containerFiles);
    if (container.getResource("logic", room)) return true;
    // The agent's answer lands in deliverHostResponse, which applies the
    // patch and delivers true/false to the suspended new.room.
    return postHostRequest("room", {
      room,
      from,
      edge: engine.vars[2],
      state: engine.readState(),
      objects: engine.readObjects(),
    });
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
  /** 0x76 get.num: a host-request prompt; the engine suspends until answered. */
  promptNumber(prompt, row, col) {
    return postHostRequest("getnum", { prompt, row, col });
  },
  /** 0x73 get.string: a host-request prompt; the engine suspends until answered. */
  promptString(prompt, maxLen, row, col) {
    return postHostRequest("getstring", { prompt, maxLen, row, col });
  },
  /**
   * 0x7d save.game: the selector's directory listing is a host request; the
   * response's base64 images decode on delivery.
   */
  listSaveGames() {
    return postHostRequest("saveList", {});
  },
  get promptSaveDescription() {
    // Replays drive the save dialog with recorded key presses, so the engine's
    // own in-dialog editor must run: a DOM prompt can never be answered by a
    // recorded key, only by an explicit answer action.
    if (replay) return undefined;
    return (initial: string, maxLen: number, row: number, col: number) =>
      postHostRequest("saveDescription", { initial, maxLen, row, col });
  },
  saveGame(bytes, slot = 1) {
    // The main thread owns localStorage; the image travels as base64.
    return postHostRequest("saveWrite", { slot, image: bytesToBase64(bytes) });
  },
  /** 0x7e restore.game: the save lookup is a host request; null = cancelled. */
  restoreGame(slot = 1) {
    return postHostRequest("restore", { slot });
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
let lastOwnership: Uint16Array | null = null;
let lastPicture: Uint8Array | null = null;
let lastPicturePriority: Uint8Array | null = null;
let lastObjectsJson = "";
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
  // Armed inspector channels join the sameness check so a sprite's sub-pixel
  // or slot change still ships its fresh ownership/objects payload.
  const ownership = debug.ownership ? engine.getOwnership() : null;
  const objects = debug.objects ? engine.readObjects() : null;
  const picture = debug.picture ? engine.getPictureSurface() : null;
  const objectsJson = objects ? JSON.stringify(objects) : "";
  // Repeated display/trace opcodes can mark text dirty without changing a cell.
  // Sending those frames floods software GPU renderers and delays user input.
  let same =
    lastInputReady === initialLogicStarted &&
    lastModal === modal &&
    lastPicRow === engine.displayBase &&
    lastTextMode === engine.textModeActive &&
    lastInputEnabled === engine.inputEnabled &&
    lastReleaseGate === engine.releaseGate &&
    objectsJson === lastObjectsJson &&
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
  if (same && ownership && lastOwnership) {
    for (let i = 0; i < ownership.length; i++) {
      if (ownership[i] !== lastOwnership[i]) {
        same = false;
        break;
      }
    }
  } else if (same && ownership !== null && lastOwnership === null) {
    same = false;
  }
  if (same && picture && lastPicture) {
    for (let i = 0; i < picture.visual.length; i++) {
      if (picture.visual[i] !== lastPicture[i] || picture.priority[i] !== lastPicturePriority![i]) {
        same = false;
        break;
      }
    }
  } else if (same && picture !== null && lastPicture === null) {
    same = false;
  }
  if (same) return;
  lastVisual = frame.visual.slice(); // retained copy, never transferred
  lastText = textCells.slice();
  lastOwnership = ownership ? ownership.slice() : null;
  lastPicture = picture ? picture.visual.slice() : null;
  lastPicturePriority = picture ? picture.priority.slice() : null;
  lastObjectsJson = objectsJson;
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
      cycle: cycleCount,
      ...(ownership ? { ownership } : {}),
      ...(objects ? { objects } : {}),
      ...(picture ? { picVisual: picture.visual, picPriority: picture.priority } : {}),
    },
    [
      frame.visual.buffer,
      frame.priority.buffer,
      text.buffer,
      ...(ownership ? [ownership.buffer] : []),
      ...(picture ? [picture.visual.buffer, picture.priority.buffer] : []),
    ],
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
        if (paused) {
          cycleClock.poll(now, engine!.vars[10]!, true);
          return;
        }
        advanceSoundClock();
        deliverQueuedKey();
        if (
          engine!.modalKind !== null ||
          engine!.continuationPending ||
          engine!.hostInteractionPending
        ) {
          tickEngine();
          flushTraceBatch();
          postFrame();
          if (pendingReenter && !engine!.hostInteractionPending) {
            // The suspended re-entered room has landed (or been declined).
            pendingReenter = false;
            sendControl({ type: "reentered", room: engine!.vars[0] });
            postFrame(true);
          }
        } else if (cycleClock.poll(now, engine!.vars[10]!)) {
          flushDeferredMovement();
          tickEngine();
          finishCycle();
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
        sendControl({ type: "error", message: String(e) });
      }
    }, HOST_POLL_MS) as unknown as number;
  }
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === "pause") {
      paused = msg.paused === true;
      sendControl({ type: "paused", paused });
      return;
    }
    if (msg.type === "hostAnswer") {
      // The main thread resolved the in-flight host request. A stale id —
      // an answer for a request already abandoned — is dropped, never
      // delivered.
      const id = Number(msg.id);
      const outstanding = hostRequestOutstanding;
      if (!engine || outstanding === null || outstanding.id !== id) return;
      hostRequestOutstanding = null;
      settleHostRequest(outstanding);
      try {
        deliverHostResponse(outstanding.op, String(msg.response ?? ""));
      } catch (wait) {
        if (!(wait instanceof HostWait)) throw wait;
      }
      // Apply the landed answer at this boundary rather than the next timer
      // pass: a message posted after the answer — a state query, the key's
      // own echo — observes the resumed state. A re-suspension (the
      // selector's next need) posts its request inside this tick.
      if (engine.hostInteractionReady) tickEngine();
      // The runner holds the blocked observation postReplay(op) sent when
      // the request fired; the resumed state is its unblocked follow-up.
      if (replay && !engine.awaitingHostAnswer) postReplay(null, true);
      return;
    }
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
            // A parked host wait consumes no replay ticks, exactly as the
            // blocking bridge did: its answer's delivery resumes the chunk.
            if (engine.awaitingHostAnswer) break;
            replay.tick++;
            remaining--;
            chunkTicks++;
            recordedClock();
            if (
              engine.modalKind !== null ||
              engine.continuationPending ||
              engine.hostInteractionPending
            )
              tickEngine();
            else if (cycleClock.poll((replay.tick * 1000) / 60, engine.vars[10]!)) {
              flushDeferredMovement();
              tickEngine();
              finishCycle();
            }
            if ((chunkTicks & 63) === 0 && performance.now() - startTime >= maxChunkMs) {
              break;
            }
          }
        } catch (e) {
          sendControl({ type: "error", id: thisRequest, message: String(e) });
          return;
        }

        // The runner already has its blocked observation from postReplay(op);
        // the answer's delivery posts the next one.
        if (engine.awaitingHostAnswer) return;
        if (remaining > 0) {
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
    if (msg.type === "debug") {
      const want = (msg.channels ?? {}) as Record<string, unknown>;
      const traceWas = debug.trace;
      debug.ownership = want["ownership"] === true;
      debug.objects = want["objects"] === true;
      debug.trace = want["trace"] === true;
      debug.picture = want["picture"] === true;
      if (debug.trace !== traceWas) applyTraceChannel();
      // Invalidate the sameness check so a newly armed channel ships with the
      // next frame and a disarmed one clears promptly.
      lastVisual = null;
      lastObjectsJson = "";
      postFrame();
      return;
    }
    if (msg.type === "debugWrite" && engine) {
      if (Array.isArray(msg.vars))
        for (const pair of msg.vars as number[][]) engine.vars[pair[0]! & 0xff] = pair[1]! & 0xff;
      if (Array.isArray(msg.flags))
        for (const pair of msg.flags as number[][]) engine.flags[pair[0]! & 0xff] = pair[1] ? 1 : 0;
      // Attribute the host write to the current boundary, not the next cycle.
      captureStateDiffs();
      sendControl({ type: "debugWritten", id: msg.id });
      return;
    }
    if (msg.type === "debugEvents") {
      const since = typeof msg.since === "number" ? msg.since : 0;
      sendControl({
        type: "debugEvents",
        id: msg.id,
        cycle: cycleCount,
        latestSeq: debugEventSeq,
        events: debugEvents.filter((e) => e.seq > since),
      });
      return;
    }
    if (msg.type === "debugTrace") {
      const since = typeof msg.since === "number" ? msg.since : 0;
      sendControl({
        type: "debugTrace",
        id: msg.id,
        cycle: cycleCount,
        latestSeq: traceSeq,
        records: traceRing.filter((r) => r.seq > since),
      });
      return;
    }
    if (msg.type === "checkpoint") {
      // The paused interpreter's resumable image — the candidate preview's
      // restore point. null outside a resumable cycle boundary.
      sendControl({
        type: "checkpoint",
        id: msg.id,
        image: engine ? engine.autosaveImage() : null,
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
      // The same safe-boundary gates an autosave uses: a suspended host
      // request, a text screen or the pre-first-room gap cannot resume; a
      // parked window or key wait records with its continuation.
      const hostImage = engine.recordingImage();
      if (!hostImage) {
        sendControl({
          type: "recordingStarted",
          id: msg.id,
          ok: false,
          error: "Recording needs a quiet moment: answer the open prompt and let the room draw.",
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
      // A suspended interaction is abandoned: its parked continuation is
      // meaningless once the room's resources change under it, and the
      // request still in flight resolves into a dropped answer.
      if (engine.hostInteractionPending) {
        engine.abortInteraction();
        setKeyWaiting(false);
        abandonHostRequest();
      }
      // Live patch landed: re-enter the room so the new resources take effect.
      // An open message window blocks the cycle, and bytecode can never issue
      // new.room while one is up, so the harness acknowledges them first —
      // otherwise the re-entered room would sit behind an invisible window.
      for (let guard = 0; engine.modalKind !== null && guard < 16; guard++) engine.ackPrint();
      try {
        engine.reenterRoom(typeof msg.room === "number" ? msg.room : undefined);
      } catch (wait) {
        if (!(wait instanceof HostWait)) throw wait;
        // Room authoring suspended the transition: the hostAnswer message
        // delivers it and the timer's tick completes it, then reports.
        pendingReenter = true;
        postFrame(true);
        return;
      }
      postFrame(true);
      sendControl({ type: "reentered", room: engine.vars[0] });
      return;
    }
    if (msg.type === "boot") {
      initialLogicStarted = false;
      const boot = msg as BootMsg;
      currentSessionId = typeof boot.sessionId === "number" ? boot.sessionId : 0;
      replay = Number.isInteger(boot.replaySeed)
        ? { tick: 0, revision: 0, random: boot.replaySeed! >>> 0 }
        : null;
      paused = false;
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
      keyQueue = [];
      deferredMovement.length = 0;
      recording = null;
      hostRequestOutstanding = null;
      keyWaiting = false;
      pendingReenter = false;
      isSeeking = false;
      lastVisual = null;
      lastText = null;
      lastOwnership = null;
      lastPicture = null;
      lastPicturePriority = null;
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
      debugEvents.length = 0;
      debugEventSeq = 0;
      prevVars = null;
      prevFlags = null;
      traceRing.length = 0;
      traceSeq = 0;
      pendingTrace = [];
      applyTraceChannel();
      // Baseline the diff ring before the first cycle so boot writes count.
      captureStateDiffs();
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
          // A checkpoint parked at a have.key wait restores still waiting:
          // the host needs the flag to route the answering key back.
          if (engine.awaitingKey) setKeyWaiting(true);
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
      paused = false;
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
      replay = { tick: 0, revision: 0, random: seed >>> 0 };
      // A request in flight belonged to the replaced engine; its late answer
      // is dropped by the serial check and the host resolves its UI now.
      abandonHostRequest();
      setKeyWaiting(false);
      engine = new Engine(openContainer(currentBootFiles), host, currentDictionary);
      engine.flags[9] = 1;
      inputBuffer = [];
      keyQueue = [];
      deferredMovement.length = 0;
      recording = null;
      pendingReenter = false;
      paused = false;
      lastVisual = null;
      lastText = null;
      lastOwnership = null;
      lastPicture = null;
      lastPicturePriority = null;
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
      debugEvents.length = 0;
      debugEventSeq = 0;
      prevVars = null;
      prevFlags = null;
      traceRing.length = 0;
      traceSeq = 0;
      pendingTrace = [];
      applyTraceChannel();
      captureStateDiffs();
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
      const pending = engine.hostInteraction;
      // A click on the suspended selector or confirmation answers with its
      // cancel key; a request still in flight resolves into a dropped answer.
      if (pending !== null && engine.awaitingHostAnswer) {
        if (pending.kind === "saveDialog" || pending.kind === "confirm") {
          setKeyWaiting(false);
          abandonHostRequest();
          engine.deliverHostAnswer(AGI_KEY.ESCAPE);
        }
      }
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
      flushDeferredMovement();
      const key = Number(msg.code) & 0xffff;
      recordEvent({ cycle: cycleCount, kind: "key", code: key });
      // A parked key wait answers from the queue directly — any key,
      // including a navigation key that would otherwise defer.
      const keyWaitParked = engine?.awaitingKey === true;
      if (
        !keyWaitParked &&
        deferredMovement.length > 0 &&
        engine?.modalKind === null &&
        NAV_KEYS[key] !== undefined
      ) {
        if (deferredMovement.length < 19) deferredMovement.push(key);
      } else keyQueue.push(key);
      deliverQueuedKey();
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
        if (deferredMovement.length > 0 && !engine.awaitingKey) {
          if (deferredMovement.length < 19) deferredMovement.push(dirKey);
        } else keyQueue.push(dirKey);
        deliverQueuedKey();
      }
      return;
    }
  } catch (e) {
    sendControl({ type: "error", message: String(e) });
  }
};
