import assert from "node:assert/strict";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import { parseDirection, type Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";
import { NavigationError } from "../../src/agent/navigationController.ts";
import type { PlanOptions } from "../../src/agent/navigation.ts";

/**
 * Deaths end one of two ways: scripted ones set v67 (1 or 2), which makes logic 0 hand every
 * later cycle to the "You are dead" handler (100.agi), and timer deaths jump to room 95.
 */
const DEATH_ROOM = 95;

function alive(run: Speedrun, label: string): void {
  assert.equal(run.engine.vars[67], 0, `Roger died (v67): ${label}`);
  assert.notEqual(run.engine.vars[0], DEATH_ROOM, `Roger died: ${label}`);
}

/** Ego is drawn, updating and steerable: the navigation controller's own precondition. */
function inControl(run: Speedrun): boolean {
  const ego = run.engine.screenObjects[0]!;
  return run.engine.movementControlEnabled && ego.active && ego.update;
}

/** Run a walk, acknowledging any narration window that interrupts it. */
function through(run: Speedrun, walk: () => void): void {
  for (let prompts = 0; ; prompts++) {
    try {
      walk();
      return;
    } catch (error) {
      if (!(error instanceof NavigationError) || error.outcome.status !== "needs_input")
        throw error;
      assert.ok(prompts < 4, "unexpected repeated narration during a walk");
      run.dismiss();
    }
  }
}

/** Straight-line walk to a point. */
function go(run: Speedrun, x: number, y: number): void {
  through(run, () => run.walkTo(x, y));
}

/** Planned walk around obstacles; trigger pixels are avoided unless the target is one. */
function path(run: Speedrun, x: number, y: number, options: PlanOptions = {}): void {
  through(run, () => run.walkPath(x, y, { avoidTriggers: true, geometry: "current", ...options }));
  alive(run, `walk to ${x},${y}`);
}

/** Walk a planned route onto a spot whose room logic switches rooms by position. */
function enter(run: Speedrun, x: number, y: number, room: number, options: PlanOptions = {}): void {
  const result = run.traverse({
    passage: { kind: "position", planned: true, target: { x0: x, x1: x, y0: y, y1: y } },
    expectedRoom: room,
    passageOptions: { avoidTriggers: false, geometry: "current", ...options },
    landing: { label: `arrive in ${room}`, test: (e) => e.vars[0] === room },
  });
  assert.equal(result.status, "reached", JSON.stringify(result));
  alive(run, `entering ${room}`);
}

/** Leave through a screen edge along a planned route that keeps off trigger pixels. */
function leave(
  run: Speedrun,
  direction: "N" | "E" | "S" | "W",
  room: number,
  options: PlanOptions = {},
): void {
  for (let prompts = 0; ; prompts++) {
    const outcome = run.traverse(
      {
        passage: { kind: "exit", direction: parseDirection(direction), room, planned: true },
        passageOptions: {
          avoidTriggers: true,
          geometry: "current",
          maxSearchNodes: 241920,
          ...options,
        },
        landing: { label: `arrive in ${room}`, test: (e) => e.vars[0] === room },
      },
      { budgets: { hostPolls: 10000, movementUpdates: 1000 } },
    );
    const scripted =
      outcome.status === "needs_input" || outcome.status === "movement_control_unavailable";
    if (scripted && prompts < 8) {
      // A narration window or a short scripted animation (wading in, being spat out).
      run.dismiss();
      run.wait(() => inControl(run), "scripted interruption ends", 3000);
      alive(run, `leaving ${direction}`);
      if (run.engine.vars[0] === room) return;
      continue;
    }
    assert.equal(outcome.status, "reached", JSON.stringify(outcome));
    alive(run, `leaving ${direction}`);
    return;
  }
}

function boot(run: Speedrun): void {
  // Logic 98 asks for a name with get.string before the opening room.
  run.answer("Roger Wilco");
  run.wait(() => run.state().room === 140, "title screen", 600);
  run.checkpoint("Title screen", { room: 140, score: 0 });
  run.key(AGI_KEY.ENTER);
  run.wait(() => run.state().room === 1, "story introduction", 600);
  run.advance(30);
  run.key(AGI_KEY.ENTER);
  run.wait(() => run.state().room === 2, "orbital station hull", 2000);
  run.wait(() => run.engine.inputEnabled, "janitor introduction complete", 5000);
  alive(run, "boot");
  run.checkpoint("Sweeping the station hull", { room: 2, score: 0 });
}

/** Orbital station: answer the boss, change out of the suit, empty the locker, ride to the shuttle bay. */
function station(run: Speedrun): void {
  const e = run.engine;
  // 002.agi: the watch close-up accepts "press c" (+1) once the beep has armed the call.
  run.command("look watch");
  run.command("press c");
  assert.equal(e.vars[3], 1, "answered the call");
  run.wait(() => e.flags[42] !== 0, "boss delivers his message", 3000);
  run.dismiss();
  run.key(AGI_KEY.F10); // controller 13 leaves the watch close-up
  run.wait(() => e.flags[69] === 0, "watch close-up closed", 300);
  // Floor -> wall -> ceiling: logic 2 swaps views as ego crosses each seam; the
  // airlock box (46-53, 88-93) only opens for the ceiling walker.
  run.walkTo(60, 130);
  run.walkTo(50, 92);
  run.walkToUntil(50, 90, () => e.flags[32] !== 0, "airlock takes Roger in");
  run.waitForRoom(3, "airlock chamber", 3000);
  run.wait(() => e.movementControlEnabled, "decontamination finishes", 3000);
  run.checkpoint("Inside the airlock", { room: 3, score: 2 });
  run.direction("W");
  run.type("change clothes"); // 003.agi: uniform rack box (52-65, 106-110), +1
  run.walkTo(60, 108);
  run.submit("change clothes");
  assert.equal(e.vars[50], 2, "wearing the janitor uniform");
  run.direction("E");
  run.type("open locker"); // locker box (102-112, 111-122)
  run.walkTo(107, 115);
  run.submit("open locker");
  run.command("get all"); // athletic supporter +1, cubix rube +1
  run.assertCarried(21, "Supporter");
  run.assertCarried(37, "Puzzle");
  run.assertCarried(20, "Order Form");
  run.assertCarried(35, "Dialect Translator");
  assert.equal(e.vars[3], 5, "locker emptied");
  run.walkTo(40, 116);
  run.walkToUntil(10, 116, () => e.flags[32] !== 0, "west door closes behind Roger");
  run.waitForRoom(4, "station concourse", 3000);
  alive(run, "concourse");
  run.checkpoint("Collected the uniform and locker gear", { room: 4, score: 5 });
}

/** Concourse lift and transport tube to the shuttle bay, where Vohaul's goons are waiting. */
function kidnapped(run: Speedrun): void {
  const e = run.engine;
  // 004.agi: the boss walks in after 18 cycles and lectures; he fires anyone still suited up.
  go(run, 40, 131);
  run.walkToUntil(30, 117, () => e.vars[30] === 1, "lift platform rises");
  run.wait(() => e.vars[30] === 2 && e.movementControlEnabled, "lift reaches the catwalk", 3000);
  // The catwalk is the y73-76 band; its rail opens only at x97-108 for the tube door.
  go(run, 34, 74);
  go(run, 103, 74);
  run.walkToUntil(103, 72, () => e.flags[33] !== 0, "transport tube door");
  run.waitForRoom(5, "shuttle bay", 3000);
  run.wait(() => e.movementControlEnabled && e.vars[30] === 3, "tube car opens", 3000);
  alive(run, "shuttle bay");
  // 005.agi: the boarding stairs arm at (72-78, 122) heading north and spring at y109 (+5).
  run.walkPath(75, 126);
  run.walkToUntil(75, 105, () => e.flags[33] !== 0, "shuttle boarding stairs");
  run.waitForRoom(6, "Vohaul's asteroid", 8000);
  run.checkpoint("Ambushed aboard the shuttle", { room: 6, score: 10 });
  // 006.agi: each speech window stays open (f15) until a key arrives while f32 is armed.
  for (let windows = 0; run.state().room === 6; windows++) {
    assert.ok(windows < 20, "Vohaul's monologue ends");
    run.wait(() => e.flags[32] !== 0 || run.state().room !== 6, "Vohaul pauses", 3000);
    if (run.state().room !== 6) break;
    run.advance(150); // reading time for the open speech window
    run.key(AGI_KEY.ENTER);
    run.advance(4);
  }
  run.checkpoint("Heard Vohaul's plan", { room: 7, score: 10 });
}

/** Labion crash site: the dead guard's keycard and the pod's homing beacon. */
function crashSite(run: Speedrun): void {
  const e = run.engine;
  run.wait(() => run.state().room === 10 && e.inputEnabled, "hovercraft crash on Labion", 20000);
  alive(run, "crash");
  run.checkpoint("Survived the crash on Labion", { room: 10, score: 10 });
  // 010.agi: Roger wakes inside the guard's box (34-67, 129-138); "acquire card" is +3.
  run.take("get keycard", 36, "guard's keycard");
  // The wreck console box is (59-93, 140-150); silencing the beacon is +1 and delays the hunters.
  run.direction("SE");
  run.type("press button");
  run.walkPath(75, 142);
  run.submit("press button");
  assert.ok(e.flags[84] !== 0, "beacon silenced");
  run.checkpoint("Took the keycard and silenced the beacon", { room: 10, score: 14 });
  leave(run, "N", 11);
}

/** First jungle clearing: outlast the search hovercraft, then free the snared Labion native. */
function hunters(run: Speedrun): void {
  const e = run.engine;
  // 111.agi: with the beacon off the hunters arrive 5x91 cycles after entering; they shoot
  // unless f1 (ego fully behind higher priority) holds. The big tree covers (106-114, 96-104).
  path(run, 110, 100);
  run.wait(() => e.vars[235] !== 0, "search hovercraft arrives", 6000);
  assert.ok(e.flags[1] !== 0, "hidden behind the tree");
  run.wait(() => e.vars[3] === 19 && e.movementControlEnabled, "hovercraft gives up (+5)", 6000);
  alive(run, "hovercraft search");
  run.checkpoint("Hid from the search hovercraft", { room: 11, score: 19 });
}

function freeNative(run: Speedrun): void {
  const e = run.engine;
  // 011.agi: the right edge below y150 leads to the snare clearing.
  path(run, 140, 158);
  leave(run, "E", 12);
  assert.ok(e.vars[94]! > 0, "the snared native cried out");
  run.direction("NE");
  run.type("untie alien"); // 012.agi: said("free", "alien") inside (28-37, 126-134), +5
  path(run, 33, 130);
  run.submit("untie alien");
  run.wait(() => e.flags[80] !== 0 && e.movementControlEnabled, "native cut loose", 3000);
  run.checkpoint("Freed the snared native", { room: 12, score: 24 });
  leave(run, "W", 11);
}

/** Hilltop mailbox (order form -> whistle), then down to the spore patch. */
function mailOrder(run: Speedrun): void {
  const e = run.engine;
  // The hill path leaves room 11 by its upper-left corner onto the mailbox ledge.
  path(run, 3, 52);
  run.exit("W", 20);
  run.direction("W");
  run.type("put order form in slot"); // 020.agi: mailbox box (80-101, 45-52), +2
  path(run, 90, 50);
  run.submit("put order form in slot");
  assert.ok(!run.carried(20), "order form mailed");
  run.type("get whistle"); // the tray fills 27 cycles later (v107 = 2), +2
  run.wait(() => e.vars[107] === 2, "mail-order whistle arrives", 1000);
  run.submit("get whistle");
  run.assertCarried(26, "Whistle");
  run.checkpoint("Mailed the order form for a whistle", { room: 20, score: 28 });
  // The ledge's south-east lip is a fall trigger (109.agi): a harmless tumble to y97 that
  // saves the walk back around through the clearing.
  go(run, 112, 52);
  run.walkToUntil(112, 62, () => e.flags[53] !== 0, "step off the ledge");
  run.wait(
    () => e.vars[230] === 0 && e.vars[96] === 0 && e.movementControlEnabled,
    "Roger picks himself up",
    3000,
  );
  alive(run, "ledge tumble");
  // Spores: the pick-up box (24-45, 135-152) is wider than the paralysing pod (26-41, 139-148).
  run.direction("SW");
  run.type("get spore");
  path(run, 30, 136);
  run.submit("get spore");
  run.assertCarried(23, "Spore");
  assert.equal(e.vars[96], 0, "not paralysed");
  run.checkpoint("Picked a spore", { room: 20, score: 32 });
  path(run, 20, 84);
  run.walkToUntil(20, 78, () => run.state().room === 21, "north-west trail");
}

/** Root-monster maze: every trigger pixel wakes the roots, so the planner threads between them. */
function berryMaze(run: Speedrun): void {
  const e = run.engine;
  path(run, 40, 99);
  // 021.agi: the (35-46, 93-97) gap is crawled under the y95 root; f34 marks the far side.
  go(run, 40, 92);
  assert.ok(e.flags[34] !== 0, "crawled under the root");
  run.direction("NE");
  run.type("get berries"); // bush box (57-107, 70-73), +4
  path(run, 80, 72);
  run.submit("get berries");
  run.waitForItem(22, "berries picked", 2000);
  run.checkpoint("Picked berries beyond the root maze", { room: 21, score: 36 });
  path(run, 40, 92);
  go(run, 40, 99);
  path(run, 80, 150); // back at (72-86, 150) with f34 set: +4 for surviving the maze
  assert.ok(e.flags[204] !== 0, "maze round trip scored");
  run.checkpoint("Threaded the root maze both ways", { room: 21, score: 40 });
  leave(run, "S", 20);
}

/** Back over the hilltop to the swamp, smelling bad enough to be spat out. */
function toSwamp(run: Speedrun): void {
  const e = run.engine;
  leave(run, "E", 11);
  // The clearing's east edge is walled between y81 and y150; the swamp trail starts on the hilltop.
  path(run, 150, 54);
  run.exit("E", 13);
  // 000.agi: rubbing berries (+3) is refused in the water, so do it on the bank.
  run.command("rub berries on body");
  run.wait(() => e.flags[77] !== 0 && inControl(run), "berry juice applied", 1000);
  run.checkpoint("Rubbed on the berries", { room: 13, score: 43 });
  // 107.agi: the swamp lurker grabs Roger and spits him out because of f77.
  leave(run, "E", 14, { avoidTriggers: false });
}

/** Dive from the swamp's deep pool to the air pocket that holds the glowing gem. */
function gemCave(run: Speedrun): void {
  const e = run.engine;
  // 014.agi: only the deep pool (92-105, 89-107) allows diving; "hold breath" buys 7 air
  // periods instead of 2 and scores +2.
  run.type("hold breath");
  path(run, 98, 98, { avoidTriggers: false });
  assert.ok(e.flags[95] !== 0, "swimming in the deep pool");
  run.submit("hold breath");
  run.waitForRoom(26, "underwater passage", 1000);
  leave(run, "W", 27, { avoidTriggers: false });
  // 027.agi: surfacing at (45-80, 129) reveals the cavern (+2) and resets the air timer.
  path(run, 60, 129, { avoidTriggers: false });
  assert.equal(e.vars[30], 1, "surfaced in the cavern pool");
  run.walkToUntil(100, 88, () => e.vars[30] === 2, "climb out of the pool");
  run.direction("E");
  run.type("get gem"); // gem box (99-124, 80-91), +3
  go(run, 105, 88);
  run.submit("get gem");
  run.assertCarried(24, "Glowing Gem");
  run.checkpoint("Found the glowing gem", { room: 27, score: 50 });
  run.direction("W");
  run.type("hold breath"); // +2 again for the careful swimmer
  run.walkToUntil(60, 92, () => e.vars[30] === 1, "back into the pool");
  run.submit("hold breath");
  run.wait(() => run.state().y > 130, "submerged", 100);
  leave(run, "E", 26, { avoidTriggers: false });
  path(run, 88, 34, { avoidTriggers: false });
  run.walkToUntil(88, 20, () => e.flags[30] !== 0, "break the surface");
  run.waitForRoom(14, "swamp surface", 1000);
  alive(run, "return swim");
  run.checkpoint("Swam back to the swamp", { room: 14, score: 52 });
}

/** Out of the swamp, over the chasm on a felled snag, and into the hunter's snare. */
function snared(run: Speedrun): void {
  const e = run.engine;
  leave(run, "E", 15, { avoidTriggers: false });
  leave(run, "E", 16, { avoidTriggers: false });
  // 016.agi: "climb snag" inside (71-89, 115-128) topples the dead tree across the chasm (+3)
  // and leaves Roger straddling it; only due east or west is safe on the log.
  run.type("climb tree");
  path(run, 78, 126);
  run.submit("climb tree");
  run.wait(() => e.vars[32] === 1 && e.movementControlEnabled, "the snag bridges the chasm", 3000);
  run.dismiss();
  run.checkpoint("Felled a snag across the chasm", { room: 16, score: 55 });
  run.walkDirection("E", () => e.vars[32] === 0, "shuffle east along the log");
  alive(run, "log crossing");
  leave(run, "E", 17);
  // 017.agi: both trigger lines east of x77 spring the snare; the hunter's camp holds the rope.
  run.walkDirection("E", () => e.vars[96] === 6, "walk into the snare");
  run.wait(() => run.state().room === 19 && e.inputEnabled, "carried to the hunter's cage", 20000);
  run.checkpoint("Caged at the hunter's camp", { room: 19, score: 55 });
}

/** 019.agi: lure the hunter, stun him with the spore, take his key and his rope. */
function cageBreak(run: Speedrun): void {
  const e = run.engine;
  run.command("call hunter"); // first call only annoys him (f35)
  run.command("call hunter");
  run.type("throw spore");
  run.wait(() => e.flags[41] !== 0, "hunter comes up to the bars", 3000);
  run.submit("throw spore"); // inside (103-121, 117-129), +5
  assert.ok(!run.carried(23), "spore thrown");
  run.type("get key");
  run.wait(() => e.vars[33] === 4, "hunter paralysed beside the cage", 3000);
  run.submit("get key"); // +2, and the wake-up timer restarts at 255
  run.assertCarried(34, "Cage Key");
  run.command("unlock cage");
  assert.ok(e.flags[37] !== 0, "cage unlocked");
  run.checkpoint("Stunned the hunter and took his key", { room: 19, score: 62 });
}

/** Out of the cage with the rope, back to the log bridge, and down into the chasm. */
function ropeDescent(run: Speedrun): void {
  const e = run.engine;
  run.command("open cage"); // refused while standing in the door swing (103-115, 117-120)
  run.wait(() => e.vars[31] === 3, "cage door swings open", 1000);
  run.walkDirection("W", () => e.flags[30] === 0 && run.state().x <= 98, "step out of the cage");
  run.type("get rope"); // coil box (73-89, 100-114), +2
  path(run, 75, 105, { avoidTriggers: false });
  run.submit("get rope");
  run.assertCarried(25, "Rope");
  run.checkpoint("Escaped the cage with the hunter's rope", { room: 19, score: 64 });
  // 018.agi: the landing pad box (45-117, 80-130) summons a gunship; skirt it along the south.
  leave(run, "N", 18, { avoidTriggers: false });
  leave(run, "W", 17);
  assert.ok(e.vars[99]! >= 3, "snare already sprung");
  leave(run, "W", 16, { avoidTriggers: false });
  run.type("cross log"); // east mounting box (125-136, 114-120)
  path(run, 135, 117);
  run.submit("cross log");
  assert.equal(e.vars[32], 1, "straddling the log");
  run.type("tie rope to log"); // mid-span box (99-115, 118), +2
  run.walkDirection("W", () => run.state().x <= 107, "shuffle to mid-span");
  run.submit("tie rope to log");
  assert.ok(e.flags[89] !== 0, "rope tied to the log");
  run.command("climb down rope");
  run.waitForRoom(22, "hanging in the chasm", 1000);
  alive(run, "rope descent");
  run.checkpoint("Climbed down into the chasm", { room: 22, score: 66 });
}

/** 022.agi: swing the rope until its arc reaches the west ledge, then let go. */
function ropeSwing(run: Speedrun): void {
  const e = run.engine;
  run.type("swing"); // accepted only at the rope's end (78, 64-70), +2
  run.walkDirection("S", () => run.state().y >= 66, "climb to the rope's end");
  run.submit("swing");
  assert.equal(e.vars[31], 1, "rope swinging");
  // Each pass widens the arc by one pixel. Letting go lands only from x60-68; four passes
  // beyond x89 feed Roger to the cave beast, so release on the first arc that reaches x67.
  const rope = e.screenObjects[10]!;
  run.wait(() => rope.x >= 61 && rope.x <= 67, "the arc reaches the ledge", 6000);
  assert.ok(e.vars[39]! < 4, "the beast has not grabbed Roger");
  run.key(AGI_KEY.F6); // controller 6: the game's own "let go" key
  run.wait(() => e.flags[37] !== 0 || e.vars[67] !== 0, "land on the ledge", 2000);
  assert.equal(e.vars[67], 0, "survived the jump");
  run.checkpoint("Swung across to the chasm ledge", { room: 22, score: 73 });
  leave(run, "W", 25);
}

/** 025.agi: the tunnel past x133 is pitch dark and something hungry waits at x32 unless lit. */
function darkTunnel(run: Speedrun): void {
  const e = run.engine;
  run.direction("W");
  run.type("hold gem"); // only accepted in the dark part (f30), +2
  run.wait(() => run.state().x < 130, "walk into the dark");
  run.submit("hold gem");
  assert.ok(e.flags[90] !== 0, "gem lights the tunnel");
  path(run, 18, 121, { avoidTriggers: false });
  run.walkToUntil(10, 121, () => e.flags[32] !== 0, "the floor gives way at x16");
  run.waitForRoom(23, "tumbled into the canyon", 2000);
  run.wait(() => e.vars[30] === 3 && inControl(run), "Roger gets back up", 5000);
  alive(run, "tunnel drop");
  run.checkpoint("Lit the dark tunnel with the gem", { room: 23, score: 75 });
}

/** Canyon of the little pink dwellers: recover the gem, hear the elder out, say the word. */
function canyon(run: Speedrun): void {
  const e = run.engine;
  // 023.agi: the tumble knocks the gem loose at x31; picking it back up is +1.
  run.type("get gem");
  path(run, 32, 124);
  run.submit("get gem");
  run.assertCarried(24, "Glowing Gem");
  leave(run, "S", 29);
  // 029.agi: crossing y100 summons the elder; his four speeches stay open (f15) until a key.
  run.walkToUntil(run.state().x, 100, () => e.vars[32]! > 0, "the elder rides in");
  for (let speeches = 0; e.vars[32] !== 0; speeches++) {
    assert.ok(speeches < 8, "the elder finishes");
    run.wait(() => e.flags[37] !== 0 || e.vars[32] === 0, "the elder speaks", 3000);
    if (e.vars[32] === 0) break;
    run.advance(150); // reading time for the open speech window
    run.key(AGI_KEY.ENTER);
    run.advance(4);
  }
  assert.ok(e.flags[98] !== 0, "thanked for saving the snared native");
  run.command("say the word"); // +3; the assistants roll the boulder off the exit hole
  run.wait(() => e.flags[94] !== 0, "boulder rolled aside", 3000);
  run.checkpoint("Said the word to the canyon dwellers", { room: 29, score: 79 });
  run.walkToUntil(86, 133, () => e.flags[36] !== 0, "climb into the hole (80-93, 131-136)");
  run.waitForRoom(38, "ladder shaft", 2000);
}

/**
 * One leg of the tunnel maze. v103 is 1 on a ladder and 2 in a crawlway; the room logics
 * swap modes at fixed junction pixels, so each leg holds one arrow key until the mode or
 * room changes (or a ladder rung row is reached) and then checks where that left Roger.
 */
function tunnelLeg(
  run: Speedrun,
  direction: "N" | "E" | "S" | "W",
  expected: { room: number; mode: 1 | 2; stopY?: number },
): void {
  const e = run.engine;
  const room = e.vars[0];
  const mode = e.vars[103];
  const stopY = expected.stopY;
  run.walkDirection(
    direction,
    () =>
      e.vars[0] !== room || e.vars[103] !== mode || (stopY !== undefined && run.state().y >= stopY),
    `tunnel leg ${direction} from room ${room}`,
  );
  assert.equal(e.vars[0], expected.room, `tunnel leg ${direction}: room`);
  assert.equal(e.vars[103], expected.mode, `tunnel leg ${direction}: ladder/crawl mode`);
  alive(run, "tunnels");
}

/** Rooms 38 and 30-37: the pitch-dark ladder maze under the canyon. */
function tunnels(run: Speedrun): void {
  const e = run.engine;
  // 038.agi: both hands are needed on the ladder; without light within 90 cycles Roger
  // loses his grip. The gem goes in his mouth.
  run.command("put gem in mouth");
  assert.ok(e.flags[90] !== 0, "gem lights the shaft");
  tunnelLeg(run, "S", { room: 38, mode: 2 }); // foot of the entry ladder
  tunnelLeg(run, "E", { room: 30, mode: 2 });
  tunnelLeg(run, "E", { room: 30, mode: 1 }); // junction x97 mounts the x115 ladder
  tunnelLeg(run, "S", { room: 30, mode: 1, stopY: 150 }); // lower crawlway level
  tunnelLeg(run, "E", { room: 30, mode: 2 });
  tunnelLeg(run, "E", { room: 31, mode: 2 });
  tunnelLeg(run, "E", { room: 31, mode: 1 }); // x35 ladder; the y95 crawlway here has a lurker
  tunnelLeg(run, "S", { room: 32, mode: 1 });
  run.checkpoint("Deep in the ladder maze", { room: 32, score: 79 });
  tunnelLeg(run, "S", { room: 32, mode: 2 }); // the ladder stub feeds the top crawlway east
  tunnelLeg(run, "E", { room: 32, mode: 1 }); // x115 ladder
  tunnelLeg(run, "S", { room: 32, mode: 2 }); // its foot turns west along y148
  tunnelLeg(run, "W", { room: 32, mode: 1 }); // x35 ladder foot
  tunnelLeg(run, "S", { room: 32, mode: 2 });
  tunnelLeg(run, "W", { room: 33, mode: 2 });
  tunnelLeg(run, "W", { room: 33, mode: 1 });
  tunnelLeg(run, "W", { room: 33, mode: 2 });
  tunnelLeg(run, "W", { room: 33, mode: 1 }); // x35 ladder, the only one that goes on down
  tunnelLeg(run, "S", { room: 36, mode: 1 });
  tunnelLeg(run, "S", { room: 36, mode: 1, stopY: 96 });
  tunnelLeg(run, "E", { room: 36, mode: 2 });
  tunnelLeg(run, "E", { room: 37, mode: 2 });
  tunnelLeg(run, "E", { room: 39, mode: 2 });
  // 039.agi awards +20 for finding the way out.
  run.checkpoint("Crawled out of the ladder maze", { room: 39, score: 99 });
}

/** Underground river: ride the current to the whirlpool branch, never the waterfall branch. */
function river(run: Speedrun): void {
  leave(run, "E", 40, { avoidTriggers: false });
  // 040.agi: the (50-54, 77-93) mouth drops over the falls (room 41, fatal); the x138 line at
  // y77-95 feeds the whirlpool that flushes Roger out of the mountain (+5).
  path(run, 136, 86, {
    avoidTriggers: false,
    avoidRegions: [{ x0: 40, x1: 64, y0: 70, y1: 97 }],
  });
  run.walkToUntil(140, 86, () => run.state().room !== 40, "drift into the whirlpool branch");
  assert.equal(run.state().room, 42, "whirlpool chamber");
  run.wait(() => run.state().room === 43, "flushed out through the whirlpool", 10000);
  alive(run, "whirlpool");
  run.checkpoint("Rode the whirlpool out of the caves", { room: 43, score: 104 });
}

/** 044.agi: whistle the Labion Terror Beast out of its cave and keep it busy with the puzzle. */
function terrorBeast(run: Speedrun): void {
  const e = run.engine;
  run.wait(() => e.vars[30] === 3 && inControl(run), "Roger surfaces in the pond", 3000);
  run.dismiss();
  leave(run, "E", 44, { avoidTriggers: false });
  // Stand on dry land well away from the cave: the whistle is refused inside (88-110, 84-102)
  // and the puzzle can only be thrown ashore while the beast is on the prowl (v30 3..5).
  run.type("blow whistle"); // +5
  path(run, 130, 130, { avoidTriggers: false });
  assert.ok(e.flags[30] === 0, "out of the water");
  run.submit("blow whistle");
  assert.ok(e.flags[96] !== 0, "beast burst out of the cave");
  run.type("throw puzzle"); // +10
  run.wait(() => e.vars[30]! >= 3 && e.vars[30]! <= 5, "the beast looks for Roger", 3000);
  run.submit("throw puzzle");
  assert.ok(!run.carried(37), "puzzle thrown");
  run.wait(() => e.vars[30]! >= 18, "the beast is absorbed by the puzzle", 3000);
  run.dismiss();
  alive(run, "terror beast");
  run.checkpoint("Distracted the Terror Beast with the puzzle", { room: 44, score: 119 });
  run.type("get rock"); // rubble in the burst cave mouth (88-108, 77-88), +2
  path(run, 90, 86, { avoidTriggers: false });
  run.submit("get rock");
  run.assertCarried(27, "Stone");
  leave(run, "N", 45, { avoidTriggers: false });
}

/** 045.agi: drop the platform guard with a slung rock, then ride the keycard lift to his craft. */
function landingPlatform(run: Speedrun): void {
  const e = run.engine;
  const guard = e.screenObjects[1]!;
  // Roger arrives inside the south bush box (53-93, 158-167), which hides him (f32). The rock
  // lands 18 cycles after the command and only hits a guard who is not idling at a rail end
  // (v31 > 0 while v30 is 1 or 2), so release it while he is walking toward mid-platform.
  assert.ok(e.flags[32] !== 0, "hidden in the bushes");
  run.type("sling rock at guard"); // needs the athletic supporter; +20
  run.wait(
    () => (e.vars[30] === 1 && guard.x < 80) || (e.vars[30] === 2 && guard.x > 70),
    "guard strides along the platform",
    3000,
  );
  run.submit("sling rock at guard");
  run.wait(() => e.flags[117] !== 0 || e.vars[67] !== 0, "guard topples off the platform", 3000);
  run.dismiss();
  alive(run, "platform guard");
  assert.equal(e.vars[67], 0, "not shot by the guard");
  run.checkpoint("Slung the rock at the platform guard", { room: 45, score: 141 });
  // The card slot box is (124-141, 95-104); the open doorway only admits x124-128.
  run.type("insert keycard"); // +5
  path(run, 126, 102);
  run.submit("insert keycard");
  run.wait(() => e.vars[41] === 2, "lift door opens", 2000);
  run.walkToUntil(126, 90, () => e.flags[36] !== 0, "step into the lift");
  run.wait(() => run.state().room === 8 && inControl(run), "lift rises to the platform", 5000);
  run.dismiss();
  run.checkpoint("Rode the keycard lift to the platform", { room: 8, score: 146 });
  // 008.agi: the hatch box is (76-90, 91-93); the platform rim is a fall trigger.
  run.type("climb in ship");
  path(run, 84, 92);
  run.submit("climb in ship");
  run.waitForRoom(46, "hovercraft cockpit", 1000);
}

/** 046.agi: power, vertical attitude, ascent thrusters, throttle back; +20 once off the planet. */
function liftoff(run: Speedrun): void {
  const e = run.engine;
  // The cockpit monitor is a full-screen readout that waits for any key (f36).
  const readMonitor = (label: string): void => {
    run.wait(() => e.flags[36] !== 0, label, 3000);
    run.advance(120); // reading time for the readout
    run.key(AGI_KEY.ENTER);
    run.wait(() => e.flags[36] === 0, "monitor readout closes", 200);
  };
  run.wait(() => e.inputEnabled, "strapped into the pilot seat", 2000);
  run.command("press power");
  run.wait(() => e.flags[30] === 0 && e.flags[32] !== 0, "console powers up", 2000);
  run.command("turn dial"); // HAC -> VAC (v37 = 1)
  run.wait(() => e.flags[30] === 0 && e.vars[37] === 1, "attitude dial on vertical control", 2000);
  run.command("press ascent");
  run.wait(() => e.vars[40] === 3, "ascent thrusters ignite", 2000);
  run.dismiss();
  run.command("pull throttle"); // centre -> back = ascend while on VAC
  readMonitor("liftoff readout");
  run.wait(() => e.vars[40] === 5, "minimum altitude achieved", 5000);
  alive(run, "ascent");
  run.checkpoint("Lifted off from Labion", { room: 46, score: 166 });
  readMonitor("altitude readout");
  // Thirty seconds later Vohaul overrides the controls whatever Roger does with them.
  run.wait(() => run.state().room === 7, "Vohaul's remote control flies the craft home", 20000);
  run.wait(() => run.state().room === 48, "docked inside the asteroid", 10000);
}

/**
 * Corridor decks roll a hazard on every room entry (120.agi): 14% of the time a floor waxer
 * (116.agi) is armed to sweep the corridor 18-60 cycles later, and mid-corridor rooms have
 * nowhere to hide. Walking straight back out cancels an armed waxer (116.agi resets v125 to 3
 * when the room it was armed for is left before it spawns) and the next entry rolls again, so
 * Roger simply backs out of any corridor that sounds wrong. A waxer that does spawn travels at
 * walking pace from the far end, so one met mid-room is outwalked to the next lift alcove.
 */
function corridor(run: Speedrun, direction: "E" | "W", room: number): void {
  const e = run.engine;
  const from = e.vars[0]!;
  for (let attempt = 0; ; attempt++) {
    assert.ok(attempt < 8, `corridor to room ${room} keeps rolling hazards`);
    leave(run, direction, room);
    if (e.vars[131] === 0) return;
    assert.equal(e.vars[131], 116, "only the floor waxer is expected on these decks");
    assert.equal(e.vars[125], 4, "waxer armed but not yet spawned");
    // v130 names the room a spawned waxer chased Roger out of: it re-enters behind him at his
    // own pace, so he keeps walking. Turning back into that room is what gets him waxed.
    if (e.vars[130] === from) return;
    run.exit(direction === "E" ? "W" : "E", from);
    assert.equal(e.vars[125], 3, "backing out disarmed the waxer");
    alive(run, "corridor");
  }
}

/** Step into a lift alcove (f104), call a deck, and wait for the doors on the far side. */
function rideLift(run: Speedrun, x: number, y: number, command: string, room: number): void {
  const e = run.engine;
  run.type(command);
  path(run, x, y + 4);
  run.walkToUntil(x, y - 2, () => e.flags[104] !== 0, "step into the lift");
  run.submit(command);
  run.wait(() => run.state().room === room && inControl(run), `lift arrives at ${room}`, 6000);
  if (e.vars[131] !== 0) {
    // A waxer rolled for the arrival deck: it cannot reach into the lift alcove, so let it
    // sweep the corridor and leave (v125 back to 3) before stepping out.
    assert.equal(e.vars[131], 116, "only the floor waxer is expected on these decks");
    assert.ok(e.flags[104] !== 0, "sheltering in the lift alcove");
    run.wait(() => e.vars[125] === 3, "floor waxer finishes its pass", 6000);
  }
  alive(run, "lift arrival");
}

/** Janitor closets share one layout: a wall button east of a door whose sill ignores blocks. */
function enterCloset(run: Speedrun, buttonX: number, doorX: number, open: () => boolean): void {
  run.type("press button");
  path(run, buttonX, 98);
  run.submit("press button");
  run.wait(open, "closet door slides open", 1000);
  go(run, doorX, 97);
  run.walkToUntil(doorX, 90, () => run.state().y <= 95, "step into the closet");
  run.dismiss();
}

/** Vohaul's asteroid, deck three: the plunger hangs in the mid-corridor janitor closet. */
function deckThree(run: Speedrun): void {
  const e = run.engine;
  run.wait(
    () => run.state().room === 49 && e.inputEnabled && inControl(run),
    "out of the craft",
    10000,
  );
  run.dismiss();
  run.checkpoint("Landed inside Vohaul's asteroid", { room: 49, score: 166 });
  // 049.agi: the bay platform's only safe ways off are the y73-79 catwalks east and west.
  path(run, 3, 76);
  run.exit("W", 51);
  rideLift(run, 86, 75, "press three", 60);
  corridor(run, "W", 61);
  corridor(run, "W", 62);
  enterCloset(run, 102, 92, () => e.vars[30] === 2);
  run.take("get plunger", 28, "plunger"); // 062.agi, +1
  run.checkpoint("Took the plunger from a janitor closet", { room: 62, score: 167 });
}

/** Deck four: glass cutter from the janitor closet, toilet paper from the washroom stall. */
function deckFour(run: Speedrun): void {
  const e = run.engine;
  go(run, 92, 99);
  corridor(run, "E", 61);
  corridor(run, "E", 60);
  rideLift(run, 91, 93, "press four", 70);
  corridor(run, "W", 71);
  corridor(run, "W", 72);
  enterCloset(run, 102, 92, () => e.vars[30] === 2);
  run.take("get cutter", 32, "glass cutter"); // 072.agi, +1
  go(run, 92, 99);
  corridor(run, "W", 73);
  // 073.agi: the west washroom door's button box is (65-74, 97-101); its sill is (57-74, 95).
  run.type("press button");
  path(run, 70, 99);
  run.submit("press button");
  run.wait(() => e.vars[31] === 2, "washroom door opens", 1000);
  go(run, 61, 97);
  run.walkToUntil(61, 90, () => run.state().room === 76, "into the washroom");
  run.wait(() => e.movementControlEnabled, "through the door", 100);
  run.direction(0);
  // 076.agi: only the second stall opens; its door box is (77-87, 104-112), the seat (80-83, 104-105).
  run.type("open door");
  path(run, 82, 110);
  run.submit("open door");
  run.wait(() => e.vars[30] === 2, "stall door opens", 1000);
  run.walkToUntil(82, 100, () => e.flags[30] !== 0, "into the stall");
  run.take("get paper", 29, "toilet paper"); // +1
  run.checkpoint("Collected the glass cutter and toilet paper", { room: 76, score: 169 });
  path(run, 60, 160);
  run.exit("S", 73);
  corridor(run, "W", 74);
  corridor(run, "W", 75);
}

/** Deck five: waste basket and the lighter in the overalls, then back down to the bay. */
function deckFive(run: Speedrun): void {
  const e = run.engine;
  rideLift(run, 60, 93, "press five", 85);
  corridor(run, "E", 84);
  corridor(run, "E", 83);
  // 083.agi: closet button (68-76, 97-100), door sill x58-64. The floor grate at
  // (86-95, 97-102) further east drops Roger into a pit, so stay west of it.
  enterCloset(run, 72, 61, () => e.vars[32] === 2);
  run.take("get basket", 30, "waste basket"); // +1
  run.command("get overalls"); // searching them (f213) reveals the lighter
  run.take("get lighter", 33, "lighter"); // +1
  run.command("put paper in basket"); // 000.agi: basket + paper -> "Basket with Paper", +1
  run.assertCarried(31, "Basket with Paper");
  run.checkpoint("Packed a basket of paper and a lighter", { room: 83, score: 172 });
  go(run, 61, 99);
  corridor(run, "W", 84);
  corridor(run, "W", 85);
  rideLift(run, 60, 93, "press one", 50);
}

/** 066.agi: the tube below the bay is an acid trap; the plunger and a paper fire beat it. */
function acidTrap(run: Speedrun): void {
  const e = run.engine;
  path(run, 3, 76);
  run.exit("W", 49);
  // The bay stairs change Roger's step size, so aim for a band rather than a pixel; the
  // y134/y154 trigger rows across the stairwell are disarmed by the room logic.
  through(run, () =>
    run.walkPath(
      { x0: 72, x1: 80, y0: 120, y1: 131 },
      { avoidTriggers: true, geometry: "current" },
    ),
  );
  run.walkDirection("S", () => run.state().room === 66, "down the stairs to the tube");
  // Stepping off the stairs shuts the door; walking west of x73 and east of x80 raises both
  // barriers, and then the floor (o5) retracts to the left over a vat of acid.
  go(run, 76, 100);
  go(run, 70, 102);
  go(run, 83, 102);
  run.wait(() => e.vars[33] === 3, "the floor starts to slide away", 1000);
  run.checkpoint("Sealed in above the acid vat", { room: 66, score: 172 });
  // The plunger holds only on the smooth wall at (60-66, 97-107), and Roger's grip lasts only
  // if the floor has already slid past x45 (f37 otherwise). The floor carries him west with
  // it, so walk back to the wall at the last moment.
  const floor = e.screenObjects[5]!;
  run.type("stick plunger to wall"); // +10
  run.wait(() => floor.x <= 47, "the floor is nearly gone", 8000);
  go(run, 63, 102);
  run.wait(() => floor.x <= 45, "the floor slides past the safe mark", 1000);
  run.submit("stick plunger to wall");
  assert.equal(e.flags[37], 0, "grip will hold until the floor returns");
  run.wait(() => e.flags[211] !== 0 || e.vars[67] !== 0, "the floor slides back (+10)", 8000);
  alive(run, "acid vat");
  assert.equal(e.vars[67], 0, "did not fall into the acid");
  run.checkpoint("Hung from the plunger over the acid", { room: 66, score: 192 });
  run.command("let go");
  run.wait(() => e.flags[38] !== 0 && e.vars[31] === 0 && e.vars[32] === 0, "barriers drop", 2000);
  // 122.agi: a burning basket sets off the sprinklers, which short out the patrol robot for
  // good (v135 = 6) before it is ever switched on. +1 for the basket, +10 for the fire.
  run.command("drop basket");
  run.command("light paper");
  run.wait(() => e.vars[240] === 4, "sprinklers douse the tube", 3000);
  run.dismiss();
  assert.equal(e.vars[135], 6, "patrol robot shorted out");
  run.checkpoint("Set off the sprinklers with a paper fire", { room: 66, score: 203 });
  leave(run, "E", 68, { avoidTriggers: false });
}

/** The console's east rim in the miniature rooms is a fall trigger; keep every plan west of it. */
const CONSOLE_EAST_RIM = [{ x0: 100, x1: 159, y0: 0, y1: 167 }];

/** 086.agi: Vohaul's chamber. The stair platform's ray shrinks Roger into a jar on the console. */
function shrunk(run: Speedrun): void {
  const e = run.engine;
  run.walkToUntil(150, 100, () => run.state().room === 86, "through Vohaul's door");
  run.wait(() => e.vars[137] === 4 && inControl(run), "Vohaul finishes gloating", 5000);
  run.dismiss();
  run.checkpoint("Faced Sludge Vohaul", { room: 86, score: 203 });
  // The stairs start at (71-82, 138) heading north; the platform row y88 fires the shrink ray.
  path(run, 76, 140, { avoidTriggers: false });
  run.walkToUntil(76, 85, () => e.flags[111] !== 0, "up the platform stairs");
  run.wait(() => run.state().room === 87 && e.inputEnabled, "miniaturised into the jar", 8000);
  run.dismiss();
  // 087.agi: the jar's air lasts 15 game minutes; the glass cutter opens it (+5).
  run.command("cut glass");
  run.wait(() => e.vars[30] === 0 && e.flags[215] !== 0 && inControl(run), "out of the jar", 3000);
  run.dismiss();
  run.checkpoint("Cut a way out of the specimen jar", { room: 87, score: 208 });
}

/** 088.agi: inside Vohaul's life-support unit; the button behind the pump stops it (+10). */
function lifeSupport(run: Speedrun): void {
  const e = run.engine;
  // The vent grille is the trigger diagonal inside (0-26, 77-101).
  run.type("climb in grate");
  path(run, 15, 91, { avoidTriggers: false, avoidRegions: CONSOLE_EAST_RIM });
  run.submit("climb in grate");
  run.waitForRoom(88, "inside the life-support unit", 1000);
  run.type("press button"); // button box (88-94, 98-101)
  path(run, 90, 100);
  run.submit("press button");
  run.wait(() => e.vars[3] === 218, "the pump stops", 1000);
  run.dismiss();
  assert.ok(e.flags[112] !== 0, "Vohaul's life support is off");
  run.checkpoint("Shut down Vohaul's life support", { room: 88, score: 218 });
  run.type("climb out"); // vent box (108-117, 100-116)
  through(run, () => run.walkPath({ x0: 109, x1: 116, y0: 101, y1: 115 }, { geometry: "current" }));
  run.submit("climb out");
  run.waitForRoom(87, "back on the console", 1000);
  run.wait(() => inControl(run) && e.flags[114] !== 0, "Vohaul's death starts the countdown", 2000);
  run.dismiss();
  assert.equal(e.vars[144], 1, "clone launch countdown running");
}

/** 089.agi: power the shrink ray's keyboard, type ENLARGE, and get back under the ray. */
function enlarged(run: Speedrun): void {
  const e = run.engine;
  leave(run, "W", 89);
  run.type("pull lever"); // switch box (13-22, 92-95); with Vohaul alive x114 here was fatal
  path(run, 17, 94);
  run.submit("pull lever");
  run.wait(() => e.flags[113] !== 0 && inControl(run), "keyboard powered", 1000);
  run.command("type enlarge"); // Roger hops across the keys, then v143 = 1
  run.wait(() => e.vars[96] === 0 && inControl(run), "ENLARGE typed", 3000);
  assert.equal(e.vars[143], 1, "ray set to enlarge");
  leave(run, "E", 87);
  // The cut pane (79-81, 99-106) ignores blocks; the jar floor (79-83, 96-98) triggers the ray.
  path(run, 80, 108, { avoidRegions: CONSOLE_EAST_RIM });
  run.walkToUntil(80, 96, () => e.vars[31] === 2, "back into the jar");
  run.wait(
    () => run.state().room === 86 && inControl(run) && e.inputEnabled,
    "restored to full size",
    8000,
  );
  run.dismiss();
  alive(run, "enlarging");
  run.checkpoint("Returned to full size", { room: 86, score: 218 });
}

/** 086.agi: Vohaul's own terminal aborts the clone launch with the code inked on his hand. */
function abortLaunch(run: Speedrun): void {
  const e = run.engine;
  run.type("look screen"); // terminal keyboard box on the platform (60-72, 61-65)
  path(run, 66, 63);
  run.submit("look screen");
  run.wait(() => e.flags[36] !== 0 && e.inputEnabled, "terminal screen", 200);
  run.advance(120); // reading time for the status screen
  run.type("shsr"); // +10
  run.key(AGI_KEY.ENTER);
  run.wait(() => e.flags[115] !== 0, "clone launch aborted", 200);
  assert.equal(e.vars[144], 2, "launch countdown stopped");
  run.advance(60);
  run.key(AGI_KEY.F6); // controller 6 leaves the terminal
  run.wait(() => e.flags[36] === 0 && e.inputEnabled, "terminal closed", 200);
  run.checkpoint("Aborted the clone launch with Vohaul's code", { room: 86, score: 228 });
  path(run, 146, 36);
  run.walkToUntil(150, 34, () => run.state().room === 90, "up the east stairs");
}

/** 090/091.agi: the glass walkway tubes. The second one cracks open to space under Roger. */
function glassTubes(run: Speedrun): void {
  const e = run.engine;
  run.type("get mask"); // emergency box (21-27, 139-141), +2
  path(run, 24, 140);
  run.submit("get mask");
  run.assertCarried(39, "Oxygen Mask");
  run.command("wear mask");
  assert.equal(e.vars[50], 4, "mask on");
  // Each tube doubles back at a bend that the room logic walks for Roger (v31 = 25 cycles).
  path(run, 131, 138, { avoidTriggers: false });
  run.walkToUntil(136, 138, () => e.vars[31]! > 0, "round the first bend");
  run.wait(() => e.vars[30] === 1 && e.movementControlEnabled, "upper run of the tube", 300);
  enter(run, 106, 57, 91);
  path(run, 1, 100, { avoidTriggers: false });
  run.walkToUntil(0, 100, () => e.vars[31]! > 0, "round the second bend");
  run.wait(() => e.vars[30] === 0 && e.movementControlEnabled, "lower run of the tube", 300);
  // Crossing (62, 120-130) fractures the tube; ten seconds later the air is gone.
  leave(run, "S", 53, { avoidTriggers: false });
  assert.equal(e.vars[128], 2, "the tube fractured on the way");
  run.checkpoint("Survived the fractured tube behind an oxygen mask", { room: 53, score: 230 });
}

/** Ring corridor to the escape pod bay; board a pod before the Marrow-Matic robot wakes. */
function podBay(run: Speedrun): void {
  const e = run.engine;
  leave(run, "W", 54, { avoidTriggers: false });
  leave(run, "W", 55, { avoidTriggers: false });
  leave(run, "W", 56, { avoidTriggers: false });
  // 056.agi/114.agi: the bay robot starts stalking 27 cycles after entry and cooks anyone it
  // reaches outside a pod. The nearest pod (4) has its button at (111-116, 97-100) and its
  // hatch at (118-129, 97-100); boarding (+10) is allowed as soon as the button is pressed.
  run.type("press button");
  go(run, 114, 99);
  run.submit("press button");
  assert.equal(e.vars[117], 4, "pod four called up");
  run.type("climb in pod");
  go(run, 122, 99);
  run.submit("climb in pod");
  assert.ok(e.flags[116] !== 0, "aboard the pod");
  run.wait(() => e.vars[3] === 240 && e.vars[96] === 0, "strapped into the escape pod", 1000);
  run.dismiss();
  alive(run, "pod bay robot");
  run.checkpoint("Boarded an escape pod", { room: 56, score: 240 });
  run.command("launch");
  run.wait(
    () => run.state().room === 93 && e.inputEnabled,
    "pod launched clear of the asteroid",
    20000,
  );
  run.dismiss();
  run.checkpoint("Escaped the doomed asteroid", { room: 93, score: 240 });
}

/** 093.agi: four minutes of air in the pod; the sleep chamber is the only way to last (+10). */
function sleepChamber(run: Speedrun): void {
  const e = run.engine;
  run.command("look around"); // the first look hands control back to the player (f30)
  assert.ok(e.flags[30] !== 0 && e.movementControlEnabled, "free to move about the pod");
  run.type("open chamber"); // chamber box (80-88, 83-94)
  path(run, 84, 90, { avoidTriggers: false });
  run.submit("open chamber");
  run.wait(() => e.vars[32] === 2, "sleep chamber opens", 1000);
  run.dismiss();
  run.command("get in chamber");
  run.wait(() => e.vars[96] === 11, "Roger drifts off to sleep", 3000);
  run.dismiss();
  assert.equal(e.vars[144], 2, "the clone launch stayed aborted");
  run.wait(() => e.vars[42] === 2, "closing title card", 5000);
  alive(run, "ending");
  run.checkpoint("Asleep in the pod with Xenon saved", { room: 93, score: 250 });
}

export const SQ2_STAGES: readonly ((run: Speedrun) => void)[] = [
  boot,
  station,
  kidnapped,
  crashSite,
  hunters,
  freeNative,
  mailOrder,
  berryMaze,
  toSwamp,
  gemCave,
  snared,
  cageBreak,
  ropeDescent,
  ropeSwing,
  darkTunnel,
  canyon,
  tunnels,
  river,
  terrorBeast,
  landingPlatform,
  liftoff,
  deckThree,
  deckFour,
  deckFive,
  acidTrap,
  shrunk,
  lifeSupport,
  enlarged,
  abortLaunch,
  glassTubes,
  podBay,
  sleepChamber,
];

/**
 * Space Quest II complete-game walkthrough: from sweeping the hull of Orbital Station 4 to
 * the escape pod's sleep chamber, with all 250 points. The game declares 250 as its maximum
 * and the logic's one-time awards add up to exactly that.
 */
export function sq2Complete(run: Speedrun): void {
  for (const stage of SQ2_STAGES) stage(run);
}

export const sq2Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.SQ2,
  alias: "sq2",
  label: "defeated Vohaul, escaped the asteroid and reached the ending with maximum score",
  coverage: "complete-game",
  // Every timed or random event on the route is waited out or countered from observed state
  // (hovercraft, guard, floor waxers), so the default seed needs no tuning.
  seed: 1,
  route: sq2Complete,
  expected: {
    room: 93,
    score: 250,
    // v96 = 11 is the ending's credits mode, v42 = 2 the closing title card, and v144 = 2
    // the aborted clone launch that selects the good-ending farewell.
    vars: { 42: 2, 96: 11, 144: 2 },
    // f32 asleep in the chamber, f197 its award, f112 Vohaul's life support off, f115 abort code.
    flags: { 32: 1, 112: 1, 115: 1, 197: 1 },
    carriedExactly: [21, 24, 26, 32, 33, 34, 35, 36, 39],
    inputEnabled: false,
  },
  requiresAnswer: true,
};
