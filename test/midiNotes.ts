/**
 * A minimal reader of the type 1 files `exportMidi` writes: the note-on
 * numbers per track, each with the pitch wheel position in force at that
 * moment (8192 is centre). Independent of the importer, so a test can check
 * what was written rather than what the importer makes of it.
 */
export function exportedMidiNotes(
  bytes: Uint8Array,
): { track: number; note: number; wheel: number }[] {
  const notes: { track: number; note: number; wheel: number }[] = [];
  let at = 14;
  for (let track = 0; at < bytes.length; track++) {
    const size =
      (bytes[at + 4]! << 24) | (bytes[at + 5]! << 16) | (bytes[at + 6]! << 8) | bytes[at + 7]!;
    const end = at + 8 + size;
    let p = at + 8;
    let wheel = 8192;
    while (p < end) {
      while (bytes[p]! & 128) p++;
      p++;
      const status = bytes[p++]!;
      if (status === 255) {
        const type = bytes[p++]!;
        const length = bytes[p++]!;
        p += length;
        if (type === 47) break;
        continue;
      }
      const a = bytes[p++]!;
      const b = bytes[p++]!;
      if (status >> 4 === 14) wheel = (b << 7) | a;
      else if (status >> 4 === 9 && b > 0) notes.push({ track, note: a, wheel });
    }
    at = end;
  }
  return notes;
}

/** The pitch a note sounds at under a two-semitone bend range, in MIDI semitones. */
export function bentPitch(note: { note: number; wheel: number }): number {
  return note.note + ((note.wheel - 8192) / 8192) * 2;
}

/** The exact MIDI pitch of a PSG divisor at the 3579545/32 Hz tone clock. */
export function divisorPitch(divisor: number): number {
  return 69 + 12 * Math.log2(3579545 / 32 / divisor / 440);
}
