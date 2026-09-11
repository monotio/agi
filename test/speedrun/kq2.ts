import assert from "node:assert/strict";
import type { Speedrun } from "./runner.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { planWalk, type Target } from "../../src/agent/navigation.ts";

function skipIntro(run: Speedrun): void {
  run.repeatUntil(
    () => {
      run.key(AGI_KEY.ENTER);
      run.advance(30);
    },
    () => run.state().control && run.state().room === 1,
    "intro yielded control",
    200,
  );
  assert.ok(run.state().control, "intro never yielded control");
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
  run.assertCarried(63, "basket");
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
  run.waitForRoom(72, "tree door opens", 1200);
  run.checkpoint("Tree house", { room: 72, score: 3 });
  // Ladder: walk onto the hole; f31 marks the climbing view. Then descend.
  run.walkToUntil(90, 115, () => run.engine.flags[31] !== 0, "climb onto ladder");
  run.exit("S", 73);
  // Arrive on the ladder (f31); climb down until the logic dismounts ego.
  run.walkDirection("S", () => run.engine.flags[31] === 0, "dismount at ladder foot");
  assert.equal(run.engine.flags[31], 0, "dismounted at ladder foot");
  run.exit("E", 74);
  // Dwarf: f33 means he is home; leave west and re-enter until he is gone.
  run.repeatUntil(
    () => {
      run.exit("W", 73);
      run.exit("E", 74);
    },
    () => run.engine.flags[33] === 0,
    "dwarf never left",
    12,
  );
  run.walkTo(50, 120);
  run.command("get soup");
  run.assertCarried(67, "soup");
  run.checkpoint("Soup", { room: 74, score: 5 });
  // Rock barriers force an east-then-south approach to the trunk.
  run.walkTo(100, 122);
  run.walkTo(98, 140);
  run.command("open chest");
  run.command("get earrings");
  run.assertCarried(58, "earrings");
  run.checkpoint("Earrings", { room: 74, score: 12 });
  // Leave the tree house: back north through the rock corridor, then west.
  run.walkTo(100, 122);
  run.walkTo(20, 121);
  run.exit("W", 73);
  // Climb up: stand in the trigger strip (y120-121) facing north to re-mount;
  // the row above is a conditional wall.
  run.walkTo(105, 121);
  run.walkDirection("N", () => run.engine.flags[31] !== 0, "climbing the ladder");
  assert.equal(run.engine.flags[31], 1, "climbing the ladder");
  run.exit("N", 72);
  // Arrive climbing (f31); walk onto the hole trigger to regain normal view.
  run.walkToUntil(90, 112, () => run.engine.flags[31] === 0, "step off ladder hole");
  // Leave west along y110: clears the ladder triggers (y112+) and the walls
  // at y104 and y116; the x=30 column is the door back outside.
  run.walkTo(90, 110);
  run.walkTo(33, 110);
  run.walkDirection("W", () => run.state().room !== 72, "exit tree house");
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
  run.repeatUntil(
    () => {
      run.command("open door");
      run.waitForRoom(70, "cottage door opens", 1200);
      if (run.engine.flags[31] !== 0) {
        run.walkDirection("S", () => run.state().room !== 70, "flee the wolf");
        assert.equal(run.state().room, 3, "fled the wolf");
        run.walkTo(73, 112);
      }
    },
    () => run.state().room === 70 && run.engine.flags[31] === 0,
    "wolf never left",
    12,
  );
  run.walkTo(40, 110);
  run.command("give soup grandma");
  run.wait(() => run.engine.flags[98] !== 0, "grandma fed", 600);
  run.command("look under bed");
  run.assertCarried(55, "ruby ring");
  run.assertCarried(68, "cloak");
  run.checkpoint("Cloak and ring", { room: 70, score: 18 });
  run.walkTo(14, 157);
  run.walkDirection("S", () => run.state().room !== 70, "leave cottage");
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
  // said("give", "basket", "bitch") in logic 153 accepts "give basket girl";
  // the give lands only when distance(ego, girl) <= 25 (Manhattan, v94).
  const girlGap = () => {
    const ego = run.engine.screenObjects[0]!;
    const girl = run.engine.screenObjects[2]!;
    return (
      Math.abs(girl.x + Math.floor(girl.width / 2) - (ego.x + Math.floor(ego.width / 2))) +
      Math.abs(girl.y - ego.y)
    );
  };
  // Buffer the give while chasing her; press Enter only once she is in
  // reach. A failed give consumes the line, so retype before re-approaching.
  run.repeatUntil(
    () => {
      if (run.engine.inputEdit === "") run.type("give basket girl");
      const girl = run.engine.screenObjects[2]!;
      try {
        run.walkTo(
          Math.max(2, Math.min(157, girl.x - 6)),
          Math.max(40, Math.min(165, girl.y)),
          300,
        );
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Walk blocked")) throw error;
        run.advance(60);
      }
      if (girlGap() <= 20) run.submit("give basket girl");
    },
    () => run.engine.flags[59] !== 0,
    "basket given to LRRH",
    60,
  );
  run.assertCarried(52, "bouquet");
  run.checkpoint("Bouquet", { room: 4, score: 22 });
  run.command("wear cloak");
  run.command("wear ring");
  assert.equal(run.engine.flags[70], 1, "cloak worn");
  assert.equal(run.engine.flags[68], 1, "ring worn");
  run.checkpoint("Cloak and ring worn", { room: 4, score: 25 });
  run.exit("E", 5);
  run.exit("E", 6);
}

export function exitNorthSafe(
  run: Speedrun,
  toRoom: number,
  target: Target = { x0: 60, x1: 90, y0: 42, y1: 45 },
): void {
  const fromRoom = run.state().room;
  for (let n = 0; n < 10; n++) {
    run.walkPath(target);
    run.exit("N", toRoom);
    if (run.engine.flags[40] === 0 && run.engine.flags[234] === 0) return;
    run.exit("S", fromRoom);
  }
}

export function exitSouthSafe(
  run: Speedrun,
  toRoom: number,
  target: Target = { x0: 60, x1: 90, y0: 165, y1: 167 },
): void {
  const fromRoom = run.state().room;
  for (let n = 0; n < 10; n++) {
    run.walkPath(target);
    run.exit("S", toRoom);
    if (run.engine.flags[40] === 0 && run.engine.flags[234] === 0) return;
    run.exit("N", fromRoom);
  }
}

function monasteryCross(run: Speedrun): void {
  monasteryApproach(run);
  run.checkpoint("Monastery approach", { room: 6, score: 25 });
  run.walkPath({ x0: 70, x1: 70, y0: 150, y1: 150 });
  run.command("open door");
  run.waitForRoom(71, "monastery door opens", 1200);
  run.checkpoint("Chapel", { room: 71, score: 25 });
  run.walkPath({ x0: 80, x1: 90, y0: 82, y1: 83 });
  run.command("pray");
  run.waitForFlag(154, "prayer counted", 600);
  run.checkpoint("Prayed", { room: 71, score: 27 });
  run.wait(() => run.engine.flags[32] === 0, "monk stands and asks name");
  run.command("graham");
  run.assertCarried(69, "cross");
  run.checkpoint("Cross", { room: 71, score: 29 });
  run.command("wear cross");
  assert.equal(run.engine.flags[69], 1, "cross worn");
  run.checkpoint("Cross worn", { room: 71, score: 31 });
  run.walkPath({ x0: 60, x1: 80, y0: 165, y1: 167 });
  run.exit("S", 6);
  run.checkpoint("Left monastery", { room: 6, score: 31 });
}

/** Follow a fixed bridge path one cell at a time, preserving its input timing.
 * The deck and approaches avoid lethal trigger rims and the bridge object's baseline.
 * A changed collision or puzzle outcome must fail instead of being routed around.
 */
export function walkBridge(run: Speedrun, waypoints: readonly (readonly number[])[]): void {
  for (const point of waypoints) {
    const targetX = point[0]!,
      targetY = point[1]!;
    run.walkTo(targetX, targetY);
    assert.equal(run.engine.flags[119], 0, "no chasm fall");
  }
}

/** Cold boot through the cross, brooch, first inscription and bridge round trip (41 points). */
export function kq2Bridge(run: Speedrun): void {
  monasteryCross(run);
  run.exit("S", 13);
  run.walkPath({ x0: 42, x1: 46, y0: 60, y1: 62 });
  run.command("look in hole");
  run.command("get brooch");
  run.assertCarried(59, "brooch");
  run.checkpoint("Brooch", { room: 13, score: 39 });
  run.exit("N", 6);
  run.walkPath({ x0: 140, x1: 145, y0: 150, y1: 152 });
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
    [72, 112],
    [79, 119],
    [83, 119],
    [84, 118],
    [85, 118],
    [86, 117],
    [104, 117],
    [105, 116],
    [111, 116],
    [112, 115],
    [113, 115],
    [114, 114],
    [116, 114],
    [117, 113],
    [118, 113],
    [119, 112],
    [120, 112],
    [121, 111],
    [122, 111],
  ]);
  walkBridge(run, [
    [146, 87],
    [154, 79],
    [154, 42],
  ]);
  walkBridge(run, [
    [146, 87],
    [138, 87],
  ]);
  run.checkpoint("Bridge crossed east", { room: 48, score: 40 });
  run.exit("E", 49);
  run.exit("N", 42);
  run.checkpoint("Door room", { room: 42, score: 40 });
  run.walkPath({ x0: 75, x1: 84, y0: 102, y1: 105 });
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
  run.walkPath({ x0: 60, x1: 90, y0: 42, y1: 45 });
  run.exit("N", 40);

  // In Room 40: get mallet from tree hole (+2, item 60)
  run.walkPath({ x0: 72, x1: 96, y0: 80, y1: 95 });
  run.command("take mallet");
  run.waitForItem(60, "mallet taken");
  run.checkpoint("Mallet", { room: 40, score: 43 });

  // 3. Room 40 -> 39 -> 38
  run.walkPath({ x0: 1, x1: 5, y0: 110, y1: 130 });
  run.exit("W", 39);

  run.walkPath({ x0: 1, x1: 5, y0: 110, y1: 130 });
  run.exit("W", 38);

  // In Room 38: get necklace from hollow log (+7, item 57)
  run.walkPath({ x0: 95, x1: 110, y0: 125, y1: 135 });
  run.command("take necklace");
  run.waitForItem(57, "necklace taken");
  run.checkpoint("Necklace", { room: 38, score: 50 });

  // 4. Room 38 -> 31 -> 30 -> 23
  run.walkPath({ x0: 60, x1: 80, y0: 42, y1: 45 });
  run.exit("N", 31);

  // In 31: walk along bottom west to 30
  run.walkPath({ x0: 1, x1: 5, y0: 155, y1: 165 });
  run.exit("W", 30);

  // In 30: walk north to 23
  run.walkPath({ x0: 70, x1: 85, y0: 42, y1: 45 });
  run.exit("N", 23);

  // In 23: get stake from tree at (73, 111) (+2, item 54)
  run.walkPath({ x0: 70, x1: 76, y0: 115, y1: 120 });
  run.command("take stake");
  run.waitForItem(54, "stake taken");
  run.checkpoint("Stake", { room: 23, score: 52 });

  // 5. Room 23 -> 22
  run.walkPath({ x0: 1, x1: 5, y0: 110, y1: 130 });
  run.exit("W", 22);

  // In 22: clam at (100, 100) -> take clam (+0, item 82), take bracelet (+7, item 53)
  run.walkPath({ x0: 95, x1: 105, y0: 104, y1: 108 });
  run.command("take clam");
  run.wait(() => run.engine.flags[72] !== 0, "clam taken");
  run.command("take bracelet");
  run.waitForItem(53, "bracelet taken");
  run.checkpoint("Bracelet", { room: 22, score: 59 });

  // 6. Room 22 -> 29 -> 36
  run.walkPath({ x0: 60, x1: 80, y0: 160, y1: 167 });
  run.exit("S", 29);

  // In Room 29: stay in safe corridor x in [100..110] away from water
  run.walkPath({ x0: 100, x1: 110, y0: 100, y1: 120 });
  run.walkPath({ x0: 100, x1: 110, y0: 160, y1: 166 });
  run.exit("S", 36);

  // In 36: navigate east around central tree to reach trident at (130, 140) (+3, item 51)
  run.walkTo(145, 50);
  run.walkTo(145, 100);
  run.walkTo(125, 140);
  run.command("take trident");
  run.waitForItem(51, "trident taken");
  run.checkpoint("Trident", { room: 36, score: 62 });

  // 7. Step into water in Room 36 and swim
  run.walkDirection("W", () => run.engine.flags[0] !== 0, "stepping into water in room 36");
  run.wait(() => run.engine.vars[95] === 1, "treading water");
  run.command("swim");
  run.wait(() => run.engine.vars[95] === 2, "swimming");

  // Exit west into ocean (Room 50)
  run.exit("W", 50);

  // Swim North 3 times in Room 50 (v73: 36 -> 29 -> 22 -> 15)
  for (let i = 0; i < 3; i++) {
    const prev = run.engine.vars[73];
    run.walkDirection("N", () => run.engine.vars[73] !== prev, "swimming north in room 50");
  }

  // Exit East onto beach in Room 15
  run.exit("E", 15);

  // 8. In Room 15: swim north along shore to (12, 80) near mermaid rock
  run.walkTo(12, 80);
  run.command("give flowers mermaid");
  run.wait(() => run.engine.flags[33] !== 0, "seahorse summoned");
  run.checkpoint("Mermaid", { room: 15, score: 64 });

  // Ride seahorse
  run.command("ride seahorse");
  run.wait(() => run.engine.vars[0] === 54, "entered underwater 54", 10000);
  run.checkpoint("Seahorse", { room: 54, score: 66 });

  // Transit 54 -> 53 -> 52 -> 51
  run.wait(() => run.engine.vars[0] === 51, "arrived at King Neptune", 30000);

  // 9. In Room 51: King Neptune at (25, 101)
  run.walkPath({ x0: 55, x1: 65, y0: 100, y1: 105 });
  run.command("give trident neptune");
  run.wait(() => run.engine.flags[95] !== 0, "clam opened");
  run.checkpoint("Neptune", { room: 51, score: 70 });

  // Take gold key from open clam (+5, item 61)
  run.walkPath({ x0: 10, x1: 22, y0: 120, y1: 130 });
  run.command("take key");
  run.wait(() => run.engine.flags[96] !== 0, "key taken");
  run.checkpoint("Gold key", { room: 51, score: 75 });

  // Take cloth from bottle (+2, item 73)
  run.command("take cloth");
  run.waitForItem(73, "cloth taken");
  run.checkpoint("Cloth", { room: 51, score: 77 });

  // Exit East from 51 -> transit 52 -> 53 -> 54 -> Room 15
  run.exit("E", 52);
  run.wait(() => run.engine.vars[0] === 15 && run.state().control, "returned to Room 15", 30000);

  // Walk east out of water onto land in Room 15
  run.walkDirection("E", () => run.engine.vars[95] === 0, "walking out of water in room 15");

  // 10. Room 15 -> North 3 times: 15 -> 8 -> 1 -> 43
  run.walkPath({ x0: 70, x1: 90, y0: 42, y1: 45 });
  run.exit("N", 8);

  run.walkPath({ x0: 70, x1: 90, y0: 42, y1: 45 });
  run.exit("N", 1);

  run.walkPath({ x0: 85, x1: 95, y0: 42, y1: 45 });
  run.exit("N", 43);

  // Exit East into Room 44 (Hagatha cave exterior)
  run.walkPath({ x0: 150, x1: 155, y0: 110, y1: 130 });
  run.exit("E", 44);

  // Enter cave at right into Room 69
  run.walkTo(125, 95);
  run.wait(() => run.engine.vars[0] === 69, "entered Hagatha cave", 5000);

  // In 69: walk near cage at (100, 100) (distance <= 20)
  run.walkPath({ x0: 84, x1: 90, y0: 100, y1: 102 });
  run.command("cover cage");
  run.wait(() => run.engine.vars[65] === 2, "cage covered");
  run.checkpoint("Cover cage", { room: 69, score: 79 });

  run.command("take cage");
  run.waitForItem(70, "cage taken");
  run.checkpoint("Cage", { room: 69, score: 81 });

  // Leave cave back to Room 44 (cloth 73 is automatically retrieved on exit)
  run.walkPath({ x0: 5, x1: 15, y0: 115, y1: 125 });
  run.exit("W", 44);

  // 11. Go east 4 times: 44 -> 45 -> 46 -> 47 -> 48
  for (const [, toR] of [
    [44, 45],
    [45, 46],
    [46, 47],
    [47, 48],
  ] as const) {
    run.walkPath({ x0: 150, x1: 155, y0: 110, y1: 130 });
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
  run.walkPath({ x0: 75, x1: 84, y0: 102, y1: 105 });
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

/** Chapter: antique shop trade, mountaintop carpet flight, second key, second door unlocked (127 points). */
export function kq2Door2(run: Speedrun): void {
  kq2Door1(run);

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

  // 2. North through 47 -> 40 -> 33 -> 26 -> 19 -> 20 (antique shop)
  exitNorthSafe(run, 40);
  exitNorthSafe(run, 33);
  exitNorthSafe(run, 26);
  exitNorthSafe(run, 19);

  run.walkPath({ x0: 150, x1: 155, y0: 110, y1: 130 });
  run.exit("E", 20);

  // 3. Antique shop: open door, trade caged nightingale for oil lamp
  run.walkPath({ x0: 87, x1: 95, y0: 112, y1: 116 });
  run.command("open door");
  run.wait(() => run.state().room === 68, "entered antique shop", 3000);

  run.command("give bird lady");
  run.wait(() => run.engine.vars[3] === 96, "got lamp, score 96", 3000);
  run.checkpoint("Oil lamp", { room: 68, score: 96 });

  run.wait(() => run.state().room === 20, "exited antique shop back to 20", 5000);
  run.checkpoint("Outside shop", { room: 20, score: 96 });

  // 4. Rub lamp for magic carpet (+2, score 98, item 76)
  run.command("rub lamp");
  run.wait(() => (run.engine.vars[88] ?? 0) > 0, "genie animation started", 3000);
  run.wait(() => run.engine.vars[88] === 0 && run.state().control, "rub lamp 1 finished", 5000);
  run.checkpoint("Magic carpet", { room: 20, score: 98 });

  // 5. Ride carpet to mountaintop Room 55 (+4, score 102)
  run.command("ride carpet");
  run.wait(() => run.state().room === 55, "entered room 55", 15000);
  run.wait(() => run.engine.flags[107] === 0 && run.state().control, "landed on mountaintop", 5000);
  run.checkpoint("Mountaintop", { room: 55, score: 102 });

  // 6. Rub lamp for sword (+2, score 104, item 50) and bridle (+2, score 106, item 77)
  run.command("rub lamp");
  run.wait(() => (run.engine.vars[88] ?? 0) > 0, "genie animation 2 started", 3000);
  run.wait(() => run.engine.vars[88] === 0 && run.state().control, "rub lamp 2 finished", 5000);
  run.checkpoint("Sword", { room: 55, score: 104 });

  run.command("rub lamp");
  run.wait(() => (run.engine.vars[88] ?? 0) > 0, "genie animation 3 started", 3000);
  run.wait(() => run.engine.vars[88] === 0 && run.state().control, "rub lamp 3 finished", 5000);
  run.checkpoint("Bridle", { room: 55, score: 106 });

  // 7. Room 55 -> East -> 56: bridle snake into Pegasus (+5, score 111, f109) and talk to horse (+2, score 113, sugar cube 79)
  run.exit("E", 56);
  run.walkTo(80, 80);
  run.command("put bridle snake");
  run.wait(() => run.engine.flags[109] !== 0, "bridled winged horse", 3000);
  run.checkpoint("Bridled Pegasus", { room: 56, score: 111 });

  run.command("talk horse");
  run.wait(() => run.engine.flags[110] !== 0, "talked to horse", 3000);
  run.checkpoint("Sugar cube", { room: 56, score: 113 });

  // 8. 56 -> East -> 57 -> East -> 58 (cave): take second gold key (+5, score 118, item 61, f111)
  run.walkTo(80, 90);
  run.walkTo(140, 90);
  run.walkTo(140, 89);
  run.exit("E", 57);

  run.walkTo(140, 89);
  run.exit("E", 58);

  run.walkTo(25, 88);
  run.walkTo(25, 112);
  run.walkTo(108, 112);
  run.walkTo(108, 128);
  run.command("take key");
  run.wait(() => run.engine.flags[111] !== 0, "took gold key 2", 3000);
  run.checkpoint("Second gold key", { room: 58, score: 118 });

  // 9. Leave cave: 58 -> West -> 57 -> West -> 56 -> West -> 55
  run.walkTo(108, 112);
  run.walkTo(25, 112);
  run.walkTo(25, 88);
  run.walkTo(0, 88);
  run.exit("W", 57);

  run.walkTo(129, 89);
  run.walkTo(0, 89);
  run.exit("W", 56);

  run.walkTo(140, 90);
  run.walkTo(0, 90);
  run.exit("W", 55);
  run.checkpoint("Mountaintop return", { room: 55, score: 118 });

  // 10. Ride carpet back to antique shop exterior Room 20
  run.command("ride carpet");
  run.wait(
    () => run.state().room === 20 && run.engine.flags[148] === 0 && run.state().control,
    "returned to room 20",
    30000,
  );
  run.checkpoint("Returned to room 20", { room: 20, score: 118 });

  // 11. Return south: 20 -> West -> 19 -> South -> 26 -> South -> 33 -> South -> 40 -> South -> 47 -> East -> 48
  run.walkTo(45, 85);
  run.walkTo(0, 85);
  run.exit("W", 19);

  exitSouthSafe(run, 26);
  exitSouthSafe(run, 33);
  exitSouthSafe(run, 40);
  exitSouthSafe(run, 47, { x0: 78, x1: 82, y0: 165, y1: 167 });

  run.walkTo(80, 131);
  run.walkTo(140, 131);
  run.exit("E", 48);
  run.checkpoint("Returned to bridge room", { room: 48, score: 118 });

  // 12. In 48: cross bridge East (crossing 5, +1, score 119) to 49
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
  run.checkpoint("Bridge crossed east 3", { room: 48, score: 119 });
  run.exit("E", 49);
  run.exit("N", 42);

  // 13. In 42: unlock door with second gold key (+7, score 126, f86 set)
  run.walkPath({ x0: 75, x1: 84, y0: 102, y1: 105 });
  run.command("unlock door");
  run.wait(() => run.engine.flags[86] !== 0, "second door unlocked");
  run.checkpoint("Second door unlocked", { room: 42, score: 126 });

  // Read third inscription (sets f75)
  run.command("read inscription");
  run.wait(() => run.engine.flags[75] !== 0, "third inscription read");
  run.checkpoint("Third inscription", { room: 42, score: 126 });

  // 14. Return across bridge West (crossing 6, +1, score 127)
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
  run.checkpoint("Bridge crossed west 3", { room: 48, score: 127 });
}

/** Infiltrate Dracula's castle, retrieve keys and tiara, cross bridge 4 and unlock third door into Cloudland. */
export function kq2Castle(run: Speedrun): void {
  kq2Door2(run);

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

  // 2. North through 47 -> 40 -> 33
  exitNorthSafe(run, 40);
  exitNorthSafe(run, 33);

  // 3. West into 32
  run.walkPath({ x0: 1, x1: 5, y0: 110, y1: 130 });
  run.exit("W", 32);

  // 4. In 32: enter boat
  run.walkPath({ x0: 95, x1: 105, y0: 125, y1: 130 });
  run.command("enter boat");
  run.wait(() => run.state().room === 25, "arrived in room 25", 20000);
  run.wait(() => run.engine.flags[31] !== 0, "boat reached shore in 25", 5000);

  // 5. Exit boat in 25
  run.command("exit boat");
  run.wait(() => run.engine.flags[32] !== 0, "exited boat", 5000);

  // 6. Eat sugar cube (+1, score 128, f157)
  run.command("eat sugar");
  run.wait(() => run.engine.flags[157] !== 0, "ate sugar cube", 3000);

  // 7. North into 18 (castle exterior)
  run.walkPath({ x0: 65, x1: 75, y0: 51, y1: 53 });
  run.exit("N", 18);

  // 8. Castle door in 18
  run.walkTo(70, 146);
  run.command("open door");
  run.wait(() => run.state().room === 61, "entered castle", 15000);

  // 9. West into 60 (ramp tower)
  run.walkPath({ x0: 20, x1: 25, y0: 120, y1: 125 });
  run.exit("W", 60);

  // 10. Ascend spiral staircase in 60 to 59
  const ascentWaypoints: [number, number][] = [
    [120, 154],
    [120, 131],
    [85, 93],
    [40, 70],
    [25, 75],
    [22, 85],
    [35, 100],
    [60, 90],
    [65, 88],
    [85, 83],
    [88, 76],
    [95, 70],
    [105, 55],
    [115, 45],
    [118, 32],
  ];
  run.walkWaypoints(ascentWaypoints);
  run.exit("N", 59);

  // 11. Room 59 Dresser & Candle Retrieval
  run.walkWaypoints([
    [121, 128],
    [91, 98],
    [71, 98],
    [44, 116],
  ]);
  run.command("open drawer");
  run.wait(() => run.engine.vars[98] === 1, "drawer opened", 5000);
  run.command("take candle");
  run.wait(() => run.engine.flags[141] !== 0, "took candle", 5000);

  // 12. Room 59 Exit back to Room 60
  run.walkWaypoints([
    [71, 98],
    [91, 98],
    [121, 128],
    [121, 160],
  ]);
  run.exit("S", 60);

  // 13. Room 60 Descent to Torch & Lighting Candle
  const descentWaypoints: [number, number][] = [
    [115, 45],
    [105, 55],
    [95, 70],
    [88, 76],
    [85, 83],
    [65, 88],
    [60, 90],
    [35, 100],
    [22, 85],
    [25, 75],
    [40, 70],
  ];
  run.walkWaypoints(descentWaypoints);
  run.command("light candle");
  run.wait(() => run.engine.flags[106] !== 0, "candle lit", 5000);

  // 14. Room 60 Exit down to 61
  const exit60Waypoints: [number, number][] = [
    [62, 70],
    [85, 93],
    [120, 131],
    [120, 154],
    [140, 163],
  ];
  run.walkWaypoints(exit60Waypoints);
  run.exit("E", 61);

  // 15. 61 -> 64 (dining room)
  run.walkTo(130, 123);
  run.exit("E", 64);

  // 16. In 64: take ham (+2, score 133)
  run.walkTo(25, 132);
  run.walkTo(75, 132);
  run.command("take ham");
  run.wait(() => run.engine.flags[140] !== 0, "took ham", 5000);

  // 17. 64 -> 65
  run.walkTo(135, 132);
  run.exit("E", 65);

  // 18. 65 -> 66
  run.walkTo(131, 166);
  run.exit("S", 66);

  // 19. 66 -> 67 (Dracula's tomb)
  run.walkPath(14, 150);
  run.exit("W", 67);

  // 20. In 67: Dracula check & defeat
  run.repeatUntil(
    () => {
      run.exit("E", 66);
      run.exit("W", 67);
    },
    () => run.engine.vars[92] === 1,
    "waiting for Dracula in coffin in room 67",
    50,
  );
  run.walkTo(75, 110);
  run.command("open coffin");
  run.wait(() => run.engine.vars[91] === 1, "coffin opened", 5000);
  run.command("kill dracula");
  run.wait(() => run.engine.vars[92] === 2 && run.engine.flags[92] === 0, "dracula killed", 10000);
  run.command("take pillow");
  run.wait(() => run.engine.flags[137] !== 0, "took pillow", 5000);
  run.command("take keys");
  run.wait(() => run.engine.flags[138] !== 0 && run.engine.flags[139] !== 0, "took keys", 5000);

  // 21. Return from 67: 67 -> 66 -> 65 -> 64 -> 63 -> 62
  run.walkTo(132, 130);
  run.exit("E", 66);

  run.walkPath(73, 37);
  run.exit("N", 65);

  run.walkTo(26, 61);
  run.walkTo(20, 55);
  run.exit("W", 64);

  run.walkTo(128, 129);
  run.walkTo(85, 86);
  run.exit("N", 63);

  run.walkTo(75, 155);
  const ascend63Waypoints: [number, number][] = [
    [90, 145],
    [105, 130],
    [115, 115],
    [120, 95],
    [122, 80],
    [122, 70],
    [116, 60],
    [106, 50],
    [96, 40],
    [90, 34],
  ];
  run.walkWaypoints(ascend63Waypoints);
  run.exit("N", 62);

  // In 62: chest & tiara
  run.walkTo(120, 126);
  run.command("unlock chest");
  run.wait(() => run.engine.vars[93] === 1, "unlocked chest", 5000);

  run.command("open chest");
  run.wait(() => run.engine.vars[93] === 2, "opened chest", 5000);

  run.command("take tiara");
  run.wait(() => run.engine.flags[143] !== 0, "took tiara", 5000);

  // 62 -> 63
  run.walkWaypoints([
    [86, 126],
    [62, 150],
    [46, 163],
  ]);
  run.exit("S", 63);

  const descend63Waypoints: [number, number][] = [
    [95, 40],
    [105, 50],
    [115, 60],
    [120, 70],
    [120, 80],
    [118, 95],
    [115, 115],
    [105, 130],
    [90, 145],
    [75, 155],
    [50, 165],
  ];
  run.walkWaypoints(descend63Waypoints);
  run.exit("S", 64);

  // 64 -> 61
  run.walkWaypoints([
    [85, 85],
    [128, 128],
    [128, 132],
    [25, 132],
    [25, 120],
  ]);
  run.exit("W", 61);

  // 61 -> 18
  run.walkTo(70, 150);
  run.exit("S", 18);

  // 18 -> 25
  run.walkTo(71, 160);
  run.exit("S", 25);

  // In 25: enter boat
  run.walkTo(45, 73);
  run.walkTo(45, 80);
  run.walkTo(73, 108);
  run.walkTo(74, 108);
  run.walkTo(76, 110);
  run.walkTo(76, 118);
  run.walkTo(70, 124);
  run.walkTo(70, 155);
  run.command("enter boat");
  run.wait(() => run.state().room === 32, "arrived in 32", 20000);
  run.wait(() => run.engine.flags[35] !== 0, "boat reached shore in 32", 10000);

  // Return to bridge in 48
  run.walkTo(140, 140);
  run.walkTo(154, 140);
  run.exit("E", 33);

  exitSouthSafe(run, 40);
  exitSouthSafe(run, 47, { x0: 78, x1: 82, y0: 165, y1: 167 });

  run.walkTo(80, 131);
  run.walkTo(140, 131);
  run.exit("E", 48);

  // Cross bridge East #4 into 49
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
  run.checkpoint("Bridge crossed east 4", { room: 48, score: 156 });
  run.exit("E", 49);
  run.exit("N", 42);

  // Unlock third door in 42
  run.walkPath({ x0: 75, x1: 84, y0: 102, y1: 105 });
  run.command("unlock door");
  run.wait(() => run.engine.flags[87] !== 0, "third door unlocked");
  run.wait(() => run.state().room === 80, "teleported to cloudland", 15000);
  run.checkpoint("Third door unlocked", { room: 80, score: 163 });
}

/** Full KQ2 walkthrough to maximum score 185 and ending credits in Room 106. */
export function kq2Complete(run: Speedrun): void {
  kq2Castle(run);

  // Cloudland: 80 -> 75
  run.exit("N", 75);
  run.checkpoint("Cloudland shore", { room: 75, score: 163 });

  // Take net and fish
  run.walkPath({ x0: 55, x1: 65, y0: 100, y1: 105 });
  run.command("take net");
  run.wait(() => run.engine.flags[113] !== 0, "took net");
  run.checkpoint("Net taken", { room: 75, score: 164 });

  run.walkTo(95, 105);
  run.command("cast net");
  run.dismiss();
  run.wait(() => run.engine.flags[231] !== 0, "net cast, fish caught");
  run.dismiss();
  run.checkpoint("Fish caught", { room: 75, score: 166 });

  run.walkTo(88, 108);
  run.command("take fish");
  run.waitForItem(80, "took fish");
  run.dismiss();

  run.command("throw fish");
  run.wait(() => run.engine.flags[232] !== 0, "threw fish back");
  run.dismiss();
  run.checkpoint("Fish released", { room: 75, score: 169 });

  run.command("ride fish");
  run.checkpoint("Fish ridden", { room: 75, score: 170 });
  run.wait(() => run.state().room === 77 && run.state().control, "arrived on island", 30000);
  run.checkpoint("Island arrived", { room: 77, score: 170 });

  // Island: 77 -> 78
  run.exit("E", 78);
  run.checkpoint("Amulet room", { room: 78, score: 170 });

  run.walkPath(16, 88);
  run.command("take amulet");
  run.wait(() => run.engine.flags[122] !== 0, "took amulet");
  run.checkpoint("Amulet taken", { room: 78, score: 173 });
  run.walkPath({ x0: 50, x1: 70, y0: 165, y1: 167 });
  run.exit("S", 83);
  run.checkpoint("Tower exterior", { room: 83, score: 173 });

  // Quartz tower exterior & entrance
  run.walkPath({ x0: 45, x1: 55, y0: 155, y1: 165 });
  run.command("open door");
  run.wait(() => run.state().room === 93, "entered tower", 10000);
  run.checkpoint("Tower entrance", { room: 93, score: 173 });

  // Tower stairs 93
  run.direction(7);
  run.wait(() => run.engine.flags[32] !== 0, "stairs mounted", 5000);
  const p93 = planWalk(run, { x0: 50, x1: 100, y0: 50, y1: 59 }, { avoidTriggers: true });
  for (const wp of p93.waypoints) run.walkTo(wp.x, wp.y);
  run.wait(() => run.state().room === 92, "entered mid tower", 5000);
  run.checkpoint("Tower middle", { room: 92, score: 173 });

  // Tower stairs 92
  run.walkWaypoints([
    [75, 137],
    [61, 57],
    [69, 49],
  ]);
  run.wait(() => run.state().room === 91, "entered tower top", 5000);
  run.checkpoint("Tower top", { room: 91, score: 173 });

  // Lion room 91
  run.walkTo(64, 155);
  run.command("feed ham");
  run.wait(() => run.engine.vars[75] === 2, "lion asleep", 10000);
  run.checkpoint("Lion fed", { room: 91, score: 177 });

  const p91 = planWalk(run, { x0: 80, x1: 95, y0: 120, y1: 128 }, { avoidTriggers: true });
  for (const wp of p91.waypoints) run.walkTo(wp.x, wp.y);
  run.command("open door");
  run.wait(() => run.state().room === 90, "entered princess room", 10000);
  run.checkpoint("Princess room", { room: 90, score: 182 });

  // Princess room 90 -> Finale
  run.command("home");
  run.wait(() => run.state().room === 107, "wedding cutscene", 10000);
  run.checkpoint("Wedding", { room: 107, score: 185 });

  run.wait(() => run.state().room === 106, "ending credits", 30000);
  run.checkpoint("KQ2 completed with maximum score", { room: 106, score: 185 });
}
