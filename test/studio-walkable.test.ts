import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  standVerdict,
  walkableBounds,
  walkableMask,
  type WalkableInput,
} from "../src/studio/walkable.ts";

const at = (x: number, y: number): number => y * 160 + x;

/** Priority 4 everywhere: ordinary floor with no control lines. */
function plane(paint: (set: (x0: number, x1: number, y: number, value: number) => void) => void) {
  const priority = new Uint8Array(160 * 168).fill(4);
  paint((x0, x1, y, value) => priority.fill(value, at(x0, y), at(x1, y) + 1));
  return priority;
}

const input = (over: Partial<WalkableInput>): WalkableInput => ({
  priority: plane(() => {}),
  egoWidth: 1,
  egoHeight: 1,
  observeBlocks: true,
  waterGate: null,
  horizon: null,
  ...over,
});

/** The x values on row y where the mask is 1, as inclusive runs. */
function runs(mask: Uint8Array, y: number): [number, number][] {
  const out: [number, number][] = [];
  for (let x = 0; x < 160; x++) {
    if (!mask[at(x, y)]) continue;
    const last = out[out.length - 1];
    if (last && last[1] === x - 1) last[1] = x;
    else out.push([x, x]);
  }
  return out;
}

describe("walkableMask", () => {
  it("a barrier line rejects every footprint that covers one of its cells", () => {
    const priority = plane((set) => set(50, 59, 100, 0));
    // One cell wide: exactly the line's own cells.
    assert.deepEqual(runs(walkableMask(input({ priority })), 100), [
      [0, 49],
      [60, 159],
    ]);
    // Four wide: x..x+3 touches 50..59 for x in 47..59; the right bound is 156.
    const wide = walkableMask(input({ priority, egoWidth: 4 }));
    assert.deepEqual(runs(wide, 100), [
      [0, 46],
      [60, 156],
    ]);
    assert.deepEqual(runs(wide, 99), [[0, 156]], "the row above is untouched");
  });

  it("water needs the gate: on keeps only all-water footprints, off rejects them", () => {
    const priority = plane((set) => set(20, 29, 120, 3));
    // No gate: water is ordinary ground.
    assert.deepEqual(runs(walkableMask(input({ priority, egoWidth: 4 })), 120), [[0, 156]]);
    // obj.on.water: x..x+3 all inside 20..29 means x in 20..26, and nowhere else.
    const on = walkableMask(input({ priority, egoWidth: 4, waterGate: "on" }));
    assert.deepEqual(runs(on, 120), [[20, 26]]);
    assert.deepEqual(runs(on, 121), [], "dry rows are closed to a water-bound actor");
    // obj.on.land: the all-water footprints close; a partly dry one stays open.
    const off = walkableMask(input({ priority, egoWidth: 4, waterGate: "off" }));
    assert.deepEqual(runs(off, 120), [
      [0, 19],
      [27, 156],
    ]);
    // Both gates together accept nothing.
    assert.equal(
      walkableMask(input({ priority, egoWidth: 4, waterGate: "both" })).some((v) => v !== 0),
      false,
    );
  });

  it("a narrower water width classifies water on those cells only", () => {
    // Navigation's widest-cel geometry scans barriers over the widest cel but
    // classifies water over the current cel: here the first four of six.
    const priority = plane((set) => set(20, 29, 120, 3));
    const current = walkableMask(input({ priority, egoWidth: 6, waterWidth: 4, waterGate: "on" }));
    assert.deepEqual(runs(current, 120), [[20, 26]]);
    const whole = walkableMask(input({ priority, egoWidth: 6, waterGate: "on" }));
    assert.deepEqual(runs(whole, 120), [[20, 24]]);
  });

  it("a conditional barrier blocks only an actor that observes blocks", () => {
    const priority = plane((set) => set(30, 39, 80, 1));
    assert.deepEqual(runs(walkableMask(input({ priority })), 80), [
      [0, 29],
      [40, 159],
    ]);
    assert.deepEqual(runs(walkableMask(input({ priority, observeBlocks: false })), 80), [[0, 159]]);
  });

  it("the baseline stays below the horizon and at least one cel height down", () => {
    const horizon = walkableMask(input({ horizon: 36 }));
    assert.equal(horizon[at(10, 36)], 0, "the horizon row itself is closed");
    assert.equal(horizon[at(10, 37)], 1);
    const ignored = walkableMask(input({ horizon: null }));
    assert.equal(ignored[at(10, 0)], 1, "ignore.horizon opens the top row");
    const tall = walkableMask(input({ egoHeight: 10 }));
    assert.equal(tall[at(10, 8)], 0, "a 10-row cel cannot stand with its baseline above y=9");
    assert.equal(tall[at(10, 9)], 1);
    assert.deepEqual(walkableBounds(input({ egoHeight: 10, horizon: 36, egoWidth: 7 })), {
      minY: 37,
      maxX: 153,
    });
  });

  it("fixed priority 15 skips the control scan but keeps the bounds", () => {
    const priority = plane((set) => set(50, 59, 100, 0));
    const mask = walkableMask(input({ priority, bypassControl: true, horizon: 36 }));
    assert.equal(mask[at(55, 100)], 1);
    assert.equal(mask[at(55, 36)], 0);
  });
});

describe("standVerdict", () => {
  it("names the first reason the engine refuses a footprint", () => {
    const priority = plane((set) => {
      set(50, 59, 100, 0);
      set(30, 39, 80, 1);
      set(20, 29, 120, 3);
    });
    const base = input({ priority, egoWidth: 4, horizon: 36 });
    assert.equal(standVerdict(base, 10, 140), "ok");
    assert.equal(standVerdict(base, 157, 140), "bounds");
    assert.equal(standVerdict(base, 10, 36), "horizon");
    assert.equal(standVerdict(base, 48, 100), "barrier");
    assert.equal(standVerdict(base, 28, 80), "conditional");
    assert.equal(standVerdict({ ...base, waterGate: "on" }, 10, 140), "water");
    assert.equal(standVerdict({ ...base, waterGate: "off" }, 20, 120), "land");
  });
});
