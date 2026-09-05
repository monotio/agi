import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROFILES } from "../src/runtime/profile.ts";
import * as views from "../src/view/view.ts";

// Three loop entries share one loop structure and two 3x1 cels. The encoded
// rows are [1,2,0] and [3,4,0]; every offset and pixel is hand-computed.
function sharedLoops(header: number, control = 0): Uint8Array {
  return new Uint8Array([
    0,
    0,
    3,
    0,
    0,
    11,
    0,
    11,
    0,
    11,
    0,
    header,
    5,
    0,
    11,
    0,
    3,
    1,
    control,
    0x11,
    0x21,
    0,
    3,
    1,
    control,
    0x31,
    0x41,
    0,
  ]);
}

describe("profile-aware loaded view orientation", () => {
  it("uses only the packed low nibble for 2.230 cel counts", () => {
    const view = views.parseView(sharedLoops(0xc2), PROFILES["2.230"]);
    assert.deepEqual(
      view.loops.map((loop) => loop.cels.length),
      [2, 2, 2],
    );
    assert.deepEqual([...views.selectViewCel(view, 0, 0)!.pixels], [1, 2, 0]);
  });

  it("mirrors current shared pixels on per-cel selection, including a third alias", () => {
    const view = views.parseView(sharedLoops(2, 0x80));
    assert.deepEqual([...views.selectViewCel(view, 0, 0)!.pixels], [1, 2, 0]);
    assert.deepEqual([...views.selectViewCel(view, 1, 0)!.pixels], [0, 2, 1]);
    assert.deepEqual([...views.selectViewCel(view, 2, 0)!.pixels], [1, 2, 0]);
    assert.deepEqual([...views.selectViewCel(view, 2, 0)!.pixels], [1, 2, 0]);
    assert.deepEqual([...views.selectViewCel(view, 0, 0)!.pixels], [0, 2, 1]);
    // Per-cel encoding leaves the other cel unchanged.
    assert.deepEqual([...views.readViewCel(view, 1, 1)!.pixels], [3, 4, 0]);
  });

  it("mirrors every shared cel when a 2.230 loop changes orientation", () => {
    const view = views.parseView(sharedLoops(0xc2), PROFILES["2.230"]);
    assert.deepEqual([...views.selectViewCel(view, 1, 0)!.pixels], [0, 2, 1]);
    assert.deepEqual([...views.readViewCel(view, 0, 1)!.pixels], [0, 4, 3]);
    assert.deepEqual([...views.selectViewCel(view, 2, 1)!.pixels], [3, 4, 0]);
    assert.deepEqual([...views.readViewCel(view, 0, 0)!.pixels], [1, 2, 0]);
  });

  it("honors packed stored orientation and ignores per-cel orientation markers", () => {
    const view = views.parseView(sharedLoops(0xd2, 0xf0), PROFILES["2.230"]);
    assert.deepEqual([...views.selectViewCel(view, 1, 0)!.pixels], [1, 2, 0]);
    assert.deepEqual([...views.selectViewCel(view, 0, 0)!.pixels], [0, 2, 1]);
  });

  it("changes packed orientation without mirroring when bit 0x40 is clear", () => {
    const view = views.parseView(sharedLoops(0x82), PROFILES["2.230"]);
    assert.deepEqual([...views.selectViewCel(view, 2, 0)!.pixels], [1, 2, 0]);
    assert.deepEqual([...views.selectViewCel(view, 0, 1)!.pixels], [3, 4, 0]);
  });

  it("does not activate packed mirroring when bit 0x80 is clear", () => {
    const view = views.parseView(sharedLoops(0x42), PROFILES["2.230"]);
    assert.deepEqual([...views.selectViewCel(view, 2, 0)!.pixels], [1, 2, 0]);
  });

  it("keeps preview and loaded state independent, and does not mutate cartridge bytes", () => {
    const payload = sharedLoops(2, 0x80);
    const original = payload.slice();
    const view = views.parseView(payload);
    const secondLoad = views.parseView(payload);
    views.selectViewCel(view, 1, 0);
    assert.deepEqual([...views.readViewCel(view, 0, 0)!.pixels], [0, 2, 1]);
    assert.deepEqual([...views.readViewCel(secondLoad, 0, 0)!.pixels], [1, 2, 0]);
    assert.deepEqual([...view.loops[0]!.cels[0]!.pixels], [1, 2, 0]);
    assert.deepEqual(payload, original);
  });

  it("returns undefined for unavailable selections without changing loaded state", () => {
    const view = views.parseView(sharedLoops(2, 0x80));
    assert.equal(views.selectViewCel(view, 1, 9), undefined);
    assert.equal(views.readViewCel(view, 9, 0), undefined);
    assert.deepEqual([...views.readViewCel(view, 0, 0)!.pixels], [1, 2, 0]);
  });
});

describe("2.230 view authoring", () => {
  it("emits packed loop orientation and transparent-only cel headers", () => {
    const payload = views.buildView(
      { loops: [{ cels: [{ width: 3, height: 1, pixels: [1, 2, 0] }] }, { mirrorLoop: 0 }] },
      PROFILES["2.230"],
    );
    assert.deepEqual([...payload], [0, 0, 2, 0, 0, 9, 0, 9, 0, 0xc1, 3, 0, 3, 1, 0, 0x11, 0x21, 0]);
    const view = views.parseView(payload, PROFILES["2.230"]);
    assert.deepEqual([...views.selectViewCel(view, 1, 0)!.pixels], [0, 2, 1]);
  });

  it("rejects more than 15 cels in a packed loop", () => {
    assert.throws(
      () =>
        views.buildView(
          {
            loops: [
              { cels: Array.from({ length: 16 }, () => ({ width: 1, height: 1, pixels: [1] })) },
            ],
          },
          PROFILES["2.230"],
        ),
      /15 cels/,
    );
  });

  it("rejects a packed mutable loop alias outside orientation range 0..3", () => {
    assert.throws(
      () =>
        views.buildView(
          {
            loops: [
              { cels: [{ width: 1, height: 1, pixels: [1] }] },
              { mirrorLoop: 0 },
              { mirrorLoop: 0 },
              { mirrorLoop: 0 },
              { mirrorLoop: 0 },
            ],
          },
          PROFILES["2.230"],
        ),
      /0\.\.3/,
    );
  });
});

describe("view byte strings", () => {
  const loops = [{ cels: [{ width: 1, height: 1, pixels: [1] }] }];

  it("encodes high description characters as individual bytes", () => {
    const payload = views.buildView({ loops, description: "A\x80\xff" });
    const offset = payload[3]! | (payload[4]! << 8);
    assert.deepEqual([...payload.slice(offset)], [65, 128, 255, 0]);
  });

  it("decodes high display bytes without UTF-8 replacement or expansion", () => {
    const payload = new Uint8Array([
      0, 0, 1, 15, 0, 7, 0, 1, 3, 0, 1, 1, 0, 0x11, 0, 65, 128, 255, 0,
    ]);
    assert.equal(views.parseView(payload).description, "A\x80\xff");
  });

  it("rejects descriptions that cannot fit a zero-terminated byte string", () => {
    assert.throws(() => views.buildView({ loops, description: "snowman \u2603" }), /byte/);
    assert.throws(() => views.buildView({ loops, description: "one\0two" }), /zero/);
  });
});
