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

const tone = (ticks: number, divisor: number, attenuation: number): SoundEventInput => ({
  ticks,
  data: { kind: "tone", divisor, attenuation },
});
const noise = (ticks: number, control: number, attenuation: number): SoundEventInput => ({
  ticks,
  data: { kind: "noise", control, attenuation },
});
const rest = (ticks: number): SoundEventInput => ({ ticks, data: { kind: "rest" } });

// Divisor reference (99431.67 / Hz, hand-checked): A3 452, C4 380, D4 339,
// E4 302, A4 226, C5 190, E5 151, G5 127, C6 95, E3 603.
export const SOUND_PRESETS: readonly SoundPreset[] = [
  {
    id: "discovery",
    name: "Discovery",
    description: "A short rising three-note sparkle for finding something.",
    tracks: [[tone(10, 151, 4), tone(10, 127, 4), tone(20, 95, 4)], [], [], []],
  },
  {
    id: "danger",
    name: "Danger",
    description: "Two low pulses over a held bass tone.",
    tracks: [[tone(14, 452, 3), rest(6), tone(14, 452, 3)], [], [tone(34, 603, 7)], []],
  },
  {
    id: "door-step",
    name: "Door / step",
    description: "Two white-noise taps with a soft thud, for a door or a step.",
    tracks: [[tone(6, 339, 9)], [], [], [noise(4, 5, 6), rest(8), noise(4, 5, 7)]],
  },
  {
    id: "success",
    name: "Success",
    description: "An ascending major triad held on the high note.",
    tracks: [
      [tone(8, 190, 4), tone(8, 151, 4), tone(8, 127, 4), tone(24, 95, 4)],
      [tone(48, 302, 9)],
      [],
      [],
    ],
  },
  {
    id: "death",
    name: "Death",
    description: "A slow descending phrase over a low drone.",
    tracks: [[tone(20, 302, 5), tone(20, 339, 5), tone(40, 380, 6)], [tone(80, 452, 9)], [], []],
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
