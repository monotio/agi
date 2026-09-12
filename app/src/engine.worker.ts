/// <reference types="vite/client" />
/**
 * Engine worker: hosts the authentic interpreter off the main thread.
 * Message shapes are defined once in workerProtocol.ts — WorkerInbound in,
 * WorkerControl and WorkerPresentation out — and both dispatchers typecheck
 * against them.
 */
import { parseWordsTok } from "../../src/logic/words.ts";
import { openContainer } from "../../src/container/container.ts";
import { OperationRecorder } from "../../src/agent/recordedReplay.ts";
import type { RecordedEvent } from "./gameRecording.ts";
import { Engine, HostWait, type EngineHost } from "../../src/runtime/engine.ts";
import type { ReplayObservation } from "./replay.ts";
import { createProgressPreview } from "./progressPreview.ts";
import { base64ToBytes, bytesToBase64 } from "./bytes.ts";
import { createWorkerContext, resetSession, type WorkerPorts } from "./worker/context.ts";
import type {
  BootMessage,
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "./workerProtocol.ts";

const ports: WorkerPorts = {
  control: (message, options) => sendControl(message, options),
  presentation: (message, options) => sendPresentation(message, options),
  now: () => performance.now(),
};

/** All mutable worker state lives on the context; see worker/context.ts. */
const ctx = createWorkerContext(ports);

function sendControl(message: WorkerControl, options?: Transferable[]): void {
  if (ctx.replay.currentSessionId > 0 && !("sessionId" in message)) {
    (message as Record<string, unknown>)["sessionId"] = ctx.replay.currentSessionId;
  }
  self.postMessage(message, options ?? []);
}

function sendPresentation(message: WorkerPresentation, options?: Transferable[]): void {
  if (ctx.replay.isSeeking) return;
  if (ctx.replay.currentSessionId > 0 && !("sessionId" in message)) {
    (message as Record<string, unknown>)["sessionId"] = ctx.replay.currentSessionId;
  }
  self.postMessage(message, options ?? []);
}

function recordEvent(event: RecordedEvent): void {
  if (!ctx.recording.recording) return;
  if (ctx.recording.recording.events.length >= 5000) {
    ctx.recording.recording.tainted =
      "Recording reached its action limit; record a shorter scenario.";
    return;
  }
  ctx.recording.recording.events.push(event);
}
function tickEngine(): void {
  if (!ctx.engine) return;
  ctx.cycle.initialLogicStarted = true;
  // A suspended interaction freezes the cycle until its answer lands — the
  // gate inside tick() is the same, but skipping here keeps the recorder's
  // operation list honest: a parked tick never runs.
  if (ctx.engine.hostInteractionPending && !ctx.engine.hostInteractionReady) return;
  if (ctx.recording.recording) {
    ctx.recording.recording.tape.run("tick", () => ctx.engine!.tick());
    // A tick that ended suspended stays one recorded operation: the resumed
    // answer and the calls it produces join the same list on the next tick.
    if (ctx.engine!.awaitingHostAnswer) ctx.recording.recording.tape.holdTick();
  } else ctx.engine.tick();
}
function recordedClock(): void {
  ctx.recording.recording?.tape.clock();
  ctx.engine?.advanceClock(1000 / 60);
  ctx.engine?.soundTick();
}
function stopTimers(): void {
  if (ctx.cycle.timer !== null) {
    clearInterval(ctx.cycle.timer);
    ctx.cycle.timer = null;
  }
  if (ctx.cycle.soundTimer !== null) {
    clearInterval(ctx.cycle.soundTimer);
    ctx.cycle.soundTimer = null;
  }
}
/** Poll input/modal services at display cadence; v10 separately gates logic cycles. */
const HOST_POLL_MS = 1000 / 60;

function postReplay(blocked: string | null, fullState = false): void {
  if (!ctx.replay.replay || !ctx.engine) return;
  const isFull = fullState || blocked !== null;
  const state = isFull ? ctx.engine.readState() : ctx.engine.readLeanState();
  const rows = isFull ? Array.from({ length: 25 }, (_, row) => ctx.engine!.textRow(row)) : [];
  const observation: ReplayObservation = {
    sessionId: ctx.replay.currentSessionId,
    revision: ++ctx.replay.replay.revision,
    tick: ctx.replay.replay.tick,
    cycle: ctx.cycle.cycleCount,
    blocked,
    state,
    rows,
    egoView: ctx.engine.screenObjects[0]!.view,
    releaseGate: ctx.engine.releaseGate,
  };
  sendControl({
    type: "replay",
    sessionId: ctx.replay.currentSessionId,
    id: ctx.replay.replayRequest,
    observation,
  });
  ctx.replay.replayRequest = null;
}

/** Liveness observations stay responsive at slow game-selected cycle speeds. */
const CYCLE_REPORT_MS = 250;

/**
 * Autosave cadence. Five seconds is the
 * cheapest interval that is still invisible: one snapshot is a serialize() of
 * a few kilobytes plus a base64 pass, well under a millisecond, and the
 * usual maximum a player can lose to a browser reload is
 * five seconds of walking. Tightening it further buys nothing a player would
 * notice; the flush on page-hide covers the tail.
 */
const AUTOSAVE_INTERVAL_MS = 5_000;

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
  if (!ctx.engine) return false;
  if (!force && ctx.cycle.cycleCount === ctx.autosave.lastAutosaveCycle) return false;
  let image: Uint8Array | null;
  try {
    image = ctx.engine.autosaveImage();
  } catch (error) {
    sendPresentation({ type: "log", text: `Autosave snapshot failed: ${String(error)}` });
    return false;
  }
  if (!image) return false;
  const msg: Extract<WorkerPresentation, { type: "autosave" }> = {
    type: "autosave",
    image: bytesToBase64(image),
    menus: ctx.engine.readMenuState(),
    cycle: ctx.cycle.cycleCount,
    room: ctx.engine.vars[0]!,
  };
  try {
    const presentation = ctx.engine.getPresentation();
    msg.preview = createProgressPreview({
      visual: presentation.visual,
      text: presentation.text,
      picRow: ctx.engine.displayBase,
    });
  } catch (error) {
    sendPresentation({ type: "log", text: `Autosave preview skipped: ${String(error)}` });
  }
  // The patched container travels only when a patch really landed since the
  // host last saw one: a resource snapshot on every tick would cost far more
  // than the save image it accompanies.
  if (
    ctx.autosave.autosaveFiles &&
    ctx.engine.patchGeneration !== ctx.autosave.lastPatchGeneration
  ) {
    const files: Record<string, Uint8Array> = {};
    for (const [name, bytes] of ctx.engine.containerFiles) files[name] = bytes.slice();
    if (ctx.boot.authoredWords) files["WORDS.TOK"] = ctx.boot.authoredWords;
    msg.files = files;
    ctx.autosave.lastPatchGeneration = ctx.engine.patchGeneration;
  }
  sendPresentation(msg);
  ctx.autosave.lastAutosaveCycle = ctx.cycle.cycleCount;
  ctx.autosave.lastAutosaveAt = Date.now();
  return true;
}

const DEBUG_EVENT_CAP = 4000;

/**
 * Diff vars/flags against the previous completed cycle. The ring records
 * every write the interpreter made — the timeline lane's raw material —
 * whether or not an inspector view is currently open.
 */
function captureStateDiffs(): void {
  if (!ctx.engine) return;
  if (ctx.debug.prevVars === null || ctx.debug.prevFlags === null) {
    ctx.debug.prevVars = ctx.engine.vars.slice();
    ctx.debug.prevFlags = ctx.engine.flags.slice();
    return;
  }
  for (let i = 0; i < 256; i++) {
    const v = ctx.engine.vars[i]!;
    if (v !== ctx.debug.prevVars[i])
      ctx.debug.debugEvents.push({
        seq: ++ctx.debug.debugEventSeq,
        cycle: ctx.cycle.cycleCount,
        kind: "var",
        index: i,
        from: ctx.debug.prevVars[i]!,
        to: v,
      });
    const f = ctx.engine.flags[i]!;
    if (f !== ctx.debug.prevFlags[i])
      ctx.debug.debugEvents.push({
        seq: ++ctx.debug.debugEventSeq,
        cycle: ctx.cycle.cycleCount,
        kind: "flag",
        index: i,
        from: ctx.debug.prevFlags[i]!,
        to: f,
      });
  }
  ctx.debug.prevVars.set(ctx.engine.vars);
  ctx.debug.prevFlags.set(ctx.engine.flags);
  if (ctx.debug.debugEvents.length > DEBUG_EVENT_CAP)
    ctx.debug.debugEvents.splice(0, ctx.debug.debugEvents.length - DEBUG_EVENT_CAP);
}

const TRACE_CAP = 4000;
const TRACE_POST_MAX = 500;

function applyTraceChannel(): void {
  ctx.engine?.setTraceListener(
    ctx.debug.channels.trace
      ? (record) => {
          const stamped = { ...record, seq: ++ctx.debug.traceSeq, cycle: ctx.cycle.cycleCount };
          ctx.debug.traceRing.push(stamped);
          if (ctx.debug.traceRing.length > TRACE_CAP)
            ctx.debug.traceRing.splice(0, ctx.debug.traceRing.length - TRACE_CAP);
          ctx.debug.pendingTrace.push(stamped);
        }
      : null,
  );
}

/** Post accumulated trace records; sendPresentation drops them while seeking. */
function flushTraceBatch(): void {
  if (ctx.debug.pendingTrace.length === 0) return;
  sendPresentation({ type: "trace", records: ctx.debug.pendingTrace.splice(0, TRACE_POST_MAX) });
}

/** Completed interpreter cycle: count it, attribute state writes, ship trace. */
function finishCycle(): void {
  ctx.cycle.cycleCount++;
  captureStateDiffs();
  flushTraceBatch();
}

function advanceSoundClock(authoring = false): void {
  if (ctx.replay.replay) return;
  const frozen = authoring || ctx.cycle.paused;
  const ticks = ctx.clocks.sound.advance(ctx.ports.now(), frozen);
  for (let tick = 0; tick < ticks; tick++) {
    recordedClock();
  }
}

const host: EngineHost = {
  randomWord() {
    let value: number;
    if (!ctx.replay.replay) value = Math.floor(Math.random() * 65536);
    else {
      ctx.replay.replay.random = (Math.imul(ctx.replay.replay.random, 1664525) + 1013904223) >>> 0;
      value = ctx.replay.replay.random >>> 16;
    }
    ctx.recording.recording?.tape.host(["random", value]);
    return value;
  },
  print(text) {
    if (ctx.recording.recording && ctx.recording.recording.printed.length < 16)
      ctx.recording.recording.printed.push(text.slice(0, 400));
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
    const buffered = ctx.input.keyQueue.shift();
    if (buffered !== undefined) {
      ctx.recording.recording?.tape.host(["waitKey", buffered]);
      return buffered;
    }
    ctx.fns.setKeyWaiting(true);
    if (ctx.replay.replay) postReplay("waitkey");
    throw new HostWait();
  },
  statusLine(text) {
    sendPresentation({ type: "status", text });
  },
  takeInputLine() {
    const line = ctx.input.inputBuffer.shift() ?? null;
    ctx.recording.recording?.tape.host(["line", line]);
    return line;
  },
  takeKeys() {
    const keys = ctx.input.keyQueue.splice(0);
    ctx.recording.recording?.tape.host(["keys", keys.slice()]);
    return keys;
  },
  prepareRoom(room, from) {
    if (!ctx.boot.authorRooms || !ctx.engine) return true;
    const container = openContainer(ctx.engine.containerFiles);
    if (container.getResource("logic", room)) return true;
    // The agent's answer lands in deliverHostResponse, which applies the
    // patch and delivers true/false to the suspended new.room.
    return ctx.fns.postHostRequest("room", {
      room,
      from,
      edge: ctx.engine.vars[2],
      state: ctx.engine.readState(),
      objects: ctx.engine.readObjects(),
    });
  },
  /** 0x6e shake.screen: cosmetic jitter on the main thread. */
  shakeScreen(count) {
    sendPresentation({ type: "shake", count });
  },
  /** 0x81/0xa2 show.obj: modal view popup (engine pauses on the open modal). */
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
    return ctx.fns.postHostRequest("getnum", { prompt, row, col });
  },
  /** 0x73 get.string: a host-request prompt; the engine suspends until answered. */
  promptString(prompt, maxLen, row, col) {
    return ctx.fns.postHostRequest("getstring", { prompt, maxLen, row, col });
  },
  /**
   * 0x7d save.game: the selector's directory listing is a host request; the
   * response's base64 images decode on delivery.
   */
  listSaveGames() {
    return ctx.fns.postHostRequest("saveList", {});
  },
  get promptSaveDescription() {
    // Replays drive the save dialog with recorded key presses, so the engine's
    // own in-dialog editor must run: a DOM prompt can never be answered by a
    // recorded key, only by an explicit answer action.
    if (ctx.replay.replay) return undefined;
    return (initial: string, maxLen: number, row: number, col: number) =>
      ctx.fns.postHostRequest("saveDescription", { initial, maxLen, row, col });
  },
  saveGame(bytes, slot = 1) {
    // The main thread owns localStorage; the image travels as base64.
    return ctx.fns.postHostRequest("saveWrite", { slot, image: bytesToBase64(bytes) });
  },
  /** 0x7e restore.game: the save lookup is a host request; null = cancelled. */
  restoreGame(slot = 1) {
    return ctx.fns.postHostRequest("restore", { slot });
  },
  /** 0x90 log / 0x85 obj.status.v / 0x87 show.mem: debug log stream. */
  logText(text) {
    sendPresentation({ type: "log", text });
  },
  /** 0x8d version: stored into a string slot by the engine. */
  versionString() {
    const value = ctx.engine ? `AGI ${ctx.engine.profile.id}` : "AGI IS HERE";
    ctx.recording.recording?.tape.host(["version", value]);
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
    ctx.recording.recording?.tape.host(["soundDevice", ctx.boot.selectedSoundDevice]);
    return ctx.boot.selectedSoundDevice;
  },
  soundOutput(output) {
    sendPresentation({ type: "soundOutput", output });
  },
  /** 0x64 stop.sound: silence playback on the main thread. */
  stopSound() {
    sendPresentation({ type: "stopSound" });
  },
};

ctx.host = host;

// Until their owning modules land (docs/rc10-cleanup-plan.md Part 2), the
// still-local functions fill the context's function table.
Object.assign(ctx.fns, {
  postReplay,
  tickEngine,
  recordedClock,
  advanceSoundClock,
  finishCycle,
  startTimers,
  stopTimers,
  autosave,
  postFrame,
  captureStateDiffs,
  applyTraceChannel,
  flushTraceBatch,
  recordEvent,
});

function postFrame(capture = false): void {
  if (!ctx.engine || ctx.replay.isSeeking) return;
  const enabled = ctx.engine.flags[9] !== 0;
  if (enabled !== ctx.presentation.lastSoundEnabled) {
    ctx.presentation.lastSoundEnabled = enabled;
    sendPresentation({ type: "soundEnabled", enabled });
  }
  const controls = ctx.engine.readControls();
  const serialized = JSON.stringify(controls);
  if (serialized !== ctx.presentation.lastControls) {
    ctx.presentation.lastControls = serialized;
    sendPresentation({ type: "controls", controls });
  }
  if (ctx.engine.inputEdit !== ctx.presentation.lastInputEdit) {
    ctx.presentation.lastInputEdit = ctx.engine.inputEdit;
    sendPresentation({ type: "inputEdit", text: ctx.presentation.lastInputEdit });
  }
  const frame = ctx.engine.getPresentation();
  if (capture) captureFrame(frame);
  const modal = ctx.engine.modalKind;
  const textCells = frame.text;
  // Armed inspector channels join the sameness check so a sprite's sub-pixel
  // or slot change still ships its fresh ownership/objects payload.
  const ownership = ctx.debug.channels.ownership ? ctx.engine.getOwnership() : null;
  const objects = ctx.debug.channels.objects ? ctx.engine.readObjects() : null;
  const picture = ctx.debug.channels.picture ? ctx.engine.getPictureSurface() : null;
  const objectsJson = objects ? JSON.stringify(objects) : "";
  // Repeated display/trace opcodes can mark text dirty without changing a cell.
  // Sending those frames floods software GPU renderers and delays user input.
  let same =
    ctx.cycle.lastInputReady === ctx.cycle.initialLogicStarted &&
    ctx.presentation.lastModal === modal &&
    ctx.presentation.lastPicRow === ctx.engine.displayBase &&
    ctx.presentation.lastTextMode === ctx.engine.textModeActive &&
    ctx.presentation.lastInputEnabled === ctx.engine.inputEnabled &&
    ctx.presentation.lastReleaseGate === ctx.engine.releaseGate &&
    objectsJson === ctx.presentation.lastObjectsJson &&
    ctx.presentation.lastText !== null;
  if (same && ctx.presentation.lastText) {
    for (let i = 0; i < textCells.length; i++) {
      if (textCells[i] !== ctx.presentation.lastText[i]) {
        same = false;
        break;
      }
    }
  }
  if (same && ctx.presentation.lastVisual) {
    for (let i = 0; i < frame.visual.length; i++) {
      if (frame.visual[i] !== ctx.presentation.lastVisual[i]) {
        same = false;
        break;
      }
    }
  } else if (!ctx.presentation.lastVisual) {
    same = false;
  }
  if (same && ownership && ctx.presentation.lastOwnership) {
    for (let i = 0; i < ownership.length; i++) {
      if (ownership[i] !== ctx.presentation.lastOwnership[i]) {
        same = false;
        break;
      }
    }
  } else if (same && ownership !== null && ctx.presentation.lastOwnership === null) {
    same = false;
  }
  if (same && picture && ctx.presentation.lastPicture) {
    for (let i = 0; i < picture.visual.length; i++) {
      if (
        picture.visual[i] !== ctx.presentation.lastPicture[i] ||
        picture.priority[i] !== ctx.presentation.lastPicturePriority![i]
      ) {
        same = false;
        break;
      }
    }
  } else if (same && picture !== null && ctx.presentation.lastPicture === null) {
    same = false;
  }
  if (same) return;
  ctx.presentation.lastVisual = frame.visual.slice(); // retained copy, never transferred
  ctx.presentation.lastText = textCells.slice();
  ctx.presentation.lastOwnership = ownership ? ownership.slice() : null;
  ctx.presentation.lastPicture = picture ? picture.visual.slice() : null;
  ctx.presentation.lastPicturePriority = picture ? picture.priority.slice() : null;
  ctx.presentation.lastObjectsJson = objectsJson;
  ctx.presentation.lastPicRow = ctx.engine.displayBase;
  ctx.presentation.lastTextMode = ctx.engine.textModeActive;
  ctx.presentation.lastInputEnabled = ctx.engine.inputEnabled;
  ctx.cycle.lastInputReady = ctx.cycle.initialLogicStarted;
  ctx.presentation.lastReleaseGate = ctx.engine.releaseGate;
  ctx.presentation.lastModal = modal;
  const text = textCells.slice();
  sendPresentation(
    {
      type: "frame",
      visual: frame.visual,
      priority: frame.priority,
      text,
      picRow: ctx.engine.displayBase,
      modal,
      textMode: ctx.engine.textModeActive,
      inputEnabled: ctx.engine.inputEnabled,
      inputReady: ctx.cycle.initialLogicStarted,
      holdToMove: ctx.engine.releaseGate !== 0,
      edit: ctx.engine.inputEdit,
      cycle: ctx.cycle.cycleCount,
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
  if (!ctx.engine || ctx.replay.replay !== null) return;
  ctx.presentation.recentRing.push(
    ctx.cycle.cycleCount,
    frame.visual,
    frame.priority,
    frame.text,
    ctx.engine.displayBase,
  );
  const now = ctx.ports.now();
  if (now - ctx.cycle.lastHistoryAt >= 1000) {
    ctx.cycle.lastHistoryAt = now;
    ctx.presentation.historyRing.push(
      ctx.cycle.cycleCount,
      frame.visual,
      frame.priority,
      frame.text,
      ctx.engine.displayBase,
    );
  }
}

/**
 * Serve a frames request. `stride` 1 reads the full-rate ring; anything
 * coarser than the full-rate ring's span falls back to the 1 Hz history.
 */
function serveFrames(id: number, count: number, stride: number, since: number | null): void {
  const n = Math.max(1, Math.min(64, Math.floor(count)));
  const step = Math.max(1, Math.floor(stride));
  const useHistory = step * n > ctx.presentation.recentRing.capacity;
  const frames = useHistory ? [] : ctx.presentation.recentRing.take(n, step, since);
  if (useHistory) {
    // History samples are timed rather than every fixed number of logic cycles.
    // Select by their actual cycle IDs so a v10 change cannot distort stride.
    const history = ctx.presentation.historyRing.take(
      ctx.presentation.historyRing.capacity,
      1,
      since,
    );
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
  if (ctx.cycle.soundTimer === null) {
    ctx.cycle.soundTimer = setInterval(() => {
      try {
        advanceSoundClock();
      } catch (error) {
        sendControl({ type: "error", message: String(error) });
        stopTimers();
      }
    }, 1000 / 60) as unknown as number;
  }
  if (ctx.cycle.timer === null) {
    ctx.cycle.timer = setInterval(() => {
      try {
        const now = ctx.ports.now();
        if (ctx.cycle.paused) {
          ctx.clocks.cycle.poll(now, ctx.engine!.vars[10]!, true);
          return;
        }
        advanceSoundClock();
        ctx.fns.deliverQueuedKey();
        if (
          ctx.engine!.modalKind !== null ||
          ctx.engine!.continuationPending ||
          ctx.engine!.hostInteractionPending
        ) {
          tickEngine();
          flushTraceBatch();
          postFrame();
          if (ctx.hostRequests.pendingReenter && !ctx.engine!.hostInteractionPending) {
            // The suspended re-entered room has landed (or been declined).
            ctx.hostRequests.pendingReenter = false;
            sendControl({ type: "reentered", room: ctx.engine!.vars[0]! });
            postFrame(true);
          }
        } else if (ctx.clocks.cycle.poll(now, ctx.engine!.vars[10]!)) {
          ctx.fns.flushDeferredMovement();
          tickEngine();
          finishCycle();
          postFrame(true);
        }
        if (now - ctx.cycle.lastCycleReportAt >= CYCLE_REPORT_MS) {
          ctx.cycle.lastCycleReportAt = now;
          const scalars = ctx.engine!.readState();
          sendPresentation({
            type: "cycle",
            cycle: ctx.cycle.cycleCount,
            room: scalars.room,
            egoX: scalars.egoX,
            egoY: scalars.egoY,
          });
        }
        if (Date.now() - ctx.autosave.lastAutosaveAt >= ctx.autosave.autosaveIntervalMs)
          autosave(false);
      } catch (e) {
        stopTimers();
        sendControl({ type: "error", message: String(e) });
      }
    }, HOST_POLL_MS) as unknown as number;
  }
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as WorkerInbound;
  try {
    if (msg.type === "pause") {
      ctx.cycle.paused = msg.paused === true;
      sendControl({ type: "paused", paused: ctx.cycle.paused });
      return;
    }
    if (msg.type === "hostAnswer") {
      ctx.fns.onHostAnswer(msg);
      return;
    }
    if (msg.type === "replayAdvance") {
      if (!ctx.replay.replay || !ctx.engine) return;
      if (typeof msg.sessionId === "number") ctx.replay.currentSessionId = msg.sessionId;
      const ticks = Number(msg.ticks);
      if (!Number.isInteger(ticks) || ticks < 0 || ticks > 100_000)
        throw new Error("Replay advance requires 0..100000 virtual ticks.");
      const seeking = Boolean(msg.seeking);
      const renderFinal = Boolean(msg.renderFinal);
      const fullState = Boolean(msg.fullState);
      ctx.replay.isSeeking = seeking;
      ctx.replay.replayRequest = Number(msg.id);

      let remaining = ticks;
      const thisRequest = ctx.replay.replayRequest;
      const thisSession = ctx.replay.currentSessionId;

      const advanceChunk = () => {
        if (!ctx.replay.replay || !ctx.engine) return;
        if (ctx.replay.replayRequest !== thisRequest || ctx.replay.currentSessionId !== thisSession)
          return;

        const startTime = ctx.ports.now();
        let chunkTicks = 0;
        const maxChunkTicks = seeking ? 2500 : 250;
        const maxChunkMs = seeking ? 16 : 12;
        try {
          while (remaining > 0 && chunkTicks < maxChunkTicks) {
            // A parked host wait consumes no replay ticks, exactly as the
            // blocking bridge did: its answer's delivery resumes the chunk.
            if (ctx.engine.awaitingHostAnswer) break;
            ctx.replay.replay.tick++;
            remaining--;
            chunkTicks++;
            recordedClock();
            if (
              ctx.engine.modalKind !== null ||
              ctx.engine.continuationPending ||
              ctx.engine.hostInteractionPending
            )
              tickEngine();
            else if (
              ctx.clocks.cycle.poll((ctx.replay.replay.tick * 1000) / 60, ctx.engine.vars[10]!)
            ) {
              ctx.fns.flushDeferredMovement();
              tickEngine();
              finishCycle();
            }
            if ((chunkTicks & 63) === 0 && ctx.ports.now() - startTime >= maxChunkMs) {
              break;
            }
          }
        } catch (e) {
          sendControl({ type: "error", id: thisRequest, message: String(e) });
          return;
        }

        // The runner already has its blocked observation from postReplay(op);
        // the answer's delivery posts the next one.
        if (ctx.engine.awaitingHostAnswer) return;
        if (remaining > 0) {
          setTimeout(advanceChunk, 0);
          return;
        }

        if (!seeking || renderFinal) {
          ctx.replay.isSeeking = false;
          postFrame();
        }
        postReplay(null, fullState);
      };

      advanceChunk();
      return;
    }
    if (msg.type === "renderFrame") {
      if (ctx.engine) {
        ctx.replay.isSeeking = false;
        ctx.presentation.lastVisual = null;
        ctx.presentation.lastText = null;
        postFrame();
      }
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
        state: ctx.engine ? ctx.engine.readState() : null,
      });
      return;
    }
    if (msg.type === "objects") {
      sendControl({
        type: "objects",
        id: msg.id,
        objects: ctx.engine ? ctx.engine.readObjects() : [],
      });
      return;
    }
    if (msg.type === "debug") {
      const want = msg.channels ?? {};
      const traceWas = ctx.debug.channels.trace;
      ctx.debug.channels.ownership = want.ownership === true;
      ctx.debug.channels.objects = want.objects === true;
      ctx.debug.channels.trace = want.trace === true;
      ctx.debug.channels.picture = want.picture === true;
      if (ctx.debug.channels.trace !== traceWas) applyTraceChannel();
      // Invalidate the sameness check so a newly armed channel ships with the
      // next frame and a disarmed one clears promptly.
      ctx.presentation.lastVisual = null;
      ctx.presentation.lastObjectsJson = "";
      postFrame();
      return;
    }
    if (msg.type === "debugWrite") {
      if (!ctx.engine) return;
      if (Array.isArray(msg.vars))
        for (const pair of msg.vars) ctx.engine.vars[pair[0]! & 0xff] = pair[1]! & 0xff;
      if (Array.isArray(msg.flags))
        for (const pair of msg.flags) ctx.engine.flags[pair[0]! & 0xff] = pair[1] ? 1 : 0;
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
        cycle: ctx.cycle.cycleCount,
        latestSeq: ctx.debug.debugEventSeq,
        events: ctx.debug.debugEvents.filter((e) => e.seq > since),
      });
      return;
    }
    if (msg.type === "debugTrace") {
      const since = typeof msg.since === "number" ? msg.since : 0;
      sendControl({
        type: "debugTrace",
        id: msg.id,
        cycle: ctx.cycle.cycleCount,
        latestSeq: ctx.debug.traceSeq,
        records: ctx.debug.traceRing.filter((r) => r.seq > since),
      });
      return;
    }
    if (msg.type === "checkpoint") {
      // The paused interpreter's resumable image — the candidate preview's
      // restore point. null outside a resumable cycle boundary.
      sendControl({
        type: "checkpoint",
        id: msg.id,
        image: ctx.engine ? ctx.engine.autosaveImage() : null,
      });
      return;
    }
    if (msg.type === "startRecording") {
      if (!ctx.engine) {
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
      const hostImage = ctx.engine.recordingImage();
      if (!hostImage) {
        sendControl({
          type: "recordingStarted",
          id: msg.id,
          ok: false,
          error: "Recording needs a quiet moment: answer the open prompt and let the room draw.",
        });
        return;
      }
      ctx.recording.recording = {
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
        replayState: ctx.engine.captureReplayState(),
        cycle: ctx.cycle.cycleCount,
        state: ctx.engine.readState(),
      });
      return;
    }
    if (msg.type === "stopRecording") {
      const taken = ctx.recording.recording;
      ctx.recording.recording = null;
      sendControl({
        type: "recordingStopped",
        id: msg.id,
        operations: taken?.tape.operations ?? [],
        events: taken?.events ?? [],
        printed: taken?.printed ?? [],
        tainted: taken?.tainted ?? taken?.tape.error ?? null,
        usedGetnum: false,
        cycle: ctx.cycle.cycleCount,
        state: ctx.engine ? ctx.engine.readState() : null,
      });
      return;
    }
    if (msg.type === "cancelRecording") {
      ctx.recording.recording = null;
      return;
    }
    if (msg.type === "exportFiles") {
      // Explicit local downloads work even while a print window is open.
      const files: Record<string, Uint8Array> | null = ctx.engine ? {} : null;
      if (files && ctx.engine) {
        for (const [name, bytes] of ctx.engine.containerFiles) files[name] = bytes.slice();
        if (ctx.boot.authoredWords) files["WORDS.TOK"] = ctx.boot.authoredWords;
      }
      sendControl({ type: "exportFiles", id: msg.id, files });
      return;
    }
    if (msg.type === "reenter") {
      ctx.fns.onReenter(msg);
      return;
    }
    if (msg.type === "boot") {
      const boot: BootMessage = msg;
      ctx.replay.currentSessionId = typeof boot.sessionId === "number" ? boot.sessionId : 0;
      ctx.replay.replay = Number.isInteger(boot.replaySeed)
        ? { tick: 0, revision: 0, random: boot.replaySeed! >>> 0 }
        : null;
      const files = new Map<string, Uint8Array>(Object.entries(boot.files));
      ctx.boot.liveDictionary = new Map<string, number>(boot.words);
      ctx.boot.currentBootFiles = files;
      ctx.boot.currentDictionary = ctx.boot.liveDictionary;
      ctx.replay.lastReplaySeed = Number.isInteger(boot.replaySeed) ? boot.replaySeed! : null;
      ctx.boot.authoredWords = null;
      ctx.boot.authorRooms = boot.authorRooms === true;
      ctx.boot.selectedSoundDevice = boot.soundDevice === 0 ? 0 : 1;
      ctx.engine = new Engine(openContainer(files), host, ctx.boot.liveDictionary);
      // Browser sessions start with game sound enabled; saved games restore their own flag.
      ctx.engine.flags[9] = 1;
      // A boot clears the in-flight request and key wait silently: the worker
      // is fresh, there is no host UI or parked wait to resolve.
      ctx.hostRequests.hostRequestOutstanding = null;
      ctx.input.keyWaiting = false;
      ctx.replay.isSeeking = false;
      // v10 selects the number of 50ms timer increments between logic cycles.
      // Modal/input presentation remains responsive at the host polling cadence.
      resetSession(ctx);
      ctx.autosave.autosaveIntervalMs = Number(boot.autosaveMs ?? AUTOSAVE_INTERVAL_MS);
      ctx.autosave.autosaveFiles = boot.autosaveFiles === true;
      ctx.autosave.lastAutosaveAt = Date.now();
      ctx.autosave.lastAutosaveCycle = -1;
      ctx.autosave.lastPatchGeneration = ctx.engine.patchGeneration;
      // Autosave resume: replay the stored image into the engine before it has
      // run a single cycle, through the same restore path restore.game uses.
      // A corrupt or profile-mismatched image throws out of the decode with no
      // state touched, so the game just carries on with its normal boot.
      if (typeof boot.restoreImage === "string" && boot.restoreImage) {
        try {
          ctx.engine.restoreImage(base64ToBytes(boot.restoreImage));
          ctx.engine.restoreMenuState(boot.restoreMenus);
          const restored = ctx.engine.readState();
          sendControl({
            type: "restored",
            ok: true,
            room: restored.room,
            egoX: restored.egoX,
            egoY: restored.egoY,
          });
          // A checkpoint parked at a have.key wait restores still waiting:
          // the host needs the flag to route the answering key back.
          if (ctx.engine.awaitingKey) ctx.fns.setKeyWaiting(true);
        } catch (e) {
          sendControl({ type: "restored", ok: false, message: String(e) });
        }
      }
      if (!ctx.replay.replay) startTimers();
      sendControl({ type: "booted", profile: ctx.engine.profile.id });
      postReplay(null);
      return;
    }
    if (msg.type === "exitReplay") {
      ctx.replay.replay = null;
      ctx.replay.currentSessionId = 0;
      ctx.replay.isSeeking = false;
      ctx.cycle.paused = false;
      ctx.presentation.recentRing.reset();
      ctx.presentation.historyRing.reset();
      ctx.clocks.sound.reset(ctx.ports.now());
      ctx.clocks.cycle.reset(ctx.ports.now());
      ctx.cycle.lastCycleReportAt = ctx.ports.now();
      stopTimers();
      startTimers();
      postFrame();
      sendControl({ type: "exitedReplay" });
      return;
    }
    if (msg.type === "resetReplay") {
      if (!ctx.boot.currentBootFiles || !ctx.boot.currentDictionary) return;
      if (typeof msg.sessionId === "number") ctx.replay.currentSessionId = msg.sessionId;
      ctx.replay.isSeeking = Boolean(msg.seeking);
      if (ctx.engine) ctx.engine.stopSoundPlayback();
      const seed =
        typeof msg.seed === "number"
          ? msg.seed
          : ctx.replay.lastReplaySeed !== null
            ? ctx.replay.lastReplaySeed
            : 0;
      ctx.replay.replay = { tick: 0, revision: 0, random: seed >>> 0 };
      // A request in flight belonged to the replaced engine; its late answer
      // is dropped by the serial check and the host resolves its UI now.
      ctx.fns.abandonHostRequest();
      ctx.fns.setKeyWaiting(false);
      ctx.engine = new Engine(
        openContainer(ctx.boot.currentBootFiles),
        host,
        ctx.boot.currentDictionary,
      );
      ctx.engine.flags[9] = 1;
      resetSession(ctx);
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
        cycle: ctx.cycle.cycleCount,
        hasEngine: Boolean(ctx.engine),
        modal: ctx.engine ? ctx.engine.modalOpen : false,
        textMode: ctx.engine ? ctx.engine.textModeActive : false,
        pictureShown: ctx.engine ? ctx.engine.isPictureShown : false,
      });
      return;
    }
    if (msg.type === "patchMetadata") {
      if (!ctx.engine) return;
      const files = msg.files;
      if (ctx.recording.recording && (files["WORDS.TOK"] || files["OBJECT"]))
        ctx.recording.recording.tainted = "Game resources changed during recording.";
      const words = files["WORDS.TOK"] ? new Uint8Array(files["WORDS.TOK"]) : undefined;
      const objects = files["OBJECT"] ? new Uint8Array(files["OBJECT"]) : undefined;
      const tests = files["TESTS.JSON"] ? new Uint8Array(files["TESTS.JSON"]) : undefined;
      // Validate the dictionary before changing either the container or parser.
      const entries = words ? parseWordsTok(words) : undefined;
      ctx.engine.patchAuxiliaryFiles({
        ...(words ? { words } : {}),
        ...(objects ? { objects } : {}),
        ...(tests ? { tests } : {}),
      });
      if (entries && words) {
        ctx.boot.liveDictionary.clear();
        for (const { word, id } of entries) ctx.boot.liveDictionary.set(word, id);
        ctx.boot.authoredWords = words;
      }
      sendControl({ type: "metadataPatched" });
      return;
    }
    if (msg.type === "patch") {
      if (!ctx.engine) return;
      if (ctx.recording.recording)
        ctx.recording.recording.tainted = "Game resources changed during recording.";
      ctx.engine.patchResource(msg.kind, msg.num, new Uint8Array(msg.payload));
      return;
    }
    if (msg.type === "soundEnabled") {
      if (!ctx.engine) return;
      ctx.recording.recording?.tape.record(["soundEnabled", msg.enabled ? 1 : 0]);
      ctx.engine.setSoundEnabled(msg.enabled);
      postFrame();
      return;
    }
    if (msg.type === "soundDevice") {
      if (ctx.recording.recording)
        ctx.recording.recording.tainted = "The sound device changed during recording.";
      const device = msg.device === 0 ? 0 : 1;
      if (device !== ctx.boot.selectedSoundDevice) ctx.engine?.stopSoundPlayback();
      ctx.boot.selectedSoundDevice = device;
      if (ctx.engine) ctx.engine.vars[22] = device === 0 ? 1 : 3;
      return;
    }
    if (msg.type === "input") {
      ctx.fns.onInput(msg);
      return;
    }
    if (msg.type === "edit") {
      ctx.fns.onEdit(msg);
      return;
    }
    if (msg.type === "dismissPrint") {
      ctx.fns.onDismissPrint();
      return;
    }
    if (msg.type === "key") {
      ctx.fns.onKey(msg);
      return;
    }
    if (msg.type === "direction") {
      ctx.fns.onDirection(msg);
      return;
    }
    // A message type with no handler fails typecheck here.
    const unhandled: never = msg;
    void unhandled;
  } catch (e) {
    sendControl({ type: "error", message: String(e) });
  }
};
