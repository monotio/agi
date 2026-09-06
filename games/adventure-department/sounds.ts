import type { SoundTrackInput } from "../../src/agent/tools.ts";

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
 * attenuation runs from 0 (loudest) through 15 (silent).
 */
export const TUTORIAL_SOUND_SOURCES: Readonly<Record<number, TutorialSoundSource>> = {
  [TUTORIAL_SOUND_IDS.intro]: {
    representation: "music",
    tempo: 120,
    tracks: [
      {
        notes: [
          { note: "D4", duration: 30, attenuation: 3 },
          { note: "F4", duration: 30, attenuation: 3 },
          { note: "A4", duration: 45, attenuation: 2 },
          { note: "G4", duration: 15, attenuation: 3 },
          { note: "F4", duration: 30, attenuation: 3 },
          { note: "E4", duration: 30, attenuation: 4 },
          { note: "D4", duration: 30, attenuation: 3 },
        ],
      },
      {
        notes: [
          { note: "D3", duration: 60, attenuation: 8 },
          { note: "Bb3", duration: 60, attenuation: 8 },
          { note: "C4", duration: 60, attenuation: 8 },
          { note: "D4", duration: 30, attenuation: 7 },
        ],
      },
      {
        notes: [
          { note: "D3", duration: 60, attenuation: 10 },
          { note: "Bb2", duration: 60, attenuation: 10 },
          { note: "C3", duration: 60, attenuation: 10 },
          { note: "D3", duration: 30, attenuation: 9 },
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
          { note: "G4", duration: 12, attenuation: 3 },
          { note: "B4", duration: 12, attenuation: 2 },
          { note: "D5", duration: 12, attenuation: 1 },
        ],
      },
      {
        notes: [
          { note: "E4", duration: 12, attenuation: 8 },
          { note: "G4", duration: 12, attenuation: 7 },
          { note: "B4", duration: 12, attenuation: 6 },
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
          { note: "G4", duration: 12, attenuation: 3 },
          { note: "B4", duration: 12, attenuation: 2 },
          { note: "D5", duration: 12, attenuation: 1 },
        ],
      },
      {
        notes: [
          { freqDivisor: 640, duration: 4, attenuation: 5 },
          { note: "rest", duration: 14 },
          { note: "E4", duration: 12, attenuation: 8 },
          { note: "G4", duration: 12, attenuation: 7 },
          { note: "B4", duration: 12, attenuation: 6 },
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
