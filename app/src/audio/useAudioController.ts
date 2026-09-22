import type { AgiAudio, AudioMode } from "./AgiAudio.ts";
import type { WorkerInbound } from "../workerProtocol.ts";

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
    // path is fixed by the interpreter profile, not a host preference.
    if (mode !== "amiga")
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
