import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROFILES } from "../src/runtime/profile.ts";
import { planRoute, testRoute, type RouteInput } from "../src/studio/route.ts";
import { buildTutorial } from "../games/adventure-department/game.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildView } from "../src/view/view.ts";

const at = (x: number, y: number): number => y * 160 + x;

function plane(paint: (set: (x0: number, x1: number, y: number, value: number) => void) => void) {
  const priority = new Uint8Array(160 * 168).fill(4);
  paint((x0, x1, y, value) => priority.fill(value, at(x0, y), at(x1, y) + 1));
  return priority;
}

const route = (over: Partial<RouteInput>): RouteInput => ({
  priority: plane(() => {}),
  from: { x: 10, y: 140 },
  to: { x: 20, y: 140 },
  egoWidth: 1,
  egoHeight: 1,
  observeBlocks: true,
  waterGate: null,
  horizon: 36,
  profile: PROFILES["2.936"],
  ...over,
});

/** Every cell direction input visits along a path: diagonal toward each point, then straight. */
function cells(path: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  const out = [path[0]!];
  for (let i = 1; i < path.length; i++) {
    let { x, y } = path[i - 1]!;
    const to = path[i]!;
    while (x !== to.x || y !== to.y) {
      x += Math.sign(to.x - x);
      y += Math.sign(to.y - y);
      out.push({ x, y });
    }
  }
  return out;
}

describe("planRoute", () => {
  it("an open floor gives a direct path from the start to the target", () => {
    const result = planRoute(route({}));
    assert.deepEqual(result.path, [
      { x: 10, y: 140 },
      { x: 20, y: 140 },
    ]);
    assert.match(result.reason, /estimate/);
  });

  it("a wall below the horizon has no route; a one-row gap is the only way through", () => {
    const wall = plane((set) => {
      for (let y = 37; y < 168; y++) set(80, 80, y, 0);
    });
    const blocked = planRoute(route({ priority: wall, to: { x: 120, y: 140 } }));
    assert.equal(blocked.path, null);
    assert.match(blocked.reason, /no route/i);

    const gap = wall.slice();
    gap[at(80, 100)] = 4;
    const through = planRoute(route({ priority: gap, to: { x: 120, y: 140 } }));
    assert.ok(through.path, through.reason);
    const crossing = cells(through.path).filter((cell) => cell.x === 80);
    assert.deepEqual(crossing, [{ x: 80, y: 100 }], "the path crosses the wall only at its gap");
    assert.deepEqual(through.path.at(-1), { x: 120, y: 140 });
  });

  it("a start or target the actor cannot stand on is refused with its reason", () => {
    const priority = plane((set) => set(10, 10, 140, 0));
    assert.match(planRoute(route({ priority })).reason, /start .* barrier/);
    assert.match(planRoute(route({ to: { x: 20, y: 30 } })).reason, /target .* horizon/);
  });

  it("an exact-zero left edge is a border crossing under 3.002.086", () => {
    // A barrier row with its only opening at x=0.
    const priority = plane((set) => set(1, 159, 100, 0));
    const input = route({ priority, from: { x: 10, y: 120 }, to: { x: 10, y: 80 } });
    const open = planRoute(input);
    assert.ok(open.path?.some((point) => point.x === 0));
    const border = planRoute({ ...input, profile: PROFILES["3.002.086"] });
    assert.equal(border.path, null, "stepping onto x=0 reports border 4 in that build");
  });
});

describe("testRoute on the tutorial", () => {
  const tutorial = buildTutorial();
  const game = new Map(Object.entries(tutorial.files));

  it("room 2: the engine walks from the west doorway to the lever plate", () => {
    const result = testRoute({ game, room: 2, from: { x: 18, y: 151 }, to: { x: 30, y: 140 } });
    assert.equal(result.outcome, "reached", result.reason);
    assert.equal(result.reached, true);
    assert.equal(result.room, 2);
    assert.deepEqual(result.end, { x: 30, y: 140 });
    // Eleven diagonal steps reach (29,140) and one east step the plate: at
    // least twelve movement updates, whatever direction changes cost.
    assert.ok(result.steps >= 12, `ran ${result.steps} movement updates`);
  });

  it("room 1: the velvet rope stops a walk to the mural and says it is blocked", () => {
    const result = testRoute({ game, room: 1, from: { x: 18, y: 151 }, to: { x: 78, y: 116 } });
    assert.equal(result.reached, false);
    assert.equal(result.outcome, "blocked");
    assert.match(result.reason, /blocked/i);
    assert.equal(result.room, 1);
    assert.ok(
      result.end.y > 121,
      `ego stays below the rope line, at ${JSON.stringify(result.end)}`,
    );
  });

  it("a walk after a flag set still runs, and returns its frames on request", () => {
    // f31 set: the lever is already down and the awake robot waves.
    const result = testRoute({
      game,
      room: 2,
      from: { x: 18, y: 151 },
      to: { x: 30, y: 140 },
      flags: [{ id: 31, value: true }],
      frames: true,
    });
    assert.equal(result.outcome, "reached", result.reason);
    // A PNG signature: 0x89 "PNG".
    assert.deepEqual([...(result.frames?.[0]?.subarray(0, 4) ?? [])], [0x89, 0x50, 0x4e, 0x47]);
  });

  it("an unstandable start is refused before any walk", () => {
    const result = testRoute({ game, room: 1, from: { x: 78, y: 121 }, to: { x: 30, y: 140 } });
    assert.equal(result.outcome, "start_blocked");
    assert.equal(result.reached, false);
    assert.equal(result.steps, 0);
  });
});

describe("testRoute outcomes", () => {
  // Room 1: ego 1x1 at (40,110); a posn() box at x 80-100 sends it to room 2
  // and one at y 130-140 opens a message window.
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xf0, 2, 0xf8, 0, 0, 0xff));
  game.putResource("picture", 2, Uint8Array.of(0xf0, 2, 0xf8, 0, 0, 0xff));
  game.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
  );
  const enter =
    "load.pic(v0);draw.pic(v0);show.pic();load.view(0);animate.obj(o0);set.view(o0,0);position(o0,40,110);draw(o0);accept.input();";
  for (const [num, source] of [
    [0, "if(equaln(v0,0)){new.room(1);}call.v(v0);return;"],
    [
      1,
      `#message 1 "Hi"\nif(isset(f5)){${enter}}if(posn(o0,80,100,100,120)){new.room(2);}if(posn(o0,40,130,60,140)){print(1);}return;`,
    ],
    [2, `if(isset(f5)){${enter}}return;`],
  ] as const)
    game.putResource("logic", num, assembleLogic(source, { dictionary: new Map() }).payload);

  it("a logic transition during the walk is a room change", () => {
    const result = testRoute({ game, room: 1, from: { x: 40, y: 110 }, to: { x: 120, y: 110 } });
    assert.equal(result.outcome, "room_changed", result.reason);
    assert.equal(result.room, 2);
    assert.equal(result.reached, false);
  });

  it("a window the walk opens stops it for input", () => {
    const result = testRoute({ game, room: 1, from: { x: 40, y: 110 }, to: { x: 50, y: 150 } });
    assert.equal(result.outcome, "modal", result.reason);
    assert.equal(result.room, 1);
    assert.equal(result.end.y, 130, "the first baseline inside the box opens it");
  });
});
