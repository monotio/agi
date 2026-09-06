import assert from "node:assert/strict";
import type { Speedrun } from "./runner.ts";

/** The lake, witch and woodcutter circuit, using ordinary walking and parser input. */
export function middle(run: Speedrun): void {
  run.walkTo(80, 135);
  run.exit("N", 25);
  run.walkTo(80, 140);
  run.exit("W", 32);
  run.exit("W", 31);
  run.walkTo(120, 140);
  run.command("get bowl");
  run.command("look at bowl");
  run.checkpoint("Bowl", { room: 31, score: 26 });
  run.walkTo(35, 140);
  run.exit("S", 18);
  for (let encounter = 0; !run.engine.flags[82]; encounter++) {
    assert.ok(encounter < 20, "Elf encounter did not appear");
    if (run.engine.flags[22] || run.engine.flags[20]) {
      run.wait(() => run.engine.flags[20] !== 0, "Elf appears");
      for (let approach = 0; !run.engine.flags[82]; approach++) {
        assert.ok(approach < 20, "Could not approach elf");
        run.command("talk to elf");
        if (!run.engine.flags[82]) run.advance(60);
      }
    } else {
      run.exit("N", 31);
      run.exit("S", 18);
    }
  }
  run.checkpoint("Elf ring", { score: 29 });
  run.walkTo(35, 70);
  run.exit("N", 31);
  run.walkTo(4, 150);
  run.exit("N", 34);
  run.walkTo(90, 105);
  run.command("get pebbles");
  run.checkpoint("Pebbles", { score: 30 });
  run.walkTo(90, 145);
  run.exit("S", 31);
  run.walkTo(90, 80);
  run.exit("W", 30);
  run.walkTo(90, 80);
  run.walkTo(75, 140);
  run.command("get walnut");
  run.command("open walnut");
  run.checkpoint("Golden walnut", { score: 36 });
  run.walkTo(75, 80);
  run.walkTo(90, 80);
  run.exit("N", 35);
  run.walkTo(100, 140);
  run.exit("W", 36);
  run.exit("W", 37);
  run.exit("S", 28);
  run.walkTo(150, 102);
  for (const [x, y] of [
    [126, 102],
    [125, 103],
    [124, 103],
    [122, 105],
    [121, 105],
    [120, 106],
    [119, 106],
    [117, 108],
    [117, 112],
    [125, 120],
    [125, 121],
    [126, 122],
    [126, 132],
    [92, 166],
    [89, 166],
    [55, 132],
  ] as const)
    run.walkTo(x, y);
  for (let encounter = 0; ; encounter++) {
    assert.ok(encounter < 20, "Witch never left her house");
    run.walkTo(55, 132);
    run.command("eat house");
    if (run.engine.vars[81] === 2) break;
    run.walkTo(55, 160);
    run.walkTo(10, 160);
    run.exit("W", 27);
    run.exit("E", 28);
    run.walkTo(55, 160);
  }
  run.checkpoint("Gingerbread", { score: 38 });
  run.command("open door");
  run.wait(() => run.state().room === 65, "Witch door opens");
  run.walkTo(95, 150);
  run.walkTo(95, 100);
  run.walkTo(145, 100);
  run.walkTo(145, 150);
  run.walkTo(135, 150);
  run.command("get note");
  run.command("read note");
  run.checkpoint("Witch note", { score: 41 });
  run.wait(() => run.engine.flags[21] !== 0, "Witch faces oven", 10000);
  run.walkTo(145, 150);
  run.walkTo(145, 100);
  run.walkTo(95, 100);
  run.walkTo(35, 100);
  run.walkTo(40, 120);
  run.command("push witch");
  run.checkpoint("Witch defeated", { score: 48 });
  run.walkTo(40, 98);
  run.command("open cupboard");
  run.command("get cheese");
  run.checkpoint("Cheese", { score: 52 });
  run.walkTo(40, 150);
  run.walkTo(49, 150);
  run.direction(5);
  run.wait(() => run.state().room === 28, "Exit witch house");
  run.direction(0);
  run.walkTo(55, 132);
  for (const [x, y] of [
    [89, 166],
    [92, 166],
    [126, 132],
    [126, 122],
    [125, 121],
    [125, 120],
    [117, 112],
    [117, 108],
    [119, 106],
    [120, 106],
    [121, 105],
    [122, 105],
    [124, 103],
    [125, 103],
    [126, 102],
    [150, 102],
  ] as const)
    run.walkTo(x, y);
  run.walkTo(153, 60);
  run.exit("N", 37);
  run.walkTo(153, 164);
  run.exit("N", 44);
  run.walkTo(115, 140);
  run.walkTo(115, 124);
  run.direction(3);
  run.wait(() => run.state().room === 79, "Enter woodcutter house");
  run.direction(0);
  run.command("give bowl");
  run.command("fill bowl");
  run.walkTo(120, 150);
  run.command("get fiddle");
  run.checkpoint("Woodcutter fiddle", { score: 60 });
  run.walkTo(45, 150);
  run.walkTo(45, 130);
  run.walkTo(35, 130);
  run.walkTo(35, 113);
  run.exit("W", 44);
  run.walkTo(56, 140);
  run.exit("N", 5);
  run.walkTo(80, 140);
  run.exit("W", 6);
  run.walkTo(130, 160);
  run.walkTo(26, 160);
  run.walkTo(26, 140);
  run.walkTo(30, 125);
  run.command("look in stump");
  run.command("get pouch");
  run.command("look in pouch");
  run.checkpoint("Diamond pouch", { room: 6, score: 67 });
}
