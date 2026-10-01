/**
 * The isolated Test run's presentation bridge. The worker's presentation
 * stream — composed frames, text/input mirrors, sound output and pause
 * holds — routes into an injected frame sink and a privately-owned audio
 * instance. One bridge serves one preview: a replaced run calls reset() and
 * teardown calls dispose(), and nothing the old run still posts can repaint
 * a dead canvas or resurrect audio.
 *
 * The audio owner name "debugger" mirrors the live link's convention: the
 * worker's debugAudio hold is a named pause owner, epoch-scoped, so a
 * released hold from a replaced epoch cannot unfreeze a newer run's audio.
 */
import { reactive } from "vue";
import type { SoundOutput } from "../../../../../src/sound/sound.ts";
import type { GameControlBinding } from "../../../../../src/runtime/engine.ts";
import type { SoundTick } from "../../../audio/soundTiming.ts";
import type { WorkerOutbound } from "../../../worker/workerProtocol.ts";

/** The frame presentation message — what the composited canvas consumes. */
export type DebugFrameMessage = Extract<WorkerOutbound, { type: "frame" }>;

/** The narrow audio surface the bridge needs — AgiAudio satisfies it. */
export interface DebugAudioPort {
  output(event: SoundOutput): void;
  outputTick(tick: SoundTick): void;
  stop(): void;
  setPauseOwner(owner: string, paused: boolean): void;
  setMuted?(muted: boolean): void;
  close(): void | Promise<void>;
}

/**
 * A one-shot guard for async resources a preview may outlive: GPU stage
 * creation, audio setup, worker boot. A promise that resolves after close
 * has its resource disposed and is never adopted — a replaced or closed
 * preview cannot be repainted by work started for it.
 */
export interface LateGuard {
  readonly closed: boolean;
  adopt<T>(pending: Promise<T | null>, disposeResource: (value: T) => void): Promise<T | null>;
  close(): void;
}

export function createLateGuard(): LateGuard {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    async adopt<T>(
      pending: Promise<T | null>,
      disposeResource: (value: T) => void,
    ): Promise<T | null> {
      const value = await pending;
      if (closed) {
        if (value !== null) disposeResource(value);
        return null;
      }
      return value;
    },
    close() {
      closed = true;
    },
  };
}

export interface DebugPresentationOptions {
  /** Composite and draw one engine frame (GPU stage or the 2D fallback). */
  present(frame: DebugFrameMessage): void;
  /**
   * Create the run's private audio instance — lazily, on the first sound
   * output. May be asynchronous: a bridge reset or disposed before creation
   * settles closes the late instance and never attaches it.
   */
  createAudio?: () => DebugAudioPort | Promise<DebugAudioPort>;
  /** The engine's key wait opened/closed — the preview's input affordance. */
  onWaitingKey?(waiting: boolean): void;
  /** The engine's own input-row text (mirrored by game logic, not typing). */
  onInputEdit?(text: string): void;
  /** The game's registered key/menu bindings, for shortcut affordances. */
  onControls?(controls: readonly GameControlBinding[]): void;
  /** The engine ended itself — quit(0) through the normal path. */
  onQuit?(): void;
}

/** The bridge's render-facing mirror — reactive for the preview chrome. */
interface DebugPresentationView {
  readonly hasFrame: boolean;
  readonly waitingForKey: boolean;
  readonly inputEdit: string;
  readonly controls: readonly GameControlBinding[];
  readonly audioHeld: boolean;
  readonly audioAttached: boolean;
  /** The engine's open modal kind as reported on the latest frame. */
  readonly modal: string | null;
}

export interface DebugPresentation {
  /** Route one worker presentation message. Control traffic never arrives. */
  handle(message: WorkerOutbound): void;
  /** Reactive mirror of the fields the preview chrome renders. */
  readonly view: DebugPresentationView;
  /** The latest frame the run presented — for canvas re-paints. */
  readonly lastFrame: DebugFrameMessage | null;
  /** Engine-reported key wait. */
  readonly waitingForKey: boolean;
  /** The engine's own input-row mirror. */
  readonly inputEdit: string;
  /** Registered game controls from the latest report. */
  readonly controls: readonly GameControlBinding[];
  /** Any audio hold is up — the worker's, the debugger's, or the preview's. */
  readonly audioHeld: boolean;
  /** The attached audio port, for volume/mute controls. */
  readonly audio: DebugAudioPort | null;
  /** A fresh run: silence sound, clear every owner, drop in-flight creation. */
  reset(): void;
  /**
   * The run ended for good: close its audio instance — the next run creates
   * a fresh one. Frames and input chrome stay.
   */
  releaseAudio(): void;
  /** Tear the bridge down: last frame drops, audio closes exactly once. */
  dispose(): void;
  readonly disposed: boolean;
}

export function createDebugPresentation(options: DebugPresentationOptions): DebugPresentation {
  let lastFrame: DebugFrameMessage | null = null;
  let waitingForKey = false;
  let inputEdit = "";
  let controls: readonly GameControlBinding[] = [];
  /** Bumped on reset/dispose; late async audio resolves into the void. */
  let generation = 0;
  let disposed = false;
  let audio: DebugAudioPort | null = null;
  let audioPending = false;
  /** Output that arrived while audio was still being created. */
  const queuedOutputs: Extract<WorkerOutbound, { type: "soundOutput" | "soundTick" }>[] = [];
  const audioHolds = new Set<string>();
  /** The epoch that raised the debugger hold — only it may release. */
  let debugAudioEpoch: number | null = null;
  /** The reactive mirror the preview renders; updated only in handle(). */
  let modal: string | null = null;
  const view = reactive({
    hasFrame: false,
    waitingForKey: false,
    inputEdit: "",
    controls: [] as readonly GameControlBinding[],
    audioHeld: false,
    audioAttached: false,
    modal: null as string | null,
  });

  function syncView(): void {
    view.hasFrame = lastFrame !== null;
    view.waitingForKey = waitingForKey;
    view.inputEdit = inputEdit;
    view.controls = controls;
    view.audioHeld = audioHolds.size > 0;
    view.audioAttached = audio !== null;
    view.modal = modal;
  }

  function flushOutput(): void {
    const current = audio;
    const gen = generation;
    if (!current) return;
    while (queuedOutputs.length > 0 && !disposed && gen === generation && audio === current) {
      const packet = queuedOutputs.shift()!;
      if (packet.type === "soundTick") current.outputTick(packet);
      else current.output(packet.output);
    }
  }

  function ensureAudio(): void {
    if (audio || audioPending || !options.createAudio || disposed) return;
    audioPending = true;
    const gen = generation;
    void Promise.resolve(options.createAudio()).then(
      (created) => {
        audioPending = false;
        // A reset or teardown happened while creation was in flight: the
        // late instance is closed, never attached, never audible.
        if (disposed || gen !== generation) {
          void created.close();
          return;
        }
        audio = created;
        for (const owner of audioHolds) audio.setPauseOwner(owner, true);
        flushOutput();
        syncView();
      },
      () => {
        audioPending = false;
      },
    );
  }

  function setHold(owner: string, paused: boolean): void {
    if (paused) audioHolds.add(owner);
    else audioHolds.delete(owner);
    audio?.setPauseOwner(owner, paused);
  }

  function resetAudio(): void {
    audioHolds.clear();
    debugAudioEpoch = null;
    queuedOutputs.length = 0;
    if (audio) {
      for (const owner of ["debugger", "worker"]) audio.setPauseOwner(owner, false);
      audio.stop();
    }
    // A creation still in flight belongs to the old run entirely.
    generation++;
  }

  return {
    view,
    get lastFrame() {
      return lastFrame;
    },
    get waitingForKey() {
      return waitingForKey;
    },
    get inputEdit() {
      return inputEdit;
    },
    get controls() {
      return controls;
    },
    get audioHeld() {
      return audioHolds.size > 0;
    },
    get audio() {
      return audio;
    },
    get disposed() {
      return disposed;
    },

    handle(message: WorkerOutbound): void {
      if (disposed) return;
      try {
        switch (message.type) {
          case "frame":
            lastFrame = message;
            modal = message.modal;
            options.present(message);
            break;
          case "soundOutput":
          case "soundTick":
            queuedOutputs.push(message);
            ensureAudio();
            flushOutput();
            break;
          case "soundPaused":
            setHold("worker", message.paused);
            break;
          case "stopSound":
            queuedOutputs.length = 0;
            audio?.stop();
            break;
          case "soundEnabled":
            audio?.setMuted?.(!message.enabled);
            break;
          case "debugAudio":
            // The worker's debugger hold is epoch-scoped: only the epoch that
            // raised it may release it — a stale release is worker noise.
            if (message.paused) {
              debugAudioEpoch = message.epoch;
              setHold("debugger", true);
            } else if (debugAudioEpoch === null || debugAudioEpoch === message.epoch) {
              debugAudioEpoch = null;
              setHold("debugger", false);
            }
            break;
          case "waitingForKey":
            waitingForKey = message.waiting;
            options.onWaitingKey?.(message.waiting);
            break;
          case "inputEdit":
            inputEdit = message.text;
            options.onInputEdit?.(message.text);
            break;
          case "controls":
            controls = message.controls;
            options.onControls?.(message.controls);
            break;
          case "quit":
            options.onQuit?.();
            break;
          default:
            // print/status/cycle/log/trace/shake/showObj: the composed frame
            // already carries text and state; the console stays the workspace's.
            break;
        }
      } catch (error) {
        // Sanitized diagnostics: the message kind and error class only —
        // frame payloads and draft content never reach the console.
        const name = error instanceof Error ? error.name : typeof error;
        console.warn(`[debug-presentation] dropped ${message.type} (${name})`);
      }
      syncView();
    },

    reset() {
      lastFrame = null;
      waitingForKey = false;
      inputEdit = "";
      controls = [];
      modal = null;
      resetAudio();
      syncView();
    },

    releaseAudio() {
      if (disposed) return;
      resetAudio();
      const closing = audio;
      audio = null;
      if (closing) void closing.close();
      syncView();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      resetAudio();
      const closing = audio;
      audio = null;
      lastFrame = null;
      if (closing) void closing.close();
      syncView();
    },
  };
}
