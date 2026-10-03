import type { SoundOutput } from "../../../src/sound/sound.ts";

/** Presentation identity and position; independent of saved interpreter state. */
export interface SoundTiming {
  readonly stream: string;
  readonly tick: number;
}

/** Every register write from one authoritative 60 Hz sound heartbeat. */
export interface SoundTick extends SoundTiming {
  readonly outputs: readonly SoundOutput[];
  readonly complete: boolean;
}

export const SOUND_TICK_SECONDS = 1 / 60;
/** A small delivery cushion, shared by every voice and register in a tick. */
export const SOUND_LOOKAHEAD_SECONDS = 2 * SOUND_TICK_SECONDS;
