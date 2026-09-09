import assert from "node:assert/strict";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import type { Speedrun } from "./runner.ts";

/** Player inputs for the opening Daventry circuit; no game-state writes. */
export function firstHalf(run: Speedrun): void {
  run.checkpoint("Daventry", { room: 1, score: 0 });
  run.walkTo(110, 135);
  run.walkTo(100, 150);
  run.exit("W", 2);
  run.walkTo(110, 150);
  run.walkTo(110, 124);
  run.command("open door");
  run.waitForRoom(55, "Castle door opens", 1200);
  run.checkpoint("Castle door", { room: 55, score: 1 });
  run.exit("N", 54);
  run.walkTo(run.state().x, 120);
  run.exit("W", 53);
  run.walkTo(75, 110);
  run.command("bow");
  run.advance(120);
  run.dismiss();
  run.checkpoint("Audience", { room: 53, score: 4 });
  run.command("talk to king");
  run.press(AGI_KEY.ENTER, 12);
  run.walkTo(145, 120);
  run.exit("E", 54);
  run.walkTo(79, 130);
  run.exit("S", 55);
  run.exit("S", 2);
  run.walkTo(110, 150);
  run.walkTo(58, 150);
  run.walkTo(45, 137);
  run.walkTo(20, 137);
  run.exit("W", 3);
  run.walkTo(123, 120);
  run.command("push rock");
  run.advance(120);
  run.command("get dagger");
  run.checkpoint("Dagger", { room: 3, score: 11 });
  run.walkTo(115, 115);
  run.exit("N", 14);
  run.command("climb tree");
  run.checkpoint("Tree", { room: 63, score: 13 });
  run.walkTo(50, 145);
  run.walkTo(60, 120);
  run.walkTo(60, 105);
  run.walkTo(68, 97);
  run.command("get egg");
  run.checkpoint("Golden egg", { room: 63, score: 19 });
  run.walkTo(60, 105);
  run.walkTo(60, 120);
  run.walkTo(50, 145);
  run.walkTo(35, 164);
  run.exit("S", 14);
  run.walkTo(84, 130);
  run.walkTo(140, 130);
  run.exit("E", 15);
  run.walkTo(15, 140);
  run.walkTo(50, 140);
  run.command("get carrot");
  run.checkpoint("Carrot", { room: 15, score: 21 });
  run.exit("E", 16);
  run.exit("E", 9);
  run.exit("N", 24);
  run.walkTo(53, 140);
  run.command("get clover");
  run.checkpoint("Clover", { room: 24, score: 23 });
}

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
  run.repeatUntil(
    () => {
      if (run.engine.flags[22] || run.engine.flags[20]) {
        run.waitForFlag(20, "Elf appears");
        run.repeatUntil(
          () => {
            run.command("talk to elf");
            if (!run.engine.flags[82]) run.advance(60);
          },
          () => Boolean(run.engine.flags[82]),
          "Could not approach elf",
          20,
        );
      } else {
        run.exit("N", 31);
        run.exit("S", 18);
      }
    },
    () => Boolean(run.engine.flags[82]),
    "Elf encounter did not appear",
    20,
  );
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
  run.walkWaypoints([
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
  ]);
  run.command("eat house");
  run.repeatUntil(
    () => {
      if (run.engine.vars[81] === 2) return;
      run.walkTo(55, 160);
      run.walkTo(10, 160);
      run.exit("W", 27);
      run.exit("E", 28);
      run.walkTo(55, 160);
    },
    () => run.engine.vars[81] === 2,
    "Witch never left her house",
    20,
  );
  run.walkTo(55, 132);
  run.checkpoint("Gingerbread", { score: 38 });
  run.command("open door");
  run.waitForRoom(65, "Witch door opens");
  run.walkTo(95, 150);
  run.walkTo(95, 100);
  run.walkTo(145, 100);
  run.walkTo(145, 150);
  run.walkTo(135, 150);
  run.command("get note");
  run.command("read note");
  run.checkpoint("Witch note", { score: 41 });
  run.waitForFlag(21, "Witch faces oven", 10000);
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
  run.walkDirection("S", () => run.state().room === 28, "Exit witch house");
  run.walkTo(55, 132);
  run.walkWaypoints([
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
  ]);
  run.walkTo(153, 60);
  run.exit("N", 37);
  run.walkTo(153, 164);
  run.exit("N", 44);
  run.walkTo(115, 140);
  run.walkTo(115, 124);
  run.walkDirection("E", () => run.state().room === 79, "Enter woodcutter house");
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

/** Lead the goat to the troll and solve the gnome's name through player input. */
export function beans(run: Speedrun): void {
  run.checkpoint("Stump departure", { room: 6, score: 67 });
  run.walkTo(50, 130);
  run.exit("N", 11);
  run.walkTo(30, 160);
  run.command("open gate");
  run.waitForFlag(78, "goat gate opens");
  run.walkTo(30, 140);
  run.walkTo(40, 120);
  run.command("show carrot");
  run.checkpoint("Goat", { room: 11, score: 72 });
  run.walkTo(20, 140);
  run.walkTo(20, 162);
  run.exit("W", 10);
  run.walkTo(70, 162);
  run.exit("S", 7);
  run.walkTo(135, 50);
  run.walkTo(135, 90);
  run.walkTo(110, 110);
  run.exit("S", 42);
  run.walkTo(99, 90);
  run.walkTo(115, 95);
  run.exit("S", 39);
  run.walkTo(135, 45);
  run.walkTo(145, 65);
  run.walkTo(145, 80);
  run.walkTo(85, 75);
  run.walkTo(60, 70);
  run.waitForFlag(150, "goat removes troll");
  run.checkpoint("Troll", { room: 39, score: 76 });
  run.exit("W", 40);
  run.walkTo(45, 110);
  run.walkTo(40, 130);
  run.command("talk to gnome");
  run.command("ifnkovhgroghprm");
  run.walkTo(40, 120);
  run.command("get beans");
  run.checkpoint("Beans", { room: 40, score: 85 });
  run.walkTo(110, 120);
  run.walkTo(145, 100);
  run.walkTo(145, 70);
  run.exit("E", 39);
  run.exit("E", 38);
  run.command("plant beans");
  run.checkpoint("Beanstalk", { room: 38, score: 87 });
}

/** Player inputs from the planted beans through the return to King Edward. */
export function secondHalf(run: Speedrun): void {
  const engine = run.engine;
  run.walkTo(60, 90);
  run.command("climb beanstalk");
  run.wait(() => engine.screenObjects[0]!.moveTarget === null, "mount beanstalk");
  run.exit("N", 70);
  run.walkTo(69, 110);
  run.walkTo(73, 106);
  run.exit("N", 71);
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
  run.walkDirection("N", () => !engine.flags[157], "step off beanstalk");
  run.exit("E", 56);
  run.exit("E", 57);
  run.exit("E", 58);
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
  run.walkDirection("W", () => Boolean(engine.flags[157]), "mount beanstalk to descend");
  run.exit("S", 71);
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
  run.walkDirection("S", () => !engine.flags[157], "step off beanstalk at ground");
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
  run.waitForFlag(179, "lower well rope");
  run.command("climb rope");
  run.wait(() => engine.screenObjects[0]!.moveTarget === null, "mount well rope");
  run.walkDirection("S", () => run.state().room === 49, "descend well shaft");
  run.walkDirection("S", () => (engine.vars[94] ?? 0) > 0, "reach well water");
  run.command("dive");
  run.walkTo(75, 125);
  run.walkTo(32, 125);
  run.walkDirection("W", () => run.state().room === 51, "enter dragon cave");
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
  run.command("swim");
  run.wait(() => engine.screenObjects[0]!.moveTarget === null, "mount return rope");
  run.exit("N", 12);
  run.walkDirection("N", () => !engine.flags[180], "leave well");
  run.checkpoint("Return from the well", { room: 12, score: 129 });
  run.walkTo(70, 110);
  run.walkTo(70, 125);
  run.walkTo(77, 125);
  run.walkTo(77, 150);
  run.exit("S", 5);
  run.exit("N", 12);
  run.walkTo(10, 150);
  run.exit("W", 11);
  run.walkTo(103, 150);
  run.walkTo(103, 80);
  run.walkTo(94, 80);
  run.exit("N", 22);
  run.walkTo(80, 125);
  run.walkTo(80, 95);
  run.walkTo(100, 75);
  run.repeatUntil(
    () => {
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
    },
    () => Boolean(engine.flags[209]),
    "Catch the condor with a jump",
    20,
  );
  run.waitForRoom(48, "condor landing");
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
  run.walkDirection("E", () => run.state().room === 73, "fall into hole");
  run.wait(() => engine.screenObjects[0]!.view === 0, "recover underground");
  run.exit("S", 74);
  run.walkTo(80, 125);
  run.exit("W", 75);
  run.walkTo(80, 125);
  run.direction(0);
  run.wait(() => engine.vars[70]! > 20 && engine.vars[70]! < 30, "rat within cheese reach");
  run.command("give cheese to rat");
  run.waitForFlag(138, "rat leaves");
  run.walkTo(40, 125);
  run.command("open door");
  run.waitForRoom(76, "enter dwarf hall");
  run.command("play fiddle");
  run.wait(() => engine.vars[30] === 0, "finish fiddle");
  run.walkTo(73, 146);
  run.exit("S", 77);
  run.waitForFlag(187, "dwarf king leaves");
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
  run.waitForRoom(55, "castle doors");
  run.exit("N", 54);
  run.walkTo(run.state().x, 120);
  run.exit("W", 53);
  run.walkTo(75, 110);
  run.command("bow");
  run.waitForFlag(195, "King Graham ending");
  assert.equal(engine.screenObjects[0]!.view, 142, "Graham sits on the throne");
  assert.equal(engine.inputEnabled, false, "The ending disables the command prompt");
  run.checkpoint("King Graham", { room: 53, score: 159 });
}

/** Recover the three royal treasures and finish the throne-room ending. */
export function kq1Complete(run: Speedrun): void {
  run.advance(30);
  run.checkpoint("Title", { room: 83, score: 0 });
  run.press(AGI_KEY.ENTER, 30);
  run.dismiss();
  run.checkpoint("Opening", { room: 1, score: 0 });
  firstHalf(run);
  middle(run);
  beans(run);
  secondHalf(run);
  run.checkpoint("Completed", { room: 53, score: 159 });
}
