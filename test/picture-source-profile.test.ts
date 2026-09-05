import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzePictureStructure,
  annotatePictureSource,
  compilePictureSource,
  disassemblePicture,
  readPictureSource,
} from "../src/picture/source.ts";
import { PROFILES } from "../src/runtime/profile.ts";

// In 2.411 f9 ignores its raw operand; fa plots plain pairs even when that
// operand has the later stipple bit. Two dots, no stipple seeds, no brush.
const POINTS = new Uint8Array([0xf0, 3, 0xf9, 0x27, 0xfa, 11, 12, 20, 21, 0xff]);

describe("profile-aware picture source", () => {
  for (const id of ["2.089", "2.230", "2.272"] as const) {
    it(`${id} preserves ignored bytes without hiding the next command`, () => {
      const opts = { profile: PROFILES[id] };
      const bytes = new Uint8Array([0xf9, 0xf0, 3, 0xfa, 4, 5, 0xf6, 7, 8, 0xff]);
      const source = disassemblePicture(bytes, opts);
      assert.match(source, /raw 249\nvis 3\nraw 250/);
      assert.doesNotMatch(source, /pen|plot/);
      assert.deepEqual(compilePictureSource(source, opts).bytes, bytes);
      assert.throws(() => compilePictureSource("pen 0\nplot 1,2", opts), /not available/);
      assert.throws(() => compilePictureSource("plot 1,2", opts), /not available/);
    });
  }

  it("describes 2.411's ignored mode byte and plots every pair", () => {
    const opts = { profile: PROFILES["2.411"] };
    const source = disassemblePicture(POINTS, opts);
    assert.match(source, /pen raw 39/);
    assert.match(source, /plot 11,12 20,21/);
    assert.deepEqual(compilePictureSource(source, opts).bytes, POINTS);
    assert.deepEqual(readPictureSource({ getResource: () => POINTS }, 1, opts), source);
  });

  it("rejects brush/radius syntax that has no 2.411 effect", () => {
    const opts = { profile: PROFILES["2.411"] };
    assert.throws(() => compilePictureSource("pen 7 stipple\nplot 5 1,2", opts), /point plots/);
    assert.deepEqual(
      compilePictureSource("pen raw 39\nplot 11,12 20,21", opts).bytes,
      new Uint8Array([0xf9, 39, 0xfa, 11, 12, 20, 21, 0xff]),
    );
  });

  it("counts 2.411 pairs and early ignored commands according to the profile", () => {
    assert.equal(analyzePictureStructure(POINTS, { profile: PROFILES["2.411"] }).plots, 2);
    const bytes = new Uint8Array([0xf9, 0xf0, 3, 0xfa, 4, 5, 0xf6, 7, 8, 0xff]);
    const result = analyzePictureStructure(bytes, { profile: PROFILES["2.230"] });
    assert.deepEqual(result.visualColours, [3]);
    assert.equal(result.plots, 0);
  });

  it("annotates actual 2.411 point bounds and preserves the entire source stream", () => {
    const opts = { profile: PROFILES["2.411"] };
    const source = annotatePictureSource(POINTS, opts);
    assert.match(source, /bbox x11-20 y12-21/);
    assert.deepEqual(compilePictureSource(source, opts).bytes, POINTS);
  });

  it("annotates the v3 radius-one center row instead of a v2 block", () => {
    const opts = { profile: PROFILES["3.002.149"] };
    const bytes = new Uint8Array([0xf0, 3, 0xf9, 1, 0xfa, 10, 20, 0xff]);
    const source = annotatePictureSource(bytes, opts);
    assert.match(source, /bbox x9-10 y20-20/);
    assert.deepEqual(compilePictureSource(source, opts).bytes, bytes);
  });
});
