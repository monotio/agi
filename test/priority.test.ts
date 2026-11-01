import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";
import { priorityForY } from "../src/runtime/priority.ts";
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

/**
 * Each row is positioned, then redrawn so the same-script draw placement runs
 * the footprint scan that assigns the band priority before get.priority reads
 * it. An undrawn object's placement is deferred to its update pass, so the
 * preamble keeps ego drawn, re-running on every room entry (f5).
 */
function sample(rows: readonly number[]): string {
  return `if (!isset(f210) || isset(f5)) { set(f210); load.view(1); animate.obj(o0); set.view(o0, 1); position(o0, 80, 80); draw(o0); ignore.horizon(o0); }
${rows
  .map((y, i) => `  position(o0, 80, ${y}); erase(o0); draw(o0); get.priority(o0, v${60 + i});`)
  .join("\n")}`;
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

test("accepted restart keeps the priority bands set.pri.base built", () => {
  // The priority base and its table are outside the restart's write set
  // (KQ3 2.936 DS:0x124a; docs/fidelity.md "Original restart state boundary").
  const engine = game(`
    if (!isset(f6)) { set.pri.base(68); set(f16); restart.game(); }
    ${sample([47, 60, 68])}
    return;
  `);
  engine.tick();
  engine.tick();
  assert.deepEqual(Array.from(engine.vars.slice(60, 63)), [4, 4, 5]);
});

const objects = `
  load.view(1); load.view(2);
  animate.obj(o0); animate.obj(o1);
  set.view(o0, 1); set.view(o1, 2);
  ignore.objs(o0); ignore.objs(o1);
  position(o0, 20, 100); position(o1, 19, 100);
  draw(o0); draw(o1);
  stop.cycling(o0); stop.cycling(o1);
  assignn(v60, 1); step.size(o0, v60); step.time(o0, v60); step.size(o1, v60); step.time(o1, v60);
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
  engine.patchResources([
    { kind: "picture", num: 1, payload: new Uint8Array([0xf0, 1, 0xf9, 1, 0xfa, 20, 30, 0xff]) },
  ]);
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
  engine.patchResources([
    {
      kind: "view",
      num: 1,
      payload: new Uint8Array([0, 0, 1, 0, 0, 7, 0, 0xc1, 3, 0, 2, 1, 0, 0x11, 0x21, 0]),
    },
  ]);
  engine.tick();
  assert.deepEqual(
    Array.from(engine.getFrame().visual.slice(100 * 160 + 20, 100 * 160 + 22)),
    [1, 2],
  );
});

test("nonpacked shared views mirror at blitting after loop selections and remain stable on frame observation", () => {
  const engine = game(`
    load.view(1); animate.obj(o0); set.view(o0, 1); position(o0, 20, 100);
    draw(o0); stop.cycling(o0); fix.loop(o0);
    set.loop(o0, 1); set.loop(o0, 2);
    return;
  `);
  // docs/fidelity.md F-VIEWS-01: on 2.936, overlay InsertObj calls
  // MirrorCell; SetLoop/SetCel do not. These three aliases
  // start at orientation 0 with row [1, 2]. Selecting 1 then 2 without an
  // intervening blit leaves that row untouched until InsertObj reverses it
  // once to [2, 1] for loop 2. Frame reads preserve the composed result.
  engine.patchResources([
    {
      kind: "view",
      num: 1,
      payload: new Uint8Array([
        0, 0, 3, 0, 0, 11, 0, 11, 0, 11, 0, 1, 3, 0, 2, 1, 0x80, 0x11, 0x21, 0,
      ]),
    },
  ]);
  engine.tick();
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(
      Array.from(engine.getFrame().visual.slice(100 * 160 + 20, 100 * 160 + 22)),
      [2, 1],
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
  assert.equal(engine.vars[60], 32, "(158 + 130) modulo 256 after 2.089 horizon placement at Y37");
  const differentWidths = game(`${objects} distance(o0, o1, v60); return;`);
  differentWidths.patchResources([
    {
      kind: "view",
      num: 2,
      payload: buildView({ loops: [{ cels: [{ width: 4, height: 1, pixels: [2, 2, 2, 2] }] }] }),
    },
  ]);
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

// The pure band function the engine and the PICTURE editor's band guides share,
// hand-computed from 5 + floor((y - base) * 10 / (168 - base)).
test("priorityForY maps the default base 48 to bands 4..14", () => {
  assert.equal(priorityForY(47), 4); // above the base
  assert.equal(priorityForY(48), 5); // 5 + floor(0 / 120)
  assert.equal(priorityForY(59), 5); // 5 + floor(110 / 120)
  assert.equal(priorityForY(60), 6); // 5 + floor(120 / 120)
  assert.equal(priorityForY(167), 14); // 5 + floor(1190 / 120)
  assert.equal(priorityForY(167, 48), 14);
});

test("priorityForY follows a non-default base", () => {
  assert.equal(priorityForY(59, 60), 4);
  assert.equal(priorityForY(60, 60), 5);
  assert.equal(priorityForY(113, 60), 9); // 5 + floor(530 / 108)
  assert.equal(priorityForY(114, 60), 10); // 5 + floor(540 / 108)
  assert.equal(priorityForY(167, 60), 14); // 5 + floor(1070 / 108)
});

test("MakeObjList PriToY uses (pri - 5) * 12 + 48 before set.pri.base, 168 on 2.936/3.002.086 table mode, and downward pri_tbl scan on 3.002.102/149 table mode", () => {
  // docs/fidelity.md F-VIEWS-06. o0 has fixed priority 9 at (20, 96); o1 sits at
  // y = 97 with its band priority 9 (rows 96..107). Both paint at priority 9, so
  // the later draw wins their overlap at (20, 96). Default table: PriToY(9) =
  // (9 - 5) * 12 + 48 = 96 sorts before o1's baseline 97, so o1's color 2 wins.
  const defaultMode = game(
    `${objects} position(o0, 20, 96); position(o1, 20, 97); set.priority(o0, 9); return;`,
    "2.936",
  );
  defaultMode.tick();
  assert.equal(
    defaultMode.getFrame().visual[96 * 160 + 20],
    2,
    "default mode: PriToY(9)=96 sorts before baseline y=97",
  );

  // On 2.936 and 3.002.086 after set.pri.base(48), default_pri_flag == 0 and PriToY starts
  // at y = 168 (DS:[pri_tbl + 168] == 0 < 9), returning 168. Now o0 (key 168) draws AFTER
  // o1 (key 97), so o0's color (1) wins the equal-priority overlap at (20, 96)!
  const tableMode2936 = game(
    `set.pri.base(48); ${objects} position(o0, 20, 96); position(o1, 20, 97); set.priority(o0, 9); return;`,
    "2.936",
  );
  tableMode2936.tick();
  assert.equal(
    tableMode2936.getFrame().visual[96 * 160 + 20],
    1,
    "2.936 table mode: PriToY(9)=168 sorts after baseline y=97",
  );

  // On 3.002.149 after set.pri.base(48), PriToY starts at y = 167 and decrements while
  // pri_tbl[y] >= 9, returning y = 95. So o0 (key 95) draws BEFORE o1 (key 97), and o1 (2) wins!
  const tableMode3149 = game(
    `set.pri.base(48); ${objects} position(o0, 20, 96); position(o1, 20, 97); set.priority(o0, 9); return;`,
    "3.002.149",
  );
  tableMode3149.tick();
  assert.equal(
    tableMode3149.getFrame().visual[96 * 160 + 20],
    2,
    "3.002.149 table mode: PriToY(9)=95 sorts before baseline y=97",
  );
});

test("InsertObj runs MirrorCell per object during frame composition so two objects sharing a mirrored view draw in their own loop orientations", () => {
  const engine = game(`
    load.view(1);
    animate.obj(o0); set.view(o0, 1); position(o0, 10, 100); fix.loop(o0); set.loop(o0, 0); draw(o0); stop.cycling(o0);
    animate.obj(o1); set.view(o1, 1); position(o1, 30, 100); fix.loop(o1); set.loop(o1, 1); draw(o1); stop.cycling(o1);
    return;
  `);
  engine.patchResources([
    {
      kind: "view",
      num: 1,
      payload: new Uint8Array([0, 0, 2, 0, 0, 9, 0, 9, 0, 1, 3, 0, 2, 1, 0x80, 0x11, 0x21, 0]),
    },
  ]);
  engine.tick();
  const frame = engine.getFrame();
  assert.deepEqual(
    Array.from(frame.visual.slice(100 * 160 + 10, 100 * 160 + 12)),
    [1, 2],
    "o0 at loop 0 draws unmirrored [1, 2]",
  );
  assert.deepEqual(
    Array.from(frame.visual.slice(100 * 160 + 30, 100 * 160 + 32)),
    [2, 1],
    "o1 at loop 1 draws mirrored [2, 1]",
  );
});

test("PriToY's closed form is a signed word, so fixed priority 0 draws before every baseline", () => {
  // docs/fidelity.md F-VIEWS-06: PriToY returns (0 - 5) * 12 + 48 = -12 as a
  // 16-bit word and MakeObjList picks the smallest key with a signed compare.
  // Picture 0 fills the priority channel with control value 2 (signal) and
  // draws control 0 along row 167, so every scan ends holding 0 (the PC rule,
  // F-VIEWS-07) and both objects paint all their pixels: draw order alone
  // decides the overlap at (20, 96).
  const engine = game(
    `load.pic(v0); draw.pic(v0); show.pic(); ${objects} position(o0, 20, 96); position(o1, 20, 97); set.priority(o0, 0); return;`,
    "2.917",
  );
  engine.patchResources([
    {
      kind: "picture",
      num: 0,
      payload: Uint8Array.of(0xf2, 2, 0xf8, 0, 0, 0xf2, 0, 0xf6, 0, 167, 159, 167, 0xff),
    },
  ]);
  engine.tick();
  const frame = engine.getFrame();
  assert.equal(frame.priority[96 * 160 + 20], 2, "the control value survives both paints");
  assert.equal(frame.visual[95 * 160 + 20], 1, "o0 paints at fixed priority 0");
  assert.equal(frame.visual[96 * 160 + 20], 2, "o0 (key -12) draws before o1 (key 97)");
});

test("a restored replay state keeps set.pri.base's PriToY even at base 48", () => {
  // set.pri.base(48) rebuilds a table equal to the default one, yet PriToY
  // leaves the closed form (docs/fidelity.md F-VIEWS-06): on 2.936 o0's fixed
  // priority 9 keys 168 and draws after o1 (baseline 97), so o0's color 1 wins.
  const source = `if (!isset(f200)) { set(f200); set.pri.base(48); ${objects} position(o0, 20, 96); position(o1, 20, 97); set.priority(o0, 9); } return;`;
  const live = game(source, "2.936");
  live.tick();
  assert.equal(live.getFrame().visual[96 * 160 + 20], 1);
  const image = live.recordingImage()!;
  const replay = JSON.parse(JSON.stringify(live.captureReplayState()));
  const restored = game(source, "2.936");
  restored.restoreImage(image);
  restored.restoreReplayState(replay);
  restored.tick();
  assert.equal(restored.getFrame().visual[96 * 160 + 20], 1);
});
