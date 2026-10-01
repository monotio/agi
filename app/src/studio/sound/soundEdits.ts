/** Friendly edits over the immutable native SOUND document. */
import { readMusicDocument } from "../../../../src/authoring/projectDocuments.ts";
import { resourceCacheHint } from "../../../../src/authoring/authoringState.ts";
import type { ProjectChange } from "../../../../src/authoring/projectContent.ts";
import { PIT_BASE_FREQ } from "../../../../src/sound/sound.ts";
import type { SoundDocument } from "../../../../src/sound/document.ts";

export const LANE_NAMES = ["Voice 1", "Voice 2", "Voice 3", "Noise"] as const;
export const NOISE_CONTROL_NAMES: Record<number, string> = {
  0: "Periodic high",
  1: "Periodic medium",
  2: "Periodic low",
  3: "Periodic Voice 3",
  4: "White high",
  5: "White medium",
  6: "White low",
  7: "White Voice 3",
};

export function volumeToAttenuation(volume: number): number {
  if (!Number.isInteger(volume) || volume < 0 || volume > 15)
    throw new Error("Volume must be an integer from 0 to 15.");
  return 15 - volume;
}

export function attenuationToVolume(attenuation: number): number {
  if (!Number.isInteger(attenuation) || attenuation < 0 || attenuation > 15)
    throw new Error("Attenuation must be an integer from 0 to 15.");
  return 15 - attenuation;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** Nearest musical pitch is a display aid; opening a note never changes its divisor. */
export function divisorNoteLabel(divisor: number): string {
  if (divisor < 1 || divisor > 1023) return "";
  const midi = Math.round(69 + 12 * Math.log2(PIT_BASE_FREQ / divisor / 440));
  if (midi < 0 || midi > 127) return "";
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function checkTempo(tempo: number): void {
  if (!Number.isFinite(tempo) || tempo < 40 || tempo > 240)
    throw new Error("Tempo must be from 40 to 240 beats per minute.");
}

/** Beat lengths are an editing aid; native 60 Hz durations remain authoritative. */
export function editSoundNote(
  document: SoundDocument,
  id: string,
  edit: { note?: string; beats?: number; volume?: number },
  tempo: number,
): SoundDocument {
  checkTempo(tempo);
  let next = document;
  const event = document
    .tracks()
    ?.flat()
    .find((entry) => entry.id === id);
  if (!event) throw new Error("Select a note to edit.");
  if (edit.note !== undefined) {
    const rest = edit.note.trim().toLowerCase() === "rest";
    next = next.replaceEventData(
      id,
      rest
        ? { kind: "rest" }
        : {
            kind: "tone",
            note: edit.note,
            attenuation: "attenuation" in event.data ? event.data.attenuation : 4,
          },
    );
  }
  if (edit.beats !== undefined) {
    if (!Number.isFinite(edit.beats) || edit.beats <= 0)
      throw new Error("Length must be a positive number of beats.");
    next = next.updateEvent(id, { ticks: Math.max(1, Math.round((edit.beats * 3600) / tempo)) });
  }
  if (edit.volume !== undefined)
    next = next.updateEvent(id, { attenuation: volumeToAttenuation(edit.volume) });
  return next;
}

export function moveSoundNote(
  document: SoundDocument,
  id: string,
  direction: -1 | 1,
): SoundDocument {
  const event = document
    .tracks()
    ?.flat()
    .find((entry) => entry.id === id);
  if (!event) throw new Error("Select a note to move.");
  const lane = document.tracks()![event.lane]!;
  const destination = lane.findIndex((entry) => entry.id === id) + direction;
  if (destination < 0 || destination >= lane.length) return document;
  return document.removeEvent(id).insertEvent(event.lane, destination, {
    ticks: event.durationTicks,
    data: event.data,
  });
}

/** Tempo changes bake into every stream's durations in one transaction. */
export function retimeSound(document: SoundDocument, before: number, after: number): SoundDocument {
  checkTempo(before);
  checkTempo(after);
  let next = document;
  for (const event of document.tracks()?.flat() ?? [])
    next = next.updateEvent(event.id, {
      ticks: Math.max(1, Math.round((event.durationTicks * before) / after)),
    });
  return next;
}

/** Native playback and its existing authoring tempo share one session commit. */
export function soundProjectChanges(
  key: string,
  bytes: Uint8Array,
  tempo: number,
  music?: string,
): readonly ProjectChange[] {
  checkTempo(tempo);
  const prior = music === undefined ? {} : readMusicDocument(music);
  const next = { ...prior, [key.split(":")[1]!]: { revision: resourceCacheHint(bytes), tempo } };
  return [
    { key, content: bytes },
    { key: "music", content: JSON.stringify(next) },
  ];
}
