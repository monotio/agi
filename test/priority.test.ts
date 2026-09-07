import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";
import { decodeSave } from "../src/runtime/persistence.ts";
import { buildView } from "../src/view/view.ts";

const host: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

function game(source: string, profile: ProfileId = "2.936"): Engine {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(source, { dictionary: new Map(), profile: PROFILES[profile] }).payload,
  );
  container.putResource("logic", 1, assembleLogic("return;", { dictionary: new Map() }).payload);
  for (const color of [1, 2]) {
    container.putResource(
      "view",
      color,
      buildView({
        loops: [{ cels: [{ width: 2, height: 2, pixels: [color, color, color, color] }] }],
      }),
    );
  }
  return new Engine(container, host, undefined, { profile });
}

function sample(rows: readonly number[]): string {
  return rows
    .map(
      (y, i) => `position(o0, 80, ${y});
      reposition(o0, v254, v255);
      get.priority(o0, v${60 + i});`,
    )
    .join("\n");
}

// Peter Kelly's agi-re specification, Objects: "Priority and horizon".
// Both ends of every band are explicit, independently of the implementation.
const rows = [
  0, 47, 48, 59, 60, 71, 72, 83, 84, 95, 96, 107, 108, 119, 120, 131, 132, 143, 144, 155, 156, 167,
];
const priorities = [4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14];

for (const horizon of [0, 36, 100]) {
  test(`default priority bands do not depend on horizon ${horizon}`, () => {
    // reposition runs placement, which keeps a horizon-observing object below
    // the horizon; the probe is exempted so every band row is sampled in place.
    const engine = game(`set.horizon(${horizon}); ignore.horizon(o0); ${sample(rows)} return;`);
    engine.tick();
    assert.deepEqual(Array.from(engine.vars.slice(60, 60 + rows.length)), priorities);
  });
}

test("set.pri.base replaces the bands independently of set.horizon", () => {
  // Base 68 leaves 100 rows: ten rows per band. Base itself starts at 5.
  const probeRows = [0, 67, 68, 77, 78, 87, 158, 167];
  const engine = game(
    `set.pri.base(68); set.horizon(120); ignore.horizon(o0); ${sample(probeRows)} return;`,
  );
  engine.tick();
  assert.deepEqual(Array.from(engine.vars.slice(60, 68)), [4, 4, 5, 5, 6, 6, 14, 14]);
});

test("a room change retains the rebuilt priority bands", () => {
  const engine = game(`
    if (!isset(f200)) { set(f200); set.pri.base(68); set.horizon(100); new.room(1); }
    ${sample([67, 68, 167])}
    return;
  `);
  engine.tick();
  assert.equal(engine.horizon, 36);
  assert.deepEqual(Array.from(engine.vars.slice(60, 63)), [4, 5, 14]);
});

test("save/restore does not serialize a priority table or replay its rebuild", () => {
  const engine = game(`
    if (equaln(v200, 0)) { set.pri.base(68); }
    if (equaln(v200, 1)) { set.pri.base(48); }
    ${sample([60, 68])}
    return;
  `);
  engine.tick();
  assert.deepEqual(Array.from(engine.vars.slice(60, 62)), [4, 5]);
  const saved = engine.serialize();
  engine.vars[200] = 1;
  engine.tick();
  engine.restoreImage(saved);
  engine.vars[200] = 2;
  engine.tick();
  assert.deepEqual(Array.from(engine.vars.slice(60, 62)), [6, 6]);
});

test("accepted restart restores startup priority bands", () => {
  const engine = game(`
    if (!isset(f6)) { set.pri.base(68); set(f16); restart.game(); }
    ${sample([47, 60, 68])}
    return;
  `);
  engine.tick();
  engine.tick();
  assert.deepEqual(Array.from(engine.vars.slice(60, 63)), [4, 6, 6]);
});

const objects = `
  load.view(1); load.view(2);
  animate.obj(o0); animate.obj(o1);
  set.view(o0, 1); set.view(o1, 2);
  ignore.objs(o0); ignore.objs(o1);
  position(o0, 20, 100); position(o1, 19, 100);
  draw(o0); draw(o1);
  stop.cycling(o0); stop.cycling(o1);
`;

test("equal drawing keys use object number, not horizontal position", () => {
  const engine = game(`${objects} return;`);
  engine.tick();
  assert.equal(engine.getFrame().visual[100 * 160 + 20], 2);
});

test("stop.update keeps an object visible and stops its movement", () => {
  const engine = game(
    `${objects} erase(o1); stop.update(o0); assignn(v60, 3); set.dir(o0, v60); return;`,
  );
  engine.tick();
  assert.equal(engine.getFrame().visual[100 * 160 + 20], 1);
  assert.equal(engine.readObjects()[0]?.x, 20);
});

test("earlier partition is drawn before later even when its baseline is lower", () => {
  const engine = game(`${objects} position(o0, 20, 101); stop.update(o0); return;`);
  engine.tick();
  const frame = engine.getFrame();
  assert.equal(frame.visual[101 * 160 + 20], 1, "earlier object is visible outside overlap");
  assert.equal(frame.visual[100 * 160 + 20], 2, "later partition wins overlap");
});

for (const [profile, color] of [
  ["2.089", 2],
  ["2.936", 1],
] as const) {
  test(`earlier partition applies ${profile} ordering`, () => {
    const engine = game(
      `${objects} position(o0, 20, 101); stop.update(o0); stop.update(o1); return;`,
      profile,
    );
    engine.tick();
    assert.equal(engine.getFrame().visual[100 * 160 + 20], color);
  });
}

test("positive fixed priorities sort after baselines, and equal keys by object number", () => {
  const engine = game(
    `${objects} position(o0, 20, 101); set.priority(o0, 9); set.priority(o1, 9); return;`,
  );
  engine.tick();
  assert.equal(engine.getFrame().visual[100 * 160 + 20], 2);
});

test("save and restore retain draw partitions", () => {
  const engine = game(`${objects} stop.update(o0); return;`);
  engine.tick();
  const saved = engine.serialize();
  engine.restoreImage(saved);
  assert.equal(engine.getFrame().visual[100 * 160 + 21], 1);
  assert.equal(engine.getFrame().visual[100 * 160 + 20], 2);
});

test("picture rendering uses the selected early profile", () => {
  const engine = game("assignn(v60, 1); load.pic(v60); draw.pic(v60); return;", "2.411");
  // 2.411 ignores the radius and plots only the indicated center point.
  engine.patchResource("picture", 1, new Uint8Array([0xf0, 1, 0xf9, 1, 0xfa, 20, 30, 0xff]));
  engine.tick();
  assert.equal(engine.surface.visual[30 * 160 + 20], 1);
  assert.equal(engine.surface.visual[29 * 160 + 20], 15);
});

test("engine loads packed 2.230 VIEW headers", () => {
  const engine = game(
    "load.view(1); animate.obj(o0); set.view(o0, 1); position(o0, 20, 100); draw(o0); stop.cycling(o0); return;",
    "2.230",
  );
  // One loop, header c1: mutable/mirrorable loop, orientation0, one cel.
  engine.patchResource(
    "view",
    1,
    new Uint8Array([0, 0, 1, 0, 0, 7, 0, 0xc1, 3, 0, 2, 1, 0, 0x11, 0x21, 0]),
  );
  engine.tick();
  assert.deepEqual(
    Array.from(engine.getFrame().visual.slice(100 * 160 + 20, 100 * 160 + 22)),
    [1, 2],
  );
});

test("frame observation preserves shared sprite orientation selected by bytecode", () => {
  const engine = game(`
    load.view(1); animate.obj(o0); set.view(o0, 1); position(o0, 20, 100);
    draw(o0); stop.cycling(o0); fix.loop(o0);
    set.loop(o0, 1); set.loop(o0, 2);
    return;
  `);
  // Three loop aliases:0→1 mirrors the shared row,1→2 mirrors it back.
  engine.patchResource(
    "view",
    1,
    new Uint8Array([0, 0, 3, 0, 0, 11, 0, 11, 0, 11, 0, 1, 3, 0, 2, 1, 0x80, 0x11, 0x21, 0]),
  );
  engine.tick();
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(
      Array.from(engine.getFrame().visual.slice(100 * 160 + 20, 100 * 160 + 22)),
      [1, 2],
    );
  }
});

test("early show.pic preserves f15", () => {
  const engine = game("set(f15); show.pic(); return;", "2.089");
  engine.tick();
  assert.equal(engine.flags[15], 1);
});

test("distance uses cel centers and early profiles wrap overflow", () => {
  const engine = game(
    `${objects} position(o0, 0, 0); position(o1, 158, 167); distance(o0, o1, v60); return;`,
    "2.089",
  );
  engine.tick();
  assert.equal(engine.vars[60], 69, "(158 + 167) modulo 256");
  const differentWidths = game(`${objects} distance(o0, o1, v60); return;`);
  differentWidths.patchResource(
    "view",
    2,
    buildView({ loops: [{ cels: [{ width: 4, height: 1, pixels: [2, 2, 2, 2] }] }] }),
  );
  differentWidths.tick();
  assert.equal(differentWidths.vars[60], 0, "both centers are at X21");
});

test("early movement-clear actions preserve autonomous motion", () => {
  const engine = game(
    `${objects} stop.update(o0); stop.update(o1); follow.ego(o0, 3, f60); stop.motion(o0); follow.ego(o1, 3, f61); start.motion(o1); return;`,
    "2.089",
  );
  engine.tick();
  assert.deepEqual(
    engine.readObjects().map((o) => o.motionMode),
    [2, 2],
  );
});

test("early inventory display acknowledges without changing v25", () => {
  const engine = game("assignn(v25, 77); get(0); set(f13); status(); return;", "2.089");
  engine.tick();
  engine.modalKey(13);
  assert.equal(engine.vars[25], 77);
});

test("3.002.086 reports the left boundary on an exact-zero proposal", () => {
  const engine = game(
    `
    if (!isset(f200)) { set(f200); ${objects} erase(o1); position(o0, 1, 100); return; }
    assignn(v60, 7); set.dir(o0, v60); return;
  `,
    "3.002.086",
  );
  engine.tick();
  engine.tick();
  assert.equal(engine.screenObjects[0]?.x, 0);
  assert.equal(engine.vars[2], 4);
});

test("2.089 said does not treat word 9999 as a tail wildcard", () => {
  const dictionary = new Map([
    ["tail", 9999],
    ["look", 10],
  ]);
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `
    #message 1 "look"
    set.string(s1, 1); parse(s1);
    if (said("tail")) { set(f200); }
    return;
  `,
      { dictionary },
    ).payload,
  );
  const engine = new Engine(container, host, dictionary, { profile: "2.089" });
  engine.tick();
  assert.equal(engine.flags[200], 0);
});

test("v3 extension dispatch consumes its profile operands and saves the menu gate", () => {
  const engine = game(
    "hide.mouse(); allow.menu(1); show.mouse(); fence.mouse(1, 2, 3, 4); mouse.posn(v60, v61); hold.key(); release.key(); assignn(v62, 42); return;",
    "3.002.149",
  );
  engine.tick();
  assert.equal(engine.vars[62], 42);
  assert.equal(engine.releaseGate, 0);
  assert.equal(decodeSave(engine.serialize(), PROFILES["3.002.149"]).menuGate, 1);
  const early = game("hide.mouse(42); assignn(v62, 17); return;", "3.002.086");
  early.tick();
  assert.equal(early.vars[62], 17);
});
