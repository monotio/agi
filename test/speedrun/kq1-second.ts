import assert from "node:assert/strict";
import type { Speedrun } from "./runner.ts";

/** Player inputs from the planted beans through the return to King Edward. */
export function secondHalf(run: Speedrun): void {
  const engine = run.engine;
  run.walkTo(60, 90);
  run.command("climb beanstalk");
  run.wait(() => engine.screenObjects[0]!.moveTarget === null, "mount beanstalk");
  run.exit("N", 70);
  // The stalk is flanked by trigger lines (control 2) and touching either one
  // with any baseline cell drops Graham. Its safe corridor for the 8-wide
  // climbing cel is x 67..76 below row 104 and x 72..74 around rows 94..96 and
  // 9..11, so climb at x 69 to row 110, then at x 73 to the top.
  run.walkTo(69, 110);
  run.walkTo(73, 106);
  run.exit("N", 71);
  // Room 71's stalk leans right, then back left: its corridor for the 8-wide
  // cel is x 67..73 below row 100, x 74..80 for rows 86..95, x 68..74 for
  // rows 66..69, x 65..71 for rows 57..59 and x 61..67 above row 43.
  run.walkTo(70, 100);
  run.walkTo(75, 95);
  run.walkTo(75, 72);
  run.walkTo(72, 69);
  run.walkTo(72, 62);
  run.walkTo(68, 58);
  run.walkTo(68, 45);
  run.walkTo(65, 42);
  run.exit("N", 72);
  run.walkTo(66, 125);
  run.direction(1);
  run.wait(() => !engine.flags[157], "step off beanstalk");
  run.direction(0);
  run.exit("E", 56);
  run.exit("E", 57);
  run.exit("E", 58);
  // The upper bank keeps Graham beyond the giant's walking horizon. Its edge
  // is a trigger line (control 2, x 7..17 on row 40) and any baseline cell on
  // it drops Graham off the cloud, so stop one row below it.
  run.walkTo(15, 41);
  run.wait(() => engine.vars[86] === 1, "giant falls asleep");
  const giant = engine.screenObjects[1]!;
  run.walkTo(giant.x, giant.y - 15);
  run.command("get chest");
  assert.equal(engine.flags[104], 1, "Take the sleeping giant's chest");
  run.checkpoint("Sleeping giant's chest", { room: 58, score: 102 });
  run.walkTo(50, 44);
  run.walkTo(90, 44);
  run.walkTo(90, 120);
  run.exit("S", 61);
  run.walkTo(140, 125);
  run.exit("E", 62);
  run.walkTo(125, 110);
  run.command("get sling");
  run.checkpoint("Sling", { room: 62, score: 104 });
  run.walkTo(20, 125);
  run.exit("W", 61);
  run.exit("W", 60);
  run.walkTo(20, 125);
  run.exit("N", 57);
  run.walkTo(20, 112);
  run.exit("W", 56);
  run.exit("W", 72);
  run.walkTo(85, 112);
  run.direction(7);
  run.wait(() => !!engine.flags[157], "mount beanstalk to descend");
  run.direction(0);
  run.exit("S", 71);
  // Descend inside the trigger corridors mapped for the climb (room 71 enters
  // at x 66, room 70 at x 69), shifting where the stalk leans.
  run.walkTo(66, 60);
  run.walkTo(70, 64);
  run.walkTo(70, 72);
  run.walkTo(75, 77);
  run.walkTo(75, 99);
  run.walkTo(70, 104);
  run.exit("S", 70);
  run.walkTo(69, 60);
  run.walkTo(73, 64);
  run.walkTo(73, 114);
  run.walkTo(68, 119);
  run.exit("S", 38);
  run.direction(5);
  run.wait(() => !engine.flags[157], "step off beanstalk at ground");
  run.direction(0);
  run.exit("S", 27);
  run.walkTo(90, 60);
  run.walkTo(90, 64);
  run.walkTo(100, 64);
  run.exit("S", 22);
  run.walkTo(96, run.state().y);
  run.walkTo(96, 81);
  run.walkTo(94, 83);
  run.walkTo(94, 125);
  run.exit("S", 11);
  run.walkTo(94, 80);
  run.walkTo(105, 80);
  run.walkTo(105, 125);
  run.walkTo(140, 125);
  run.exit("E", 12);
  run.walkTo(10, 150);
  run.walkTo(77, 150);
  run.walkTo(77, 125);
  run.walkTo(70, 125);
  run.command("cut rope");
  run.command("lower rope");
  run.wait(() => !!engine.flags[179], "lower well rope");
  run.command("climb rope");
  run.wait(() => engine.screenObjects[0]!.moveTarget === null, "mount well rope");
  run.direction(5);
  run.wait(() => run.state().room === 49, "descend well shaft");
  run.direction(0);
  run.direction(5);
  run.wait(() => engine.vars[94]! > 0, "reach well water");
  run.direction(0);
  run.command("dive");
  run.walkTo(75, 125);
  run.walkTo(32, 125);
  run.direction(7);
  run.wait(() => run.state().room === 51, "enter dragon cave");
  run.direction(0);
  run.walkTo(100, 140);
  run.command("throw water at dragon");
  run.wait(() => engine.vars[75] === 2, "extinguish dragon");
  run.walkTo(40, 120);
  run.command("get mirror");
  run.checkpoint("Magic mirror", { room: 51, score: 125 });
  run.walkTo(120, 127);
  run.exit("E", 52);
  run.walkTo(75, 116);
  run.exit("N", 49);
  run.command("climb rope");
  // Resume motion after the well logic enters its swimming state on mounting.
  run.command("swim");
  run.wait(() => engine.screenObjects[0]!.moveTarget === null, "mount return rope");
  run.exit("N", 12);
  run.direction(1);
  run.wait(() => !engine.flags[180], "leave well");
  run.direction(0);
  run.checkpoint("Return from the well", { room: 12, score: 129 });
  run.walkTo(70, 110);
  run.walkTo(70, 125);
  run.walkTo(77, 125);
  run.walkTo(77, 150);
  // A dry room that runs the game's swimming logic clears that state before jumping.
  run.exit("S", 5);
  run.exit("N", 12);
  run.walkTo(10, 150);
  run.exit("W", 11);
  run.walkTo(103, 150);
  run.walkTo(103, 80);
  run.walkTo(94, 80);
  run.exit("N", 22);
  run.walkTo(80, 125);
  // Catch high enough that the flight finishes before the jump animation callback.
  run.walkTo(80, 95);
  run.walkTo(100, 75);
  for (let attempt = 0; attempt < 20 && !engine.flags[209]; attempt++) {
    for (let tick = 0; tick < 8000 && !engine.flags[209]; tick++) {
      run.dismiss();
      if (!engine.flags[143] && engine.flags[21] && !engine.flags[22]) {
        const bird = engine.screenObjects[1]!;
        const ego = engine.screenObjects[0]!;
        const distance =
          Math.abs(ego.x + Math.floor(ego.width / 2) - bird.x - Math.floor(bird.width / 2)) +
          Math.abs(ego.y - bird.y);
        if (distance > 20 && distance < 45 && ego.y > bird.y + 15) run.command("jump");
      }
      run.advance();
    }
    if (!engine.flags[209]) {
      run.walkTo(80, 95);
      run.walkTo(80, 125);
      run.exit("S", 11);
      run.exit("N", 22);
      run.walkTo(80, 125);
      run.walkTo(80, 95);
      run.walkTo(100, 75);
    }
  }
  assert.equal(engine.flags[209], 1, "Catch the condor with a jump");
  run.wait(() => run.state().room === 48, "condor landing");
  finishFromCondor(run);
}

/** The island, dwarf kingdom, and final audience, driven entirely through input. */
export function finishFromCondor(run: Speedrun): void {
  const engine = run.engine;
  run.wait(() => engine.screenObjects[0]!.view === 0 && !engine.flags[209], "recover landing");
  run.checkpoint("Condor landing", { room: 48, score: 132 });
  run.walkTo(110, 100);
  run.exit("W", 47);
  run.walkTo(90, 85);
  run.command("get mushroom");
  run.checkpoint("Mushroom", { room: 47, score: 133 });
  run.walkTo(145, 100);
  run.exit("E", 48);
  run.walkTo(55, 120);
  run.direction(3);
  run.wait(() => run.state().room === 73, "fall into hole");
  run.wait(() => engine.screenObjects[0]!.view === 0, "recover underground");
  run.exit("S", 74);
  run.walkTo(80, 125);
  run.exit("W", 75);
  run.walkTo(80, 125);
  run.direction(0);
  run.wait(() => engine.vars[70]! > 20 && engine.vars[70]! < 30, "rat within cheese reach");
  run.command("give cheese to rat");
  run.wait(() => !!engine.flags[138], "rat leaves");
  run.walkTo(40, 125);
  run.command("open door");
  run.wait(() => run.state().room === 76, "enter dwarf hall");
  run.command("play fiddle");
  run.wait(() => engine.vars[30] === 0, "finish fiddle");
  run.walkTo(73, 146);
  run.exit("S", 77);
  run.wait(() => !!engine.flags[187], "dwarf king leaves");
  run.walkTo(85, 135);
  run.walkTo(130, 135);
  run.command("get shield");
  run.command("get sceptre");
  run.checkpoint("Dwarf treasures", { room: 77, score: 152 });
  run.walkTo(10, 95);
  run.exit("W", 78);
  run.walkTo(30, 81);
  run.command("eat mushroom");
  run.exit("W", 36);
  run.wait(() => !engine.flags[120], "grow to normal size");
  run.checkpoint("Escape dwarf kingdom", { room: 36, score: 155 });
  run.walkTo(88, 140);
  run.walkTo(45, 140);
  run.walkTo(45, 112);
  run.walkTo(60, 112);
  run.walkTo(60, 65);
  run.walkTo(55, 65);
  run.exit("N", 45);
  run.walkTo(140, 150);
  run.exit("E", 46);
  run.walkTo(75, 100);
  run.exit("N", 3);
  run.walkTo(145, 137);
  run.exit("E", 2);
  run.walkTo(45, 137);
  run.walkTo(58, 150);
  run.walkTo(110, 150);
  run.walkTo(110, 124);
  run.command("open door");
  run.wait(() => run.state().room === 55, "castle doors");
  run.exit("N", 54);
  run.walkTo(run.state().x, 120);
  run.exit("W", 53);
  run.walkTo(75, 110);
  run.command("bow");
  run.wait(() => !!engine.flags[195], "King Graham ending");
  assert.equal(engine.screenObjects[0]!.view, 142, "Graham sits on the throne");
  assert.equal(engine.inputEnabled, false, "The ending disables the command prompt");
  run.checkpoint("King Graham", { room: 53, score: 159 });
}
