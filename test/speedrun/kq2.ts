import assert from "node:assert/strict";
import type { Speedrun } from "./runner.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { planWalk, walkPlanned, type Target } from "../../scripts/walkthrough-navigation.ts";
import { directionForDelta } from "../../src/agent/gameTestSteps.ts";

function carried(run: Speedrun, num: number): boolean {
  const item = run.engine.readState().inventory.find((entry) => entry.num === num);
  return item?.room === 255;
}

function skipIntro(run: Speedrun): void {
  for (let i = 0; i < 6000 && !(run.state().control && run.state().room === 1); i++) {
    if (i % 30 === 0) run.key(AGI_KEY.ENTER);
    run.advance();
  }
  assert.ok(run.state().control, "intro never yielded control");
}

/** Walk toward (x,y) until flag `flag` sets or the bounded loop ends. */
function walkUntilFlag(
  run: Speedrun,
  x: number,
  y: number,
  flag: number,
  label: string,
  max = 3000,
): void {
  const room = run.state().room;
  for (let n = 0; n < max; n++) {
    run.dismiss();
    if (run.engine.flags[flag] !== 0) return;
    const s = run.state();
    assert.equal(s.room, room, `Unexpected room during ${label}`);
    const dx = Math.sign(x - s.x);
    const dy = Math.sign(y - s.y);
    run.direction(directionForDelta(dx, dy));
    run.advance();
  }
  throw new Error(`walkUntilFlag ${label} timed out: ${JSON.stringify(run.state())}`);
}

/** Opening errands through the cloak and ring; later puzzles are outside this route. */
export function kq2Opening(run: Speedrun): void {
  skipIntro(run);
  run.checkpoint("Opening", { room: 1, score: 0 });
  run.exit("E", 2);
  run.exit("E", 3);
  // Opening the mailbox turns on observe.blocks inside its pocket (x<17,
  // y117-124), so interact from the open fence-gap row instead.
  run.walkTo(8, 130);
  run.walkTo(25, 131);
  run.command("open mailbox");
  run.wait(() => run.engine.flags[54] !== 0, "mailbox open", 600);
  run.command("get basket");
  assert.ok(carried(run, 63), "basket carried");
  run.checkpoint("Basket", { room: 3, score: 3 });
  // North exit is a narrow control-screen corridor: pass the x139 barrier at
  // center 134, then shift east around the y60-63 blob before crossing.
  run.walkTo(8, 130);
  run.walkTo(134, 130);
  run.walkTo(134, 80);
  run.walkTo(138, 75);
  run.exit("N", 45);
  run.exit("E", 46);
  run.walkTo(102, 135);
  run.command("open door");
  run.wait(() => run.state().room === 72, "tree door opens", 1200);
  run.checkpoint("Tree house", { room: 72, score: 3 });
  // Ladder: walk onto the hole; f31 marks the climbing view. Then descend.
  walkUntilFlag(run, 90, 115, 31, "climb onto ladder");
  run.exit("S", 73);
  // Arrive on the ladder (f31); climb down until the logic dismounts ego.
  for (let n = 0; n < 3000 && run.engine.flags[31] !== 0; n++) {
    run.dismiss();
    run.direction(5);
    run.advance();
  }
  assert.equal(run.engine.flags[31], 0, "dismounted at ladder foot");
  run.exit("E", 74);
  // Dwarf: f33 means he is home; leave west and re-enter until he is gone.
  for (let n = 0; run.engine.flags[33] !== 0; n++) {
    assert.ok(n < 12, "dwarf never left");
    run.exit("W", 73);
    run.exit("E", 74);
  }
  run.walkTo(50, 120);
  run.command("get soup");
  assert.ok(carried(run, 67), "soup carried");
  run.checkpoint("Soup", { room: 74, score: 5 });
  // Rock barriers force an east-then-south approach to the trunk.
  run.walkTo(100, 122);
  run.walkTo(98, 140);
  run.command("open chest");
  run.command("get earrings");
  assert.ok(carried(run, 58), "earrings carried");
  run.checkpoint("Earrings", { room: 74, score: 12 });
  // Leave the tree house: back north through the rock corridor, then west.
  run.walkTo(100, 122);
  run.walkTo(20, 121);
  run.exit("W", 73);
  // Climb up: stand in the trigger strip (y120-121) facing north to re-mount;
  // the row above is a conditional wall.
  run.walkTo(105, 121);
  for (let n = 0; n < 3000 && run.engine.flags[31] === 0; n++) {
    run.dismiss();
    run.direction(1);
    run.advance();
  }
  assert.equal(run.engine.flags[31], 1, "climbing the ladder");
  run.exit("N", 72);
  // Arrive climbing (f31); walk onto the hole trigger to regain normal view.
  for (let n = 0; n < 3000 && run.engine.flags[31] !== 0; n++) {
    run.dismiss();
    const s = run.state();
    const dx = Math.sign(90 - s.x);
    const dy = Math.sign(112 - s.y);
    run.direction(directionForDelta(dx, dy));
    run.advance();
  }
  // Leave west along y110: clears the ladder triggers (y112+) and the walls
  // at y104 and y116; the x=30 column is the door back outside.
  run.walkTo(90, 110);
  run.walkTo(33, 110);
  for (let n = 0; n < 3000 && run.state().room === 72; n++) {
    run.dismiss();
    run.direction(7);
    run.advance();
  }
  run.checkpoint("Outside again", { room: 46, score: 12 });
  // Back to Grandma's cottage: west, then south through the same corridor.
  run.exit("W", 45);
  run.exit("S", 3);
  run.walkTo(138, 75);
  run.walkTo(134, 80);
  run.walkTo(134, 130);
  run.walkTo(73, 131);
  run.walkTo(73, 112);
  // The wolf is home on some entries (f31); leave south and retry until not.
  for (let n = 0; ; n++) {
    assert.ok(n < 12, "wolf never left");
    run.command("open door");
    run.wait(() => run.state().room === 70, "cottage door opens", 1200);
    if (run.engine.flags[31] === 0) break;
    for (let m = 0; m < 3000 && run.state().room === 70; m++) {
      run.dismiss();
      run.direction(5);
      run.advance();
    }
    assert.equal(run.state().room, 3, "fled the wolf");
    run.walkTo(73, 112);
  }
  run.walkTo(40, 110);
  run.command("give soup to grandma");
  run.wait(() => run.engine.flags[98] !== 0, "grandma fed", 600);
  run.command("look under bed");
  assert.ok(carried(run, 55), "ruby ring carried");
  assert.ok(carried(run, 68), "cloak carried");
  run.checkpoint("Cloak and ring", { room: 70, score: 18 });
  run.walkTo(14, 157);
  for (let n = 0; n < 3000 && run.state().room === 70; n++) {
    run.dismiss();
    run.direction(5);
    run.advance();
  }
  run.checkpoint("Back outside", { room: 3, score: 18 });
}

function monasteryApproach(run: Speedrun): void {
  kq2Opening(run);
  run.walkTo(73, 131);
  run.walkTo(134, 130);
  run.walkTo(134, 80);
  run.walkTo(138, 75);
  run.exit("N", 45);
  run.exit("E", 46);
  run.exit("S", 4);
  run.wait(() => run.engine.flags[53] !== 0, "LRRH appears", 30000);
  for (let n = 0; n < 60; n++) {
    const girl = run.engine.screenObjects[2]!;
    const s = run.state();
    if (Math.hypot(girl.x - s.x, girl.y - s.y) <= 20) break;
    try {
      run.walkTo(Math.max(2, Math.min(157, girl.x - 6)), Math.max(40, Math.min(165, girl.y)), 300);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Walk blocked")) throw error;
      run.advance(60);
    }
  }
  run.command("give basket to girl");
  assert.ok(carried(run, 52), "bouquet carried");
  run.checkpoint("Bouquet", { room: 4, score: 22 });
  run.command("wear cloak");
  run.command("wear ring");
  assert.equal(run.engine.flags[70], 1, "cloak worn");
  assert.equal(run.engine.flags[68], 1, "ring worn");
  run.checkpoint("Cloak and ring worn", { room: 4, score: 25 });
  run.exit("E", 5);
  run.exit("E", 6);
}

function walkSmart(run: Speedrun, target: Target, attempts = 25): void {
  for (let n = 0; n < attempts; n++) {
    const s = run.state();
    if (s.x >= target.x0 && s.x <= target.x1 && s.y >= target.y0 && s.y <= target.y1) return;
    const plan = planWalk(run, target);
    if (!plan.found)
      throw new Error(`No static path: ${JSON.stringify(plan.reached)} from ${s.x},${s.y}`);
    let blocked = false;
    for (const point of plan.waypoints) {
      try {
        run.walkTo(point.x, point.y, Math.max(300, plan.steps * 12));
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Walk blocked")) throw error;
        blocked = true;
        break;
      }
    }
    if (!blocked) {
      const reached = run.state();
      assert.ok(
        reached.x >= target.x0 &&
          reached.x <= target.x1 &&
          reached.y >= target.y0 &&
          reached.y <= target.y1,
        "planned target reached",
      );
      return;
    }
  }
  throw new Error(
    `walkSmart exhausted: ${JSON.stringify(run.state())} target ${JSON.stringify(target)}`,
  );
}

function monasteryCross(run: Speedrun): void {
  monasteryApproach(run);
  run.checkpoint("Monastery approach", { room: 6, score: 25 });
  walkPlanned(run, { x0: 70, x1: 70, y0: 150, y1: 150 });
  run.command("open door");
  run.wait(() => run.state().room === 71, "monastery door opens", 1200);
  run.checkpoint("Chapel", { room: 71, score: 25 });
  walkPlanned(run, { x0: 80, x1: 90, y0: 82, y1: 83 });
  run.command("pray");
  run.wait(() => run.engine.flags[154] !== 0, "prayer counted", 600);
  run.checkpoint("Prayed", { room: 71, score: 27 });
  run.wait(() => run.engine.flags[32] === 0, "monk stands and asks name");
  run.command("graham");
  assert.ok(carried(run, 69), "cross carried");
  run.checkpoint("Cross", { room: 71, score: 29 });
  run.command("wear cross");
  assert.equal(run.engine.flags[69], 1, "cross worn");
  run.checkpoint("Cross worn", { room: 71, score: 31 });
  walkSmart(run, { x0: 60, x1: 80, y0: 165, y1: 167 });
  run.exit("S", 6);
  run.checkpoint("Left monastery", { room: 6, score: 31 });
}

/** Follow a fixed bridge path one cell at a time, preserving its input timing.
 * The deck and approaches avoid lethal trigger rims and the bridge object's baseline.
 * A changed collision or puzzle outcome must fail instead of being routed around.
 */
function walkBridge(run: Speedrun, waypoints: readonly (readonly number[])[]): void {
  for (const point of waypoints) {
    const targetX = point[0]!,
      targetY = point[1]!;
    for (let steps = 0; ; steps++) {
      const state = run.state();
      assert.equal(state.room, 48, "bridge room");
      assert.equal(run.engine.flags[119], 0, "no chasm fall");
      if (state.x === targetX && state.y === targetY) break;
      assert.ok(steps < 320, "bridge waypoint reached");
      run.walkTo(state.x + Math.sign(targetX - state.x), state.y + Math.sign(targetY - state.y));
    }
  }
}

/** Cold boot through the cross, brooch, first inscription and bridge round trip (41 points). */
export function kq2Bridge(run: Speedrun): void {
  monasteryCross(run);
  run.exit("S", 13);
  walkSmart(run, { x0: 42, x1: 46, y0: 60, y1: 62 });
  run.command("look in hole");
  run.command("get brooch");
  assert.ok(carried(run, 59), "brooch carried");
  run.checkpoint("Brooch", { room: 13, score: 39 });
  run.exit("N", 6);
  walkSmart(run, { x0: 140, x1: 145, y0: 150, y1: 152 });
  run.exit("N", 48);
  run.checkpoint("Bridge room", { room: 48, score: 39 });
  walkBridge(run, [
    [41, 167],
    [5, 131],
    [40, 96],
    [41, 97],
    [55, 97],
    [62, 104],
  ]);
  walkBridge(run, [
    [69, 97],
    [73, 97],
    [74, 98],
    [92, 98],
    [93, 97],
    [98, 97],
    [99, 96],
    [104, 96],
    [105, 95],
    [108, 95],
    [109, 94],
    [110, 94],
    [111, 93],
    [112, 93],
    [113, 92],
    [114, 92],
    [115, 91],
    [116, 91],
    [117, 90],
    [118, 90],
    [119, 89],
    [120, 89],
    [121, 88],
    [123, 88],
    [124, 87],
    [133, 87],
    [135, 85],
    [136, 85],
    [138, 87],
  ]);
  run.checkpoint("Bridge crossed east", { room: 48, score: 40 });
  run.exit("E", 49);
  run.exit("N", 42);
  run.checkpoint("Door room", { room: 42, score: 40 });
  walkSmart(run, { x0: 75, x1: 84, y0: 102, y1: 105 });
  run.command("read inscription");
  run.wait(() => run.engine.flags[67] !== 0, "first inscription read", 600);
  run.checkpoint("Inscription", { room: 42, score: 40 });
  run.exit("S", 49);
  run.exit("W", 48);
  walkBridge(run, [
    [154, 42],
    [154, 79],
    [146, 87],
  ]);
  walkBridge(run, [
    [122, 111],
    [121, 111],
    [120, 112],
    [119, 112],
    [118, 113],
    [117, 113],
    [116, 114],
    [114, 114],
    [113, 115],
    [112, 115],
    [111, 116],
    [105, 116],
    [104, 117],
    [86, 117],
    [85, 118],
    [84, 118],
    [83, 119],
    [79, 119],
    [72, 112],
  ]);
  run.checkpoint("Bridge crossed west", { room: 48, score: 41 });
}

/** Chapter: unlock first door, read second inscription, cross bridge back to room 48 (90 points). */
export function kq2Door1(run: Speedrun): void {
  kq2Bridge(run);

  // 1. Leave Room 48 west into 47
  walkBridge(run, [
    [62, 104],
    [55, 97],
    [41, 97],
    [40, 96],
    [5, 131],
  ]);
  run.walkTo(0, 131);
  run.exit("W", 47);

  // 2. Room 47: walk north to Room 40
  walkSmart(run, { x0: 60, x1: 90, y0: 42, y1: 45 });
  run.exit("N", 40);

  // In Room 40: get mallet from tree hole (+2, item 60)
  walkSmart(run, { x0: 72, x1: 96, y0: 80, y1: 95 });
  run.command("take mallet");
  run.wait(() => carried(run, 60), "mallet taken");
  run.checkpoint("Mallet", { room: 40, score: 43 });

  // 3. Room 40 -> 39 -> 38
  walkSmart(run, { x0: 1, x1: 5, y0: 110, y1: 130 });
  run.exit("W", 39);

  walkSmart(run, { x0: 1, x1: 5, y0: 110, y1: 130 });
  run.exit("W", 38);

  // In Room 38: get necklace from hollow log (+7, item 57)
  walkSmart(run, { x0: 95, x1: 110, y0: 125, y1: 135 });
  run.command("take necklace");
  run.wait(() => carried(run, 57), "necklace taken");
  run.checkpoint("Necklace", { room: 38, score: 50 });

  // 4. Room 38 -> 31 -> 30 -> 23
  walkSmart(run, { x0: 60, x1: 80, y0: 42, y1: 45 });
  run.exit("N", 31);

  // In 31: walk along bottom west to 30
  walkSmart(run, { x0: 1, x1: 5, y0: 155, y1: 165 });
  run.exit("W", 30);

  // In 30: walk north to 23
  walkSmart(run, { x0: 70, x1: 85, y0: 42, y1: 45 });
  run.exit("N", 23);

  // In 23: get stake from tree at (73, 111) (+2, item 54)
  walkSmart(run, { x0: 70, x1: 76, y0: 115, y1: 120 });
  run.command("take stake");
  run.wait(() => carried(run, 54), "stake taken");
  run.checkpoint("Stake", { room: 23, score: 52 });

  // 5. Room 23 -> 22
  walkSmart(run, { x0: 1, x1: 5, y0: 110, y1: 130 });
  run.exit("W", 22);

  // In 22: clam at (100, 100) -> take clam (+0, item 82), take bracelet (+7, item 53)
  walkSmart(run, { x0: 95, x1: 105, y0: 104, y1: 108 });
  run.command("take clam");
  run.wait(() => run.engine.flags[72] !== 0, "clam taken");
  run.command("take bracelet");
  run.wait(() => carried(run, 53), "bracelet taken");
  run.checkpoint("Bracelet", { room: 22, score: 59 });

  // 6. Room 22 -> 29 -> 36
  walkSmart(run, { x0: 60, x1: 80, y0: 160, y1: 167 });
  run.exit("S", 29);

  // In Room 29: stay in safe corridor x in [100..110] away from water
  walkSmart(run, { x0: 100, x1: 110, y0: 100, y1: 120 });
  walkSmart(run, { x0: 100, x1: 110, y0: 160, y1: 166 });
  run.exit("S", 36);

  // In 36: navigate east around central tree to reach trident at (130, 140) (+3, item 51)
  run.walkTo(145, 50);
  run.walkTo(145, 100);
  run.walkTo(125, 140);
  run.command("take trident");
  run.wait(() => carried(run, 51), "trident taken");
  run.checkpoint("Trident", { room: 36, score: 62 });

  // 7. Step into water in Room 36 and swim
  while (run.engine.flags[0] === 0) {
    run.direction(7); // West
    run.advance();
  }
  run.wait(() => run.engine.vars[95] === 1, "treading water");
  run.command("swim");
  run.wait(() => run.engine.vars[95] === 2, "swimming");

  // Exit west into ocean (Room 50)
  run.exit("W", 50);

  // Swim North 3 times in Room 50 (v73: 36 -> 29 -> 22 -> 15)
  for (let i = 0; i < 3; i++) {
    const prev = run.engine.vars[73];
    while (run.engine.vars[73] === prev) {
      run.direction(1);
      run.advance();
    }
  }
  run.direction(0);

  // Exit East onto beach in Room 15
  run.exit("E", 15);

  // 8. In Room 15: swim north along shore to (12, 80) near mermaid rock
  run.walkTo(12, 80);
  run.command("give flowers to mermaid");
  run.wait(() => run.engine.flags[33] !== 0, "seahorse summoned");
  run.checkpoint("Mermaid", { room: 15, score: 64 });

  // Ride seahorse
  run.command("ride seahorse");
  run.wait(() => run.engine.vars[0] === 54, "entered underwater 54", 10000);
  run.checkpoint("Seahorse", { room: 54, score: 66 });

  // Transit 54 -> 53 -> 52 -> 51
  run.wait(() => run.engine.vars[0] === 51, "arrived at King Neptune", 30000);

  // 9. In Room 51: King Neptune at (25, 101)
  walkSmart(run, { x0: 55, x1: 65, y0: 100, y1: 105 });
  run.command("give trident to neptune");
  run.wait(() => run.engine.flags[95] !== 0, "clam opened");
  run.checkpoint("Neptune", { room: 51, score: 70 });

  // Take gold key from open clam (+5, item 61)
  walkSmart(run, { x0: 10, x1: 22, y0: 120, y1: 130 });
  run.command("take key");
  run.wait(() => run.engine.flags[96] !== 0, "key taken");
  run.checkpoint("Gold key", { room: 51, score: 75 });

  // Take cloth from bottle (+2, item 73)
  run.command("take cloth");
  run.wait(() => carried(run, 73), "cloth taken");
  run.checkpoint("Cloth", { room: 51, score: 77 });

  // Exit East from 51 -> transit 52 -> 53 -> 54 -> Room 15
  run.exit("E", 52);
  run.wait(() => run.engine.vars[0] === 15 && run.state().control, "returned to Room 15", 30000);

  // Walk east out of water onto land in Room 15
  while (run.engine.vars[95] !== 0) {
    run.direction(3);
    run.advance();
  }
  run.direction(0);

  // 10. Room 15 -> North 3 times: 15 -> 8 -> 1 -> 43
  walkSmart(run, { x0: 70, x1: 90, y0: 42, y1: 45 });
  run.exit("N", 8);

  walkSmart(run, { x0: 70, x1: 90, y0: 42, y1: 45 });
  run.exit("N", 1);

  walkSmart(run, { x0: 85, x1: 95, y0: 42, y1: 45 });
  run.exit("N", 43);

  // Exit East into Room 44 (Hagatha cave exterior)
  walkSmart(run, { x0: 150, x1: 155, y0: 110, y1: 130 });
  run.exit("E", 44);

  // Enter cave at right into Room 69
  run.walkTo(125, 95);
  run.wait(() => run.engine.vars[0] === 69, "entered Hagatha cave", 5000);

  // In 69: walk near cage at (100, 100) (distance <= 20)
  walkSmart(run, { x0: 84, x1: 90, y0: 100, y1: 102 });
  run.command("cover cage with cloth");
  run.wait(() => run.engine.vars[65] === 2, "cage covered");
  run.checkpoint("Cover cage", { room: 69, score: 79 });

  run.command("take cage");
  run.wait(() => carried(run, 70), "cage taken");
  run.checkpoint("Cage", { room: 69, score: 81 });

  // Leave cave back to Room 44 (cloth 73 is automatically retrieved on exit)
  walkSmart(run, { x0: 5, x1: 15, y0: 115, y1: 125 });
  run.exit("W", 44);

  // 11. Go east 4 times: 44 -> 45 -> 46 -> 47 -> 48
  for (const [, toR] of [
    [44, 45],
    [45, 46],
    [46, 47],
    [47, 48],
  ] as const) {
    walkSmart(run, { x0: 150, x1: 155, y0: 110, y1: 130 });
    run.exit("E", toR);
  }

  // 12. In 48: cross bridge East (crossing 3, +1) to 49
  walkBridge(run, [
    [5, 131],
    [40, 96],
    [41, 97],
    [55, 97],
    [62, 104],
    [69, 97],
    [73, 97],
    [74, 98],
    [92, 98],
    [93, 97],
    [98, 97],
    [99, 96],
    [104, 96],
    [105, 95],
    [108, 95],
    [109, 94],
    [110, 94],
    [111, 93],
    [112, 93],
    [113, 92],
    [114, 92],
    [115, 91],
    [116, 91],
    [117, 90],
    [118, 90],
    [119, 89],
    [120, 89],
    [121, 88],
    [123, 88],
    [124, 87],
    [133, 87],
    [135, 85],
    [136, 85],
    [138, 87],
  ]);
  run.checkpoint("Bridge crossed east 2", { room: 48, score: 82 });
  run.exit("E", 49);
  run.exit("N", 42);

  // 13. In 42: unlock door with gold key (+7, door 1 open, f85 set)
  walkSmart(run, { x0: 75, x1: 84, y0: 102, y1: 105 });
  run.command("unlock door");
  run.wait(() => run.engine.flags[85] !== 0, "first door unlocked");
  run.checkpoint("First door unlocked", { room: 42, score: 89 });

  // Read second inscription (sets f134)
  run.command("read inscription");
  run.wait(() => run.engine.flags[134] !== 0, "second inscription read");
  run.checkpoint("Second inscription", { room: 42, score: 89 });

  // 14. Return across bridge West (crossing 4, +1)
  run.exit("S", 49);
  run.exit("W", 48);
  walkBridge(run, [
    [154, 42],
    [154, 79],
    [146, 87],
    [122, 111],
    [121, 111],
    [120, 112],
    [119, 112],
    [118, 113],
    [117, 113],
    [116, 114],
    [114, 114],
    [113, 115],
    [112, 115],
    [111, 116],
    [105, 116],
    [104, 117],
    [86, 117],
    [85, 118],
    [84, 118],
    [83, 119],
    [79, 119],
    [72, 112],
  ]);
  run.checkpoint("Bridge crossed west 2", { room: 48, score: 90 });
}
