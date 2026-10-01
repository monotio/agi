import assert from "node:assert/strict";
import { test } from "node:test";
import { createSoundDocument } from "../../src/sound/document.ts";
import { applySoundPreset, SOUND_PRESETS } from "../../src/sound/presets.ts";
import {
  attenuationToVolume,
  volumeToAttenuation,
  divisorNoteLabel,
  editSoundNote,
  moveSoundNote,
  retimeSound,
  soundProjectChanges,
} from "../src/studio/sound/soundEdits.ts";

test("volume reverses every encoded attenuation level and rejects invalid values", () => {
  assert.equal(attenuationToVolume(0), 15);
  assert.equal(attenuationToVolume(15), 0);
  for (let value = 0; value < 16; value++)
    assert.equal(volumeToAttenuation(attenuationToVolume(value)), value);
  assert.throws(() => volumeToAttenuation(16), /0.*15/);
  assert.throws(() => volumeToAttenuation(1.5), /integer/);
  assert.throws(() => attenuationToVolume(-1), /0.*15/);
  assert.equal(divisorNoteLabel(226), "A4");
});

test("friendly note, length and volume edits produce exact native bytes", () => {
  let doc = createSoundDocument().insertEvent(0, 0);
  doc = editSoundNote(doc, "e1", { note: "A4", beats: 1, volume: 12 }, 120);
  assert.deepEqual(
    [...doc.encode()],
    [8, 0, 15, 0, 17, 0, 19, 0, 30, 0, 14, 130, 147, 255, 255, 255, 255, 255, 255, 255, 255],
  );
  const rest = editSoundNote(doc, "e1", { note: "Rest" }, 120);
  assert.deepEqual([...rest.encode().slice(8, 13)], [30, 0, 0, 128, 159]);
  assert.throws(() => editSoundNote(doc, "e1", { note: "banana" }, 120));
});

test("preset insertion supplies the same native cue for every entry point", () => {
  assert.deepEqual(
    SOUND_PRESETS.map((preset) => preset.id),
    ["discovery", "danger", "door-step", "success", "death"],
  );
  const doc = applySoundPreset(createSoundDocument(), "discovery");
  assert.deepEqual(
    [...doc.encode()],
    [
      8, 0, 25, 0, 27, 0, 29, 0, 10, 0, 9, 135, 148, 10, 0, 7, 143, 148, 20, 0, 5, 143, 148, 255,
      255, 255, 255, 255, 255, 255, 255,
    ],
  );
});

test("moving notes and changing tempo preserve pitches and encode reordered durations", () => {
  let doc = createSoundDocument()
    .insertEvent(0, 0, { ticks: 30, data: { kind: "tone", note: "A4", attenuation: 3 } })
    .insertEvent(0, 1, { ticks: 60, data: { kind: "tone", note: "C5", attenuation: 6 } });
  doc = moveSoundNote(doc, "e2", -1);
  doc = retimeSound(doc, 120, 240);
  assert.deepEqual([...doc.encode().slice(8, 18)], [30, 0, 11, 142, 150, 15, 0, 14, 130, 147]);
  assert.throws(() => retimeSound(doc, 120, 0));
});

test("sound edits prepare native bytes and tempo metadata together, preserving other cues", () => {
  const bytes = createSoundDocument().insertEvent(0, 0, { ticks: 15 }).encode();
  const prior = JSON.stringify({ "255": { revision: "16-00000000", tempo: 90 } });
  const changes = soundProjectChanges("sound:2", bytes, 240, prior);
  assert.deepEqual(
    changes.map((change) => change.key),
    ["sound:2", "music"],
  );
  assert.deepEqual(changes[0]!.content, bytes);
  const music = JSON.parse(changes[1]!.content as string);
  assert.equal(music["2"].tempo, 240);
  assert.equal(typeof music["2"].revision, "string");
  assert.deepEqual(music["255"], { revision: "16-00000000", tempo: 90 });
  assert.deepEqual(JSON.parse(prior), { "255": { revision: "16-00000000", tempo: 90 } });
  assert.throws(() => soundProjectChanges("sound:2", bytes, 0, prior));
});
