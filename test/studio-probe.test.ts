import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { compilePictureSource } from "../src/picture/source.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { probeActor, type ProbeInput } from "../src/studio/probe.ts";
import { shapeSource } from "../src/studio/shapes.ts";
import { createPictureSurface } from "../src/types.ts";
import { buildView, parseView, readViewCel, type ViewCel } from "../src/view/view.ts";

const profile = PROFILES["2.936"];
const at = (x: number, y: number): number => y * 160 + x;

/** Cell indices of a 160x168 mask, ascending. */
function cells(mask: Uint8Array): number[] {
  const out: number[] = [];
  mask.forEach((v, i) => {
    if (v !== 0) out.push(i);
  });
  return out;
}

/** Every cell of the inclusive rectangle, row-major. */
function rect(x1: number, y1: number, x2: number, y2: number): number[] {
  const out: number[] = [];
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) out.push(at(x, y));
  return out;
}

/** A toy room: priority 4 everywhere, a priority-10 bench over x 40..119, y 90..105. */
function toyPicture(): { visual: Uint8Array; priority: Uint8Array } {
  const visual = new Uint8Array(160 * 168).fill(15);
  const priority = new Uint8Array(160 * 168).fill(4);
  for (const cell of rect(40, 90, 119, 105)) priority[cell] = 10;
  return { visual, priority };
}

/** A solid w x h cel in colour 1 (transparent colour 0). */
function solidCel(width: number, height: number): ViewCel {
  const view = parseView(
    buildView({
      loops: [{ cels: [{ width, height, pixels: new Array(width * height).fill(1) }] }],
    }),
  );
  return readViewCel(view, 0, 0)!;
}

const probe = (over: Partial<ProbeInput>) =>
  probeActor({
    picture: toyPicture(),
    cel: solidCel(4, 10),
    x: 50,
    baselineY: 95,
    priority: "band",
    profile,
    ...over,
  });

describe("ghost actor probe", () => {
  it("hides an actor behind the pri-10 bench exactly where the bench is", () => {
    // Band at y 95: 5 + floor((95-48)*10/120) = 5 + 3 = 8 < 10. Rows 86..95.
    const result = probe({});
    assert.equal(result.bandPriority, 8);
    assert.equal(result.drawPriority, 8);
    assert.deepEqual(cells(result.hiddenMask), rect(50, 90, 53, 95));
    assert.deepEqual(cells(result.drawnMask), rect(50, 86, 53, 89));
  });

  it("draws an actor in front of the bench in full", () => {
    // Band at y 108: 5 + floor(60*10/120) = 10, equal to the bench: drawn (hidden only when above).
    const result = probe({ baselineY: 108, cel: solidCel(4, 20) });
    assert.equal(result.bandPriority, 10);
    assert.deepEqual(cells(result.hiddenMask), []);
    assert.deepEqual(cells(result.drawnMask), rect(50, 89, 53, 108));
    // A fixed priority overrides the band: 12 at y 95 is in front too.
    const fixed = probe({ priority: 12 });
    assert.equal(fixed.bandPriority, 8);
    assert.equal(fixed.drawPriority, 12);
    assert.deepEqual(cells(fixed.hiddenMask), []);
    assert.deepEqual(cells(fixed.drawnMask), rect(50, 86, 53, 95));
  });

  it("reports the barrier cells of a baseline on a barrier row, and rejects it", () => {
    const picture = toyPicture();
    for (let x = 0; x < 160; x++) picture.priority[at(x, 130)] = 0;
    picture.priority[at(53, 130)] = 2;
    const result = probe({ picture, baselineY: 130 });
    assert.deepEqual(result.controlHits, [
      {
        value: 0,
        cells: [
          { x: 50, y: 130 },
          { x: 51, y: 130 },
          { x: 52, y: 130 },
        ],
      },
      { value: 2, cells: [{ x: 53, y: 130 }] },
    ]);
    assert.deepEqual(result.footprint.controls, {
      barrier: true,
      conditional: false,
      signal: true,
      water: false,
    });
    assert.equal(result.footprint.accepted, false);
    // Priority 15 skips the scan: the engine accepts the same footprint.
    const bypass = probe({ picture, baselineY: 130, priority: 15 });
    assert.equal(bypass.footprint.bypassed, true);
    assert.equal(bypass.footprint.accepted, true);
    // A footprint all on water, and one off the barrier row, are accepted.
    for (let x = 60; x < 64; x++) picture.priority[at(x, 140)] = 3;
    assert.deepEqual(probe({ picture, x: 60, baselineY: 140 }).footprint.controls.water, true);
    assert.deepEqual(probe({ picture, baselineY: 131 }).controlHits, []);
  });

  it("compares a control line inside the body against the priority below it", () => {
    // A barrier line on row 89, just above the bench: its cells take the
    // bench's 10 (the first value above 2 below them), so band 8 hides them
    // too; the same line on row 87 takes row 88's 4 and draws.
    const picture = toyPicture();
    for (let x = 40; x < 120; x++) picture.priority[at(x, 89)] = 0;
    for (let x = 40; x < 120; x++) picture.priority[at(x, 87)] = 0;
    const result = probe({ picture });
    assert.deepEqual(cells(result.hiddenMask), rect(50, 89, 53, 95));
    assert.deepEqual(cells(result.drawnMask), rect(50, 86, 53, 88));
  });

  it("keeps the default base on a build whose set.pri.base is a stub", () => {
    // y 70 with base 60: 5 + floor(10*10/108) = 5; with the default 48: 5 + floor(22*10/120) = 6.
    const effect = probe({ priorityBase: 60, baselineY: 70 });
    assert.equal(effect.bandPriority, 5);
    const stub = probe({
      priorityBase: 60,
      baselineY: 70,
      profile: { priorityBaseAction: "noop" },
    });
    assert.equal(stub.bandPriority, 6);
    // Above the base every baseline is band 4.
    assert.equal(probe({ priorityBase: 60, baselineY: 59 }).bandPriority, 4);
  });

  it("matches the drawn pixels of a real engine frame", () => {
    const pictureBytes = compilePictureSource(
      [
        ...shapeSource({
          kind: "rect",
          color: 6,
          priority: 10,
          filled: true,
          x1: 40,
          y1: 90,
          x2: 119,
          y2: 105,
        }),
        ...shapeSource({
          kind: "line",
          color: null,
          priority: 1,
          filled: false,
          points: [
            { x: 30, y: 89 },
            { x: 90, y: 89 },
          ],
        }),
        "end",
      ].join("\n"),
      { profile },
    ).bytes;
    // A cel with transparent holes: a diagonal of colour 0 in a 5x12 block of colour 2.
    const pixels = Array.from({ length: 60 }, (_, i) => (i % 6 === 0 ? 0 : 2));
    const viewBytes = buildView({ loops: [{ cels: [{ width: 5, height: 12, pixels }] }] });
    const container = createContainer();
    container.putResource("picture", 1, pictureBytes);
    container.putResource("view", 1, viewBytes);
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `if (!isset(f200)) { set(f200);
          assignn(v50, 1); load.pic(v50); draw.pic(v50); discard.pic(v50); show.pic();
          load.view(1); animate.obj(o1); set.view(o1, 1); ignore.blocks(o1);
          position(o1, 57, 97); draw(o1); stop.update(o1); }
        return;`,
        { dictionary: new Map(), profile },
      ).payload,
    );
    const host: EngineHost = {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
    };
    const engine = new Engine(container, host, undefined);
    engine.tick();
    const object = engine.screenObjects[1]!;
    assert.deepEqual([object.x, object.y], [57, 97]);
    const ownership = engine.getOwnership();
    const frameMask = Uint8Array.from(ownership, (owner) => (owner === 2 ? 1 : 0));

    const surface = createPictureSurface();
    renderPicture(pictureBytes, surface, { profile });
    const result = probeActor({
      picture: surface,
      cel: readViewCel(parseView(viewBytes), 0, 0)!,
      x: 57,
      baselineY: 97,
      priority: "band",
      profile,
    });
    assert.ok(cells(frameMask).length > 0, "the engine drew part of the object");
    assert.ok(cells(result.hiddenMask).length > 0, "the bench hides part of it");
    assert.deepEqual(cells(result.drawnMask), cells(frameMask));
  });
});
