import assert from "node:assert/strict";
import { test } from "node:test";
import { appearanceForProfile, loadAppearance } from "../src/render/appearance.ts";

// The Play boot path carries no IIgs font: a first frame waits for loadAppearance.
test("the IIgs look is the PC look until its chunk loads, then answers synchronously", async () => {
  assert.equal(appearanceForProfile("iigs-1.014").layout, "pc");
  const [a, b] = await Promise.all([loadAppearance("iigs-1.014"), loadAppearance("iigs-1.014")]);
  assert.equal(a.layout, "iigs");
  assert.equal(b, a);
  assert.equal(appearanceForProfile("iigs-1.014"), a);
  assert.equal(appearanceForProfile("2.936").layout, "pc");
});
