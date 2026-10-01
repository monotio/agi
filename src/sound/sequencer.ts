/** Musical views over native streams. Positions are derived, never persisted. */
import type { SoundDocument, SoundEvent, SoundEventDataInput } from "./document.ts";

// SN76489 noise bit 2 selects white noise; rates 0/1/2 divide by 512/1024/2048,
// and rate 3 follows Voice 3. These names are musical aids over those bits.
export const DRUM_SOUNDS = [
  { name: "Kick", control: 2, midi: 36 },
  { name: "Snare", control: 5, midi: 38 },
  { name: "Hat", control: 4, midi: 42 },
  { name: "Periodic high", control: 0, midi: 75 },
  { name: "Periodic mid", control: 1, midi: 76 },
  { name: "Periodic Voice 3", control: 3, midi: 77 },
  { name: "White low", control: 6, midi: 39 },
  { name: "White Voice 3", control: 7, midi: 40 },
] as const;

export interface TimedSoundEvent {
  readonly event: SoundEvent;
  readonly start: number;
  readonly end: number;
}

export function timedSoundEvents(document: SoundDocument): readonly TimedSoundEvent[] {
  return (document.tracks() ?? []).flatMap((track) => {
    let start = 0;
    return track.map((event) => {
      const result = { event, start, end: start + event.durationTicks };
      start = result.end;
      return result;
    });
  });
}

/** Division is a musical denominator: 16 = sixteenth, four steps per beat. */
export function gridTick(step: number, tempo: number, division: number): number {
  if (
    !Number.isInteger(step) ||
    step < 0 ||
    !Number.isFinite(tempo) ||
    tempo < 40 ||
    tempo > 240 ||
    ![2, 4, 8, 16].includes(division)
  )
    throw new Error("Choose a grid length and a tempo from 40 to 240.");
  return Math.round((step * 14400) / tempo / division);
}

export function beatLengthLabel(ticks: number, tempo: number): string {
  const beats = (ticks * tempo) / 3600;
  const fractions: Readonly<Record<string, string>> = { "0.125": "⅛", "0.25": "¼", "0.5": "½" };
  const musical = Object.keys(fractions).find(
    (length) => Math.abs(ticks - (Number(length) * 3600) / tempo) <= 0.5,
  );
  const label = musical ? fractions[musical]! : String(Number(beats.toFixed(3)));
  return `${label} ${beats <= 1 ? "beat" : "beats"}`;
}

/** Insert a span in one monophonic voice, retaining the untouched event ids/bytes. */
export function setSoundInterval(
  document: SoundDocument,
  lane: number,
  start: number,
  ticks: number,
  data: SoundEventDataInput,
): SoundDocument {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(ticks) || ticks < 1)
    throw new Error("Position and length must be whole ticks; length starts at 1.");
  const track = document.tracks()?.[lane];
  if (!track) throw new Error("Choose an editable voice.");
  const end = start + ticks;
  const timed = timedSoundEvents(document).filter((entry) => entry.event.lane === lane);
  let next = document;
  const extent = timed.at(-1)?.end ?? 0;
  // Remove intersected events, then keep any portions on either side.
  for (const entry of timed) {
    if (entry.end <= start || entry.start >= end) continue;
    next = next.removeEvent(entry.event.id);
  }
  let index = timed.filter((entry) => entry.end <= start).length;
  const left = timed.find((entry) => entry.start < start && entry.end > start);
  if (left) {
    const count = next.tracks()![lane]!.length;
    next = insertSoundSpan(next, lane, index, start - left.start, left.event.data);
    index += next.tracks()![lane]!.length - count;
  }
  if (start > extent) {
    const count = next.tracks()![lane]!.length;
    next = insertSoundSpan(next, lane, index, start - extent, { kind: "rest" });
    index += next.tracks()![lane]!.length - count;
  }
  const before = next.tracks()![lane]!.length;
  next = insertSoundSpan(next, lane, index, ticks, data);
  index += next.tracks()![lane]!.length - before;
  const right = timed.find((entry) => entry.start < end && entry.end > end);
  if (right) next = insertSoundSpan(next, lane, index, right.end - end, right.event.data);
  return next;
}

/** Imports may need long rests/notes; every emitted duration is a valid native word. */
export function insertSoundSpan(
  document: SoundDocument,
  lane: number,
  index: number,
  ticks: number,
  data: SoundEventDataInput,
): SoundDocument {
  let next = document;
  while (ticks > 0) {
    const length = Math.min(65534, ticks);
    next = next.insertEvent(lane, index++, { ticks: length, data });
    ticks -= length;
  }
  return next;
}

/** Removing a grid note leaves time in place for the rest of the song. */
export function silenceSoundEvent(document: SoundDocument, id: string): SoundDocument {
  return document.replaceEventData(id, { kind: "rest" });
}
