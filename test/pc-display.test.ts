import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";
import { cgaRgbViewPayload, pcDisplaysFor, type PcDisplay } from "../src/runtime/display.ts";

// Rules from docs/fidelity.md "PC fonts and display adapters": the player
// picks EGA or CGA where the build's binary starts CGA in RGB mode; v26 holds
// the monitor type (EGA 3, CGA RGB 1); toggle.monitor flips RGB and composite
// on a CGA card outside room 0; the CGA driver's view conversion hides an
// earlier cel's transparent colour in later cels of the same view.

const HOST: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

/** One loop, two cels: cel 0 is colour 1 over transparent 5, cel 1 is colour 5 over transparent 0. */
const TWO_CEL_VIEW = new Uint8Array([
  0, 0, 1, 0, 0, 7, 0,
  // loop at 7: two cels at loop+5 and loop+10
  2, 5, 0, 10, 0,
  // cel 0 at 12: width 2, height 1, transparent 5, run colour 1 × 2
  2, 1, 0x05, 0x12, 0,
  // cel 1 at 17: width 2, height 1, transparent 0, run colour 5 × 2
  2, 1, 0x00, 0x52, 0,
]);

/** Visual colour 4 along the bottom row, as an overlay. */
const BOTTOM_LINE = new Uint8Array([0xf0, 0x04, 0xf6, 0, 167, 159, 167, 0xff]);

function game(
  source: string,
  profile: ProfileId,
  pcDisplay?: PcDisplay,
  host: Partial<EngineHost> = {},
): Engine {
  const container = createContainer();
  const dictionary = new Map<string, number>();
  container.putResource("logic", 0, assembleLogic(source, { dictionary }).payload);
  container.putResource("picture", 1, new Uint8Array([0xff]));
  container.putResource("picture", 2, BOTTOM_LINE);
  container.putResource("view", 3, TWO_CEL_VIEW);
  return new Engine(container, { ...HOST, ...host }, dictionary, {
    profile,
    ...(pcDisplay ? { pcDisplay } : {}),
  });
}

test("each build offers the displays its binary starts with", () => {
  const expected: Record<string, readonly PcDisplay[]> = {
    "2.001": ["ega"],
    "2.089": ["ega"],
    "2.230": ["ega"],
    "2.272": ["ega"],
    "2.411": ["ega", "cga-rgb"],
    "2.440": ["ega", "cga-rgb"],
    "2.917": ["ega", "cga-rgb"],
    "2.936": ["ega", "cga-rgb"],
    "3.002.086": ["ega", "cga-rgb"],
    "3.002.102": ["ega", "cga-rgb"],
    "3.002.149": ["ega", "cga-rgb"],
  };
  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    assert.deepEqual(pcDisplaysFor(PROFILES[id]), expected[id] ?? [], id);
  }
});

test("v26 holds the CGA RGB monitor type at startup, restart and the 2.903+ restore", () => {
  const source =
    "if (isset(f6)) { assignv(v100, v26); return; } if (equaln(v75, 1)) { set(f16); restart.game(); } return;";
  for (const id of [
    "2.411",
    "2.440",
    "2.917",
    "2.936",
    "3.002.086",
    "3.002.102",
    "3.002.149",
  ] as const) {
    const e = game(source, id, "cga-rgb", { takeKeys: () => [13] });
    assert.equal(e.pcDisplay, "cga-rgb", id);
    assert.equal(e.vars[26], 1, `${id} startup`);
    e.vars[75] = 1;
    e.tick();
    assert.equal(e.vars[100], 1, `${id} accepted restart`);
  }
  for (const id of ["2.917", "2.936", "3.002.149"] as const) {
    const src = game("return;", id, "ega");
    src.tick();
    const restored = game("return;", id, "cga-rgb");
    restored.restoreImage(src.serialize());
    assert.equal(restored.vars[26], 1, `${id}: RestoreGame copies the running monitor type`);
  }
  for (const id of ["2.411", "2.440"] as const) {
    const src = game("return;", id, "ega");
    src.tick();
    const restored = game("return;", id, "cga-rgb");
    restored.restoreImage(src.serialize());
    assert.equal(restored.vars[26], 3, `${id}: RestoreGame keeps the saved v26`);
  }
});

test("a build without a verified CGA start runs EGA and keeps its startup v26", () => {
  for (const id of ["2.001", "2.089", "2.230", "2.272"] as const) {
    const e = game("return;", id, "cga-rgb");
    assert.equal(e.pcDisplay, "ega", id);
    assert.equal(e.vars[26], 0, id);
  }
  const amiga = game("return;", "amiga-2.316", "cga-rgb");
  assert.equal(amiga.pcDisplay, "ega");
  assert.equal(amiga.vars[26], 3);
});

test("toggle.monitor flips CGA between RGB and composite outside room 0 only", () => {
  const source = `if (isset(f6)) { assignv(v100, v26); return; }
    if (!isset(f200)) { set(f200); assignn(v1, 1); load.pic(v1); draw.pic(v1); show.pic(); }
    if (equaln(v75, 1)) { assignn(v75, 0); toggle.monitor(); }
    if (equaln(v75, 2)) { set(f16); restart.game(); }
    return;`;
  const roomZero = game(source, "2.936", "cga-rgb");
  roomZero.vars[75] = 1;
  roomZero.tick();
  assert.equal(roomZero.captureReplayState(true).monitorType, undefined, "room 0 ignores it");

  const ega = game(source, "2.936", "ega");
  ega.vars[0] = 5;
  ega.vars[75] = 1;
  ega.tick();
  assert.equal(ega.captureReplayState(true).monitorType, undefined, "EGA ignores it");

  const cga = game(source, "2.936", "cga-rgb");
  cga.vars[0] = 5;
  cga.vars[75] = 1;
  cga.tick();
  assert.equal(cga.vars[26], 1, "v26 keeps its value");
  const state = cga.captureReplayState(true);
  assert.equal(state.monitorType, 0, "the monitor is composite now");

  // History replay carries the switched monitor; an EGA session ignores it.
  const image = cga.autosaveImage()!;
  const replayed = game(source, "2.936", "cga-rgb");
  replayed.restoreImage(image);
  replayed.restoreReplayState(state);
  assert.equal(replayed.captureReplayState(true).monitorType, 0);
  const egaReplay = game(source, "2.936", "ega");
  egaReplay.restoreImage(image);
  egaReplay.restoreReplayState(state);
  assert.equal(egaReplay.captureReplayState(true).monitorType, undefined);

  // ResetAll copies the switched monitor type into v26.
  cga.vars[0] = 5;
  cga.vars[75] = 1;
  cga.tick();
  assert.equal(cga.captureReplayState(true).monitorType, undefined, "a second toggle is RGB again");
  cga.vars[75] = 1;
  cga.tick();
  cga.vars[75] = 2;
  cga.tick();
  assert.equal(cga.vars[100], 0, "restart reads the composite monitor type");
});

test("the CGA view conversion hides an earlier cel's transparent colour in later cels", () => {
  const converted = cgaRgbViewPayload(TWO_CEL_VIEW);
  // Cel 1's colour-5 run becomes its own transparent colour 0; cel 0 is untouched.
  assert.deepEqual([...converted.subarray(12, 22)], [2, 1, 0x05, 0x12, 0, 2, 1, 0x00, 0x02, 0]);
  assert.deepEqual([...TWO_CEL_VIEW.subarray(17, 22)], [2, 1, 0x00, 0x52, 0], "input untouched");

  // A repeated loop offset (a mirrored loop) is converted once.
  const mirrored = new Uint8Array([0, 0, 2, 0, 0, 9, 0, 9, 0, ...TWO_CEL_VIEW.subarray(7)]);
  // Offsets inside the loop are relative to it, so the cels move with it.
  const once = cgaRgbViewPayload(mirrored);
  assert.deepEqual([...once.subarray(14, 24)], [2, 1, 0x05, 0x12, 0, 2, 1, 0x00, 0x02, 0]);

  const source =
    "load.pic(v1); draw.pic(v1); show.pic(); load.view(3); add.to.pic(3, 0, 1, 20, 100, 15, 4); return;";
  for (const [display, colour] of [
    ["ega", 5],
    ["cga-rgb", 15],
  ] as const) {
    const e = game(source, "2.936", display);
    e.vars[1] = 1;
    e.tick();
    const row = 100 * 160;
    assert.deepEqual(
      [...e.getPictureSurface().visual.subarray(row + 20, row + 22)],
      [colour, colour],
      `${display}: cel 1 shows ${colour === 15 ? "the white picture" : "colour 5"}`,
    );
  }
});

test("cel provenance follows add.to.pic stamps, picture writes and replay", () => {
  const source = `if (equaln(v75, 0)) { assignn(v75, 1); assignn(v1, 1); load.pic(v1); draw.pic(v1); show.pic();
      load.view(3); add.to.pic(3, 0, 0, 10, 167, 15, 4); add.to.pic(3, 0, 0, 30, 100, 15, 4); return; }
    if (equaln(v75, 2)) { assignn(v75, 3); assignn(v2, 2); load.pic(v2); overlay.pic(v2); show.pic(); }
    return;`;
  const e = game(source, "2.936", "cga-rgb");
  e.tick();
  const at = (x: number, y: number) => y * 160 + x;
  const cel = e.getCelPixels();
  assert.deepEqual(
    [cel[at(10, 167)], cel[at(11, 167)], cel[at(12, 167)], cel[at(30, 100)], cel[at(31, 100)]],
    [1, 1, 0, 1, 1],
    "the two stamped pixels of each cel; the next pixel is picture",
  );
  assert.equal(
    cel.reduce((n, v) => n + v, 0),
    4,
  );

  // A host restore replays the picture sequence and rebuilds the same provenance.
  const replayed = game(source, "2.936", "cga-rgb");
  replayed.restoreImage(e.autosaveImage()!);
  assert.deepEqual(replayed.getCelPixels(), cel);

  e.vars[75] = 2;
  e.tick();
  const after = e.getCelPixels();
  assert.deepEqual(
    [after[at(10, 167)], after[at(11, 167)], after[at(30, 100)]],
    [0, 0, 1],
    "the overlay's line covers the bottom stamp only",
  );
});
