/**
 * Small original cue presets for the sound editor: starting points a creator
 * can apply, hear and then edit as ordinary native events. Each preset is a
 * plain list of event inputs for the four lanes (three tone + noise); nothing
 * is imported, sampled or copied, and applying a preset reserves no ids and
 * changes no starter content.
 */

import {
  createSoundDocument,
  SoundDocumentError,
  type SoundDocument,
  type SoundEventInput,
} from "./document.ts";

export interface SoundPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Event inputs per lane: [tone 0, tone 1, tone 2, noise]. */
  readonly tracks: readonly (readonly SoundEventInput[])[];
}

const tone = (ticks: number, note: string, attenuation: number): SoundEventInput => ({
  ticks,
  data: { kind: "tone", note, attenuation },
});
const noise = (ticks: number, control: number, attenuation: number): SoundEventInput => ({
  ticks,
  data: { kind: "noise", control, attenuation },
});
const rest = (ticks: number): SoundEventInput => ({ ticks, data: { kind: "rest" } });

// Named notes preserve the cues' pitches through the shared PSG conversion.
export const SOUND_PRESETS: readonly SoundPreset[] = [
  {
    id: "discovery",
    name: "Discovery",
    description: "A short rising three-note sparkle for finding something.",
    tracks: [[tone(10, "E5", 4), tone(10, "G5", 4), tone(20, "C6", 4)], [], [], []],
  },
  {
    id: "danger",
    name: "Danger",
    description: "Two low pulses over a held bass tone.",
    tracks: [[tone(14, "A3", 3), rest(6), tone(14, "A3", 3)], [], [tone(34, "E3", 7)], []],
  },
  {
    id: "door-step",
    name: "Door / step",
    description: "Two white-noise taps with a soft thud, for a door or a step.",
    tracks: [[tone(6, "D4", 9)], [], [], [noise(4, 5, 6), rest(8), noise(4, 5, 7)]],
  },
  {
    id: "success",
    name: "Success",
    description: "An ascending major triad held on the high note.",
    tracks: [
      [tone(8, "C5", 4), tone(8, "E5", 4), tone(8, "G5", 4), tone(24, "C6", 4)],
      [tone(48, "E4", 9)],
      [],
      [],
    ],
  },
  {
    id: "death",
    name: "Death",
    description: "A slow descending phrase over a low drone.",
    tracks: [
      [tone(20, "E4", 5), tone(20, "D4", 5), tone(40, "C4", 6)],
      [tone(80, "A3", 9)],
      [],
      [],
    ],
  },
];

/**
 * Replace a document's lanes with a preset's events on a fresh document that
 * keeps the same profile. The preset's own ids are never reused; every event
 * arrives through the same validated insert path as a manual entry.
 */
export function applySoundPreset(document: SoundDocument, presetId: string): SoundDocument {
  const preset = SOUND_PRESETS.find((entry) => entry.id === presetId);
  if (preset === undefined) {
    throw new SoundDocumentError("invalid-value", `Unknown sound preset '${presetId}'.`);
  }
  if (document.representation !== "four-stream") {
    throw new SoundDocumentError(
      "opaque",
      "Cannot apply a preset to an opaque retained payload; start a new cue or repair the import.",
    );
  }
  let next = createSoundDocument({ profileId: document.profileId });
  for (let lane = 0; lane < 4; lane++) {
    for (const event of preset.tracks[lane]!) {
      next = next.insertEvent(lane, next.tracks()![lane]!.length, event);
    }
  }
  return next;
}
