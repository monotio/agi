import assert from "node:assert/strict";
import { test } from "node:test";
import { openContainer, compactContainer } from "../src/container/container.ts";
import { detectProfile } from "../src/runtime/profile.ts";

/** Synthetic combined PIC directory; offsets and seven-byte record are hand specified. */
function files(
  first: number,
  tail: readonly [number, number],
  native: boolean,
  withVolume: boolean,
) {
  const image = new Map<string, Uint8Array>([
    ["XDIR", Uint8Array.of(8, 0, 8, 0, 11, 0, 11, 0, first, ...tail)],
    ["XVOL.0", new Uint8Array()],
  ]);
  // Minimal detection fixture, not an original executable. Deliberately use
  // XDIR in both cases: resource layout cannot decide the absence rule.
  if (native) image.set("MH2", Uint8Array.of(0, 0, 3, 0xf3));
  if (withVolume) image.set("XVOL.15", Uint8Array.of(0x12, 0x34, 15, 1, 0, 1, 0, 0xff));
  return image;
}

for (const [first, tail, withVolume] of [
  [0xff, [0xff, 0xfc], false],
  [0xf0, [0, 0], true],
] as const) {
  test(`Amiga directory absence precedes resource loading for ${first.toString(16)}`, () => {
    const image = files(first, tail, true, withVolume);
    assert.equal(detectProfile(image).id, "amiga-2.333");
    const container = openContainer(image);
    assert.equal(container.getResource("picture", 0), null);
    const packed = openContainer(compactContainer(container.files));
    assert.equal(packed.getResource("picture", 0), null);
  });
}

test("DOS combined directory still loads a real volume-15 resource", () => {
  const image = files(0xf0, [0, 0], false, true);
  assert.equal(detectProfile(image).id, "3.002.149");
  assert.deepEqual(openContainer(image).getResource("picture", 0), Uint8Array.of(0xff));
});

test("Amiga directory validation still rejects a missing real volume 14", () => {
  const image = files(0xe0, [0, 0], true, false);
  assert.throws(() => openContainer(image).getResource("picture", 0), /missing VOL.14/);
});
