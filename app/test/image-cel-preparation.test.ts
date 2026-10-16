import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareImageCels, type ImageFrame } from "../../src/creative/imageOperations.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";

test("moving a crop reuses the image hash and prepares the exact settled cel", (t) => {
  const rgba = Uint8Array.from([170, 0, 0, 255, 0, 170, 0, 255, 0, 0, 170, 255]);
  const image = {
    title: "Strip",
    mime: "image/png",
    width: 3,
    height: 1,
    rgba,
    encoded: encodePngRgba(3, 1, rgba),
  };
  const set = Uint8Array.prototype.set;
  let hashes = 0;
  t.mock.method(
    Uint8Array.prototype,
    "set",
    function (this: Uint8Array, source: ArrayLike<number>, offset?: number) {
      if (source === rgba && this.length > rgba.length) hashes++;
      return set.call(this, source, offset);
    },
  );
  const frame = (x: number): ImageFrame => ({
    region: { x, y: 0, width: 1, height: 1 },
    width: 1,
    height: 1,
    loop: 0,
  });
  const sourceId = sha256Hex(image.rgba);
  prepareImageCels(image, [frame(0)], PROFILES["2.936"], null, true, { sourceId });
  const settled = prepareImageCels(image, [frame(1)], PROFILES["2.936"], null, true, { sourceId });
  assert.equal(hashes, 1);
  assert.deepEqual([...settled.input.loops[0]!.cels![0]!.pixels], [2]);
  const fresh = prepareImageCels(
    { ...image, rgba: rgba.slice() },
    [frame(1)],
    PROFILES["2.936"],
    null,
  );
  assert.deepEqual(settled, fresh);
});
