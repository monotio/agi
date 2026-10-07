import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { buildView } from "../src/view/view.ts";
import type { GameContainer } from "../src/types.ts";

const host: EngineHost = {
  print: () => {},
  displayAt: () => {},
  statusLine: () => {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

function solidPicture(color: number): Uint8Array {
  return new Uint8Array([0xf0, color, 0xf8, 80, 80, 0xff]);
}

function solidView(color: number): Uint8Array {
  return buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [color] }] }] });
}

function makeEngine(logic: string, roomLogic?: string): Engine {
  const game = createContainer();
  game.putResource("logic", 0, assembleLogic(logic, { dictionary: new Map() }).payload);
  if (roomLogic !== undefined)
    game.putResource("logic", 1, assembleLogic(roomLogic, { dictionary: new Map() }).payload);
  game.putResource("picture", 1, solidPicture(1));
  game.putResource("picture", 3, solidPicture(2));
  game.putResource("view", 0, solidView(5));
  game.putResource("view", 1, solidView(9));
  const engine = new Engine(game, host);
  engine.tick();
  return engine;
}

function candidate(engine: Engine, edit: (game: GameContainer) => void): Map<string, Uint8Array> {
  const game = openContainer(engine.containerFiles);
  edit(game);
  return new Map(game.files);
}

test("a current picture drawn after replay overflow requires restart for its edit", () => {
  const engine = makeEngine(`
if (!isset(f200)) {
  set(f200);
  assignn(v10, 1); load.pic(v10); draw.pic(v10); show.pic();
}
if (equaln(v60, 1)) {
  set(f7);
  ${"load.view(0);\n".repeat(4100)}
  assignn(v10, 3); load.pic(v10); draw.pic(v10); show.pic();
  assignn(v60, 0);
}
increment(v200);
return;
`);
  engine.vars[60] = 1;
  engine.tick();
  assert.equal(engine.getFrame().visual[0], 2, "picture3 is actually on screen");
  assert.equal(engine.autosaveImage(), null, "the real host replay overflowed");
  const before = new Map([...engine.containerFiles].map(([key, bytes]) => [key, bytes.slice()]));
  const generation = engine.patchGeneration;
  const result = engine.applyPreviewUpdate({
    files: candidate(engine, (game) => game.putResource("picture", 3, solidPicture(3))),
  });
  assert.equal(result.status, "restartRequired");
  assert.deepEqual(engine.containerFiles, before);
  assert.equal(engine.patchGeneration, generation);
  assert.equal(engine.getFrame().visual[0], 2);
});

test("a changed view baked into add.to.pic requires restart", () => {
  const engine = makeEngine(`
if (!isset(f200)) {
  set(f200);
  assignn(v10, 1); load.pic(v10); draw.pic(v10);
  load.view(0); add.to.pic(0, 0, 0, 50, 8, 4, 0); show.pic();
}
increment(v200);
return;
`);
  assert.equal(engine.getFrame().visual[8 * 160 + 50], 5, "the static view pixel was baked");
  const generation = engine.patchGeneration;
  const result = engine.applyPreviewUpdate({
    files: candidate(engine, (game) => game.putResource("view", 0, solidView(7))),
  });
  assert.equal(result.status, "restartRequired");
  assert.equal(engine.patchGeneration, generation);
  assert.equal(engine.getFrame().visual[8 * 160 + 50], 5);
});

test("an unrelated view edit stays available beside a recorded static stamp", () => {
  const engine = makeEngine(`
if (!isset(f200)) {
  set(f200);
  assignn(v10, 1); load.pic(v10); draw.pic(v10);
  load.view(0); add.to.pic(0, 0, 0, 50, 8, 4, 0); show.pic();
}
increment(v200);
return;
`);
  assert.equal(
    engine.applyPreviewUpdate({
      files: candidate(engine, (game) => game.putResource("view", 1, solidView(7))),
    }).status,
    "committed",
  );
  assert.equal(engine.getFrame().visual[8 * 160 + 50], 5);
});

test("a new stamp dependency invalidates a previously prepared view update", () => {
  const engine = makeEngine(`
if (!isset(f200)) {
  set(f200);
  assignn(v10, 1); load.pic(v10); draw.pic(v10);
  load.view(0); add.to.pic(0, 0, 0, 50, 8, 4, 0); show.pic();
}
if (equaln(v60, 1)) {
  load.view(1); add.to.pic(1, 0, 0, 70, 8, 4, 0); assignn(v60, 0);
}
return;
`);
  const plan = engine.preparePreviewUpdate({
    files: candidate(engine, (game) => game.putResource("view", 1, solidView(7))),
  });
  engine.vars[60] = 1;
  engine.tick();
  assert.equal(engine.getFrame().visual[8 * 160 + 70], 9);
  const result = engine.commitPreviewUpdate(plan);
  assert.equal(result.status, "refused");
  assert.equal(engine.patchGeneration, 0);
  assert.equal(engine.getFrame().visual[8 * 160 + 70], 9);
});

const ROOM_TRANSITION = `
if (!isset(f200)) {
  set(f200);
  assignn(v10, 1); load.pic(v10); draw.pic(v10); show.pic();
}
if (equaln(v60, 1)) { assignn(v60, 0); new.room(1); }
if (equaln(v0, 1)) { call(1); }
increment(v200);
return;
`;

test("a room retaining its inherited backdrop requires restart for a picture edit", () => {
  const engine = makeEngine(ROOM_TRANSITION, "return;");
  engine.vars[60] = 1;
  engine.tick();
  assert.equal(engine.vars[0], 1);
  assert.equal(engine.getFrame().visual[0], 1, "new.room retained the previous backdrop");
  const before = new Map([...engine.containerFiles].map(([key, bytes]) => [key, bytes.slice()]));
  const result = engine.applyPreviewUpdate({
    files: candidate(engine, (game) => game.putResource("picture", 1, solidPicture(3))),
  });
  assert.equal(result.status, "restartRequired");
  assert.deepEqual(engine.containerFiles, before);
  assert.equal(engine.getFrame().visual[0], 1);
});

test("an overlay on an inherited backdrop must preserve the backdrop when its edit refuses", () => {
  const engine = makeEngine(
    ROOM_TRANSITION,
    `
if (isset(f5)) { assignn(v10, 3); load.pic(v10); overlay.pic(v10); show.pic(); }
if (equaln(v60, 2)) { assignn(v10, 3); draw.pic(v10); show.pic(); assignn(v60, 0); }
return;
`,
  );
  engine.vars[60] = 1;
  engine.tick();
  assert.equal(engine.vars[0], 1);
  assert.equal(engine.getFrame().visual[0], 1, "overlay flood preserves the filled backdrop");
  const before = engine.getFrame().visual.slice();
  const files = candidate(engine, (game) =>
    game.putResource("picture", 3, new Uint8Array([0xf0, 3, 0xf6, 10, 10, 20, 10, 0xff])),
  );
  assert.equal(engine.applyPreviewUpdate({ files }).status, "restartRequired");
  assert.deepEqual(engine.getFrame().visual, before);
  assert.equal(engine.patchGeneration, 0);
  // A real draw in this room restores a complete anchor and live eligibility.
  engine.vars[60] = 2;
  engine.tick();
  assert.equal(engine.getFrame().visual[0], 2);
  assert.equal(engine.applyPreviewUpdate({ files }).status, "committed");
  assert.equal(engine.getFrame().visual[10 * 160 + 10], 3);
  assert.equal(engine.getFrame().visual[0], 15);
});
