import type { AgiAudio, AudioMode } from "./AgiAudio.ts";
import type { WorkerInbound } from "../workerProtocol.ts";
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";

/** The output hardware a profile's interpreter drives. */
export type SoundFamily = "pc" | "amiga" | "iigs";

/** Both Amiga driver generations play through Paula; the IIgs through its own path. */
export function soundFamily(profile: string | null): SoundFamily {
  const sound = profile === null ? undefined : PROFILES[profile as ProfileId]?.sound;
  if (sound === "amiga" || sound === "amiga-2.082") return "amiga";
  if (sound === "iigs") return "iigs";
  return "pc";
}

/** The next PC chip in the settings cycle; only the PC families take a device choice. */
export function nextAudioMode(mode: AudioMode): AudioMode {
  return mode === "tandy" ? "pc-speaker" : "tandy";
}

/**
 * The sound-chip label: the fixed family on Amiga and IIgs editions, the
 * PC preference otherwise. The IIgs path renders triangle oscillators, not
 * the Ensoniq wavetables (docs/fidelity.md, "Apple IIgs interpreter").
 */
export function soundChipLabel(family: SoundFamily, mode: AudioMode): string {
  if (family === "amiga") return "Amiga Paula";
  if (family === "iigs") return "Apple IIgs Ensoniq";
  return mode === "tandy" ? "Tandy 4-Voice" : "PC Speaker";
}

export interface AudioControllerState {
  soundMode: AudioMode;
  soundMuted: boolean;
}

export interface AudioController {
  readonly audio: AgiAudio;
  toggleMute(): boolean;
  setAudioMode(mode: AudioMode): void;
  setAudioVolume(vol: number): void;
  resumeAudio(): Promise<void>;
}

/** Composable managing Web Audio playback modes, volume, mute state, and worker synchronization. */
export function useAudioController(
  audio: AgiAudio,
  state: AudioControllerState,
  postWorkerMessage: (msg: WorkerInbound) => void,
): AudioController {
  function toggleMute(): boolean {
    const muted = audio.toggleMute();
    state.soundMuted = muted;
    postWorkerMessage({ type: "soundEnabled", enabled: !muted });
    return muted;
  }

  function setAudioMode(mode: AudioMode): void {
    audio.setMode(mode);
    state.soundMode = mode;
    // The device operand selects between the PC output families; the Amiga
    // and IIgs paths are fixed by the interpreter profile and ignore it.
    postWorkerMessage({ type: "soundDevice", device: mode === "pc-speaker" ? 0 : 1 });
  }

  function setAudioVolume(vol: number): void {
    audio.setVolume(vol);
  }

  function resumeAudio(): Promise<void> {
    return audio.resume();
  }

  return {
    audio,
    toggleMute,
    setAudioMode,
    setAudioVolume,
    resumeAudio,
  };
}
