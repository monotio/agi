import assert from "node:assert/strict";
import { test } from "node:test";
import { GAME_TESTS_FILE, readStoredTests, runGameTests } from "../src/agent/gameTests.ts";
import { createAgentSessionState } from "../src/agent/tools.ts";
import { openContainer } from "../src/container/container.ts";
import { TUTORIAL_GAME_TESTS } from "../games/adventure-department/tests.ts";
import { renderPicture, type PictureFillDiagnostic } from "../src/picture/renderer.ts";
import { compilePictureSource } from "../src/picture/source.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { createPictureSurface, SCREEN_WIDTH } from "../src/types.ts";
import { buildView, parseView } from "../src/view/view.ts";
import { GAME_CATALOG } from "../app/src/gameCatalog.ts";
import { gameRevision } from "../app/src/gameMetadata.ts";
import {
  TUTORIAL_LOGIC_SOURCES,
  TUTORIAL_PICTURE_SOURCES,
  TUTORIAL_VIEW_SOURCES,
  buildTutorial,
} from "../games/adventure-department/game.ts";

class TutorialHost implements EngineHost {
  prints: string[] = [];
  input: (string | null)[] = [];
  keys: number[] = [];
  priorityScreens = 0;
  priorityNotes: string[] = [];
  displays: { row: number; col: number; text: string }[] = [];
  engine?: Engine;

  print(text: string): void {
    this.prints.push(text);
    this.engine?.ackPrint();
  }
  displayAt(row: number, col: number, text: string): void {
    this.displays.push({ row, col, text });
  }
  statusLine(): void {}
  takeInputLine(): string | null {
    return this.input.shift() ?? null;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
  showPriScreen(): void {
    this.priorityScreens += 1;
    this.priorityNotes.push(this.engine?.textRow(23) ?? "");
    this.engine?.ackPrint();
  }
}

test("generated walking cels keep a common ground-contact row in every direction", () => {
  for (const loop of TUTORIAL_VIEW_SOURCES[0]!.loops) {
    for (const cel of loop.cels ?? []) {
      assert.ok(
        cel.pixels
          .slice((cel.height - 1) * cel.width)
          .some((color) => color !== cel.transparentColor),
        "a supporting foot must reach the declared baseline; changing direction must not lift ego",
      );
    }
  }
});

test("character animation preserves fixed masses and changes only the intended features", () => {
  const robotCels = TUTORIAL_VIEW_SOURCES[2]!.loops[0]!.cels!;
  const fixedRobot = Array.from(robotCels[0]!.pixels);
  for (let cel = 1; cel < robotCels.length; cel++) {
    const candidate = Array.from(robotCels[cel]!.pixels);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 14; x++) {
        if (x <= 2 && y >= 6 && y <= 21) continue;
        const index = y * 14 + x;
        assert.equal(
          candidate[index],
          fixedRobot[index],
          `robot cel ${cel} moved fixed pixel ${x},${y}`,
        );
      }
    }
  }

  const felixCels = TUTORIAL_VIEW_SOURCES[3]!.loops[0]!.cels!;
  const open = Array.from(felixCels[0]!.pixels);
  const closed = Array.from(felixCels[1]!.pixels);
  const changed = open.flatMap((color, index) => (color === closed[index] ? [] : [index]));
  assert.deepEqual(
    changed,
    [6 * 14 + 4, 6 * 14 + 5, 6 * 14 + 8, 6 * 14 + 9],
    "Felix's blink changes only the two compact eye clusters",
  );
});

test("every ego walk cel keeps clothing distinct from the room floor and wall", () => {
  const { engine } = startTutorial();
  const ego = engine.readObjects()[0]!;
  const floorColor = engine.surface.visual[ego.y * SCREEN_WIDTH + ego.x + (ego.width >> 1)]!;
  const wallColor = engine.surface.visual[80 * SCREEN_WIDTH + 80]!;
  const view = parseView(buildView(TUTORIAL_VIEW_SOURCES[0]!));

  for (let loop = 0; loop < view.loops.length; loop++) {
    for (let celIndex = 0; celIndex < view.loops[loop]!.cels.length; celIndex++) {
      const cel = view.loops[loop]!.cels[celIndex]!;
      let opaqueLegPixels = 0;
      let opaqueTorsoPixels = 0;
      for (let y = 9; y <= 18; y++) {
        for (let x = 0; x < cel.width; x++) {
          const color = cel.pixels[y * cel.width + x]!;
          if (color === cel.transparentColor) continue;
          opaqueTorsoPixels++;
          assert.notEqual(
            color,
            wallColor,
            `ego loop ${loop} cel ${celIndex} loses torso pixel ${x},${y} against the wall`,
          );
        }
      }
      for (let y = 19; y <= 28; y++) {
        for (let x = 0; x < cel.width; x++) {
          const color = cel.pixels[y * cel.width + x]!;
          if (color === cel.transparentColor) continue;
          opaqueLegPixels++;
          assert.notEqual(
            color,
            floorColor,
            `ego loop ${loop} cel ${celIndex} loses leg pixel ${x},${y} against the floor`,
          );
        }
      }
      assert.ok(opaqueTorsoPixels > 0, `ego loop ${loop} cel ${celIndex} has no visible torso`);
      assert.ok(opaqueLegPixels > 0, `ego loop ${loop} cel ${celIndex} has no visible legs`);
    }
  }
});

function enter(engine: Engine, host: TutorialHost, command: string): void {
  host.input.push(command);
  engine.tick();
}

function startTutorial(): { engine: Engine; host: TutorialHost } {
  const game = buildTutorial();
  const host = new TutorialHost();
  const engine = new Engine(
    openContainer(new Map(Object.entries(game.files))),
    host,
    new Map(game.words),
  );
  host.engine = engine;
  engine.tick();
  return { engine, host };
}

function walkUntilRoom(engine: Engine, host: TutorialHost, key: number, room: number): void {
  host.keys.push(key);
  for (let cycle = 0; cycle < 260 && engine.vars[0] !== room; cycle++) engine.tick();
  assert.equal(engine.vars[0], room, `arrow-key travel did not reach room ${room}`);
}

/** Walk with one arrow key until ego's x satisfies `reached`; the repairs need the player nearby. */
function walkUntilX(
  engine: Engine,
  host: TutorialHost,
  key: number,
  reached: (x: number) => boolean,
): void {
  // One press starts walking; a second press of the same arrow would stop it.
  if (engine.readObjects()[0]!.direction === 0) host.keys.push(key);
  for (let cycle = 0; cycle < 400 && !reached(engine.readObjects()[0]!.x); cycle++) engine.tick();
  assert.ok(reached(engine.readObjects()[0]!.x), "arrow-key travel did not reach the exhibit");
}

function visualDifferences(
  actual: Uint8Array,
  background: Uint8Array,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  let differences = 0;
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const index = y * SCREEN_WIDTH + x;
      if (actual[index] !== background[index]) differences++;
    }
  }
  return differences;
}

function visualRegion(visual: Uint8Array, x1: number, y1: number, x2: number, y2: number): string {
  const rows: string[] = [];
  for (let y = y1; y <= y2; y++) {
    let row = "";
    for (let x = x1; x <= x2; x++) row += visual[y * SCREEN_WIDTH + x]!.toString(16);
    rows.push(row);
  }
  return rows.join("/");
}

test("Adventure Department is a self-contained, editable AGI 2.936 game", async () => {
  const game = buildTutorial();
  assert.equal(game.title, "Adventure Department");
  assert.equal(game.roomGeneration, false);
  assert.deepEqual(game.metadata, {
    description: "Learn pictures, sprites and priority in a three-room tutorial.",
    author: "Monotio",
    license: "MIT",
  });
  assert.ok(game.files["LOGDIR"]);
  assert.ok(game.files["PICDIR"]);
  assert.ok(game.files["VIEWDIR"]);
  assert.ok(game.files["VOL.0"]);
  assert.ok(game.files["WORDS.TOK"]);
  assert.ok(game.files["OBJECT"]);
  assert.deepEqual(Object.keys(TUTORIAL_LOGIC_SOURCES).map(Number), [0, 1, 2, 3]);
  assert.deepEqual(Object.keys(TUTORIAL_PICTURE_SOURCES).map(Number), [1, 2, 3, 4]);
  assert.deepEqual(Object.keys(TUTORIAL_VIEW_SOURCES).map(Number), [0, 1, 2, 3, 4, 5]);
  assert.equal(game.project?.authoringState?.["sources"] instanceof Object, true);

  const catalogEntry = GAME_CATALOG.find(({ id }) => id === "adventure-department");
  assert.equal(catalogEntry?.version, "1.0.1");
  assert.equal(catalogEntry?.author, "Monotio");
  const catalogGame = await catalogEntry!.load();
  assert.ok(catalogGame.project?.authoringState?.["sources"]);
});

/** Overlay pictures render over the room whose logic draws them; every other picture is a room backdrop. */
const OVERLAY_HOSTS: Readonly<Record<number, number>> = { 4: 1 };

test("every tutorial picture fill seed lands on a white interior", () => {
  const blocked: string[] = [];
  for (const [numText, source] of Object.entries(TUTORIAL_PICTURE_SOURCES)) {
    const num = Number(numText);
    const host = OVERLAY_HOSTS[num];
    assert.ok(
      host !== undefined || Object.hasOwn(TUTORIAL_LOGIC_SOURCES, num),
      `picture ${num} is neither a room backdrop nor a declared overlay`,
    );
    const surface = createPictureSurface();
    if (host !== undefined) {
      renderPicture(compilePictureSource(TUTORIAL_PICTURE_SOURCES[host]!).bytes, surface);
    }
    const fillDiagnostics: PictureFillDiagnostic[] = [];
    renderPicture(compilePictureSource(source).bytes, surface, {
      overlay: host !== undefined,
      fillDiagnostics,
    });
    for (const seed of fillDiagnostics) {
      // The predicate write_picture reports to the model as "fill seeds did nothing".
      if (seed.filledCells === 0 && seed.seedValue !== seed.selectedValue) {
        blocked.push(
          `picture ${num} ${seed.channel} seed ${seed.x},${seed.y} selected ${seed.selectedValue}, found ${seed.seedValue} (needs ${seed.targetValue})`,
        );
      }
    }
  }
  assert.deepEqual(blocked, [], `blocked fill seeds:\n${blocked.join("\n")}`);
});

// The library keys a stored release on (gameId, revision, version): changed
// resources at the same catalog version would appear beside a player's saved
// release instead of replacing it. This release is unpublished, so the version
// stays 1.0.0 and only the pin moves when the compiled bytes change.
test("tutorial resources are pinned to the released catalog version", async () => {
  assert.equal(
    await gameRevision(buildTutorial().files),
    "dcd6f07a28acda1ec6b2c1e4508fe3348080fc463b14f47afbb0e58214aa26ee",
    "tutorial resources changed: bump the GAME_CATALOG version in app/src/gameCatalog.ts and re-pin this revision",
  );
});

test("the complete tutorial teaches movement, pictures, sprites, logic, and priorities", () => {
  const game = buildTutorial();
  const host = new TutorialHost();
  const engine = new Engine(
    openContainer(new Map(Object.entries(game.files))),
    host,
    new Map(game.words),
  );
  host.engine = engine;

  engine.tick();
  assert.equal(engine.vars[0], 1);
  assert.match(
    host.displays.map(({ text }) => text).join(" "),
    /Fix 3 exhibits.*HELP.*PAINT MURAL/i,
    "the hint row states the goal and the first repair",
  );
  assert.match(engine.textRow(2), /HELP.*PAINT MURAL/i);

  const startX = engine.readObjects()[0]!.x;
  host.keys.push(0x4d00);
  engine.tick();
  assert.ok(engine.readObjects()[0]!.x > startX, "right arrow moves the apprentice");

  enter(engine, host, "help");
  assert.match(host.prints.at(-1) ?? "", /Useful commands.*PAINT MURAL/i);
  const openingText = host.displays.map(({ text }) => text).join(" ");
  for (let cycle = 0; cycle < 20; cycle++) engine.tick();
  assert.equal(engine.vars[0], 1);
  assert.ok(
    host.displays
      .map(({ text }) => text)
      .join(" ")
      .startsWith(openingText),
  );
  assert.match(engine.textRow(2), /HELP.*PAINT MURAL/i);
  const resumed = engine.serialize();
  engine.restoreImage(resumed);
  engine.tick();
  assert.match(engine.textRow(2), /HELP.*PAINT MURAL/i, "autosave resume redraws the local lesson");
  enter(engine, host, "look room");
  assert.match(host.prints.at(-1) ?? "", /ROOM.*numbered.*PICTURE.*LOGIC.*new\.room\(2\)/i);

  const muralBefore = engine.getFrame().visual[65 * SCREEN_WIDTH + 80];
  enter(engine, host, "paint mural");
  assert.equal(engine.flags[30], 0, "the mural cannot be painted from across the room");
  assert.match(host.prints.at(-1) ?? "", /too far away.*frame/i);
  walkUntilX(engine, host, 0x4d00, (x) => x >= 60);
  enter(engine, host, "paint mural");
  assert.equal(engine.flags[30], 1);
  assert.notEqual(engine.getFrame().visual[65 * SCREEN_WIDTH + 80], muralBefore);
  assert.match(host.prints.at(-1) ?? "", /vector/i);

  enter(engine, host, "east");
  assert.equal(engine.vars[0], 2);
  assert.equal(engine.readObjects()[1]!.view, 1);
  enter(engine, host, "look logic");
  assert.match(host.prints.at(-1) ?? "", /Logic selects.*view.*loop.*cel/i);
  enter(engine, host, "pull lever");
  assert.equal(engine.flags[31], 1);
  assert.equal(engine.readObjects()[1]!.view, 2);
  for (let cycle = 0; cycle < 16; cycle++) engine.tick();
  assert.match(host.prints.at(-1) ?? "", /condition/i);

  enter(engine, host, "east");
  assert.equal(engine.vars[0], 3);
  assert.equal(
    engine.surface.priority[90 * SCREEN_WIDTH + 85],
    11,
    "the counter is a priority-11 foreground",
  );
  const torsoInFront = visualDifferences(
    engine.getFrame().visual,
    engine.surface.visual,
    77,
    85,
    90,
    100,
  );
  assert.ok(torsoInFront > 0, "priority 15 puts the clerk's torso in front");

  enter(engine, host, "show priority");
  assert.equal(host.priorityScreens, 1);
  assert.match(host.priorityNotes[0]!, /Counter:11.*Felix:15/);
  enter(engine, host, "fix priority");
  assert.equal(engine.flags[32], 1);
  assert.equal(engine.flags[33], 1, "all three repairs trigger the ending");
  assert.equal(
    visualDifferences(engine.getFrame().visual, engine.surface.visual, 77, 85, 90, 100),
    0,
    "the counter now occludes the clerk's full torso",
  );
  assert.match(host.prints.at(-1) ?? "", /graduated/i);
  assert.match(host.prints.at(-2) ?? "", /priority 15 to 10/i);

  enter(engine, host, "west");
  assert.equal(engine.vars[0], 2, "the finished game remains freely explorable");
});

test("room geometry blocks closed walls and leaves only the intended side exits", () => {
  const { engine, host } = startTutorial();
  assert.equal(engine.horizon, 112, "the walkable floor begins at its visible top edge");

  const assertEdgeColor = (
    x1: number,
    x2: number,
    y1: number,
    y2: number,
    color: number,
    message: string,
  ): void => {
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        assert.equal(engine.surface.visual[y * SCREEN_WIDTH + x], color, `${message} at ${x},${y}`);
      }
    }
  };

  const room1Ego = engine.readObjects()[0]!;
  assert.deepEqual(
    { x: room1Ego.x, y: room1Ego.y, width: room1Ego.width, height: room1Ego.height },
    { x: 18, y: 151, width: 10, height: 32 },
  );
  assert.equal(engine.surface.priority[128 * SCREEN_WIDTH + 3], 0, "west wall is solid");
  assert.equal(engine.surface.priority[140 * SCREEN_WIDTH + 3], 0, "room 1 has no west exit");
  assert.equal(
    engine.surface.priority[128 * SCREEN_WIDTH + 156],
    0,
    "east wall is solid above the exit",
  );
  assert.ok(
    engine.surface.priority[140 * SCREEN_WIDTH + 156]! >= 4,
    "room 1 east corridor is walkable",
  );
  assertEdgeColor(0, 7, 94, 167, 6, "room 1 closed west wall stays plain brown");
  assertEdgeColor(152, 159, 94, 128, 6, "room 1 east wall reaches its native base");
  assertEdgeColor(152, 159, 129, 167, 1, "room 1 east passage carries floor to the edge");

  host.keys.push(0x4800);
  for (let cycle = 0; cycle < 55; cycle++) engine.tick();
  assert.equal(
    engine.readObjects()[0]!.y,
    126,
    "the angled wall base stops ego before the rear-wall horizon",
  );
  host.keys.push(0x4b00);
  for (let cycle = 0; cycle < 20; cycle++) engine.tick();
  assert.equal(engine.vars[0], 1);
  assert.equal(
    engine.readObjects()[0]!.x,
    17,
    "the apprentice stops along the visible angled wall",
  );
  assert.equal(engine.readObjects()[0]!.cycling, false, "ego rests when a wall stops movement");

  const fresh = startTutorial();
  walkUntilRoom(fresh.engine, fresh.host, 0x4d00, 2);
  assert.equal(fresh.engine.readObjects()[0]!.x, 18, "eastward travel enters on the left");
  fresh.engine.tick();
  assert.equal(fresh.engine.vars[0], 2, "entry placement does not immediately bounce rooms");
  for (const x of [3, 156]) {
    assert.equal(fresh.engine.surface.visual[119 * SCREEN_WIDTH + x], 6);
    assert.equal(fresh.engine.surface.visual[120 * SCREEN_WIDTH + x], 1);
    assert.equal(fresh.engine.surface.visual[167 * SCREEN_WIDTH + x], 1);
    assert.equal(fresh.engine.surface.priority[119 * SCREEN_WIDTH + x], 0);
    assert.ok(fresh.engine.surface.priority[120 * SCREEN_WIDTH + x]! >= 4);
    assert.ok(fresh.engine.surface.priority[167 * SCREEN_WIDTH + x]! >= 4);
  }

  walkUntilRoom(fresh.engine, fresh.host, 0x4d00, 3);
  for (let y = 94; y <= 167; y++) {
    for (let x = 152; x <= 159; x++) {
      assert.equal(
        fresh.engine.surface.visual[y * SCREEN_WIDTH + x],
        6,
        `room 3 closed east wall stays plain brown at ${x},${y}`,
      );
    }
  }
  assert.equal(fresh.engine.surface.visual[124 * SCREEN_WIDTH + 3], 6);
  assert.equal(fresh.engine.surface.visual[125 * SCREEN_WIDTH + 3], 1);
  assert.equal(fresh.engine.surface.visual[167 * SCREEN_WIDTH + 3], 1);
  assert.equal(fresh.engine.surface.priority[124 * SCREEN_WIDTH + 3], 0);
  assert.ok(fresh.engine.surface.priority[125 * SCREEN_WIDTH + 3]! >= 4);
  assert.ok(fresh.engine.surface.priority[167 * SCREEN_WIDTH + 3]! >= 4);
});

test("room transitions place ego on the correct side and closed directions explain themselves", () => {
  const { engine, host } = startTutorial();

  enter(engine, host, "west");
  assert.equal(engine.vars[0], 1);
  assert.match(host.prints.at(-1) ?? "", /west wall.*solid.*east/i);

  enter(engine, host, "east");
  assert.deepEqual(
    { room: engine.vars[0], previous: engine.vars[1], x: engine.readObjects()[0]!.x },
    { room: 2, previous: 1, x: 18 },
  );
  enter(engine, host, "east");
  assert.deepEqual(
    { room: engine.vars[0], previous: engine.vars[1], x: engine.readObjects()[0]!.x },
    { room: 3, previous: 2, x: 18 },
  );

  enter(engine, host, "east");
  assert.equal(engine.vars[0], 3);
  assert.match(host.prints.at(-1) ?? "", /east wall.*west/i);
  assert.ok(engine.surface.priority[140 * SCREEN_WIDTH + 3]! >= 4);
  assert.equal(engine.surface.priority[140 * SCREEN_WIDTH + 156], 0);

  enter(engine, host, "west");
  assert.deepEqual(
    { room: engine.vars[0], previous: engine.vars[1], x: engine.readObjects()[0]!.x },
    { room: 2, previous: 3, x: 132 },
  );
  engine.tick();
  assert.equal(engine.vars[0], 2, "right-side entry remains in the destination room");
  enter(engine, host, "west");
  assert.deepEqual(
    { room: engine.vars[0], previous: engine.vars[1], x: engine.readObjects()[0]!.x },
    { room: 1, previous: 2, x: 132 },
  );
});

test("walking speed commands use one-pixel cadence and persist between rooms", () => {
  const sample = (command?: string): { distance: number; deltas: number[] } => {
    const { engine, host } = startTutorial();
    if (command !== undefined) enter(engine, host, command);
    const positions = [engine.readObjects()[0]!.x];
    host.keys.push(0x4d00);
    for (let cycle = 0; cycle < 32; cycle++) {
      engine.tick();
      positions.push(engine.readObjects()[0]!.x);
    }
    return {
      distance: positions.at(-1)! - positions[0]!,
      deltas: positions.slice(1).map((x, index) => x - positions[index]!),
    };
  };

  const normal = sample();
  const fast = sample("fast");
  const slow = sample("slow speed");
  assert.deepEqual(
    { normal: normal.distance, fast: fast.distance, slow: slow.distance },
    { normal: 20, fast: 32, slow: 16 },
    "32 50ms cycles yield 12.5, 20, and 10 pixels per second",
  );
  for (const [mode, deltas] of [
    ["normal", normal.deltas],
    ["fast", fast.deltas],
    ["slow", slow.deltas],
  ] as const) {
    assert.ok(
      deltas.every((delta) => delta === 0 || delta === 1),
      `${mode} speed must retain one-pixel collision checks`,
    );
  }

  const { engine, host } = startTutorial();
  const printsBefore = host.prints.length;
  enter(engine, host, "fast speed");
  assert.equal(engine.readObjects()[0]!.stepTime, 1);
  enter(engine, host, "east");
  assert.equal(engine.vars[0], 2);
  assert.equal(engine.readObjects()[0]!.stepTime, 1, "fast mode survives a room transition");
  enter(engine, host, "slow");
  assert.equal(engine.readObjects()[0]!.stepTime, 2);
  enter(engine, host, "east");
  assert.equal(engine.vars[0], 3);
  assert.equal(engine.readObjects()[0]!.stepTime, 2, "slow mode survives a room transition");
  enter(engine, host, "normal speed");
  assert.equal(engine.readObjects()[0]!.stepTime, 1);
  assert.equal(
    host.prints.length,
    printsBefore,
    "speed commands work in every room without a modal",
  );
});

test("movement and sprite animation use readable pacing and ego rests on an idle cel", () => {
  const { engine, host } = startTutorial();
  let ego = engine.readObjects()[0]!;
  assert.equal(engine.vars[10], 1, "logic cycles run every 50ms");
  assert.equal(ego.stepTime, 1, "normal cadence begins with a responsive movement cycle");
  assert.equal(ego.cycleTime, 6, "walking cels still change every 300ms");
  assert.equal(ego.cycling, false, "idle ego does not animate");

  host.keys.push(0x4d00);
  engine.tick();
  ego = engine.readObjects()[0]!;
  assert.equal(ego.cycling, false, "movement starts before the first walking-cel advance");
  engine.tick();
  ego = engine.readObjects()[0]!;
  assert.equal(ego.cycling, true);
  const walkingCel = ego.cel;
  for (let cycle = 0; cycle < 6; cycle++) engine.tick();
  assert.notEqual(engine.readObjects()[0]!.cel, walkingCel);

  host.keys.push(0x4d00);
  engine.tick();
  ego = engine.readObjects()[0]!;
  assert.equal(ego.direction, 0);
  assert.equal(ego.cycling, false);
  const restingCel = ego.cel;
  for (let cycle = 0; cycle < 6; cycle++) engine.tick();
  assert.equal(engine.readObjects()[0]!.cel, restingCel);

  enter(engine, host, "east");
  let robot = engine.readObjects()[1]!;
  assert.deepEqual(
    { x: robot.x, y: robot.y, width: robot.width, height: robot.height },
    { x: 98, y: 108, width: 14, height: 32 },
  );
  assert.equal(robot.cycleTime, 10, "the robot holds each dance pose for 500ms");
  assert.equal(robot.cycling, false, "the switched-off robot is still");
  enter(engine, host, "pull lever");
  robot = engine.readObjects()[1]!;
  assert.equal(robot.cycling, true);
  const firstDanceCel = robot.cel;
  for (let cycle = 0; cycle < 7; cycle++) engine.tick();
  assert.equal(engine.readObjects()[1]!.cel, firstDanceCel, "the dance does not flicker");
  for (let cycle = 0; cycle < 3; cycle++) engine.tick();
  assert.notEqual(engine.readObjects()[1]!.cel, firstDanceCel, "the dance visibly advances");
});

test("the lab lever sweeps around a fixed pivot and retains its repaired position", () => {
  const { engine, host } = startTutorial();
  enter(engine, host, "east");

  let lever = engine.readObjects().find(({ num }) => num === 2)!;
  assert.deepEqual(
    {
      view: lever.view,
      cel: lever.cel,
      x: lever.x,
      y: lever.y,
      width: lever.width,
      height: lever.height,
      priority: lever.priority,
      fixedPriority: lever.fixedPriority,
      cycling: lever.cycling,
    },
    {
      view: 4,
      cel: 0,
      x: 29,
      y: 105,
      width: 20,
      height: 30,
      priority: 15,
      fixedPriority: true,
      cycling: false,
    },
  );
  assert.equal(engine.getFrame().visual[78 * SCREEN_WIDTH + 30], 12, "off grip is bright red");
  const pivot = visualRegion(engine.getFrame().visual, 35, 98, 41, 103);

  const printsBefore = host.prints.length;
  enter(engine, host, "pull lever");
  assert.equal(engine.flags[31], 1);
  assert.equal(engine.vars[3], 10);
  lever = engine.readObjects().find(({ num }) => num === 2)!;
  assert.deepEqual(
    {
      cel: lever.cel,
      cycling: lever.cycling,
      cycleMode: lever.cycleMode,
      cycleTime: lever.cycleTime,
    },
    { cel: 0, cycling: true, cycleMode: 2, cycleTime: 4 },
  );
  assert.equal(host.prints.length, printsBefore, "success text waits until the sweep completes");

  const cels: number[] = [];
  const rendered = new Set<string>();
  for (let cycle = 0; cycle < 18; cycle++) {
    engine.tick();
    lever = engine.readObjects().find(({ num }) => num === 2)!;
    cels.push(lever.cel);
    const frame = engine.getFrame().visual;
    rendered.add(visualRegion(frame, 29, 76, 48, 105));
    assert.equal(
      visualRegion(frame, 35, 98, 41, 103),
      pivot,
      `cel ${lever.cel} keeps the fixed pivot`,
    );
  }
  assert.deepEqual(
    cels,
    [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3],
    "after the native end-of-loop startup delay, cycle.time 4 holds every cel for 200ms",
  );
  assert.ok(rendered.size >= 3, "the interpreter renders at least three distinct lever poses");
  assert.equal(lever.cycling, false);
  assert.equal(engine.getFrame().visual[78 * SCREEN_WIDTH + 41], 12, "on grip is bright red");
  assert.match(host.prints.at(-1) ?? "", /condition.*repair flag/i);

  const score = engine.vars[3];
  enter(engine, host, "pull lever");
  assert.equal(engine.vars[3], score, "repeated pulls do not score or restart the lever");
  assert.equal(engine.readObjects().find(({ num }) => num === 2)!.cel, 3);

  enter(engine, host, "east");
  enter(engine, host, "west");
  lever = engine.readObjects().find(({ num }) => num === 2)!;
  assert.deepEqual(
    { cel: lever.cel, cycling: lever.cycling, x: lever.x, y: lever.y },
    { cel: 3, cycling: false, x: 29, y: 105 },
    "room re-entry restores the repaired terminal cel",
  );

  const interrupted = startTutorial();
  enter(interrupted.engine, interrupted.host, "east");
  enter(interrupted.engine, interrupted.host, "pull lever");
  interrupted.engine.tick();
  interrupted.engine.tick();
  enter(interrupted.engine, interrupted.host, "east");
  enter(interrupted.engine, interrupted.host, "west");
  assert.equal(interrupted.engine.readObjects().find(({ num }) => num === 2)!.cel, 3);
  assert.equal(interrupted.engine.vars[3], 10, "an interrupted sweep retains its single score");
});

test("priority repair demonstrates scenery occlusion without changing ego depth", () => {
  const { engine, host } = startTutorial();
  enter(engine, host, "east");
  enter(engine, host, "east");

  const clerk = engine.readObjects()[1]!;
  assert.deepEqual(
    {
      x: clerk.x,
      y: clerk.y,
      width: clerk.width,
      height: clerk.height,
      priority: clerk.priority,
      fixed: clerk.fixedPriority,
    },
    { x: 77, y: 100, width: 14, height: 32, priority: 15, fixed: true },
  );
  const signal = engine.readObjects().find(({ num }) => num === 2)!;
  assert.deepEqual(
    {
      view: signal.view,
      cel: signal.cel,
      x: signal.x,
      y: signal.y,
      width: signal.width,
      height: signal.height,
      priority: signal.priority,
      fixed: signal.fixedPriority,
      cycling: signal.cycling,
    },
    {
      view: 5,
      cel: 0,
      x: 110,
      y: 74,
      width: 6,
      height: 4,
      priority: 15,
      fixed: true,
      cycling: false,
    },
    "the repair signal is a VIEW-backed lamp on the archive shelf",
  );
  assert.equal(engine.getFrame().visual[72 * SCREEN_WIDTH + 112], 4, "the unrepaired lamp is red");
  for (const [x, y] of [
    [56, 85],
    [118, 85],
    [57, 121],
    [117, 121],
    [85, 90],
  ] as const) {
    assert.equal(
      engine.surface.priority[y * SCREEN_WIDTH + x],
      11,
      `counter priority at ${x},${y}`,
    );
  }
  assert.equal(engine.surface.priority[122 * SCREEN_WIDTH + 85], 0, "counter base blocks passage");
  assert.equal(engine.surface.priority[115 * SCREEN_WIDTH + 56], 0, "counter side blocks passage");
  assert.equal(
    engine.surface.priority[150 * SCREEN_WIDTH + 83],
    4,
    "floor has no painted depth bands",
  );

  const headInFront = visualDifferences(
    engine.getFrame().visual,
    engine.surface.visual,
    77,
    69,
    90,
    84,
  );
  const torsoInFront = visualDifferences(
    engine.getFrame().visual,
    engine.surface.visual,
    77,
    85,
    90,
    100,
  );
  assert.ok(headInFront > 0, "the clerk's head clears the counter");
  assert.ok(torsoInFront > 0, "priority 15 incorrectly puts the torso in front");

  enter(engine, host, "fix priority");
  assert.equal(engine.readObjects()[1]!.priority, 10);
  assert.equal(engine.readObjects().find(({ num }) => num === 2)!.cel, 1);
  assert.equal(engine.getFrame().visual[72 * SCREEN_WIDTH + 112], 10, "the repaired lamp is green");
  assert.equal(
    visualDifferences(engine.getFrame().visual, engine.surface.visual, 77, 85, 90, 100),
    0,
    "the counter hides every opaque torso pixel",
  );
  assert.equal(
    visualDifferences(engine.getFrame().visual, engine.surface.visual, 77, 69, 90, 84),
    headInFront,
    "the head above the counter remains visible",
  );

  let ego = engine.readObjects()[0]!;
  assert.equal(ego.fixedPriority, false);
  assert.equal(ego.priority, 13, "ego uses automatic priority at baseline 151");

  host.keys.push(0x4d00);
  for (let cycle = 0; cycle < 120 && engine.readObjects()[0]!.x < 79; cycle++) engine.tick();
  assert.equal(engine.readObjects()[0]!.x, 79);
  host.keys.push(0x4800);
  for (let cycle = 0; cycle < 80 && engine.readObjects()[0]!.y > 123; cycle++) engine.tick();
  ego = engine.readObjects()[0]!;
  assert.deepEqual(
    { x: ego.x, y: ego.y, priority: ego.priority, fixed: ego.fixedPriority },
    { x: 79, y: 123, priority: 11, fixed: false },
    "the counter base stops ego where automatic priority draws in front",
  );
  assert.ok(
    visualDifferences(engine.getFrame().visual, engine.surface.visual, 79, 92, 88, 121) > 0,
    "equal-priority ego pixels remain visible across the counter",
  );

  enter(engine, host, "west");
  enter(engine, host, "east");
  assert.equal(engine.vars[0], 3);
  assert.equal(
    engine.readObjects().find(({ num }) => num === 2)!.cel,
    1,
    "room re-entry rebuilds the repaired lamp from the repair flag",
  );
  assert.equal(engine.getFrame().visual[72 * SCREEN_WIDTH + 112], 10);
});

test("Felix rests with open eyes and only closes them for a brief native cel blink", () => {
  const { engine, host } = startTutorial();
  enter(engine, host, "east");
  enter(engine, host, "east");

  const initial = engine.readObjects()[1]!;
  assert.equal(initial.cel, 0);
  const openCycles = engine.vars[59]!;
  assert.ok(openCycles >= 70 && openCycles <= 140, `open hold ${openCycles} is outside 70..140`);

  for (let cycle = 1; cycle < openCycles; cycle++) {
    engine.tick();
    assert.equal(engine.readObjects()[1]!.cel, 0, `Felix blinked early on open cycle ${cycle}`);
  }
  engine.tick();
  const closed = engine.readObjects()[1]!;
  assert.equal(closed.cel, 1, "the long resting cel advances to the closed-eye cel");
  assert.deepEqual(
    { x: closed.x, y: closed.y, priority: closed.priority, fixed: closed.fixedPriority },
    { x: initial.x, y: initial.y, priority: initial.priority, fixed: initial.fixedPriority },
    "blinking does not disturb placement or the priority lesson",
  );

  const closedCycles = engine.vars[59]!;
  assert.ok(closedCycles >= 2 && closedCycles <= 4, `closed hold ${closedCycles} is outside 2..4`);
  for (let cycle = 1; cycle < closedCycles; cycle++) {
    engine.tick();
    assert.equal(engine.readObjects()[1]!.cel, 1, `Felix opened early on closed cycle ${cycle}`);
  }
  engine.tick();
  const reopened = engine.readObjects()[1]!;
  assert.equal(reopened.cel, 0);
  assert.ok(engine.vars[59]! >= 70 && engine.vars[59]! <= 140, "the next rest is randomized");
  assert.deepEqual(
    { x: reopened.x, y: reopened.y, priority: reopened.priority, fixed: reopened.fixedPriority },
    { x: initial.x, y: initial.y, priority: initial.priority, fixed: initial.fixedPriority },
  );
});

test("graduation triggers regardless of which exhibit is repaired last", () => {
  const game = buildTutorial();
  const host = new TutorialHost();
  const engine = new Engine(
    openContainer(new Map(Object.entries(game.files))),
    host,
    new Map(game.words),
  );
  host.engine = engine;
  engine.tick();

  enter(engine, host, "east");
  enter(engine, host, "east");
  enter(engine, host, "fix priority");
  assert.equal(engine.flags[33], 0);
  enter(engine, host, "west");
  walkUntilX(engine, host, 0x4b00, (x) => x <= 50);
  enter(engine, host, "pull lever");
  assert.equal(engine.flags[33], 0);
  enter(engine, host, "west");
  walkUntilX(engine, host, 0x4b00, (x) => x <= 100);
  enter(engine, host, "paint mural");

  assert.equal(engine.flags[33], 1);
  assert.equal(engine.vars[3], 30);
  assert.match(host.prints.at(-1) ?? "", /graduated.*PICTURE.*VIEW.*PRIORITY.*LOGIC.*main menu/i);
});

test("the tutorial ships stored game tests that its cartridge passes", () => {
  const tutorial = buildTutorial();
  const files = new Map(Object.entries(tutorial.files));
  assert.ok(files.has(GAME_TESTS_FILE), "TESTS.JSON travels in the cartridge");
  const session = createAgentSessionState(openContainer(files));
  for (const [word, id] of tutorial.words) session.sources.words.set(word, id);
  assert.equal(readStoredTests(session).length, TUTORIAL_GAME_TESTS.length);
  const verdict = runGameTests(session, null);
  assert.equal(verdict.success, true, verdict.error ?? "");
  assert.match(verdict.message ?? "", /^4 game tests pass, 0 fail\./);
});
