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

function hasCarried(run: Speedrun, num: number): boolean {
  return run.engine.readState().inventory.some((item) => item.num === num && item.room === 255);
}

/**
 * SQ1 Kerona underground through arrival at Ulence Flats:
 * - Return across mesa and plateau to Room 17 arch columns, ride elevator to underground (+2, f177).
 * - Room 25: take rock.
 * - Room 26: avoid grate monster, put rock in geyser (+4, f84) to open cave door.
 * - Room 28: reflect laser beams with glass (+5, f121).
 * - Room 27 upper ledge: navigate 3 acid drop cycles (+3, f178).
 * - Room 26: turn on translator (f154), enter alien chamber (Room 29).
 * - Room 29: hologram assigns Orat quest (v82=1), teleports ego to mesa (Room 15).
 * - Mesa descent: Rooms 15 -> 18 -> 19 -> 20 ledge -> 23 ramp (reset f92) -> Room 20 ground.
 * - Orat cave (Room 24): throw water at Orat (+5, v82=2), take orat part (+2, item 4).
 * - Return to Room 29: exit cave to Room 20 ground -> Room 23 ramp (set f92) -> 20 ledge -> 19 mesa -> 18 -> 15 -> 16 -> 17 arch elevator -> 32 -> 25 -> 26 -> 27 -> 28 -> 27 -> 26 -> 29.
 * - Room 29: drop orat part (+10, v82=3), enter secret doorway to Room 31.
 * - Room 31: insert cartridge into console (+5, f179), read 4 pages, take cartridge (+5, f180), board skimmer and start engine.
 * - Room 78 -> 33: navigate skimmer across desert boulder field with 0 damage.
 * - Room 35: arrival at Ulence Flats (+25, score 108).
 */
export function sq1UlenceFlats(run: Speedrun): void {
  const eng = run.engine;
  sq1Boulder(run);

  // Return west across mesa to Room 18
  for (const [x, y] of [
    [38, 46],
    [32, 46],
    [21, 57],
    [20, 57],
    [19, 58],
    [17, 58],
    [16, 59],
    [15, 59],
    [1, 73],
  ] as const) {
    run.walkTo(x, y);
  }
  run.exit("W", 18);

  walkPlanned(run, { x0: 127, y0: 41, x1: 127, y1: 41 });
  run.exit("N", 15);

  for (const [x, y] of [
    [153, 160],
    [153, 149],
    [151, 147],
    [151, 140],
    [139, 128],
    [139, 126],
    [140, 125],
    [140, 120],
    [141, 119],
    [141, 114],
    [142, 113],
    [142, 111],
    [153, 100],
    [153, 85],
  ] as const) {
    run.walkTo(x, y);
  }
  run.exit("E", 16);

  for (const [x, y] of [
    [12, 82],
    [13, 82],
    [15, 80],
    [16, 80],
    [17, 79],
    [22, 79],
    [44, 79],
    [53, 70],
    [64, 70],
    [67, 73],
    [73, 73],
    [74, 74],
    [77, 74],
    [81, 70],
    [89, 70],
    [93, 74],
    [104, 74],
    [114, 64],
    [122, 64],
    [125, 61],
    [132, 61],
    [133, 62],
    [135, 62],
    [136, 63],
    [137, 63],
    [140, 66],
    [142, 66],
    [142, 58],
    [153, 58],
  ] as const) {
    run.walkTo(x, y);
  }
  run.exit("E", 17);

  // Room 17: step through arch columns to activate tube elevator (+2, f177)
  for (let x = eng.screenObjects[0]!.x; x <= 98; x += 2) {
    run.walkTo(x, 58);
    if (eng.flags[177] !== 0) break;
  }
  run.wait(
    () => eng.vars[0] === 25 && eng.screenObjects[0]!.y >= 160 && run.state().control,
    "land in room 25",
    15000,
  );
  run.checkpoint("Kerona underground", { room: 25, score: 44 });

  // Room 25: take rock
  walkPlanned(run, { x0: 65, y0: 148, x1: 75, y1: 152 });
  run.command("take rock");
  run.wait(() => hasCarried(run, 2), "rock taken", 2000);
  walkPlanned(run, { x0: 1, y0: 145, x1: 5, y1: 150 });
  run.exit("W", 26);

  // Room 26: walk past grate along y=129, put rock in geyser (+4, f84)
  run.walkTo(75, 138);
  run.walkTo(75, 129);
  run.walkTo(45, 129);
  run.walkTo(30, 144);
  run.command("put rock in geyser");
  run.wait(() => eng.flags[84] !== 0, "geyser plugged (f84)", 3000);
  run.checkpoint("Geyser plugged", { room: 26, score: 48 });

  // Walk to open cave door at x=14
  run.walkTo(17, 130);
  run.walkTo(14, 122);
  run.exit("N", 27);

  // Room 27 lower level: walk West to Room 28
  walkPlanned(run, { x0: 1, y0: 105, x1: 5, y1: 107 });
  run.exit("W", 28);

  // Room 28: reflect laser beams with glass (+5, f121)
  walkPlanned(run, { x0: 65, y0: 126, x1: 68, y1: 130 });
  run.command("use glass");
  run.wait(() => eng.flags[121] !== 0 && run.state().control, "beams destroyed (f121)", 5000);
  run.checkpoint("Laser beams destroyed", { room: 28, score: 53 });

  // Walk up ramp to upper ledge
  walkPlanned(run, { x0: 145, y0: 40, x1: 155, y1: 45 });
  run.exit("E", 27);

  // Room 27 upper ledge: navigate 3 acid drops (+3, f178)
  run.walkTo(82, 42);
  run.wait(() => (eng.vars[31] ?? 0) >= 20, "drop 1 fell", 5000);
  run.walkTo(92, 42);
  run.wait(() => (eng.vars[32] ?? 0) >= 20, "drop 2 fell", 5000);
  run.walkTo(106, 42);
  run.wait(() => (eng.vars[33] ?? 0) >= 20, "drop 3 fell", 5000);
  run.walkTo(130, 42);
  run.exit("E", 26);
  run.checkpoint("Acid drops navigated", { room: 26, score: 56 });

  // Room 26 upper ledge: turn on translator and enter alien chamber
  run.command("turn on translator");
  run.wait(() => eng.flags[154] !== 0, "translator turned on (f154)", 2000);
  walkPlanned(run, { x0: 145, y0: 55, x1: 155, y1: 65 });
  run.exit("E", 29);

  // Room 29: hologram assigns quest and teleports ego to Room 15 on mesa top
  run.wait(() => eng.vars[0] === 15 && run.state().control, "teleported to room 15", 30000);

  // Room 15: walk south path to exit South into Room 18
  for (const [x, y] of [
    [140, 120],
    [140, 125],
    [139, 126],
    [139, 128],
    [151, 140],
    [151, 147],
    [153, 149],
    [153, 160],
  ] as const) {
    run.walkTo(x, y);
  }
  run.exit("S", 18);

  // Room 18: mesa top east to Room 19
  run.walkTo(127, 41);
  run.walkTo(142, 56);
  run.walkTo(146, 58);
  run.walkTo(153, 59);
  run.exit("E", 19);

  // Room 19: cross bridge deck east into Room 20
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
    [70, 58],
    [85, 58],
    [110, 58],
    [145, 61],
  ] as const) {
    run.walkTo(x, y);
  }
  run.exit("E", 20);

  // Room 20 ledge: walk along x=27 to exit South
  run.walkTo(26, 63);
  run.walkTo(27, 72);
  run.walkTo(27, 100);
  run.walkTo(27, 130);
  run.walkTo(27, 160);
  run.exit("S", 23);

  // Room 23: walk down the ramp to step on (28, 133) to reset f92
  for (const [x, y] of [
    [38, 76],
    [38, 86],
    [37, 87],
    [37, 89],
    [36, 89],
    [36, 91],
    [35, 91],
    [35, 93],
    [34, 93],
    [34, 95],
    [33, 95],
    [39, 101],
    [38, 102],
    [38, 103],
    [37, 104],
    [37, 108],
    [41, 112],
    [41, 113],
    [42, 114],
    [42, 115],
    [41, 116],
    [41, 119],
    [28, 132],
    [28, 133],
  ] as const) {
    run.walkTo(x, y);
  }
  assert.equal(eng.flags[92], 0, "f92 reset at base of ramp");

  // Walk into Room 20 ground level
  walkPlanned(run, { x0: 63, y0: 80, x1: 95, y1: 95 });
  run.exit("N", 20);

  // Room 20 ground level: walk to cave entrance
  for (const [x, y] of [
    [110, 119],
    [111, 119],
    [113, 121],
    [129, 121],
    [132, 118],
    [146, 118],
    [148, 120],
  ] as const) {
    run.walkTo(x, y);
  }
  run.wait(() => eng.vars[0] === 24, "entered Orat cave (room 24)", 5000);

  // Room 24: throw water at Orat (+5, v82=2)
  run.command("throw water");
  run.wait(() => eng.vars[82] === 2 && run.state().control, "Orat exploded (v82=2)", 10000);
  run.checkpoint("Orat defeated", { room: 24, score: 61 });

  // Take Orat part (+2, item 4)
  walkPlanned(run, { x0: 120, y0: 125, x1: 135, y1: 135 });
  run.command("take orat part");
  run.wait(() => hasCarried(run, 4), "took orat part (item 4)", 3000);
  run.checkpoint("Orat part taken", { room: 24, score: 63 });
  assertCarried(run, 4, "Orat part");

  // Exit Orat cave back to Room 20 ground level
  walkPlanned(run, { x0: 16, y0: 134, x1: 18, y1: 136 });
  run.walkTo(19, 132);
  run.walkTo(19, 128);
  run.wait(() => eng.vars[0] === 20, "exited cave to Room 20", 5000);

  // Room 20 ground level: walk South to Room 23
  walkPlanned(run, { x0: 63, y0: 160, x1: 95, y1: 167 });
  run.exit("S", 23);

  // Room 23 ground level: walk to ramp to set f92
  walkPlanned(run, { x0: 26, y0: 133, x1: 30, y1: 134 });
  run.walkTo(28, 133);
  run.walkTo(28, 132);
  assert.ok(eng.flags[92] !== 0, "f92 set on ramp");

  // Walk up the ramp
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
  ] as const) {
    run.walkTo(x, y);
  }
  run.exit("N", 20);

  // Room 20 ledge: walk to exit West into Room 19
  run.walkTo(27, 130);
  run.walkTo(27, 100);
  run.walkTo(27, 72);
  run.walkTo(26, 63);
  run.exit("W", 19);

  // Walk West across Room 19 mesa to Room 18
  for (const [x, y] of [
    [110, 58],
    [85, 58],
    [70, 58],
    [50, 58],
    [38, 46],
    [32, 46],
    [21, 57],
    [20, 57],
    [19, 58],
    [17, 58],
    [16, 59],
    [15, 59],
    [1, 73],
  ] as const) {
    run.walkTo(x, y);
  }
  run.exit("W", 18);

  walkPlanned(run, { x0: 127, y0: 41, x1: 127, y1: 41 });
  run.exit("N", 15);

  for (const [x, y] of [
    [153, 160],
    [153, 149],
    [151, 147],
    [151, 140],
    [139, 128],
    [139, 126],
    [140, 125],
    [140, 120],
    [141, 119],
    [141, 114],
    [142, 113],
    [142, 111],
    [153, 100],
    [153, 85],
  ] as const) {
    run.walkTo(x, y);
  }
  run.exit("E", 16);

  for (const [x, y] of [
    [12, 82],
    [13, 82],
    [15, 80],
    [16, 80],
    [17, 79],
    [22, 79],
    [44, 79],
    [53, 70],
    [64, 70],
    [67, 73],
    [73, 73],
    [74, 74],
    [77, 74],
    [81, 70],
    [89, 70],
    [93, 74],
    [104, 74],
    [114, 64],
    [122, 64],
    [125, 61],
    [132, 61],
    [133, 62],
    [135, 62],
    [136, 63],
    [137, 63],
    [140, 66],
    [142, 66],
    [142, 58],
    [153, 58],
  ] as const) {
    run.walkTo(x, y);
  }
  run.exit("E", 17);

  // Step into arch to activate tube elevator
  for (let x = eng.screenObjects[0]!.x; x <= 98; x += 2) {
    run.walkTo(x, 58);
    if (eng.flags[92] === 0) break;
  }
  run.wait(
    () => eng.vars[0] === 25 && eng.screenObjects[0]!.y >= 160 && run.state().control,
    "land in room 25",
    15000,
  );

  // Room 25 -> 26
  walkPlanned(run, { x0: 1, y0: 145, x1: 5, y1: 150 });
  run.exit("W", 26);

  // Room 26: walk past grate and through already open door
  run.walkTo(75, 138);
  run.walkTo(75, 129);
  run.walkTo(45, 129);
  walkPlanned(run, { x0: 12, y0: 121, x1: 16, y1: 123 });
  run.walkTo(14, 122);
  run.exit("N", 27);

  // Room 27: lower level walk West to Room 28
  walkPlanned(run, { x0: 1, y0: 105, x1: 5, y1: 107 });
  run.exit("W", 28);

  // Room 28: lasers dead, walk up ramp to upper ledge
  walkPlanned(run, { x0: 145, y0: 40, x1: 155, y1: 45 });
  run.exit("E", 27);

  // Room 27 upper ledge: navigate 3 acid drops
  run.walkTo(82, 42);
  run.wait(() => (eng.vars[31] ?? 0) >= 20, "drop 1 fell", 5000);
  run.walkTo(92, 42);
  run.wait(() => (eng.vars[32] ?? 0) >= 20, "drop 2 fell", 5000);
  run.walkTo(106, 42);
  run.wait(() => (eng.vars[33] ?? 0) >= 20, "drop 3 fell", 5000);
  run.walkTo(130, 42);
  run.exit("E", 26);

  // Room 26 upper ledge: translator already on, walk East to Room 29
  walkPlanned(run, { x0: 145, y0: 55, x1: 155, y1: 65 });
  run.exit("E", 29);

  // Room 29: alien chamber
  run.wait(() => eng.flags[39] !== 0 && run.state().control, "alien asks for proof (f39)", 15000);
  run.command("drop orat part");
  run.wait(() => eng.vars[82] === 3, "doorway opened (v82=3)", 10000);
  run.dismiss();
  run.advance(60);
  run.dismiss();
  run.checkpoint("Alien chamber opened", { room: 29, score: 73 });

  // Walk into doorway to enter Room 31
  run.walkTo(78, 114);
  run.wait(() => eng.vars[0] === 31, "entered Keronian base (room 31)", 5000);

  // Room 31: cartridge reader (+5, f179)
  walkPlanned(run, { x0: 78, y0: 118, x1: 85, y1: 124 });
  run.command("insert cartridge");
  run.wait(() => eng.flags[179] !== 0, "inserted cartridge (f179)", 5000);

  // Read cartridge pages
  for (let page = 1; page <= 4; page++) {
    run.key(AGI_KEY.ENTER);
    run.advance(10);
  }
  run.wait(() => run.state().control, "text screen dismissed", 5000);

  // Retrieve cartridge (+5, f180)
  run.command("take cartridge");
  run.wait(() => eng.flags[180] !== 0, "took cartridge (f180)", 5000);
  run.checkpoint("Cartridge data read", { room: 31, score: 83 });

  // Board skimmer and start engine
  walkPlanned(run, { x0: 115, y0: 125, x1: 125, y1: 135 });
  run.command("board skimmer");
  run.wait(() => eng.vars[41] === 2, "boarded skimmer", 5000);
  run.command("turn key");
  run.wait(() => eng.vars[0] === 78, "entered cutscene (room 78)", 10000);

  // Cutscene Room 78 -> Room 33
  run.dismiss();
  run.wait(() => eng.vars[0] === 33, "entered skimmer minigame (room 33)", 15000);

  // Room 33: navigate boulder field
  run.walkTo(10, 146);
  let targetX = 10;
  while (eng.vars[0] === 33 && (eng.vars[42] ?? 0) < 5) {
    const o3 = eng.screenObjects[3]!;
    if (o3.active && o3.x < 32 && o3.y >= 65 && o3.y <= 135) {
      if (targetX !== 40) {
        targetX = 40;
        run.walkTo(40, 146);
      }
    } else {
      if (targetX !== 10) {
        targetX = 10;
        run.walkTo(10, 146);
      }
    }
    if (eng.modalKind !== null) {
      run.dismiss();
    } else {
      run.advance(1);
    }
  }
  if (eng.modalKind !== null) run.dismiss();

  // Arrival at Ulence Flats (+25, score 108)
  run.checkpoint("Arrival at Ulence Flats", { room: 35, score: 108 });
  assert.equal(eng.vars[0], 35, "in Ulence Flats (room 35)");
  assert.equal(eng.vars[3], 108, "final score 108");
  assertCarried(run, 1, "Cartridge");
  assertCarried(run, 3, "Gadget");
  assertCarried(run, 5, "Keycard");
  assertCarried(run, 6, "Glass");
  assertCarried(run, 19, "Xenon Army Knife");
  assertCarried(run, 22, "Survival Kit");
}

function assertCarried(run: Speedrun, num: number, name: string): void {
  assert.ok(
    run.engine.readState().inventory.some((item) => item.num === num && item.room === 255),
    `${name} is carried`,
  );
}
