import assert from "node:assert/strict";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { walkPlanned } from "../../scripts/walkthrough-navigation.ts";
import type { Speedrun } from "./runner.ts";

function takeCartridge(run: Speedrun): void {
  run.answer("ROGER"); // boot name prompt (get.string)
  for (let n = 0; n < 3000 && !(run.engine.inputEnabled && run.engine.modalKind === null); n++) {
    if (n % 120 === 0) run.key(AGI_KEY.ENTER);
    run.advance();
  }
  run.checkpoint("Hallway", { room: 2, score: 0 });
  run.walkTo(10, 66);
  run.exit("W", 1);
  run.checkpoint("Data archive", { room: 1, score: 0 });
  run.walkTo(81, 106);
  run.answer("astral body"); // The console accepts one title answer.
  run.command("look at screen");
  run.wait(() => run.engine.flags[35] !== 0, "retrieval unit delivers cartridge", 5000);
  run.command("take cartridge");
  run.checkpoint("Cartridge", { room: 1, score: 5 });
  assertCarried(run, 1, "Cartridge");
}

/** Arcada opening through the cartridge and keycard; ship escape is not covered. */
export function sq1Opening(run: Speedrun): void {
  takeCartridge(run);
  run.walkTo(81, 120);
  run.walkTo(25, 110);
  run.exit("W", 4);
  run.walkTo(140, 63); // straight west first: the door frame object at x=152 blocks diagonals
  run.walkTo(20, 70); // shallow diagonal: the y=80 divider spans the room; stay in the y64-79 band
  run.exit("W", 3);
  run.walkTo(140, 68);
  run.command("search body");
  run.command("take keycard");
  run.checkpoint("Keycard", { room: 3, score: 6 });
  assertCarried(run, 5, "Keycard");
}

/**
 * Arcada lower level: back to the hallway elevator and down to the Star
 * Generator lab. The shaft door opens for posn(29,57)-(39,65); stepping into
 * the shaft box (29,52)-(43,56) rides ego down into the lower corridor.
 */
export function sq1LowerLevel(run: Speedrun): void {
  sq1Opening(run);
  run.exit("E", 4);
  run.walkTo(34, 64);
  run.wait(() => run.engine.flags[30] !== 0, "elevator door opens", 3000);
  run.walkTo(36, 54);
  run.wait(() => run.state().y > 148, "elevator slide finishes", 5000); // y>100 alone fires mid-ride
  run.direction(0);
  // The ride leaves ego at (36,151). Walking north through the shaft base
  // re-triggers the elevator upward; the blasted-door alcove bottom is pri 1,
  // but the doorway strip grants ignore.blocks, so enter it from the south.
  run.walkTo(114, 155);
  run.walkTo(114, 137); // base x114-120 must fit the x113-122 opening; x123 is pri 0
  run.exit("N", 11);
  run.checkpoint("Star Generator lab", { room: 11, score: 6 });
}

/**
 * Arcada escape leg 1: lab -> lower corridor elevator -> central control
 * (open bay door, +2) -> keycard elevator (+2) -> Flight Prep (flight suit
 * +2, dialect translator +2).
 */
export function sq1FlightPrep(run: Speedrun): void {
  sq1LowerLevel(run);
  run.exit("S", 4); // lab bottom edge, x=115 in (110,130)
  run.checkpoint("Lower corridor", { room: 4, score: 6 });
  // Stay at y150 walking east: the shaft base box and its trigger strip at
  // y143-144 re-ride the elevator upward.
  run.walkTo(114, 150);
  run.walkTo(140, 150);
  run.exit("E", 2); // right edge y>135
  // Lower elevator: black diagonal walls flank the shaft mouth, so come up
  // from below (y150) between the x24-36 shaft walls, then step in.
  run.walkTo(28, 150);
  run.walkTo(28, 142);
  run.wait(() => run.engine.vars[30] === 1, "room 2 elevator door open", 3000);
  run.walkTo(28, 135);
  run.wait(() => run.state().room === 5, "elevator down to room 5", 3000);
  run.checkpoint("Bottom level", { room: 5, score: 6 });
  // Straight south out of the elevator shaft, then east at y150: the
  // shaft's right B wall (x37, y132-144) snags any NE diagonal (ego width
  // 7). North at x60 afterwards is clear.
  run.walkTo(27, 150);
  run.walkTo(60, 150);
  run.walkTo(60, 141);
  run.exit("E", 6);
  // Central control: open the vehicle bay door from the console.
  run.walkTo(110, 130);
  run.command("press open bay door button");
  run.wait(() => run.engine.vars[52] === 1, "bay doors open", 3000);
  run.checkpoint("Bay door open", { room: 6, score: 8 });
  run.exit("E", 7);
  // Mid-level deck: keycard unit then the elevator down to Flight Prep.
  run.walkTo(85, 128);
  run.command("use keycard");
  run.wait(() => run.engine.flags[35] !== 0, "keycard accepted", 3000);
  run.checkpoint("Keycard slot", { room: 7, score: 10 });
  run.walkTo(105, 133); // opener box (95,129)-(118,136); y132 is the B wall
  run.wait(() => run.engine.vars[30] === 1, "room 7 elevator door open", 3000);
  run.walkTo(106, 125); // shaft box (98,121)-(114,128); door closes -> room 9
  run.wait(() => run.state().room === 9, "elevator down to room 9", 3000);
  // Flight Prep: ego arrives inside the elevator shaft (x100-116, y92-101);
  // its B side walls force a south exit to y106 before going west.
  run.walkTo(106, 106);
  run.walkTo(70, 106); // west along y106: the shaft's B corner blocks diagonals
  run.walkTo(70, 100);
  run.command("press right button");
  run.wait(() => run.engine.vars[69] === 3, "right closet open", 3000);
  run.walkTo(85, 100);
  run.command("take flight suit");
  run.wait(() => run.engine.vars[81] === 1, "flight suit worn", 3000);
  run.checkpoint("Flight suit", { room: 9, score: 12 });
  run.walkTo(70, 100);
  run.command("press left button");
  run.wait(() => run.engine.vars[70] === 3, "left closet open", 3000);
  run.walkTo(55, 100);
  run.command("take gadget");
  run.checkpoint("Equipment", { room: 9, score: 14 });
  assertCarried(run, 3, "Dialect translator");
}

/**
 * Arcada escape leg 2: Flight Prep airlock -> vehicle bay -> escape pod
 * launch. The cargo shaft trigger (x56-79, y83-110) is fatal until the pod
 * platform is raised; the autonav sequence ends with the Arcada explosion
 * (+15) and the Kerona approach cutscene.
 */
export function sq1Escape(run: Speedrun): void {
  sq1FlightPrep(run);
  // The barrier walls force a long way around (east side, bottom edge);
  // the planner reads the live control surface for this leg.
  walkPlanned(run, { x0: 70, y0: 150, x1: 70, y1: 150 });
  run.command("press airlock button");
  run.wait(() => run.engine.vars[36] === 3, "airlock door opening", 3000);
  run.advance(40); // let the door loop settle before entering
  // The doorway strip grants ignore.blocks; walk in and west over the trigger.
  walkPlanned(run, { x0: 37, y0: 114, x1: 37, y1: 114 });
  run.exit("W", 8);
  run.checkpoint("Vehicle bay", { room: 8, score: 14 });
  // Platform console, staying south of the cargo shaft trigger.
  run.walkTo(115, 146);
  run.walkTo(115, 143);
  run.command("press platform button");
  run.wait(() => run.engine.flags[54] !== 0, "pod platform raised", 3000);
  run.checkpoint("Platform up", { room: 8, score: 15 });
  // West side, then north at x50 to the pod door.
  run.walkTo(50, 143);
  run.walkTo(52, 92);
  run.command("get in pod");
  run.wait(() => run.state().room === 10, "boarded escape pod", 3000);
  run.checkpoint("Escape pod", { room: 10, score: 15 });
  run.command("close door");
  run.command("buckle seat belt");
  run.command("press power button");
  run.wait(() => run.engine.inputEnabled, "pod power on", 3000);
  run.command("pull throttle");
  run.wait(() => run.engine.flags[79] !== 0, "pod launched", 3000);
  run.command("press autonav button");
  run.wait(() => run.engine.inputEnabled, "autonav engaged", 3000);
  run.checkpoint("Autonav", { room: 10, score: 17 });
  run.wait(() => run.state().room === 12, "pod clear of the Arcada", 30000);
  run.wait(() => run.engine.vars[3] === 32, "explosion points awarded", 30000);
  run.checkpoint("Arcada exploded", { room: 12, score: 32 });
  run.wait(() => run.state().room === 13, "Kerona approach", 30000);
  run.checkpoint("Kerona approach", { room: 13, score: 32 });
}

/**
 * Kerona landing: pod interior (survival kit +2, open kit, unbuckle, get
 * out), then the glass fragment (+3) beside the pod in room 30. The first
 * room-30 entry arms the spider droid timer, deterministic under seed 1.
 */
export function sq1Landing(run: Speedrun): void {
  sq1Escape(run);
  run.wait(() => run.state().room === 30, "pod descending", 30000);
  run.wait(() => run.state().room === 14, "pod landed", 30000);
  run.checkpoint("Pod interior", { room: 14, score: 32 });
  run.command("take survival kit");
  run.checkpoint("Survival kit", { room: 14, score: 34 });
  run.command("open kit");
  run.command("unbuckle seat belt");
  run.command("get out");
  run.wait(() => run.state().room === 30, "outside the pod", 30000);
  run.walkTo(35, 120); // clear of the pod's block(45,92,70,108)
  run.walkTo(55, 120);
  run.command("take glass");
  run.checkpoint("Glass", { room: 30, score: 37 });
  assertCarried(run, 6, "Glass");
}

/**
 * Kerona desert crossing to the boulder deck: east across rooms 21-23, up
 * the ramp (f92 ignores blocks and the horizon), over the plateau maze and
 * bridge to room 20, north through 17, west through the trigger fields of
 * 16 and 15, then the room 18 mesa to the only unsealed room 19 entry.
 * Behind the boulder, wait for the wandering spider droid to enter the drop
 * zone and push the boulder onto it (+5, f165/f161, v108=2).
 */
export function sq1Boulder(run: Speedrun): void {
  const eng = run.engine;
  sq1Landing(run);

  run.exit("E", 21);
  walkPlanned(run, { x0: 140, y0: 140, x1: 153, y1: 160 });
  run.exit("E", 22);
  walkPlanned(run, { x0: 140, y0: 140, x1: 153, y1: 160 });
  run.exit("E", 23);
  run.checkpoint("Desert crossing done", { room: 23, score: 37 });

  // Ramp up: the box (23,130)-(49,132) sets f92.
  walkPlanned(run, { x0: 26, y0: 133, x1: 30, y1: 134 });
  run.walkTo(30, 131);
  assert.ok(eng.flags[92] !== 0, `f92 not set on ramp: ${JSON.stringify(run.state())}`);
  run.checkpoint("Plateau trail (f92)", { room: 23, score: 37 });

  // Room 23 upper maze to the bridge approach; f92 ignores blocks here.
  for (const [x, y] of [
    [30, 115],
    [31, 114],
    [32, 111],
    [33, 110],
    [33, 95],
    [34, 93],
    [35, 91],
    [36, 89],
    [37, 87],
    [38, 86],
    [38, 76],
    [44, 70],
  ] as const)
    run.walkTo(x, y);
  run.exit("N", 20); // bridge box (33,66)-(70,66)

  // Room 20: corridor north, then NW around the fatal trigger diagonal.
  run.walkTo(27, 72);
  run.walkTo(26, 63);
  run.walkTo(1, 38);
  run.exit("N", 17);

  // Room 17: west along the bottom.
  run.exit("W", 16);

  // Room 16: snake between the fatal-fall trigger clusters to the west edge.
  for (const [x, y] of [
    [142, 66],
    [140, 66],
    [137, 63],
    [136, 63],
    [135, 62],
    [133, 62],
    [132, 61],
    [125, 61],
    [122, 64],
    [114, 64],
    [104, 74],
    [93, 74],
    [89, 70],
    [81, 70],
    [77, 74],
    [74, 74],
    [73, 73],
    [67, 73],
    [64, 70],
    [53, 70],
    [44, 79],
    [22, 79],
    [17, 79],
    [16, 80],
    [15, 80],
    [13, 82],
    [12, 82],
  ] as const)
    run.walkTo(x, y);
  run.exit("W", 15);

  // Room 15: east channel south past the antenna guy-wire triggers.
  for (const [x, y] of [
    [153, 87],
    [153, 100],
    [142, 111],
    [142, 113],
    [141, 114],
    [141, 119],
    [140, 120],
    [140, 125],
    [139, 126],
    [139, 128],
    [151, 140],
    [151, 147],
    [153, 149],
    [153, 160],
  ] as const)
    run.walkTo(x, y);
  run.exit("S", 18);

  // Room 18: mesa top east; stay above y36 or the horizon bounces back to 15.
  run.walkTo(127, 41);
  run.walkTo(142, 56);
  run.walkTo(146, 58);
  run.walkTo(153, 59);
  run.exit("E", 19);

  // Room 19: across the bridge deck to behind the boulder.
  for (const [x, y] of [
    [15, 59],
    [16, 59],
    [17, 58],
    [19, 58],
    [20, 57],
    [21, 57],
    [32, 46],
    [38, 46],
    [50, 58],
  ] as const)
    run.walkTo(x, y);
  run.checkpoint("Behind the boulder", { room: 19, score: 37 });

  // Wait for the spider droid to activate and wander into the drop zone.
  run.wait(() => eng.flags[97] !== 0, "spider droid active (f97)", 40000);
  run.wait(
    () => {
      const o = eng.screenObjects[16]!;
      return eng.flags[110] === 0 && o.x >= 36 && o.x <= 58 && o.y >= 137 && o.y <= 151;
    },
    "spider droid under the boulder",
    120000,
  );
  run.command("push boulder");
  run.wait(() => eng.vars[3] === 42 && eng.flags[110] === 0, "droid crushed", 30000);
  run.checkpoint("Spider droid crushed", { room: 19, score: 42 });
  assert.ok(eng.flags[165] !== 0 && eng.flags[161] !== 0, "crush flags f165/f161 set");
  assert.equal(eng.vars[108], 2, "boulder resting on the droid");
}

function assertCarried(run: Speedrun, num: number, name: string): void {
  assert.ok(
    run.engine.readState().inventory.some((item) => item.num === num && item.room === 255),
    `${name} is carried`,
  );
}
