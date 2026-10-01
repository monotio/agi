import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attenuationToVolume,
  volumeToAttenuation,
  describeEvent,
} from "../src/studio/sound/soundEdits.ts";

test("volume reverses AGI attenuation and preserves all sixteen encoded levels", () => {
  assert.equal(attenuationToVolume(0), 15);
  assert.equal(attenuationToVolume(15), 0);
  for (let value = 0; value < 16; value++)
    assert.equal(volumeToAttenuation(attenuationToVolume(value)), value);
  assert.throws(() => volumeToAttenuation(16), /0.*15/);
  assert.throws(() => volumeToAttenuation(1.5), /integer/);
});

test("sound labels show musical pitch and volume", () => {
  const event = {
    id: "n",
    lane: 0 as const,
    durationTicks: 60,
    durationWord: 60,
    data: { kind: "tone" as const, divisor: 226, attenuation: 3 },
  };
  const label = describeEvent(event);
  assert.match(label, /A4/);
  assert.match(label, /volume 12/);
  assert.doesNotMatch(label, /226|att/);
});
