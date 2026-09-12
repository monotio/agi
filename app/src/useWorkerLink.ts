/**
 * The worker link: worker lifetime, the onmessage dispatch table, query
 * plumbing and the text hook. The controllers the wire dispatches to are a
 * function table (`deps`) useEngine fills after every controller exists, so
 * construction order never matters.
 */
import type { AgentHandler, LlmRequest } from "./agent/hostRequests.ts";
import type { AgiAudio } from "./audio/AgiAudio.ts";
import type { BootedGame, Frame } from "./gameTypes.ts";
import { decodeTextRows, gameStorageKey } from "./gameTypes.ts";
import type { ReplayDriver, ReplayObservation } from "./replay.ts";
import { LAST_GAME_KEY } from "./useAutosaveController.ts";
import type { EngineState, ModalKind, TextHook } from "./useEngineTypes.ts";
import type { LogAgentFn } from "./useInputController.ts";
import { createWorkerQueries } from "./workerQueries.ts";
import type {
  WorkerInbound,
  WorkerOutbound,
  WorkerQueryPayload,
  WorkerQueryType,
} from "./workerProtocol.ts";

/** Controllers the wire dispatches to; useEngine fills it once each exists. */
export interface WorkerLinkDeps {
  resetScreenState(): void;
  cancelPrompt(): void;
  handleAutosave(msg: Extract<WorkerOutbound, { type: "autosave" }>): void;
  handleFlushed(msg: Extract<WorkerOutbound, { type: "flushed" }>): void;
  handleRestored(msg: Extract<WorkerOutbound, { type: "restored" }>): void;
  handleSaveSlotRequest(
    op: "restore" | "saveList" | "saveWrite",
    context: Record<string, unknown>,
  ): Promise<string> | string;
  handlePromptRequest(
    op: "getnum" | "getstring" | "saveDescription",
    context: Record<string, unknown>,
  ): Promise<string>;
  handleRoomAuthoring(req: LlmRequest, agent: AgentHandler): Promise<string>;
  getAgentSession(): AgentHandler | null;
  getReplayDriver(): ReplayDriver;
  ejectGame(): void;
}

export interface WorkerLinkOptions {
  readonly state: EngineState;
  readonly hook: TextHook;
  readonly audio: AgiAudio;
  readonly onFrame: (frame: Frame) => void;
  readonly logAgent: LogAgentFn;
  readonly getBootedGame: () => BootedGame | null;
  readonly getActiveWalkthroughSession: () => number;
  readonly observationListeners: Set<(obs: ReplayObservation) => void>;
}

export function useWorkerLink(options: WorkerLinkOptions) {
  const { state, hook, audio, onFrame, logAgent, observationListeners } = options;
  const deps = {} as WorkerLinkDeps;

  let worker: Worker | null = null;
  let latestFrame: Frame | null = null;
  let shakeTimer: number | null = null;
  const workerQueries = createWorkerQueries();
  const drainPendingQueries = (err?: Error) => workerQueries.drainPendingQueries(err);

  /** Every worker's host requests follow the current idle-boundary session replacement. */
  const currentSessionAgent: AgentHandler = {
    handle: async (request) => (await deps.getAgentSession()?.handle(request)) ?? "",
  };

  /** Publish the engine's text surface for tests and the debug bundle. */
  function publishText(text: Uint8Array, modal: ModalKind | null, textMode: boolean): void {
    const rows = decodeTextRows(text);
    state.rows = rows;
    state.modal = modal;
    state.textMode = textMode;
    hook.rows = rows;
    hook.modal = modal;
    hook.textMode = textMode;
    publishHook();
  }

  /** Mirror the text hook onto the window: production e2e verifies engine text through it. */
  function publishHook(): void {
    if (typeof window !== "undefined") window.__AGI_TEXT__ = hook;
  }

  /**
   * Host-request services: getnum/getstring/saveDescription open a modal
   * input and suspend the worker until the player submits; restore and the
   * save slots touch localStorage. Room authoring passes through to the
   * game agent.
   */
  function hostRequestHandler(agent: AgentHandler): AgentHandler {
    return {
      async handle(req) {
        if (req.op === "restore" || req.op === "saveList" || req.op === "saveWrite") {
          return deps.handleSaveSlotRequest(req.op, req.context);
        }
        if (req.op === "getnum" || req.op === "getstring" || req.op === "saveDescription") {
          return deps.handlePromptRequest(req.op, req.context);
        }
        return deps.handleRoomAuthoring(req, agent);
      },
    };
  }

  /** Terminate the current worker and forget it (eject / shutdown paths). */
  function terminateWorker(): void {
    worker?.terminate();
    worker = null;
  }

  /** Cancel a pending shake.timer effect; lifecycle's screen reset calls this. */
  function clearShake(): void {
    clearTimeout(shakeTimer ?? undefined);
    shakeTimer = null;
  }

  function spawnWorker(): Worker {
    worker?.terminate();
    audio.stop();
    deps.resetScreenState();
    workerQueries.drainPendingQueries(new Error("engine worker replaced"));
    const w = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    wireWorker(w);
    return w;
  }

  function wireWorker(w: Worker): void {
    // Trace stream instance last seen from this worker; an epoch change
    // means the worker reset or re-armed the channel, so stale records drop.
    let traceEpochSeen = -1;
    // The map is required, not partial: a union member without a handler is a
    // type error here, so deleting one fails `npm run check` at compile time.
    const handlers: {
      [K in WorkerOutbound["type"]]: (msg: Extract<WorkerOutbound, { type: K }>) => void;
    } = {
      // Query replies — each settles its pending promise with the payload the
      // request asked for (see WorkerQueryReplies / WorkerQueryPayload).
      engineState: (msg) => workerQueries.resolveQuery(msg.id, msg.state),
      objects: (msg) => workerQueries.resolveQuery(msg.id, msg.objects),
      frames: (msg) => workerQueries.resolveQuery(msg.id, msg.frames),
      checkpoint: (msg) => workerQueries.resolveQuery(msg.id, msg.image),
      exportFiles: (msg) => workerQueries.resolveQuery(msg.id, msg.files),
      debugWritten: (msg) => workerQueries.resolveQuery(msg.id, msg),
      debugEvents: (msg) => workerQueries.resolveQuery(msg.id, msg),
      debugTrace: (msg) => workerQueries.resolveQuery(msg.id, msg),
      recordingStarted: (msg) => workerQueries.resolveQuery(msg.id, msg),
      recordingStopped: (msg) => workerQueries.resolveQuery(msg.id, msg),
      // The worker's acknowledgement that the freeze landed — the hook reads
      // the real pause state, not the request.
      paused: (msg) => {
        hook.paused = msg.paused;
      },
      // The worker parks on a player key (have.key, a selector, a
      // confirmation) without posting a host request; this flag mirrors that
      // wait so input routing and hints know a raw key resumes the game.
      waitingForKey: (msg) => {
        state.waitingForKey = msg.waiting;
      },
      // The worker suspended on a host service. The request id settles the
      // handshake: the matching hostAnswer resumes the parked interaction,
      // and a stale id — the interaction was abandoned — is dropped there.
      hostRequest: (msg) => {
        const id = msg.id;
        const req: LlmRequest = {
          op: msg.op,
          context: msg.context,
        };
        logAgent("request", `${req.op} ${JSON.stringify(req.context)}`);
        hostRequestHandler(currentSessionAgent)
          .handle(req)
          .then((response) => {
            logAgent("response", response.slice(0, 120));
            w.postMessage({ type: "hostAnswer", id, response } satisfies WorkerInbound);
          })
          .catch((e) => {
            logAgent("response", `agent error: ${String(e)}`);
            w.postMessage({ type: "hostAnswer", id, response: "" } satisfies WorkerInbound);
          });
      },
      // The worker abandoned a suspended interaction (reenter, superseded
      // request): resolve the prompt widgets its in-flight request opened so
      // the UI stops waiting on an answer that is no longer consumed.
      interactionCancelled: () => {
        deps.cancelPrompt();
      },
      frame: (msg) => {
        state.inputEnabled = msg.inputEnabled;
        state.inputReady = msg.inputReady;
        state.holdToMove = msg.holdToMove;
        publishText(msg.text, (msg.modal as ModalKind | null) ?? null, msg.textMode);
        latestFrame = {
          visual: msg.visual,
          priority: msg.priority,
          text: msg.text,
          picRow: msg.picRow,
          cycle: msg.cycle,
        };
        // Armed debug channels ride the frame; absence clears the mirror so a
        // disarmed channel never leaves stale data in the inspector.
        if (msg.ownership) latestFrame.ownership = msg.ownership;
        else delete latestFrame.ownership;
        if (msg.objects) latestFrame.objects = msg.objects;
        else delete latestFrame.objects;
        if (msg.picVisual && msg.picPriority) {
          latestFrame.picVisual = msg.picVisual;
          latestFrame.picPriority = msg.picPriority;
        } else {
          delete latestFrame.picVisual;
          delete latestFrame.picPriority;
        }
        state.debugObjects = msg.objects ?? [];
        // The show.obj notice arms the preview identity; the frame's modal
        // field is authoritative for dismissal.
        if (msg.modal !== "showObj") state.showObjView = null;
        onFrame(latestFrame);
        // Counted after the frame is drawn, so tests can poll for painted pixels.
        hook.frame++;
        publishHook();
      },
      controls: (msg) => {
        state.controls = msg.controls;
      },
      inputEdit: (msg) => {
        state.gameEdit = { text: msg.text };
      },
      print: (msg) => logAgent("log", `print: ${msg.text}`),
      status: (msg) => {
        state.status = msg.text;
      },
      shake: (msg) => {
        state.shake = true;
        clearTimeout(shakeTimer ?? undefined);
        shakeTimer = setTimeout(() => {
          state.shake = false;
          shakeTimer = null;
        }, msg.count * 100) as unknown as number;
      },
      soundEnabled: (msg) => {
        state.soundMuted = !msg.enabled;
        audio.setMuted(state.soundMuted);
      },
      sound: () => {
        state.soundPlaying = true;
      },
      soundOutput: (msg) => audio.output(msg.output),
      soundPaused: (msg) => audio.setPaused(msg.paused || state.paused),
      stopSound: () => {
        state.soundPlaying = false;
        audio.stop();
      },
      autosave: (msg) => deps.handleAutosave(msg),
      flushed: (msg) => deps.handleFlushed(msg),
      restored: (msg) => deps.handleRestored(msg),
      // Deliberate no-op: the patch flow resynchronizes through the following
      // reenter + frame; raw-worker e2e observes this notice directly.
      metadataPatched: () => {},
      log: (msg) => logAgent("log", msg.text),
      quit: () => {
        deps.ejectGame();
      },
      replay: (msg) => {
        const replayDriver = deps.getReplayDriver();
        if (!replayDriver) return;
        const obs = msg.observation;
        if (
          typeof obs.sessionId === "number" &&
          obs.sessionId !== 0 &&
          obs.sessionId !== options.getActiveWalkthroughSession()
        ) {
          return;
        }
        replayDriver.latest = obs;
        state.inputReady = true;
        state.inputEnabled = obs.state.inputEnabled;
        state.modal = (obs.state.modalKind as ModalKind | null) ?? null;
        // Lean observations carry no rows; frame messages keep the surface fresh.
        if (obs.rows.length > 0) {
          state.rows = obs.rows;
          hook.rows = obs.rows;
        }
        hook.modal = state.modal;
        hook.cycle = obs.cycle;
        hook.room = obs.state.room;
        hook.egoX = obs.state.egoX;
        hook.egoY = obs.state.egoY;
        publishHook();
        for (const listener of observationListeners) listener(replayDriver.latest);
        // Replay observations also arrive unprompted (id null) on every
        // blocked tick; only a real request id may settle a pending query.
        if (msg.id !== null) workerQueries.resolveQuery(msg.id, replayDriver.latest);
      },
      trace: (msg) => {
        // A new stream epoch means the worker dropped or reset its queue —
        // discard what a replaced session left rather than stitching streams.
        if (msg.epoch !== traceEpochSeen) {
          traceEpochSeen = msg.epoch;
          state.debugTrace = [];
          state.debugTraceDropped = 0;
        }
        state.debugTrace.push(...msg.records);
        if (state.debugTrace.length > 4000)
          state.debugTrace.splice(0, state.debugTrace.length - 4000);
        state.debugTraceDropped += msg.dropped;
        w.postMessage({ type: "traceAck", epoch: msg.epoch, batch: msg.batch });
      },
      // show.obj carries the one datum frame.modal lacks: which view the
      // modal previews. The exploded layers need it to keep the preview
      // visible as its own layer.
      showObj: (msg) => {
        state.showObjView = msg.viewNum;
      },
      cycle: (msg) => {
        hook.cycle = msg.cycle;
        hook.room = msg.room;
        hook.egoX = msg.egoX;
        hook.egoY = msg.egoY;
        if (typeof window !== "undefined") window.__AGI_TEXT__ = hook;
      },
      booted: (msg) => {
        const booted = options.getBootedGame();
        if (booted) {
          try {
            localStorage.setItem(LAST_GAME_KEY, gameStorageKey(booted));
          } catch {
            /* Playback can continue without browser storage. */
          }
        }
        state.phase = "running";
        state.error = "";
        // The worker reports the profile it detected from the shipped files.
        const profile = typeof msg.profile === "string" ? msg.profile : null;
        state.profile = profile;
        hook.profile = profile;
        publishHook();
      },
      error: (msg) => {
        state.phase = "error";
        state.error = msg.message;
      },
    };
    worker = w;
    w.onmessage = (ev: MessageEvent) => {
      // A replaced worker's messages never land here.
      if (worker !== w) return;
      // Ingress validation for whatever structured clone delivered: unknown
      // or malformed messages drop instead of reaching a handler.
      const data = ev.data;
      if (
        !data ||
        typeof data !== "object" ||
        typeof data.type !== "string" ||
        !(data.type in handlers)
      ) {
        return;
      }
      const msg = data as WorkerOutbound;
      const sessionId = "sessionId" in msg ? msg.sessionId : undefined;
      if (
        typeof sessionId === "number" &&
        sessionId > 0 &&
        sessionId !== options.getActiveWalkthroughSession()
      ) {
        return;
      }
      const handler = handlers[msg.type] as (m: WorkerOutbound) => void;
      handler(msg);
    };
  }

  /**
   * Ask the worker a question and await its reply. The request type fixes the
   * reply member and the payload shape the promise settles with
   * (WorkerQueryPayload), so a caller cannot await the wrong message.
   * Queries are answered between cycles and work while the interpreter is
   * paused, which is the whole point: the agent inspects a frozen game.
   */
  function query<K extends WorkerQueryType>(
    type: K,
    extra: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<WorkerQueryPayload[K]> {
    const effectiveTimeout =
      timeoutMs ??
      (type === "replayAdvance"
        ? Math.max(20_000, Math.ceil(Number(extra["ticks"] ?? 0) / 2))
        : 5000);
    return workerQueries.query<WorkerQueryPayload[K]>(() => worker, type, extra, effectiveTimeout);
  }

  return {
    deps,
    getWorker: () => worker,
    getLatestFrame: () => latestFrame,
    clearShake,
    spawnWorker,
    terminateWorker,
    wireWorker,
    query,
    drainPendingQueries,
    publishText,
    publishHook,
  };
}

export type WorkerLink = ReturnType<typeof useWorkerLink>;
