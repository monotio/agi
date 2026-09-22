/**
 * The worker's inbound message dispatch — the body of the worker's
 * `onmessage`, extracted so Node tests can drive the real handlers with a
 * fake-port context. engine.worker.ts owns the ports that stamp sessionId
 * and suppress presentation while seeking; this module only sees ctx.
 */
import { parseWordsTok } from "../../../src/logic/words.ts";
import { openContainer } from "../../../src/container/container.ts";
import { Engine } from "../../../src/runtime/engine.ts";
import { base64ToBytes, bytesToBase64 } from "../bytes.ts";
import { AUTOSAVE_INTERVAL_MS } from "./autosave.ts";
import { resetSession, type WorkerContext } from "./context.ts";
import type { BootMessage, WorkerInbound } from "../workerProtocol.ts";

export function onWorkerMessage(ctx: WorkerContext, msg: WorkerInbound): void {
  const control = ctx.ports.control;
  try {
    if (msg.type === "pause") {
      ctx.fns.historyRecord({ kind: "pause", paused: msg.paused === true });
      ctx.fns.onPause(msg);
      // Parking the session seals the recording's tail: the history
      // transport's open covers the moment play stopped.
      if (msg.paused === true) ctx.fns.historyFlush("pause");
      return;
    }
    if (msg.type === "hostAnswer") {
      ctx.fns.onHostAnswer(msg);
      return;
    }
    if (msg.type === "historyAck") {
      ctx.fns.onHistoryAck(msg);
      return;
    }
    if (msg.type === "historyRetry") {
      ctx.fns.onHistoryRetry();
      return;
    }
    if (msg.type === "historyViewStart") {
      ctx.fns.onHistoryViewStart(msg);
      return;
    }
    if (msg.type === "historyViewSeek") {
      ctx.fns.onHistoryViewSeek(msg);
      return;
    }
    if (msg.type === "historyViewAdvance") {
      ctx.fns.onHistoryViewAdvance(msg);
      return;
    }
    if (msg.type === "historyViewEnd") {
      ctx.fns.onHistoryViewEnd();
      return;
    }
    if (msg.type === "historyViewTake") {
      ctx.fns.onHistoryViewTake(msg);
      return;
    }
    if (msg.type === "historyRetain") {
      ctx.fns.onHistoryRetain(msg);
      return;
    }
    if (msg.type === "historyRecover") {
      control({
        type: "historyRecovery",
        id: msg.id,
        batches: [...ctx.history.sent, ...ctx.history.queue.map((entry) => entry.batch)],
        boot: ctx.fns.historySnapshot(),
        cycle: ctx.cycle.cycleCount,
        room: ctx.engine?.vars[0] ?? 0,
      });
      return;
    }
    if (msg.type === "historyEnd") {
      // The end marker posts now, but the reply holds until every batch is
      // acked — the host destroys the worker when the query settles, so a
      // reply sent early would strand a tail still owed a commit.
      ctx.fns.onHistoryEnd(msg);
      return;
    }
    if (msg.type === "historyViewRestore") {
      ctx.fns.onHistoryViewRestore(msg);
      return;
    }
    // While the history transport owns the session, player input is a
    // transport command — it never reaches the parked engine's queues.
    if (
      ctx.view.recording !== null &&
      (msg.type === "key" ||
        msg.type === "direction" ||
        msg.type === "input" ||
        msg.type === "edit" ||
        msg.type === "dismissPrint")
    )
      return;
    if (msg.type === "replayAdvance") {
      ctx.fns.onReplayAdvance(msg);
      return;
    }
    if (msg.type === "replaySnapshot") {
      ctx.fns.onReplaySnapshot(msg);
      return;
    }
    if (msg.type === "replayRestore") {
      ctx.fns.onReplayRestore(msg);
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
      control({
        type: "engineState",
        id: msg.id,
        state: ctx.engine ? ctx.engine.readState() : null,
      });
      return;
    }
    if (msg.type === "objects") {
      control({
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
      ctx.fns.historyRecord({
        kind: "debugWrite",
        vars: msg.vars ?? [],
        flags: msg.flags ?? [],
      });
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
    if (msg.type === "traceAck") {
      ctx.fns.onTraceAck(msg);
      return;
    }
    if (msg.type === "checkpoint") {
      ctx.fns.onCheckpoint(msg);
      return;
    }
    if (msg.type === "startRecording") {
      ctx.fns.onStartRecording(msg);
      return;
    }
    if (msg.type === "stopRecording") {
      ctx.fns.onStopRecording(msg);
      return;
    }
    if (msg.type === "cancelRecording") {
      ctx.fns.onCancelRecording();
      return;
    }
    if (msg.type === "exportFiles") {
      // Explicit local downloads work even while a print window is open.
      const files: Record<string, Uint8Array> | null = ctx.engine ? {} : null;
      if (files && ctx.engine) {
        for (const [name, bytes] of ctx.engine.containerFiles) files[name] = bytes.slice();
        if (ctx.boot.authoredWords) files["WORDS.TOK"] = ctx.boot.authoredWords;
      }
      control({ type: "exportFiles", id: msg.id, files });
      return;
    }
    if (msg.type === "reenter") {
      ctx.fns.onReenter(msg);
      return;
    }
    if (msg.type === "boot") {
      const boot: BootMessage = msg;
      // A fresh session discards any open history view — its scratch engine
      // and pending request settle before the reset wipes the live one.
      ctx.fns.onHistoryViewEnd();
      ctx.replay.currentSessionId = typeof boot.sessionId === "number" ? boot.sessionId : 0;
      ctx.replay.replay = Number.isInteger(boot.replaySeed)
        ? { tick: 0, revision: 0, random: boot.replaySeed! & 0xffff }
        : null;
      ctx.replay.reseeds = [];
      ctx.replay.reseedCursor = 0;
      ctx.replay.historyReplay = false;
      ctx.replay.snapshots.clear();
      const files = new Map<string, Uint8Array>(Object.entries(boot.files));
      ctx.boot.liveDictionary = new Map<string, number>(boot.words);
      ctx.boot.currentBootFiles = files;
      ctx.boot.currentDictionary = ctx.boot.liveDictionary;
      ctx.replay.lastReplaySeed = Number.isInteger(boot.replaySeed) ? boot.replaySeed! : null;
      ctx.boot.authoredWords = null;
      ctx.boot.authorRooms = boot.authorRooms === true;
      ctx.boot.selectedSoundDevice = boot.soundDevice === 0 ? 0 : 1;
      ctx.engine = new Engine(
        openContainer(files),
        ctx.host,
        ctx.boot.liveDictionary,
        boot.profile ? { profile: boot.profile } : undefined,
      );
      ctx.fns.armJournal();
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
          control({
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
          control({ type: "restored", ok: false, message: String(e) });
        }
      }
      // The always-on recording opens its segment once the engine is restored:
      // the boot record carries the image the session resumed from.
      ctx.fns.historyBoot(boot);
      if (!ctx.replay.replay) ctx.fns.startTimers();
      control({ type: "booted", profile: ctx.engine.profile.id, kind: ctx.engine.profileKind });
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
      ctx.fns.historyRecord({
        kind: "patchMeta",
        ...(words ? { words: bytesToBase64(words) } : {}),
        ...(objects ? { object: bytesToBase64(objects) } : {}),
        ...(tests ? { tests: bytesToBase64(tests) } : {}),
      });
      control({ type: "metadataPatched" });
      return;
    }
    if (msg.type === "patch") {
      if (!ctx.engine) return;
      if (ctx.recording.recording)
        ctx.recording.recording.tainted = "Game resources changed during recording.";
      ctx.engine.patchResource(msg.kind, msg.num, new Uint8Array(msg.payload));
      ctx.fns.historyRecord({
        kind: "patch",
        resource: msg.kind,
        num: msg.num,
        data: bytesToBase64(msg.payload),
      });
      return;
    }
    if (msg.type === "authoring") {
      // Host-side session state, not an engine input: it lands on the tape
      // after the commit it describes so a later adoption replays to it.
      // An oversized snapshot would fail tape validation on read — drop it
      // rather than poison the stream.
      const snapshot = msg.snapshot;
      const size =
        typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
          ? (JSON.stringify(snapshot)?.length ?? 0)
          : 0;
      if (size > 0 && size <= 4 * 1024 * 1024)
        ctx.fns.historyRecord({ kind: "authoring", snapshot });
      return;
    }
    if (msg.type === "soundEnabled") {
      if (!ctx.engine) return;
      ctx.recording.recording?.tape.record(["soundEnabled", msg.enabled ? 1 : 0]);
      ctx.engine.setSoundEnabled(msg.enabled);
      ctx.fns.historyRecord({ kind: "sound", enabled: msg.enabled === true });
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
      ctx.fns.historyRecord({ kind: "device", device });
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
    control({ type: "error", message: String(e) });
  }
}
