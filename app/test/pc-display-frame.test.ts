import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { Engine } from "../../src/runtime/engine.ts";
import type { PcDisplay } from "../../src/runtime/display.ts";
import { appearanceForProfile, loadAppearance } from "../src/render/appearance.ts";
import { compositeFrame } from "../src/render/composite.ts";

// Player-visible rule (docs/fidelity.md "PC fonts and display adapters"): on
// CGA the picture shows the driver's two-row colour patterns, while every
// cel (a moving object or an add.to.pic stamp) shows the driver's cel colours.
// Expected pixels are hand-computed from the binary's tables:
//   green (2) picture, even row: pattern 5 = green, green
//   green (2) picture, odd row:  pattern 4 = green, blue
//   green (2) cel:               cel code 12 = brown, blue
const BLUE = [0, 0, 170, 255];
const GREEN = [0, 170, 0, 255];
const BROWN = [170, 85, 0, 255];

function frame(display: PcDisplay): Uint8Array {
  const container = createContainer();
  const dictionary = new Map<string, number>();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) { set(f200); assignn(v1, 1); load.pic(v1); draw.pic(v1); show.pic();
         load.view(3); add.to.pic(3, 0, 0, 10, 100, 15, 4);
         animate.obj(o1); set.view(o1, 3); position(o1, 40, 120); draw(o1); }
       return;`,
      { dictionary },
    ).payload,
  );
  // Fill the whole picture with green.
  container.putResource("picture", 1, new Uint8Array([0xf0, 0x02, 0xf8, 0, 0, 0xff]));
  // One cel: two green pixels over transparent black.
  container.putResource(
    "view",
    3,
    new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 2, 1, 0x00, 0x22, 0]),
  );
  const engine = new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
    },
    dictionary,
    { profile: "2.936", pcDisplay: display },
  );
  engine.tick();
  const presentation = engine.getPresentation();
  const out = new Uint8Array(320 * 200 * 4);
  compositeFrame(
    {
      visual: presentation.visual,
      text: presentation.text,
      picRow: engine.displayBase,
      ...(display === "cga-rgb" ? { celPixels: engine.getCelPixels() } : {}),
      appearance: appearanceForProfile("2.936", null, display),
    },
    out,
  );
  return out;
}

const pixel = (out: Uint8Array, x: number, y: number) => [
  ...out.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4),
];

test("a CGA frame shows picture patterns by row and cel colours for stamps and objects", async () => {
  await loadAppearance("2.936", null, "cga-rgb");
  const out = frame("cga-rgb");
  // Picture row 100 is screen row 108 (one status row above the picture).
  assert.deepEqual([pixel(out, 0, 108), pixel(out, 1, 108)], [GREEN, GREEN], "even picture row");
  assert.deepEqual([pixel(out, 0, 109), pixel(out, 1, 109)], [GREEN, BLUE], "odd picture row");
  assert.deepEqual(
    [pixel(out, 20, 108), pixel(out, 21, 108), pixel(out, 22, 108), pixel(out, 23, 108)],
    [BROWN, BLUE, BROWN, BLUE],
    "the add.to.pic stamp",
  );
  assert.deepEqual([pixel(out, 24, 108), pixel(out, 25, 108)], [GREEN, GREEN], "picture again");
  assert.deepEqual(
    [pixel(out, 80, 128), pixel(out, 81, 128), pixel(out, 82, 128), pixel(out, 83, 128)],
    [BROWN, BLUE, BROWN, BLUE],
    "the moving object",
  );
});

test("the same frame on EGA shows green everywhere", () => {
  const out = frame("ega");
  for (const [x, y] of [
    [0, 108],
    [1, 109],
    [20, 108],
    [81, 128],
  ] as const)
    assert.deepEqual(pixel(out, x, y), GREEN, `${x},${y}`);
});
