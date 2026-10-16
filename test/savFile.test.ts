import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeOriginalSav, encodeOriginalSav } from "../src/runtime/savFile.ts";
import { PROFILES, EQUIVALENT_BUILDS, type ProfileId } from "../src/runtime/profile.ts";

interface Capture {
  build: string;
  hex: string;
  stateBytes: number;
}
const captures = JSON.parse(
  readFileSync(new URL("./savFile-captures.json", import.meta.url), "utf8"),
) as Capture[];

describe("original save writer captures", () => {
  for (const capture of captures) {
    test(`${capture.build} imports controlled state and exports every original byte`, () => {
      const profile =
        PROFILES[
          (EQUIVALENT_BUILDS[capture.build] ??
            (capture.build === "2.903" ? "2.917" : capture.build)) as ProfileId
        ];
      const bytes = Uint8Array.from(Buffer.from(capture.hex, "hex"));
      const state = decodeOriginalSav(bytes, profile);
      assert.equal(state.description, "Original probe");
      assert.equal(state.replayCapacity, 3);
      assert.equal(state.replayActive, 2);
      assert.deepEqual(state.replay, [
        { kind: 0, value: 21 },
        { kind: 3, value: 2 },
        { kind: 0, value: 0 },
      ]);
      assert.deepEqual(
        state.inventory,
        Uint8Array.from({ length: 30 }, (_, i) => i),
      );
      assert.equal(state.objects.length, 2);
      assert.equal(state.objects[0]!.motionMode, 1);
      assert.equal(state.objects[0]!.cycleMode, 2);
      // Native 0x70 is animated, cycling and updating, observes all three gates.
      assert.equal(state.objects[0]!.state, 0x76);
      assert.deepEqual(encodeOriginalSav(state, profile), bytes);
    });
  }
});
