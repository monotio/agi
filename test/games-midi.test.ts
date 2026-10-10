import assert from "node:assert/strict";
import { test } from "node:test";
import { importSoundDocument } from "../src/sound/document.ts";
import { exportMidi, importMidi } from "../src/sound/midi.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";
import { bentPitch, divisorPitch, exportedMidiNotes } from "./midiNotes.ts";

/**
 * King's Quest I's theme (SOUND 0) is tuned about 48 cents sharp of A440,
 * with every note within 15 cents of a half-semitone boundary. Rounding each
 * divisor to its nearest A440 semitone sends 53 of its 233 notes a semitone
 * away from their neighbours (220 to C5 where the tune means B4, 185 to D#5
 * for D5, 123 to A#5 for A5, 110 to C6 for B5, 92 to D#6 for D6). The export
 * must sound like the game: one shared tuning for the note names, a pitch
 * bend per note for the exact divisor frequency.
 */
test(
  "kq1: the theme exports in tune, every note in place and every divisor restored",
  { skip: fixtureSkip(KNOWN_GAME_HASH.KQ1) },
  () => {
    const { container } = loadGame(KNOWN_GAME_HASH.KQ1);
    const document = importSoundDocument(container.getResource("sound", 0)!, {
      profileId: "2.917",
    });
    const tracks = document.tracks()!;
    const exported = exportMidi(document);
    assert.equal(exported.tuningCents, 48);
    const written = exportedMidiNotes(exported.bytes);
    const expectedNames: Record<number, number> = { 220: 71, 185: 74, 123: 81, 110: 83, 92: 86 };
    let tones = 0;
    let named = 0;
    for (let lane = 0; lane < 3; lane++) {
      const divisors = tracks[lane]!.filter(
        (event) => event.data.kind === "tone" && event.data.attenuation !== 15,
      ).map((event) => (event.data as { divisor: number }).divisor);
      const notes = written.filter((note) => note.track === lane + 1);
      assert.equal(notes.length, divisors.length, `voice ${lane + 1} writes every tone`);
      divisors.forEach((divisor, index) => {
        tones++;
        const note = notes[index]!;
        const pitch = divisorPitch(divisor);
        // The sounding pitch is the divisor's, within a cent.
        assert.ok(Math.abs(100 * (bentPitch(note) - pitch)) < 1, `voice ${lane + 1} note ${index}`);
        // Neighbours keep their interval: no note a semitone off its place.
        if (index > 0) {
          const previous = divisorPitch(divisors[index - 1]!);
          assert.equal(note.note - notes[index - 1]!.note, Math.round(pitch - previous));
        }
        if (expectedNames[divisor] !== undefined) {
          named++;
          assert.equal(note.note, expectedNames[divisor], `divisor ${divisor}`);
        }
      });
    }
    assert.equal(tones, 233);
    assert.ok(named > 0);
    // The file round-trips to the same chip divisors.
    const back = importMidi(exported.bytes).document.tracks()!;
    for (let lane = 0; lane < 3; lane++)
      assert.deepEqual(
        back[lane]!.filter((e) => e.data.kind === "tone").map(
          (e) => (e.data as { divisor: number }).divisor,
        ),
        tracks[lane]!.filter((e) => e.data.kind === "tone" && e.data.attenuation !== 15).map(
          (e) => (e.data as { divisor: number }).divisor,
        ),
      );
  },
);
