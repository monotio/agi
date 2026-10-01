/**
 * The worker's inbound message dispatch — the body of the worker's
 * `onmessage`, extracted so Node tests can drive the real handlers with a
 * fake-port context. engine.worker.ts owns the ports that stamp sessionId
 * and suppress presentation while seeking; this module only sees ctx.
 */
import { parseWordsTok } from "../../../src/logic/words.ts";
import { openContainer } from "../../../src/container/container.ts";
import { Engine } from "../../../src/runtime/engine.ts";
import { resourceCacheHint } from "../../../src/agent/authoringState.ts";
import { base64ToBytes, bytesToBase64 } from "../project/bytes.ts";
import { AUTOSAVE_INTERVAL_MS } from "./autosave.ts";
import type { Inbound, WorkerContext } from "./context.ts";
import { resetSession } from "./session.ts";
import { newDebuggerState, newPreviewLane, mintPreviewRunToken } from "./debuggerState.ts";
import { newProjectAdmissionState } from "./projectAdmissionState.ts";
import { controllerDemand, ensureDebugController } from "./debugLoader.ts";
import type { BootMessage, FrozenTestBoot, WorkerInbound } from "./workerProtocol.ts";

/** A plain object check for boot-policy fields arriving off the wire. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural validation for a frozen-test boot — checked before the boot
 * touches any session state, so a refused message leaves the worker a clean
 * shell: no engine, no timers, no recording. Deep validation of sources and
 * bindings happens in the attach/configure admission steps themselves.
 */
function frozenBootError(boot: BootMessage, frozen: FrozenTestBoot): string | null {
  if (!Number.isSafeInteger(frozen.id)) return "frozenTest.id must be an integer";
  if (frozen.lane !== undefined && frozen.lane !== "debug" && frozen.lane !== "play-preview")
    return "frozenTest.lane must be 'debug' or 'play-preview'";
  if (boot.replaySeed !== undefined)
    return "a test boot cannot carry a replay seed; it runs the shipped LOGIC 0";
  if (boot.restoreImage !== undefined || boot.restoreMenus !== undefined)
    return "a test boot cannot resume a stored image; it runs the shipped LOGIC 0";
  if (boot.sessionId !== undefined) return "a test boot does not join a replay session";
  if (
    frozen.sources !== undefined &&
    (!isRecord(frozen.sources) ||
      Object.values(frozen.sources).some((source) => typeof source !== "string"))
  )
    return "frozenTest.sources must map logic numbers to source text";
  if (frozen.bindings !== undefined && !isRecord(frozen.bindings))
    return "frozenTest.bindings must be a name map";
  if (frozen.sourceBindings !== undefined && !isRecord(frozen.sourceBindings))
    return "frozenTest.sourceBindings must be a name map";
  if (frozen.breakpoints !== undefined && !Array.isArray(frozen.breakpoints))
    return "frozenTest.breakpoints must be a list";
  if (frozen.watchpoints !== undefined && !Array.isArray(frozen.watchpoints))
    return "frozenTest.watchpoints must be a list";
  return null;
}

/**
 * A refused test boot answers on the reliable debug channel — the id lets
 * the launcher match the refusal to its admission — and reports on the
 * ordinary error channel too. Posted before any session state moved.
 */
function refuseFrozenBoot(ctx: WorkerContext, frozen: FrozenTestBoot, error: string): void {
  const id = Number.isSafeInteger(frozen.id) ? frozen.id : 0;
  ctx.ports.control({
    type: "debugError",
    id,
    epoch: null,
    buildId: null,
    code: "invalidRequest",
    error,
  });
  ctx.ports.control({ type: "error", message: `isolated test boot refused: ${error}` });
}

/**
 * Frozen-test admission, driven synchronously inside the boot branch so it
 * completes before any timer, sound clock, input or logic cycle can run:
 * attach under the verified build, one atomic configuration, then (unless
 * stopOnEntry is explicitly false) the idle stop latch. A refusal discards
 * the half-admitted run — the engine leaves, the session state resets and
 * no `booted` posts — never a fallback to running play.
 */
function admitFrozenTest(ctx: WorkerContext, frozen: FrozenTestBoot): boolean {
  const fail = (step: string): boolean => {
    ctx.ports.control({ type: "error", message: `isolated test boot refused: ${step}` });
    ctx.engine = null;
    ctx.debugger = newDebuggerState();
    return false;
  };
  if (frozen.lane === "play-preview") {
    // The lane is physical-run authority, not session decoration: minted
    // for this exact engine instance before the attach so the verified
    // build identity lands on it and `debugAttached` can publish the run
    // token. `stopOnEntry:false` alone never mints one — only the explicit
    // lane grant does.
    ctx.debugger.preview = newPreviewLane(mintPreviewRunToken(), ctx.engine!);
  }
  ctx.fns.onDebugAttach({
    type: "debugAttach",
    id: frozen.id,
    ...(frozen.sources !== undefined ? { sources: frozen.sources } : {}),
    ...(frozen.bindings !== undefined ? { bindings: frozen.bindings } : {}),
    ...(frozen.sourceBindings !== undefined ? { sourceBindings: frozen.sourceBindings } : {}),
  });
  if (ctx.debugger.epoch === 0) return fail("debugger attach failed");
  if (frozen.breakpoints !== undefined || frozen.watchpoints !== undefined) {
    ctx.fns.onDebugConfigure({
      type: "debugConfigure",
      id: frozen.id,
      epoch: ctx.debugger.epoch,
      revision: 1,
      ...(frozen.breakpoints !== undefined ? { breakpoints: frozen.breakpoints } : {}),
      ...(frozen.watchpoints !== undefined ? { watchpoints: frozen.watchpoints } : {}),
    });
    if (ctx.debugger.configRevision !== 1) return fail("debugger configuration failed");
  }
  if (frozen.stopOnEntry !== false) {
    ctx.fns.onDebugPause({ type: "debugPause", id: frozen.id, epoch: ctx.debugger.epoch });
    if (!ctx.fns.debugStoppedHeld()) return fail("the entry pause did not hold");
  }
  return true;
}

/**
 * A frozen test keeps no ordinary recording: end any predecessor segment,
 * then leave `segment` null so every history hook is inert for the run —
 * the ephemeral host, not the tape, owns test saves. The RNG seed a test
 * supplies still feeds the live draw state historyBoot would have seeded.
 */
function disableTestRecording(ctx: WorkerContext, boot: BootMessage): void {
  ctx.fns.historyEnd("boot");
  const h = ctx.history;
  h.epoch++;
  h.session = "";
  h.rng = (typeof boot.rngSeed === "number" ? boot.rngSeed : 1) & 0xffff;
  h.sent = [];
  h.queue = [];
  h.queuedBytes = 0;
  h.queuedEvents = 0;
  h.resumePending = false;
  h.resumedFrom = null;
  h.pendingEndReply = null;
  if (h.resendTimer !== null) {
    ctx.ports.cancelSchedule?.(h.resendTimer);
    h.resendTimer = null;
  }
}

/**
 * Replay the messages the gate held while the controller module loaded —
 * in arrival order, demand first — through the normal dispatch.
 */
function drainDebugQueue(ctx: WorkerContext): void {
  const pending = ctx.debuggerLoader.queue;
  ctx.debuggerLoader.queue = [];
  for (const msg of pending) onWorkerMessage(ctx, msg);
}

/**
 * The controller's module load already failed once: a frozen-test boot
 * cannot admit its stopped first-instruction session, so refuse it on the
 * debug channel the session awaits (the frozen policy's `id` matches the
 * refusal to its admission) and on the error channel — the worker stays
 * un-booted rather than silently starting a running game.
 */
function refuseFrozenBootLoad(ctx: WorkerContext, msg: Inbound<"boot">): void {
  const frozen = msg.frozenTest;
  const error = "the execution debugger failed to load; the frozen test cannot run";
  ctx.ports.control({
    type: "debugError",
    id: frozen !== undefined && Number.isSafeInteger(frozen.id) ? frozen.id : 0,
    epoch: null,
    buildId: null,
    code: "unavailable",
    error,
  });
  ctx.ports.control({ type: "error", message: `isolated test boot refused: ${error}` });
}

/**
 * Whether an inbound must wait on the controller's one-shot lazy load:
 * every `debug*` command and a frozen-test boot demands it — and kicks the
 * import off — while everything else queues only behind an in-flight load,
 * so no timer, input or host-answer work can slip a first tick in under an
 * incomplete boot policy. A settled failure is refused explicitly instead
 * of being retried per message.
 */
function debugLoadGate(ctx: WorkerContext, msg: WorkerInbound): boolean {
  const loader = ctx.debuggerLoader;
  if (loader.installed) return false;
  if (loader.failed) {
    if (msg.type === "boot" && msg.frozenTest !== undefined) {
      refuseFrozenBootLoad(ctx, msg);
      return true;
    }
    return false;
  }
  if (loader.loading === null && !controllerDemand(msg)) return false;
  if (loader.loading === null) {
    void ensureDebugController(ctx).then(() => drainDebugQueue(ctx));
  }
  loader.queue.push(msg);
  return true;
}

export function onWorkerMessage(ctx: WorkerContext, msg: WorkerInbound): void {
  const loader = ctx.projectLoader;
  if (
    loader.loading !== null ||
    (((msg.type === "boot" && msg.projectMode === "create") || msg.type === "projectCreate") &&
      !loader.installed)
  ) {
    loader.queue.push(msg);
    if (loader.loading === null) {
      loader.loading = import("./projectAdmission.ts")
        .then(
          ({
            createProjectAdmission,
            initializeProjectAdmission,
            projectAdmissionIdentity,
            enterProjectCreate,
          }) => {
            Object.assign(
              ctx.fns,
              createProjectAdmission(ctx, { lane: () => ctx.projectAdmission }),
            );
            loader.initialize = (boot) => {
              if (ctx.projectAdmission !== null)
                initializeProjectAdmission(
                  ctx,
                  ctx.projectAdmission,
                  boot.projectDocuments,
                  boot.projectHistory,
                );
            };
            loader.identity = () => projectAdmissionIdentity(ctx, ctx.projectAdmission);
            loader.enterCreate = (request) => enterProjectCreate(ctx, request);
            loader.installed = true;
          },
        )
        .catch((error: unknown) => {
          ctx.ports.control({
            type: "error",
            message: `Project admission failed to load: ${String(error)}`,
          });
          loader.queue = [];
        })
        .finally(() => {
          loader.loading = null;
          const pending = loader.queue;
          loader.queue = [];
          for (const held of pending) onWorkerMessage(ctx, held);
        });
    }
    return;
  }
  if (msg.type === "projectCreate") {
    loader.enterCreate!(msg);
    return;
  }
  if (msg.type === "imageHeroPreview") {
    const lane = ctx.projectAdmission;
    if (lane === null || lane.engine !== ctx.engine || lane.runToken !== msg.runToken) return;
    const serial = (ctx.imagePreviewSerial ?? 0) + 1;
    ctx.imagePreviewSerial = serial;
    ctx.imageHeroPreview = undefined;
    ctx.imagePreviewEngine = undefined;
    if (msg.bytes === null) {
      ctx.fns.postFrame();
      return;
    }
    void import("./imageHeroPreview.ts")
      .then(({ createImageHeroPreview }) => {
        if (
          ctx.projectAdmission !== lane ||
          ctx.engine !== lane.engine ||
          ctx.imagePreviewSerial !== serial
        )
          return;
        ctx.imagePreviewEngine = lane.engine;
        ctx.imageHeroPreview = createImageHeroPreview(
          lane.engine,
          msg.bytes!,
          ctx.cycle.cycleCount,
        );
        ctx.fns.postFrame();
      })
      .catch(() => {
        /* Invalid previews leave the game presentation intact. */
      });
    return;
  }
  if (debugLoadGate(ctx, msg)) return;
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
        msg.type === "click" ||
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
      // While the execution controller owns the run, the legacy direct
      // write is refused: mutation goes through the atomic debugSetValues
      // path, which publishes a fresh pinned stop instead.
      if (ctx.fns.debugAttached()) {
        control({
          type: "debugWritten",
          id: msg.id,
          error: "debugWrite is disabled while the debugger owns execution; use debugSetValues.",
        });
        return;
      }
      ctx.fns.historyRecord({
        kind: "debugWrite",
        vars: msg.vars ?? [],
        flags: msg.flags ?? [],
      });
      ctx.fns.onDebugWrite(msg);
      return;
    }
    if (msg.type === "debugAttach") {
      ctx.fns.onDebugAttach(msg);
      return;
    }
    if (msg.type === "debugDetach") {
      ctx.fns.onDebugDetach(msg);
      return;
    }
    if (msg.type === "debugConfigure") {
      ctx.fns.onDebugConfigure(msg);
      return;
    }
    if (msg.type === "debugPause") {
      ctx.fns.onDebugPause(msg);
      return;
    }
    if (msg.type === "debugResume") {
      ctx.fns.onDebugResume(msg);
      return;
    }
    if (msg.type === "debugRunTo") {
      ctx.fns.onDebugRunTo(msg);
      return;
    }
    if (msg.type === "debugInspect") {
      ctx.fns.onDebugInspect(msg);
      return;
    }
    if (msg.type === "debugEvaluate") {
      ctx.fns.onDebugEvaluate(msg);
      return;
    }
    if (msg.type === "debugSetValues") {
      ctx.fns.onDebugSetValues(msg);
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
    if (msg.type === "previewUpdate") {
      // The play-preview lane's own transaction: a complete candidate,
      // staged detached and committed at a strict idle boundary — never a
      // patch, never a metadata patch, never a reset. Every context that
      // did not grant the lane gets an explicit refused result.
      ctx.fns.onPreviewUpdate(msg);
      return;
    }
    if (msg.type === "previewUpdateStatus") {
      ctx.fns.onPreviewStatus(msg);
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
      // A re-enter replaces the parked run: release the debugger's latch
      // before the engine's boundary assert, then rebind the session's
      // identity against the re-entered state.
      ctx.fns.debugBeforeReplace();
      ctx.fns.onReenter(msg);
      ctx.fns.debugSessionReplaced();
      return;
    }
    if (msg.type === "playHere") {
      // A jump abandons the parked pass the same way a walkthrough does.
      ctx.fns.debugBeforeReplace();
      ctx.fns.onPlayHere(msg);
      ctx.fns.debugSessionReplaced();
      return;
    }
    if (msg.type === "boot") {
      const boot: BootMessage = msg;
      // A frozen-test policy validates before any session state moves: a
      // refused admission leaves the worker a clean shell — no engine, no
      // timers, never a fallback into running play.
      const frozen = boot.frozenTest;
      if (frozen !== undefined) {
        const error = frozenBootError(boot, frozen);
        if (error !== null) {
          refuseFrozenBoot(ctx, frozen, error);
          return;
        }
      }
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
      ctx.boot.project = undefined;
      // A test run never installs room authoring: already-built rooms
      // transition through the real engine and a missing one reports the
      // engine's deterministic outcome — no generation request, no fallback.
      ctx.boot.authorRooms = frozen === undefined && boot.authorRooms === true;
      ctx.boot.createAllowed = frozen === undefined;
      ctx.boot.selectedSoundDevice = boot.soundDevice === 0 ? 0 : 1;
      ctx.boot.profile = boot.profile ?? null;
      ctx.engine = new Engine(
        openContainer(files, ctx.boot.profile ? { profile: ctx.boot.profile } : {}),
        ctx.host,
        ctx.boot.liveDictionary,
        ctx.boot.profile ? { profile: ctx.boot.profile } : undefined,
      );
      ctx.projectAdmission =
        boot.projectMode === "create" && frozen === undefined
          ? newProjectAdmissionState(mintPreviewRunToken(), ctx.engine)
          : null;
      if (ctx.projectAdmission !== null) loader.initialize?.(boot);
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
      if (frozen !== undefined) {
        // Test saves are ephemeral and host-served — the autosave cadence is
        // disabled outright rather than posting images nobody persists.
        ctx.autosave.autosaveIntervalMs = Number.POSITIVE_INFINITY;
        ctx.autosave.autosaveFiles = false;
      }
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
      if (frozen === undefined) {
        // The always-on recording opens its segment once the engine is
        // restored: the boot record carries the image the session resumed
        // from.
        ctx.fns.historyBoot(boot);
      } else {
        // Test admission lands before any timer can fire: the recording is
        // left inert, then attach → configure → pause complete synchronously.
        disableTestRecording(ctx, boot);
        if (!admitFrozenTest(ctx, frozen)) return;
      }
      if (!ctx.replay.replay) ctx.fns.startTimers();
      control({
        type: "booted",
        profile: ctx.engine.profile.id,
        kind: ctx.engine.profileKind,
        ...(ctx.projectAdmission !== null
          ? {
              projectAdmission: {
                runToken: ctx.projectAdmission.runToken,
                identity: loader.identity!()!,
              },
            }
          : {}),
      });
      // A live debug session survives a normal boot under a fresh epoch,
      // rebound against the new image. The frozen admission just installed
      // its own session — rebinding would mint a second epoch and strand the
      // stop the launcher was handed.
      if (frozen === undefined) ctx.fns.debugSessionReplaced();
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
      // A pinned debug stop or an armed parked pass has no patchable
      // boundary: refuse rather than dropping the stop for a patch that
      // cannot apply. Resume or detach first.
      if (ctx.fns.debugCaptureBlocked())
        throw new Error("Cannot patch metadata while execution is stopped or parked mid-cycle.");
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
      ctx.fns.debugSessionReplaced();
      control({ type: "metadataPatched" });
      return;
    }
    if (msg.type === "patch") {
      const resources = msg.resources.map(({ kind, num, payload }) => ({
        kind,
        num,
        payload: new Uint8Array(payload),
      }));
      const refused = (patchGen: number, error: string) =>
        control({
          type: "patched",
          resources: resources.map(({ kind, num }) => ({ kind, num, hint: null })),
          patchGen,
          error,
        });
      if (!ctx.engine) {
        refused(0, "No game is running.");
        return;
      }
      if (ctx.recording.recording)
        ctx.recording.recording.tainted = "Game resources changed during recording.";
      // Same refusal: the pinned stop survives a patch that cannot apply.
      if (ctx.fns.debugCaptureBlocked()) {
        refused(
          ctx.engine.patchGeneration,
          "Cannot patch resources while execution is stopped or parked mid-cycle.",
        );
        return;
      }
      try {
        // All or none: a refusal leaves every resource on its old bytes.
        ctx.engine.patchResources(resources);
      } catch (e) {
        // The ack names the refusal for a caller awaiting it; the rethrow
        // keeps the session error every patch sender has always raised.
        refused(ctx.engine.patchGeneration, String(e));
        throw e;
      }
      for (const { kind, num, payload } of resources)
        ctx.fns.historyRecord({
          kind: "patch",
          resource: kind,
          num,
          data: bytesToBase64(payload),
        });
      ctx.fns.debugSessionReplaced();
      control({
        type: "patched",
        resources: resources.map(({ kind, num, payload }) => ({
          kind,
          num,
          hint: resourceCacheHint(payload),
        })),
        patchGen: ctx.engine.patchGeneration,
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
      if (device !== ctx.boot.selectedSoundDevice) ctx.engine?.stopSound();
      ctx.boot.selectedSoundDevice = device;
      if (ctx.engine) ctx.engine.vars[22] = device === 0 ? 1 : 3;
      ctx.fns.historyRecord({ kind: "device", device });
      return;
    }
    if (msg.type === "observeSentences") {
      ctx.input.observeSentences = msg.enabled;
      if (!msg.enabled) {
        ctx.input.sentence = null;
        ctx.fns.applyTraceChannel();
      }
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
    if (msg.type === "click") {
      ctx.fns.onClick(msg);
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
