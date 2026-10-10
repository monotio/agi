/** Dependency-free Standard MIDI Files type 0/1 reader and type 1 writer. */
import { createSoundDocument, type SoundDocument, type SoundEventDataInput } from "./document.ts";
import type { ProfileId } from "../runtime/profile.ts";
import { PSG_BASE_FREQ } from "./sound.ts";
import { DRUM_SOUNDS, insertSoundSpan } from "./sequencer.ts";
import { MusicReader, type SoundImport } from "./musicImport.ts";

interface MidiNote {
  start: number;
  end: number;
  note: number;
  /** The channel's pitch bend at note-on, in semitones. */
  bend: number;
  velocity: number;
  id: number;
}

/** Pitch-bend sensitivity (RPN 0) in semitones; the General MIDI default. */
const DEFAULT_BEND_RANGE = 2;
const BEND_CENTER = 8192;

/** The exact MIDI pitch of a PSG tone divisor, fractional semitones from A440. */
function midiPitchOfDivisor(divisor: number): number {
  return 69 + 12 * Math.log2(PSG_BASE_FREQ / divisor / 440);
}

/** The nearest PSG tone divisor for a MIDI pitch, clamped to the 10-bit range. */
function divisorOfMidiPitch(pitch: number): number {
  return Math.max(1, Math.min(1023, Math.round(PSG_BASE_FREQ / (440 * 2 ** ((pitch - 69) / 12)))));
}
interface MidiPart {
  track: number;
  channel: number;
  name: string;
  notes: MidiNote[];
  end: number;
}
interface Tempo {
  tick: number;
  micros: number;
  order: number;
}

function drumControl(note: number): number {
  const named = DRUM_SOUNDS.find((drum) => drum.midi === note);
  if (named) return named.control;
  if (note === 35) return 2;
  if ([37, 40].includes(note)) return 5;
  if ([44, 46, 49, 51, 52, 53, 55, 57, 59].includes(note)) return 4;
  return 6;
}

export function importMidi(bytes: Uint8Array, profileId?: ProfileId): SoundImport {
  const reader = new MusicReader(bytes, "MIDI");
  if (reader.text(4) !== "MThd")
    throw new Error("MIDI header is missing. Choose an SMF .mid file.");
  const headerLength = reader.number(4);
  if (headerLength < 6) throw new Error("MIDI header is too short. Choose a complete MIDI file.");
  const format = reader.number(2),
    trackCount = reader.number(2),
    division = reader.number(2);
  if (format > 1 || !trackCount || (format === 0 && trackCount !== 1))
    throw new Error("MIDI type 0 or 1 is required. Export the music as a type 1 MIDI file.");
  if (
    !division ||
    (division & 0x8000 && (![24, 25, 29, 30].includes(256 - (division >> 8)) || !(division & 255)))
  )
    throw new Error("MIDI timing is invalid. Export with beat timing.");
  reader.take(headerLength - 6);
  const parts: MidiPart[] = [],
    tempos: Tempo[] = [{ tick: 0, micros: 500000, order: -1 }];
  // Pitch bend state per channel: the wheel position (-1..1), its range in
  // semitones and the selected registered parameter (0x3fff = none).
  const tunings = Array.from({ length: 16 }, () => ({
    bend: 0,
    range: DEFAULT_BEND_RANGE,
    rpn: 0x3fff,
  }));
  let count = 0,
    noteId = 0;
  for (let track = 0; track < trackCount; track++) {
    if (reader.text(4) !== "MTrk")
      throw new Error("MIDI track header is missing. Choose a complete MIDI file.");
    const size = reader.number(4),
      start = reader.position;
    reader.take(size);
    const input = new MusicReader(bytes, "MIDI", start, start + size);
    const channels = new Map<number, MidiPart>(),
      active = new Map<number, MidiNote[]>();
    let tick = 0,
      running = 0,
      name = "",
      ended = false;
    while (input.position < input.end) {
      if (++count > 100000) throw new Error("MIDI has too many events. Export a shorter section.");
      tick += input.vlq();
      if (!Number.isSafeInteger(tick))
        throw new Error("MIDI duration is too large. Export a shorter section.");
      let status = input.byte();
      if (status < 128) {
        if (!running) throw new Error("MIDI running status is missing. Export a valid MIDI file.");
        input.position--;
        status = running;
      }
      if (status === 255) {
        running = 0;
        const type = input.byte(),
          data = input.take(input.vlq());
        if (type === 81) {
          if (data.length !== 3)
            throw new Error("MIDI tempo needs three bytes. Export a valid MIDI file.");
          const micros = data[0]! * 65536 + data[1]! * 256 + data[2]!;
          if (!micros) throw new Error("MIDI tempo must be positive. Export a valid MIDI file.");
          tempos.push({ tick, micros, order: count });
        } else if (type === 3) name = String.fromCharCode(...data.subarray(0, 128));
        else if (type === 47) {
          if (data.length) throw new Error("MIDI end marker is invalid. Export a valid MIDI file.");
          ended = true;
          break;
        }
        continue;
      }
      if (status === 240 || status === 247) {
        running = 0;
        input.take(input.vlq());
        continue;
      }
      if (status < 128 || status >= 240)
        throw new Error("MIDI event status is invalid. Export a valid MIDI file.");
      running = status;
      const kind = status >> 4,
        channel = status & 15,
        a = input.byte(),
        b = kind === 12 || kind === 13 ? 0 : input.byte();
      if (a > 127 || b > 127)
        throw new Error("MIDI event data exceeds 7 bits. Export a valid MIDI file.");
      const key = channel * 128 + a;
      const tuning = tunings[channel]!;
      if (kind === 14) {
        tuning.bend = (((b << 7) | a) - BEND_CENTER) / BEND_CENTER;
        continue;
      }
      if (kind === 11) {
        // RPN 0 sets the bend range: data entry coarse in semitones, fine in cents.
        if (a === 101) tuning.rpn = (b << 7) | (tuning.rpn & 127);
        else if (a === 100) tuning.rpn = (tuning.rpn & (127 << 7)) | b;
        else if (a === 6 && tuning.rpn === 0) tuning.range = b + (tuning.range % 1);
        else if (a === 38 && tuning.rpn === 0) tuning.range = Math.floor(tuning.range) + b / 100;
        continue;
      }
      if (kind === 9 && b > 0) {
        let part = channels.get(channel);
        if (!part) {
          part = { track, channel, name, notes: [], end: 0 };
          channels.set(channel, part);
        }
        const note = {
          start: tick,
          end: tick,
          note: a,
          bend: tuning.bend * tuning.range,
          velocity: b,
          id: noteId++,
        };
        part.notes.push(note);
        const held = active.get(key) ?? [];
        held.push(note);
        active.set(key, held);
      } else if (kind === 8 || kind === 9) {
        const held = active.get(key);
        const note = held?.shift();
        if (note) note.end = tick;
      }
    }
    if (!ended) throw new Error("MIDI end-of-track marker is missing. Choose a complete file.");
    for (const held of active.values()) for (const note of held) note.end = tick;
    // Standard track names from our type-1 export retain intentionally empty voices.
    if (format === 1 && division === 60 && trackCount === 5 && /^(Voice [1-3]|Drums)$/.test(name)) {
      const channel = name === "Drums" ? 9 : Number(name.slice(-1)) - 1;
      if (!channels.has(channel))
        channels.set(channel, { track, channel, name, notes: [], end: tick });
    }
    for (const part of channels.values()) {
      part.name = name;
      part.end = tick;
      part.notes = part.notes.filter((n) => n.end > n.start);
      parts.push(part);
    }
  }
  tempos.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const map: { tick: number; seconds: number; micros: number }[] = [];
  let seconds = 0,
    priorTick = 0,
    micros = 500000;
  for (const tempo of tempos) {
    seconds += ((tempo.tick - priorTick) * micros) / 1000000 / (division & 0x7fff);
    map.push({ tick: tempo.tick, seconds, micros: tempo.micros });
    priorTick = tempo.tick;
    micros = tempo.micros;
  }
  function nativeTick(tick: number): number {
    if (division & 0x8000) {
      const fps = 256 - (division >> 8);
      return Math.round((tick * 60) / (fps === 29 ? 30000 / 1001 : fps) / (division & 255));
    }
    let low = 0,
      high = map.length;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (map[middle]!.tick <= tick) low = middle;
      else high = middle;
    }
    const tempo = map[low]!;
    return Math.round(
      (tempo.seconds + ((tick - tempo.tick) * tempo.micros) / 1000000 / division) * 60,
    );
  }
  const melodies = parts.filter((p) => p.channel !== 9 && p.notes.length);
  const exportParts = parts.filter(
    (p) =>
      (p.channel < 3 && p.name === `Voice ${p.channel + 1}`) ||
      (p.channel === 9 && p.name === "Drums"),
  );
  const exported = format === 1 && division === 60 && trackCount === 5 && exportParts.length === 4;
  const selected = exported
    ? exportParts.filter((p) => p.channel !== 9).sort((a, b) => a.channel - b.channel)
    : [...melodies]
        .sort(
          (a, b) => b.notes.length - a.notes.length || a.track - b.track || a.channel - b.channel,
        )
        .slice(0, 3)
        .sort((a, b) => a.track - b.track || a.channel - b.channel);
  const drums = parts.filter((p) => p.channel === 9).flatMap((p) => p.notes);
  const dropped = new Set<number>();
  const rendered = new Set<number>();
  let document = createSoundDocument(profileId ? { profileId } : undefined),
    up = 0,
    down = 0,
    short = 0;
  function render(notes: MidiNote[], lane: number, endTick?: number): void {
    // Sweep boundaries in MIDI time; compare original pitches before octave folding.
    const changes = notes
      .flatMap((note) => [
        { tick: note.start, note, on: true },
        { tick: note.end, note, on: false },
      ])
      .sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on) || a.note.id - b.note.id);
    const active = new Set<number>();
    const pitches: MidiNote[][] = Array.from({ length: 128 }, () => []);
    const segments: { start: number; end: number; note: MidiNote }[] = [];
    let previous = 0,
      index = 0;
    while (index < changes.length) {
      const tick = changes[index]!.tick;
      if (tick > previous && active.size) {
        let highest: MidiNote | undefined;
        for (let pitch = 127; pitch >= 0; pitch--) {
          const held = pitches[pitch]!;
          while (held.length && !active.has(held.at(-1)!.id)) held.pop();
          highest = held.at(-1);
          if (highest) break;
        }
        if (!highest)
          throw new Error("MIDI active notes are inconsistent. Export a valid MIDI file.");
        const last = segments.at(-1);
        if (last?.note === highest && last.end === previous) last.end = tick;
        else segments.push({ start: previous, end: tick, note: highest });
      }
      while (index < changes.length && changes[index]!.tick === tick) {
        const change = changes[index++]!;
        if (change.on) {
          active.add(change.note.id);
          pitches[change.note.note]!.push(change.note);
        } else active.delete(change.note.id);
      }
      previous = tick;
    }
    const heard = new Map<number, number>();
    for (const segment of segments)
      heard.set(segment.note.id, (heard.get(segment.note.id) ?? 0) + segment.end - segment.start);
    for (const note of notes)
      if ((heard.get(note.id) ?? 0) < note.end - note.start) dropped.add(note.id);
    const folded = new Map<number, number>();
    let position = 0;
    for (const segment of segments) {
      const start = nativeTick(segment.start),
        end = nativeTick(segment.end);
      if (end <= start) {
        short++;
        continue;
      }
      rendered.add(segment.note.id);
      const attenuation = 15 - Math.max(1, Math.round((segment.note.velocity * 15) / 127));
      let data: SoundEventDataInput;
      if (lane === 3)
        data = { kind: "noise", control: drumControl(segment.note.note), attenuation };
      else {
        let note = folded.get(segment.note.id);
        if (note === undefined) {
          note = segment.note.note;
          while (PSG_BASE_FREQ / (440 * 2 ** ((note - 69) / 12)) > 1023) note += 12;
          while (PSG_BASE_FREQ / (440 * 2 ** ((note - 69) / 12)) < 1) note -= 12;
          if (note > segment.note.note) up++;
          if (note < segment.note.note) down++;
          folded.set(segment.note.id, note);
        }
        // A bent note sounds between semitones: store the divisor of the
        // pitch it plays at, as the export wrote it.
        data =
          segment.note.bend === 0
            ? { kind: "tone", note, attenuation }
            : { kind: "tone", divisor: divisorOfMidiPitch(note + segment.note.bend), attenuation };
      }
      if (start > position)
        document = insertSoundSpan(
          document,
          lane,
          document.tracks()![lane]!.length,
          start - position,
          { kind: "rest" },
        );
      document = insertSoundSpan(
        document,
        lane,
        document.tracks()![lane]!.length,
        end - start,
        data,
      );
      position = end;
    }
    if (endTick !== undefined && nativeTick(endTick) > position)
      document = insertSoundSpan(
        document,
        lane,
        document.tracks()![lane]!.length,
        nativeTick(endTick) - position,
        { kind: "rest" },
      );
  }
  selected.forEach((part, index) =>
    render(part.notes, exported ? part.channel : index, exported ? part.end : undefined),
  );
  render(drums, 3, exported ? exportParts.find((p) => p.channel === 9)!.end : undefined);
  if (!exported && !document.tracks()!.flat().length)
    throw new Error(
      "MIDI has no playable notes. Choose a file with notes at least one game tick long.",
    );
  const summary = [
    `${selected.length} melody ${selected.length === 1 ? "part" : "parts"} · Drums mapped to noise · Timing rounded to 60 Hz · Pitches rounded to chip divisors`,
  ];
  const shortened = [...dropped].filter((id) => rendered.has(id)).length;
  const omitted = dropped.size - shortened;
  if (omitted) summary.push(`${omitted} chord ${omitted === 1 ? "note" : "notes"} dropped`);
  if (shortened) summary.push(`${shortened} chord ${shortened === 1 ? "note" : "notes"} shortened`);
  if (up) summary.push(`${up} ${up === 1 ? "note" : "notes"} moved up by octaves`);
  if (down) summary.push(`${down} ${down === 1 ? "note" : "notes"} moved down by octaves`);
  if (melodies.length > selected.length)
    summary.push(
      `${melodies.length - selected.length} melody ${melodies.length - selected.length === 1 ? "part" : "parts"} omitted`,
    );
  if (short) summary.push(`${short} short ${short === 1 ? "note" : "notes"} dropped`);
  return {
    document,
    tempo: Math.max(
      40,
      Math.min(240, Math.round(60000000 / map.filter((t) => t.tick === 0).at(-1)!.micros)),
    ),
    summary: summary.join(" · "),
  };
}

function variable(value: number): number[] {
  const bytes = [value & 127];
  while ((value = Math.floor(value / 128))) bytes.unshift((value & 127) | 128);
  return bytes;
}
function chunk(name: string, data: number[]): number[] {
  return [...name]
    .map((c) => c.charCodeAt(0))
    .concat(
      [
        Math.floor(data.length / 16777216) & 255,
        (data.length >> 16) & 255,
        (data.length >> 8) & 255,
        data.length & 255,
      ],
      data,
    );
}

export interface MidiExport {
  readonly bytes: Uint8Array;
  /**
   * How far the sound's notes sit from A440, in cents (positive is sharp).
   * Note numbers are chosen against this tuning so the written notes keep
   * the tune's intervals; pitch bends then play each note at its exact
   * divisor frequency.
   */
  readonly tuningCents: number;
  /** Plain sentences about content the file cannot express; empty when exact. */
  readonly warnings: readonly string[];
}

/**
 * The tuning a set of tone pitches shares: the circular mean of each pitch's
 * distance from its nearest A440 semitone, weighted by duration, in
 * semitones (-0.5..0.5). Chip divisors land a tune anywhere between
 * semitones; rounding each note on its own then scatters neighbours a
 * semitone apart, which this common offset prevents.
 */
function tuningOffset(pitches: readonly { pitch: number; weight: number }[]): number {
  let x = 0;
  let y = 0;
  for (const { pitch, weight } of pitches) {
    const angle = 2 * Math.PI * (pitch - Math.round(pitch));
    x += Math.cos(angle) * weight;
    y += Math.sin(angle) * weight;
  }
  if (x === 0 && y === 0) return 0;
  return Math.atan2(y, x) / (2 * Math.PI);
}

/**
 * 60 PPQ at 60 BPM makes one MIDI tick exactly one native SOUND tick. Tone
 * voices carry a ±2 semitone bend range (RPN 0) and a pitch bend before each
 * note, so playback matches the divisor frequency, not the nearest semitone.
 */
export function exportMidi(document: SoundDocument): MidiExport {
  const tracks = document.tracks();
  if (!tracks)
    throw new Error(
      "This sound is stored in a format without voice tracks, so there are no notes to write as MIDI.",
    );
  const pitches: { pitch: number; weight: number }[] = [];
  for (let lane = 0; lane < 3; lane++)
    for (const event of tracks[lane]!)
      if (event.data.kind === "tone" && event.data.attenuation !== 15)
        pitches.push({
          pitch: midiPitchOfDivisor(event.data.divisor),
          weight: event.durationTicks,
        });
  const tuning = tuningOffset(pitches);
  let raw = 0;
  const chunks = [chunk("MTrk", [0, 255, 81, 3, 15, 66, 64, 0, 255, 47, 0])];
  for (let lane = 0; lane < 4; lane++) {
    const channel = lane === 3 ? 9 : lane;
    const name = lane === 3 ? "Drums" : `Voice ${lane + 1}`,
      data = [0, 255, 3, name.length, ...[...name].map((c) => c.charCodeAt(0))];
    if (lane < 3)
      data.push(
        ...[101, 0, 100, 0, 6, DEFAULT_BEND_RANGE, 38, 0].flatMap((byte, index) =>
          index % 2 === 0 ? [0, 176 | channel, byte] : [byte],
        ),
      );
    let pending = 0;
    let bend = BEND_CENTER;
    for (const event of tracks[lane]!) {
      if (event.data.kind === "raw") raw++;
      if (
        event.data.kind === "raw" ||
        event.data.kind === "rest" ||
        event.data.attenuation === 15
      ) {
        pending += event.durationTicks;
        continue;
      }
      const voiceData = event.data;
      let note: number;
      if (voiceData.kind === "noise") {
        note = DRUM_SOUNDS.find((d) => d.control === voiceData.control)!.midi;
      } else {
        const pitch = midiPitchOfDivisor(voiceData.divisor);
        note = Math.max(0, Math.min(127, Math.round(pitch - tuning)));
        const wheel = Math.max(
          0,
          Math.min(
            16383,
            Math.round(BEND_CENTER + ((pitch - note) / DEFAULT_BEND_RANGE) * BEND_CENTER),
          ),
        );
        if (wheel !== bend) {
          data.push(...variable(pending), 224 | channel, wheel & 127, wheel >> 7);
          pending = 0;
          bend = wheel;
        }
      }
      const velocity = Math.round(((15 - voiceData.attenuation) * 127) / 15);
      data.push(
        ...variable(pending),
        144 | channel,
        note,
        velocity,
        ...variable(event.durationTicks),
        128 | channel,
        note,
        0,
      );
      pending = 0;
    }
    data.push(...variable(pending), 255, 47, 0);
    chunks.push(chunk("MTrk", data));
  }
  const warnings: string[] = [];
  if (raw > 0)
    warnings.push(
      `${raw} ${raw === 1 ? "event holds" : "events hold"} raw bytes instead of a note, so ${raw === 1 ? "it is" : "they are"} silent in the MIDI file.`,
    );
  return {
    bytes: Uint8Array.from([...chunk("MThd", [0, 1, 0, 5, 0, 60]), ...chunks.flat()]),
    tuningCents: Math.round(tuning * 100),
    warnings,
  };
}
