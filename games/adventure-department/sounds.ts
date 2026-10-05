import type { SoundTrackInput } from "../../src/agent/soundBuilder.ts";

export const TUTORIAL_SOUND_IDS = {
  intro: 1,
  point: 2,
  lever: 3,
} as const;

export interface TutorialSoundSource {
  readonly representation: "music" | "sound";
  readonly tempo: number | null;
  readonly tracks: readonly SoundTrackInput[];
}

/**
 * Editable native AGI sound sources. Durations are 60 Hz sound ticks and
 * attenuation runs from 0 (loudest) through 15 (silent). Stored divisors keep
 * the released resources and walkthrough identities fixed.
 */
export const TUTORIAL_SOUND_SOURCES: Readonly<Record<number, TutorialSoundSource>> = {
  [TUTORIAL_SOUND_IDS.intro]: {
    representation: "music",
    tempo: 120,
    tracks: [
      {
        notes: [
          { freqDivisor: 339, duration: 30, attenuation: 3 },
          { freqDivisor: 285, duration: 30, attenuation: 3 },
          { freqDivisor: 226, duration: 45, attenuation: 2 },
          { freqDivisor: 254, duration: 15, attenuation: 3 },
          { freqDivisor: 285, duration: 30, attenuation: 3 },
          { freqDivisor: 302, duration: 30, attenuation: 4 },
          { freqDivisor: 339, duration: 30, attenuation: 3 },
        ],
      },
      {
        notes: [
          { freqDivisor: 677, duration: 60, attenuation: 8 },
          { freqDivisor: 427, duration: 60, attenuation: 8 },
          { freqDivisor: 380, duration: 60, attenuation: 8 },
          { freqDivisor: 339, duration: 30, attenuation: 7 },
        ],
      },
      {
        notes: [
          { freqDivisor: 677, duration: 60, attenuation: 10 },
          { freqDivisor: 853, duration: 60, attenuation: 10 },
          { freqDivisor: 760, duration: 60, attenuation: 10 },
          { freqDivisor: 677, duration: 30, attenuation: 9 },
        ],
      },
      { notes: [{ note: "rest", duration: 210 }] },
    ],
  },
  [TUTORIAL_SOUND_IDS.point]: {
    representation: "sound",
    tempo: null,
    tracks: [
      {
        notes: [
          { freqDivisor: 254, duration: 12, attenuation: 3 },
          { freqDivisor: 201, duration: 12, attenuation: 2 },
          { freqDivisor: 169, duration: 12, attenuation: 1 },
        ],
      },
      {
        notes: [
          { freqDivisor: 302, duration: 12, attenuation: 8 },
          { freqDivisor: 254, duration: 12, attenuation: 7 },
          { freqDivisor: 201, duration: 12, attenuation: 6 },
        ],
      },
    ],
  },
  [TUTORIAL_SOUND_IDS.lever]: {
    representation: "sound",
    tempo: null,
    tracks: [
      {
        notes: [
          { freqDivisor: 900, duration: 4, attenuation: 2 },
          { note: "rest", duration: 14 },
          { freqDivisor: 254, duration: 12, attenuation: 3 },
          { freqDivisor: 201, duration: 12, attenuation: 2 },
          { freqDivisor: 169, duration: 12, attenuation: 1 },
        ],
      },
      {
        notes: [
          { freqDivisor: 640, duration: 4, attenuation: 5 },
          { note: "rest", duration: 14 },
          { freqDivisor: 302, duration: 12, attenuation: 8 },
          { freqDivisor: 254, duration: 12, attenuation: 7 },
          { freqDivisor: 201, duration: 12, attenuation: 6 },
        ],
      },
      {
        notes: [
          { freqDivisor: 1000, duration: 4, attenuation: 7 },
          { note: "rest", duration: 50 },
        ],
      },
      {
        notes: [
          { freqDivisor: 4, duration: 4, attenuation: 1 },
          { freqDivisor: 1, duration: 4, attenuation: 5 },
          { note: "rest", duration: 46 },
        ],
      },
    ],
  },
};
