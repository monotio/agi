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
import { base64ToBytes, bytesToBase64 } from "./bytes.ts";
import { createWorkerContext, resetSession, type WorkerPorts } from "./worker/context.ts";
import { AUTOSAVE_INTERVAL_MS } from "./worker/autosave.ts";
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
    if (ctx.replay.replay) ctx.fns.postReplay("waitkey");
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
    ctx.fns.stopTimers();
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
  recordEvent,
});

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
      ctx.fns.onReplayAdvance(msg);
      return;
    }
    if (msg.type === "renderFrame") {
      ctx.fns.onRenderFrame();
      return;
    }
    if (msg.type === "frames") {
      ctx.fns.onFrames(msg);
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
      ctx.fns.onDebug(msg);
      return;
    }
    if (msg.type === "debugWrite") {
      ctx.fns.onDebugWrite(msg);
      return;
    }
    if (msg.type === "debugEvents") {
      ctx.fns.onDebugEvents(msg);
      return;
    }
    if (msg.type === "debugTrace") {
      ctx.fns.onDebugTrace(msg);
      return;
    }
    if (msg.type === "checkpoint") {
      ctx.fns.onCheckpoint(msg);
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
      if (!ctx.replay.replay) ctx.fns.startTimers();
      sendControl({ type: "booted", profile: ctx.engine.profile.id });
      ctx.fns.postReplay(null);
      return;
    }
    if (msg.type === "exitReplay") {
      ctx.fns.onExitReplay();
      return;
    }
    if (msg.type === "resetReplay") {
      ctx.fns.onResetReplay(msg);
      return;
    }
    if (msg.type === "flush") {
      ctx.fns.onFlush(msg);
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
      ctx.fns.postFrame();
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
