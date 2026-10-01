/**
 * Sound Studio's pure edit vocabulary over the strict SoundDocument: splits,
 * cursor stepping and display labels. Duration words stay authoritative —
 * `updateEvent`/`insertEvent` are the only writers and surface their own
 * exact errors (0 encodes 65,536 ticks; 65,535 is the unrepresentable
 * terminator).
 */
import { PIT_BASE_FREQ } from "../../../../src/sound/sound.ts";
import type { SoundDocument, SoundEvent } from "../../../../src/sound/document.ts";

export const LANE_NAMES = ["Voice 1", "Voice 2", "Voice 3", "Noise"] as const;

/** Human volume and encoded attenuation use opposite scales. */
export function volumeToAttenuation(volume: number): number {
  if (!Number.isInteger(volume) || volume < 0 || volume > 15)
    throw new Error("Volume must be an integer from 0 to 15.");
  return 15 - volume;
}

/** Convert a stored AGI attenuation into the editor's volume scale. */
export function attenuationToVolume(attenuation: number): number {
  if (!Number.isInteger(attenuation) || attenuation < 0 || attenuation > 15)
    throw new Error("Attenuation must be an integer from 0 to 15.");
  return 15 - attenuation;
}

/** The noise control byte's readable name (periodic/white × rate). */
export const NOISE_CONTROL_NAMES: Record<number, string> = {
  0: "Periodic · high",
  1: "Periodic · medium",
  2: "Periodic · low",
  3: "Periodic · tone 2",
  4: "White · high",
  5: "White · medium",
  6: "White · low",
  7: "White · tone 2",
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** The nearest note name for a divisor, as a display aid (≈, never stored). */
export function divisorNoteLabel(divisor: number): string {
  if (divisor < 1 || divisor > 1023) return "";
  const midi = Math.round(69 + 12 * Math.log2(PIT_BASE_FREQ / divisor / 440));
  if (midi < 0 || midi > 127) return "";
  return `≈${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Seconds a tick count lasts at the authentic 60 Hz interpreter rate. */
export function ticksSeconds(ticks: number): number {
  return ticks / 60;
}

export function describeEvent(event: SoundEvent): string {
  const ticks = `${event.durationTicks}t`;
  switch (event.data.kind) {
    case "rest":
      return `Rest · ${ticks}`;
    case "tone":
      return `${divisorNoteLabel(event.data.divisor) || "Tone"} · volume ${attenuationToVolume(event.data.attenuation)} · ${ticks}`;
    case "noise":
      return `${NOISE_CONTROL_NAMES[event.data.control & 7] ?? `Noise ${event.data.control}`} · volume ${attenuationToVolume(event.data.attenuation)} · ${ticks}`;
    case "raw":
      return `Raw record · ${ticks}`;
  }
}

/**
 * One event's start tick inside its lane — the sum of the durations before
 * it. The cursor the timeline draws and keyboard stepping share this.
 */
export function eventOnset(lane: readonly SoundEvent[], index: number): number {
  let onset = 0;
  for (let i = 0; i < index; i++) onset += lane[i]!.durationTicks;
  return onset;
}

/**
 * Split one event into two at `atTicks` after its onset. The second part
 * re-enters through `insertEvent`, which retriggers the profile's per-note
 * envelope — callers surface that in their copy; the data bytes are copied
 * verbatim (a raw record stays raw).
 */
export function splitEventAt(document: SoundDocument, id: string, atTicks: number): SoundDocument {
  const event = document.event(id);
  if (event === undefined) throw new Error(`Unknown event '${id}'.`);
  if (!Number.isInteger(atTicks) || atTicks < 1 || atTicks >= event.durationTicks) {
    throw new Error(
      `Split position must be an integer in 1..${Math.max(1, event.durationTicks - 1)} ticks.`,
    );
  }
  const lanes = document.tracks();
  if (lanes === null) throw new Error("This sound format is read-only.");
  const index = lanes[event.lane]!.findIndex((entry) => entry.id === id);
  return document.updateEvent(id, { ticks: atTicks }).insertEvent(event.lane, index + 1, {
    ticks: event.durationTicks - atTicks,
    data: event.data,
  });
}
