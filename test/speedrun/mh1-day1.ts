import assert from "node:assert/strict";
import { KEY_C, KEY_ENTER, KEY_RIGHT, KEY_TAB, Manhunter, ROOM_MAP } from "./mh1.ts";
import { DIRECTION_KEYS, type Speedrun } from "./runner.ts";

/**
 * Day 1 of Manhunter: New York from the title screen to the return home that
 * starts Day 2. Every input is a key the player could press: cursor steering,
 * Enter on hotspots, the MAD and inventory keys, and typed prompt replies.
 * Nothing writes game state. Room and variable numbers were read from the
 * game's logic disassemblies; the fixed maze and sewer routes were recorded
 * from the engine's own runs and are replayed here as ordinary key presses.
 */
export function day1(run: Speedrun): void {
  const mh = new Manhunter(run);
  opening(mh);
  bellevue(mh);
  trinity(mh);
  flatbush(mh);
  prospectPark(mh);
  sewers(mh);
  coneyIsland(mh);
  orbs(mh);
}

/** Title, intro, the MAD tracker's replay of the explosion, then the city map. */
export function opening(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.step(120);
  run.checkpoint("Title", { room: 153 });
  mh.key(KEY_ENTER, 120);
  mh.waitFor(() => engine.vars[0] === 101, "the MAD tracker", 6000);
  // Enter starts the tracker, which replays the suspect's movements in four
  // timed segments alternating rooms 125 and 124; each finished segment sets
  // one of flags 65, 38, 68 and 69. C closes the MAD onto the city map.
  mh.waitFor(() => mh.hint().includes("Press <ENTER>"), "the tracker prompt");
  run.key(KEY_ENTER);
  mh.waitFor(
    () => Boolean(engine.flags[69] && engine.flags[68] && engine.flags[38] && engine.flags[65]),
    "the tracker's four segments",
    9000,
  );
  assert.ok([124, 125].includes(engine.vars[0]!), `tracker rooms; ${mh.describe()}`);
  run.checkpoint("Tracker", {});
  mh.key(KEY_C, 120);
  run.checkpoint("City map", { room: ROOM_MAP });
}

/** Bellevue Hospital: through the ward to the body, a close look at its foot, then the MAD lookup. */
export function bellevue(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(1, 2, 138, 113, 130);
  run.checkpoint("Bellevue Hospital", { room: 130 });
  // v66 is "inside", v50 the scene: 2 entrance hall, 3 ward, 6 close-up.
  mh.cursorTo(140, 137);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[66] === 1 && engine.vars[50] === 2 && mh.cursor.active, "the hall");
  mh.step(5);
  mh.cursorTo(77, 120);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[50] === 3 && mh.cursor.active, "the ward");
  mh.step(5);
  // The middle hotspot looks at the foot; the one on the right is the morgue.
  mh.cursorTo(96, 91);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[50] === 6, "the close-up");
  mh.step(60);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[50] === 3, "back in the ward");
  mh.step(10);
  mh.cursorTo(50, 160);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[50] === 2, "back in the hall");
  mh.step(5);
  mh.cursorTo(77, 160);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[66] === 0 && engine.vars[50] === 0, "outside");
  mh.step(10);
  // The MAD outside the hospital: Info on the name from the scene.
  mh.key(KEY_C, 30);
  mh.waitFor(() => engine.vars[0] === 101, "the MAD");
  mh.step(60);
  run.checkpoint("MAD", { room: 101 });
  mh.cursorTo(30, 40);
  run.answer("Reno Davis");
  mh.enter(120);
  run.answer("bye");
  mh.enter(120);
  mh.key(KEY_C);
  mh.waitFor(() => engine.vars[0] === 130, "back at Bellevue");
  mh.step(60);
  mh.map();
}

/** Trinity Church: in and straight back out registers the visit. */
export function trinity(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(13, 3, 73, 152, 111);
  mh.step(120);
  run.checkpoint("Trinity Church", { room: 111 });
  mh.cursorTo(72, 150);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[66] === 1, "inside the church");
  mh.step(60);
  mh.cursorTo(80, 160);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[66] === 0, "outside the church");
  mh.step(60);
  mh.map();
}

/**
 * Recorded maze route: "x,y,d" turns for the avatar (object 0) in room 126,
 * each pressed once the avatar stands on the cell, d being the direction
 * (1 up, 3 right, 5 down, 7 left). The route visits the twelve squares that
 * flags 151 to 162 count, in the order 4 5 8 10 6 7 11 12 9 1 2 3.
 */
const MAZE_TURNS =
  "136,161,7 125,161,1 125,152,7 27,152,5 27,156,5 27,161,3 30,161,1 30,152,3 85,152,1 85,132,7 75,132,5 75,134,7 74,134,5 74,139,7 25,139,1 25,122,7 17,122,5 17,126,5 17,131,3 20,131,1 20,122,3 30,122,5 30,134,3 31,134,5 31,139,3 50,139,1 50,122,3 60,122,1 60,102,3 74,102,3 75,102,5 75,119,7 65,119,5 65,124,7 64,124,5 64,129,7 60,129,7 57,129,5 57,130,3 70,130,1 70,122,3 100,122,5 100,134,3 101,134,5 101,138,3 117,138,1 117,135,1 117,133,7 115,133,5 115,134,7 114,134,5 114,138,7 95,138,1 95,122,7 80,122,1 80,112,3 110,112,5 110,114,3 111,114,5 111,119,3 130,119,5 130,139,3 135,139,1 135,112,7 125,112,1 125,82,7 105,82,1 105,62,7 100,62,7 95,62,1 95,52,7 65,52,1 65,42,7 50,42,5 50,44,3 51,44,5 51,49,3 55,49,5 55,70,7 45,70,5 45,98,7 34,98,5 34,99,7 20,99,1 20,92,3 27,92,1 27,85,1 27,83,7 25,83,5 25,84,7 24,84,5 24,89,7 20,89,5 20,94,3 21,94,5 21,99,3 35,99,1 35,72,7 17,72,1 17,65,1 17,63,3 20,63,5 20,64,3 21,64,5 21,69,3 40,69,5 40,98,3 50,98,1 50,72,3 55,72,1 55,52,7 50,52,1 50,42,3 70,42,5 70,44,3 71,44,5 71,49,3 100,49,5 100,54,3 101,54,5 101,59,3 110,59,5 110,74,3 111,74,5 111,79,3 130,79,1 130,72,3 137,72,5 137,96,5 137,101,7 135,101,1 135,42,7 120,42,5 120,44,3 121,44,5 121,49,3 127,49,5 127,56,5 127,61,7 125,61,1 125,52,7 120,52,1 120,42,3 135,42,5 135,64,7 134,64,5 134,69,7 130,69,5 130,104,3 131,104,5 131,109,3 135,109,5 135,139,7 125,139,1 125,122,7 105,122,1 105,112,7 95,112,1 95,92,7 85,92,1 85,82,7 75,82,1 75,62,7 65,62,5 65,84,7 60,84,7 57,84,5 57,89,3 70,89,1 70,62,3 80,62,5 80,74,3 81,74,5 81,79,3 90,79,5 90,84,3 91,84,5 91,89,3 95,89,5 95,104,7 94,104,5 94,109,7 78,109,1 78,99,3 80,99,5 80,104,3 81,104,5 81,109,3 110,109,5 110,114,3 111,114,5 111,119,3 130,119,5 130,139,3 135,139,1 135,112,7 125,112,1 125,82,7 105,82,1 105,62,7 97,62,1 97,59,7 95,59,1 95,52,7 65,52,1 65,42,7 50,42,5 50,44,3 51,44,5 51,49,3 55,49,5 55,70,7 45,70,5 45,98,7 35,98,1 35,52,7 27,52,1 27,45,1";

/** Flatbush: the bar, the knife game in its arcade, then the maze machine. */
export function flatbush(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(8, 5, 51, 36, 122);
  mh.waitFor(() => engine.vars[47] === 1, "the bar ready");
  mh.step(5);
  run.checkpoint("Flatbush bar", { room: 122 });
  mh.cursorTo(75, 100);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[66] === 1 && engine.vars[0] === 122, "inside the bar");
  mh.step(120);
  mh.cursorTo(20, 100);
  run.key(KEY_ENTER);
  mh.waitFor(
    () => engine.vars[0] === 118 && engine.vars[50] === 0 && mh.hint().includes("throw"),
    "the knife game",
    6000,
  );
  run.checkpoint("Knife game", { room: 118 });
  // The thrower sweeps; a knife leaves when Enter is read with the cursor on
  // the target column. Four hits end the game and return to the bar.
  for (const target of [50, 69, 85, 102]) {
    mh.waitFor(() => Math.abs(mh.cursor.x - target) <= 1, `a knife aimed at ${target}`, 600);
    run.key(KEY_ENTER);
    for (let t = 0; t < 400 && engine.vars[0] === 118; t++) {
      mh.step(1);
      if (t > 20 && engine.vars[50] === 0) break;
    }
    if (engine.vars[0] !== 118) break;
  }
  mh.step(60);
  mh.waitFor(() => engine.vars[0] === 122 && mh.cursor.active, "back in the bar", 3000);
  // The arcade again now runs the maze machine, room 126.
  mh.cursorTo(20, 100);
  assert.match(mh.hint(), /video game/);
  run.key(KEY_ENTER);
  // The machine shows its rules (v50 0) and Enter starts the game (v50 1);
  // from then on Enter would back out, so the avatar is driven by arrows only.
  mh.waitFor(
    () => engine.vars[0] === 126 && mh.hint().includes("continue"),
    "the maze machine",
    600,
  );
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[50] === 1 && mh.cursor.active, "the maze started", 300);
  run.checkpoint("Maze", { room: 126 });
  maze(mh);
  // The machine's ending returns to the bar through two Enter prompts.
  mh.waitFor(
    () => engine.vars[0] === 126 && mh.hint().includes("continue"),
    "the maze ending",
    4000,
  );
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[50] === 1, "the machine's back-up prompt");
  mh.step(10);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[0] === 122, "the bar after the maze");
  // Back out of the bar onto the street in front of it.
  mh.step(120);
  mh.cursorTo(75, 120);
  assert.match(mh.hint(), /back out/);
  mh.enter(200);
  mh.cursorTo(75, 120);
  assert.match(mh.hint(), /enter the Flatbush Bar/);
  mh.map();
}

/** Drive the maze avatar along the recorded turns, one decision per cycle. */
function maze(mh: Manhunter): void {
  const { run, engine } = mh;
  const turns = MAZE_TURNS.split(" ").map((turn) => turn.split(",").map(Number));
  const squares = () =>
    [151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162].filter((f) => engine.flags[f])
      .length;
  let next = 0;
  for (let guard = 0; guard < 20000 && next < turns.length; guard++) {
    if (engine.vars[50] === 4 || engine.vars[0] !== 126) break;
    const [x, y, direction] = turns[next]!;
    // A direction key repeats the current direction as a stop, and v92 counts
    // a square's pick-up animation, which zeroes v6: the recording pressed only
    // once the avatar stood still on the cell or headed elsewhere.
    if (
      mh.cursor.x === x &&
      mh.cursor.y === y &&
      engine.vars[92] === 0 &&
      engine.vars[6] !== direction
    ) {
      run.key(DIRECTION_KEYS[direction!]!);
      next++;
    }
    mh.cycle();
  }
  assert.equal(next, turns.length, `the maze route ran to its end; ${mh.describe()}`);
  assert.equal(squares(), 12, "all twelve maze squares were collected");
}

/** Prospect Park: the women's toilets, stall three, sit, and three flushes drop Mick into the sewers. */
export function prospectPark(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(9, 5, 65, 50, 119);
  mh.step(180);
  run.checkpoint("Prospect Park", { room: 119 });
  const use = (x: number, y: number, id: number, action: RegExp, ticks: number): void => {
    mh.cursorTo(x, y);
    assert.equal(engine.vars[48], id, `park hotspot ${id}; ${mh.describe()}`);
    assert.match(mh.hint(), action);
    mh.enter(ticks);
  };
  use(62, 70, 1, /Move/, 240);
  assert.equal(engine.vars[66], 1, "inside the toilets");
  // The left door is the women's room (v93 = 2); the right one leads nowhere useful.
  use(45, 70, 1, /Move/, 240);
  assert.equal(engine.vars[93], 2, "the women's room");
  use(125, 45, 3, /Move/, 240);
  use(125, 45, 3, /Move/, 240);
  assert.equal(engine.vars[90], 3, "stall three");
  use(62, 70, 2, /sit down/, 240);
  assert.equal(engine.flags[151], 1, "seated");
  for (let flush = 1; flush <= 3; flush++) {
    mh.waitFor(() => engine.vars[92] === 0, `flush ${flush} ready`, 600);
    use(62, 70, 9, /flush/, 30);
  }
  mh.waitFor(() => engine.vars[0] === 128, "the fall into the sewers", 12000);
  mh.step(120);
}

/**
 * Recorded sewer route. Room 128 is a graph of pictures (v250) with up to four
 * exits, selected by cursor position: L left (2,90), R right (157,90), B
 * bottom (78,160), M middle (78,90). C takes the keycard on the current
 * picture at (72,145), where the room registers v51 = 4. The route collects
 * all twelve keycards and ends at the dock picture 78.
 */
const SEWER_MOVES =
  "LBBLLLLLLLLCBLLLLLLLLLLLLLLLRLLLCLLLLLLLLRLLLLCLRRLLBLLLLLRRLLCLLRRLLLLLLCLLLLLLLRRLLLLRLLLLLLLRCBLLLLLLLLLRLLLLLLLLLLLLRLLLLLLLCBLLLLLRRLLCLLLRLLLLLLLCLLRRLLLLRLRLLLLLLRLLLLLLLLLLLLRLRLLLCLLLLLLLLLLRCBLLLLLLCL";

export function sewers(mh: Manhunter): void {
  const { run, engine } = mh;
  run.checkpoint("Sewers", { room: 128 });
  assert.equal(engine.vars[250], 254, "the sewer entry picture");
  const exits: Record<string, [number, number]> = {
    L: [2, 90],
    R: [157, 90],
    B: [78, 160],
    M: [78, 90],
  };
  let cards = 0;
  for (const move of SEWER_MOVES) {
    if (move === "C") {
      mh.cursorTo(72, 145);
      assert.equal(engine.vars[51], 4, `keycard ${cards + 1}; ${mh.describe()}`);
      mh.enter(90);
      cards++;
      continue;
    }
    const [x, y] = exits[move]!;
    mh.cursorTo(x, y);
    run.key(KEY_ENTER);
    mh.settle();
  }
  assert.equal(cards, 12, "twelve keycards");
  assert.equal(engine.vars[250], 78, "the dock picture");
  mh.cursorTo(112, 100);
  assert.equal(engine.vars[51], 6, `the dock; ${mh.describe()}`);
  run.key(KEY_ENTER);
  mh.settle();
  mh.cursorTo(72, 83);
  assert.match(mh.hint(), /take the medallion/);
  mh.enter(120);
  assert.equal(engine.readState().inventory[13]!.room, 255, "the medallion is carried");
  mh.cursorTo(78, 160);
  run.key(KEY_ENTER);
  mh.settle();
  mh.map();
}

/** One pitch at the Kewpie Doll booth once the sweeping thrower reaches (x,y) on one of `shelves`. */
function pitch(mh: Manhunter, x: number, y: number, shelves: readonly number[]): void {
  const { run, engine } = mh;
  mh.waitFor(
    () => mh.cursor.x === x && mh.cursor.y === y && shelves.includes(engine.vars[91]!),
    `the thrower at (${x},${y})`,
    2000,
  );
  run.key(KEY_ENTER);
  for (let t = 0; t < 400 && engine.vars[59] === 0; t++) {
    mh.step(1);
    if (t > 20 && engine.vars[95] === 0) break;
  }
}

/**
 * Coney Island: the Kewpie Doll Baseball booth. Logic 129 judges a pitch by
 * the ball's final column (v30, the thrower's x plus six) and shelf (v91: 2
 * top, 1 or 4 middle, 0 bottom); the prize sequence needs the third top doll,
 * then the second middle doll, then the fourth bottom doll (v90 10, 20, 30).
 * The barker then wants to see the medallion (v25 = 13 from the inventory)
 * and hands over the Data Card, item 15, which leads to the Orbs.
 */
export function coneyIsland(mh: Manhunter): void {
  const { run, engine } = mh;
  mh.travel(10, 6, 68, 157, 129);
  mh.step(200);
  run.checkpoint("Coney Island", { room: 129 });
  // The path hotspot snaps the cursor to (34,125); Enter from there opens the
  // booth choice. Moving after the snap would select the darts booth instead.
  mh.hotspot(1, 40, 100);
  assert.match(mh.hint(), /test your skills/);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[50] === 1, "the booth choice", 300);
  mh.step(5);
  mh.hotspot(2, 96, 100);
  assert.match(mh.hint(), /Kewpie Doll/);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[50] === 2, "the booth", 300);
  mh.waitFor(() => mh.hint().includes("throw"), "the first ball", 300);
  assert.equal(engine.vars[62], 2, "the Kewpie Doll booth");
  run.checkpoint("Kewpie Doll Baseball", { room: 129 });
  pitch(mh, 77, 105, [2]);
  assert.equal(engine.vars[90], 10, "the first pitch hit the third top doll");
  pitch(mh, 65, 135, [1, 4]);
  assert.equal(engine.vars[90], 20, "the second pitch hit the second middle doll");
  pitch(mh, 89, 165, [0]);
  mh.waitFor(() => engine.vars[59] === 4, "the barker's odd look", 1500);
  // Tab lists the carried items by number (Twelve Keycards 11, Medallion 13,
  // MAD 14); Right moves to the medallion and Enter shows it (v25 = 13).
  run.key(KEY_TAB);
  mh.step(6);
  assert.equal(engine.modalKind, "inventory");
  run.key(KEY_RIGHT);
  mh.step(1);
  run.key(KEY_ENTER);
  mh.step(12);
  assert.equal(engine.flags[72], 1, "the barker accepted the medallion");
  mh.waitFor(() => engine.vars[59] === 3, "the prize offer", 2500);
  mh.hotspot(1, 120, 100);
  assert.match(mh.hint(), /take your prize/);
  run.key(KEY_ENTER);
  mh.waitFor(() => engine.vars[0] === 131, "the Orbs", 600);
  assert.equal(engine.readState().inventory[15]!.room, 255, "the Data Card is carried");
}

/**
 * The Orbs read the Data Card, demand the suspect's name and send Mick home.
 * Logic 131 parses the reply without testing it on Day 1. Each stage of v50
 * and v47 waits for one Enter; the closing sequence runs on clock waits and
 * sets v60 = 2 before new.room(104).
 */
export function orbs(mh: Manhunter): void {
  const { run, engine } = mh;
  run.checkpoint("Orbs", { room: 131 });
  run.answer("Reno Davis");
  let acknowledged = "";
  for (let t = 0; t < 12000 && engine.vars[0] === 131; t++) {
    mh.step(1);
    const stage = `${engine.vars[50]}/${engine.vars[47]}`;
    if (stage !== acknowledged && mh.hint().includes("Press <ENTER>")) {
      acknowledged = stage;
      run.key(KEY_ENTER);
    }
  }
  mh.waitFor(() => engine.vars[0] === 104, "home", 600);
  mh.step(30);
  assert.equal(engine.vars[60], 2, "Day 2 begins");
  run.checkpoint("Home, Day 2", { room: 104 });
}
