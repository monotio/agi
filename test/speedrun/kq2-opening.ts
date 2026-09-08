import assert from "node:assert/strict";
import type { Speedrun } from "./runner.ts";
import { directionForDelta } from "../../src/agent/gameTestSteps.ts";

function carried(run: Speedrun, num: number): boolean {
  const item = run.engine.readState().inventory.find((entry) => entry.num === num);
  return item?.room === 255;
}

function skipIntro(run: Speedrun): void {
  for (let i = 0; i < 6000 && !(run.state().control && run.state().room === 1); i++) {
    if (i % 30 === 0) run.key(13);
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
