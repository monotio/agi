import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSoundDocument, importSoundDocument } from "../src/sound/document.ts";
import { applySoundPreset, SOUND_PRESETS } from "../src/sound/presets.ts";

const IDS = ["discovery", "danger", "door-step", "success", "death"] as const;

describe("sound cue presets", () => {
  it("ships the five agreed original cues", () => {
    assert.deepEqual(SOUND_PRESETS.map((preset) => preset.id).sort(), [...IDS].sort());
    for (const preset of SOUND_PRESETS) {
      assert.equal(preset.tracks.length, 4, preset.id);
      assert.ok(preset.name.length > 0, preset.id);
    }
  });

  it("applies each preset to a blank document as editable native events", () => {
    for (const preset of SOUND_PRESETS) {
      const doc = applySoundPreset(createSoundDocument(), preset.id);
      assert.equal(doc.representation, "four-stream", preset.id);
      assert.ok(doc.extentTicks()! > 0, preset.id);
      // Every preset event is canonical and remains editable.
      const tracks = doc.tracks()!;
      let sawToneOrNoise = false;
      for (const lane of tracks) {
        for (const event of lane) {
          assert.notEqual(event.data.kind, "raw", `${preset.id} encodes canonical events`);
          if (event.data.kind === "tone" || event.data.kind === "noise") {
            sawToneOrNoise = true;
            const edited = doc.updateEvent(event.id, { attenuation: 9 });
            assert.equal(edited.representation, "four-stream");
          }
        }
      }
      assert.ok(sawToneOrNoise, `${preset.id} plays at least one note`);
      // The encoded payload imports losslessly as the same editable document.
      const reopened = importSoundDocument(doc.encode(), { profileId: "2.936" });
      assert.equal(reopened.representation, "four-stream");
      assert.deepEqual([...reopened.encode()], [...doc.encode()]);
      assert.equal(reopened.tracks()!.flat().length, tracks.flat().length);
    }
  });

  it("encodes the discovery cue to hand-computed bytes", () => {
    // E5 divisor 151 -> 09 87; G5 divisor 127 -> 07 8f; C6 divisor 95 -> 05 8f.
    // All attenuation 4 on lane 0 -> control 0x94.
    const doc = applySoundPreset(createSoundDocument(), "discovery");
    assert.deepEqual(
      [...doc.encode()],
      [
        8, 0, 25, 0, 27, 0, 29, 0,
        // lane 0: E5 10t, G5 10t, C6 20t, terminator
        10, 0, 0x09, 0x87, 0x94, 10, 0, 0x07, 0x8f, 0x94, 20, 0, 0x05, 0x8f, 0x94, 0xff, 0xff,
        // lanes 1-3: terminators
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      ],
    );
    assert.equal(doc.extentTicks(), 40);
  });

  it("uses the noise lane for the door-step cue", () => {
    const doc = applySoundPreset(createSoundDocument(), "door-step");
    const noise = doc.tracks()![3]!;
    assert.ok(noise.some((event) => event.data.kind === "noise"));
  });

  it("rejects preset application on an opaque document", () => {
    const opaque = importSoundDocument(new Uint8Array(5), { profileId: "2.936" });
    assert.throws(() => applySoundPreset(opaque, "discovery"), /opaque/i);
  });

  it("rejects an unknown preset id", () => {
    assert.throws(() => applySoundPreset(createSoundDocument(), "fanfare"), /preset/i);
  });
});
