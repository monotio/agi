/**
 * Sound Studio's private audition owner: one SoundAudition over a private
 * AgiAudio, leased through the engine's runtime pause hold. Editing or
 * reselecting a cue retargets the payload (the service's epoch guard retires
 * stale work); closing the studio disposes the service, which releases only
 * this hold. Nothing here touches the gameplay audio, the worker stream or
 * the player's sound preference.
 */
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import type { RuntimePauseLeaseAcquire } from "../../engine/runtimePauseLease.ts";
import { AgiAudio, type AudioMode } from "../../audio/AgiAudio.ts";
import {
  SoundAudition,
  type AuditionLeaseAcquire,
  type AuditionSnapshot,
} from "../../audio/soundAudition.ts";

/** The narrow driver surface the studio uses — a test stub satisfies it. */
export type SoundPreviewDriver = Pick<
  SoundAudition,
  | "setTarget"
  | "play"
  | "pause"
  | "resume"
  | "stop"
  | "seek"
  | "setLaneMuted"
  | "setLaneSolo"
  | "subscribe"
  | "snapshot"
  | "close"
>;

interface SoundPreviewTarget {
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly documentId: string;
  readonly revision: string | number;
  readonly payload: Uint8Array;
  readonly profileId: ProfileId;
}

export interface SoundPreview {
  /** The device's preview rendering choice; the `soundDevice` operand. */
  readonly device: AudioMode;
  readonly snapshot: AuditionSnapshot;
  setTarget(target: SoundPreviewTarget): void;
  play(): void;
  pause(): void;
  stop(): void;
  seek(tick: number): void;
  setLaneMuted(lane: number, muted: boolean): void;
  setLaneSolo(lane: number | null): void;
  setDevice(mode: AudioMode): void;
  close(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

function deviceOperand(mode: AudioMode): number {
  // The player's soundDevice operand: 0 is the PC speaker, anything else the
  // three-voice chip — the same mapping the play path posts to the worker.
  return mode === "pc-speaker" ? 0 : 1;
}

export function createSoundPreview(options: {
  readonly acquirePauseLease: RuntimePauseLeaseAcquire;
  /** Tests inject a stub; production builds the real audition pair lazily. */
  readonly driver?: (
    acquire: AuditionLeaseAcquire,
    mode: AudioMode,
  ) => { driver: SoundPreviewDriver; audio: AgiAudio | null };
  readonly device?: AudioMode;
}): SoundPreview {
  let device: AudioMode = options.device ?? "tandy";
  const acquire: AuditionLeaseAcquire = (request) => options.acquirePauseLease(request.owner);
  const made =
    options.driver !== undefined
      ? options.driver(acquire, device)
      : (() => {
          const audio = new AgiAudio({ mode: device });
          return { driver: new SoundAudition({ audio, acquire }), audio };
        })();
  const driver = made.driver;
  let lastTarget: SoundPreviewTarget | null = null;
  const listeners = new Set<() => void>();
  let snapshot: AuditionSnapshot = driver.snapshot();
  const unsubscribe = driver.subscribe((next) => {
    snapshot = next;
    for (const listener of listeners) listener();
  });

  function notify(): void {
    for (const listener of listeners) listener();
  }

  const preview: SoundPreview = {
    get device() {
      return device;
    },
    get snapshot() {
      return snapshot;
    },
    setTarget(target) {
      lastTarget = target;
      driver.setTarget({
        projectId: target.projectId,
        ...(target.workspaceId !== undefined ? { workspaceId: target.workspaceId } : {}),
        documentId: target.documentId,
        revision: target.revision,
        payload: target.payload,
        profileId: target.profileId,
        device: deviceOperand(device),
      });
    },
    play() {
      void driver.play();
    },
    pause() {
      driver.pause();
    },
    stop() {
      driver.stop();
    },
    seek(tick) {
      void driver.seek(tick);
    },
    setLaneMuted(lane, muted) {
      driver.setLaneMuted(lane, muted);
    },
    setLaneSolo(lane) {
      driver.setLaneSolo(lane);
    },
    setDevice(mode) {
      if (mode === device) return;
      device = mode;
      made.audio?.setMode(mode);
      // The device is part of the target identity; retarget so the next run
      // renders on the chosen chip rather than the remembered operand.
      const target = lastTarget;
      if (target !== null) preview.setTarget(target);
      notify();
    },
    async close() {
      unsubscribe();
      await driver.close();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return preview;
}
