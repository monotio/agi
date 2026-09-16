/**
 * Authentic AGI sound payload construction: the note-input shape the agent
 * writes, MIDI/divisor conversion, and the four-channel (three tone voices +
 * noise voice) binary layout with per-channel 0xffff terminators. Pure data
 * in, bytes out — no session state, so template and tool code share it without
 * an import cycle.
 */

export interface SoundNoteInput {
  note?: number | string | null | undefined;
  duration: number;
  freqDivisor?: number | null | undefined;
  attenuation?: number | null | undefined;
}

export interface SoundTrackInput {
  notes: SoundNoteInput[];
}

const NOTE_SEMITONES: Record<string, number> = {
  c: 0,
  "c#": 1,
  db: 1,
  d: 2,
  "d#": 3,
  eb: 3,
  e: 4,
  f: 5,
  "f#": 6,
  gb: 6,
  g: 7,
  "g#": 8,
  ab: 8,
  a: 9,
  "a#": 10,
  bb: 10,
  b: 11,
};

/**
 * Parses a note representation (MIDI number 1..127 or string e.g. "C4", "A4", "F#5") into a MIDI note number.
 * Returns null for rests, silence, or invalid notes.
 */
export function parseNoteToMidi(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    return input > 0 && input <= 127 ? Math.round(input) : null;
  }
  const str = input.trim().toLowerCase();
  if (str === "" || str === "rest" || str === "r" || str === "silence" || str === "none") {
    return null;
  }
  const match = /^([a-g][#b]?)(-?\d+)$/.exec(str);
  if (!match) {
    const num = parseInt(str, 10);
    return !isNaN(num) && num > 0 && num <= 127 ? num : null;
  }
  const name = match[1]!;
  const octave = parseInt(match[2]!, 10);
  const semi = NOTE_SEMITONES[name];
  if (semi === undefined) return null;
  const midi = (octave + 1) * 12 + semi;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/**
 * Converts a MIDI note number (60 = C4, 69 = A440) to an authentic AGI 10-bit tone frequency divisor.
 */
export function midiToAgiDivisor(midi: number | null): number {
  if (midi === null || midi <= 0 || midi > 127) return 0;
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  return Math.max(1, Math.min(1023, Math.round(99431.67 / freq)));
}

/**
 * Builds authentic AGI sound binary payload (4 channels: 3 tone voices + 1 noise voice).
 * Supports MIDI note numbers (e.g. 60 for C4, 69 for A440) or note names ('C4', 'G4', 'rest'),
 * as well as raw frequency divisors. Each channel terminates with 0xffff.
 */
export function buildSound(tracks: readonly SoundTrackInput[]): Uint8Array {
  const channelData: number[][] = [];
  for (let ch = 0; ch < 4; ch++) {
    const track = tracks[ch];
    const bytes: number[] = [];
    if (track && Array.isArray(track.notes)) {
      for (const note of track.notes) {
        const dur = Math.max(1, Math.min(65534, note.duration || 1));
        bytes.push(dur & 0xff, (dur >> 8) & 0xff);

        let div = 0;
        let isRest = false;

        if (typeof note.freqDivisor === "number" && note.freqDivisor > 0) {
          div = Math.max(0, Math.min(1023, note.freqDivisor));
        } else if (note.note !== undefined && note.note !== null) {
          const midi = parseNoteToMidi(note.note);
          if (midi !== null) {
            div = midiToAgiDivisor(midi);
          } else {
            isRest = true;
          }
        } else if (typeof note.freqDivisor === "number") {
          div = Math.max(0, Math.min(1023, note.freqDivisor));
        } else {
          isRest = true;
        }

        // Store the device command word, including its latch and channel bits.
        // Noise uses the raw control nibble; repeat it in the unused second
        // byte so early profiles that emit both bytes preserve the selection.
        const byte0 = ch === 3 ? div & 0x0f : (div >> 4) & 0x3f;
        const byte1 = 0x80 | (ch << 5) | (div & 0x0f);
        bytes.push(byte0, byte1);

        let att = 0;
        if (isRest || (ch < 3 && div === 0)) {
          att = 15; // 0x0f = silence in AGI
        } else if (typeof note.attenuation === "number") {
          att = Math.max(0, Math.min(15, note.attenuation));
        }
        bytes.push((0x90 + ch * 0x20) | att);
      }
    }
    // Channel terminator (0xffff)
    bytes.push(0xff, 0xff);
    channelData.push(bytes);
  }

  let offset = 8;
  const offsets: number[] = [];
  for (let ch = 0; ch < 4; ch++) {
    offsets.push(offset);
    offset += channelData[ch]!.length;
  }

  const result = new Uint8Array(offset);
  for (let ch = 0; ch < 4; ch++) {
    const off = offsets[ch]!;
    result[ch * 2] = off & 0xff;
    result[ch * 2 + 1] = (off >> 8) & 0xff;
    result.set(channelData[ch]!, off);
  }
  return result;
}
