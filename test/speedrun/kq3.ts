import assert from "node:assert/strict";
import type { Speedrun } from "./runner.ts";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import type { Walkthrough } from "./route.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";

function enter(run: Speedrun, x: number, y: number, room: number): void {
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = run.traverse({
      passage: { kind: "position", planned: true, target: { x0: x, x1: x, y0: y, y1: y } },
      expectedRoom: room,
      passageOptions: { avoidTriggers: false, geometry: "current" },
      landing: {
        label: `enter room ${room}`,
        test: (e) => e.vars[0] === room && e.movementControlEnabled,
      },
    });
    if (result.status === "movement_control_unavailable" || result.status === "needs_input") {
      run.wait(
        () => run.engine.movementControlEnabled && run.engine.modalKind === null,
        "wizard finishes his visit",
        5000,
      );
      assert.ok(
        [0, 11, 25, 26, 224].includes(run.engine.vars[44]!),
        "arrival leaves Gwydion unharmed",
      );
      if (run.state().room === room) return;
      continue;
    }
    assert.equal(result.status, "reached", JSON.stringify(result));
    return;
  }
  assert.fail("too many interruptions on room passage");
}

function leave(run: Speedrun, direction: number, room: number): void {
  for (let attempt = 0; attempt < 12; attempt++) {
    const outcome = run.traverse(
      {
        passage: { kind: "exit", direction, room, planned: true },
        passageOptions: { avoidTriggers: true, geometry: "current", maxSearchNodes: 241920 },
        landing: {
          label: `room ${room}`,
          test: (e) => e.vars[0] === room && e.movementControlEnabled,
        },
      },
      { budgets: { hostPolls: 10000, movementUpdates: 1000 } },
    );
    if (outcome.status === "needs_input" || outcome.status === "movement_control_unavailable") {
      run.dismiss();
      run.wait(() => run.engine.movementControlEnabled, "finish the arrival", 5000);
      assert.ok(
        [0, 11, 25, 26, 224].includes(run.engine.vars[44]!),
        "arrival leaves Gwydion unharmed",
      );
      if (run.state().room === room) return;
      continue;
    }
    assert.equal(outcome.status, "reached", JSON.stringify(outcome));
    return;
  }
  assert.fail("too many interruptions during exit");
}

function stairHazards(run: Speedrun) {
  const avoidRegions = [{ x0: 0, x1: 50, y0: 99, y1: 99 }];
  const width = run.engine.screenObjects[0]!.width;
  for (let y = 87; y <= 107; y++) {
    let start: number | null = null;
    for (let x = 45; x <= 63; x++) {
      let harmful = false;
      if (x <= 62)
        for (let dx = 0; dx < width; dx++)
          if (run.engine.surface.priority[y * 160 + x + dx] === 2) harmful = true;
      if (harmful && start === null) start = x;
      if (!harmful && start !== null) {
        avoidRegions.push({ x0: start, x1: x - 1, y0: y, y1: y });
        start = null;
      }
    }
  }
  return avoidRegions;
}

function upstairs(run: Speedrun): void {
  const avoidRegions = stairHazards(run);
  const result = run.traverse(
    {
      approach: { kind: "position", planned: true, target: { x0: 35, x1: 42, y0: 99, y1: 99 } },
      approachOptions: { avoidTriggers: false },
      activation: {
        keys: [AGI_KEY.DOWN],
        ready: { label: "stair landing", test: (e) => e.flags[0] !== 0 },
        changed: { label: "crossing stairs", test: (e) => e.flags[221] !== 0 && e.flags[0] === 0 },
      },
      passage: { kind: "position", planned: true, target: { x0: 93, x1: 109, y0: 42, y1: 44 } },
      expectedRoom: 3,
      passageOptions: {
        avoidTriggers: false,
        geometry: "current",
        avoidRegions,
        maxSearchNodes: 241920,
      },
      landing: { label: "upper hallway", test: (e) => e.vars[0] === 3 && e.movementControlEnabled },
    },
    { budgets: { hostPolls: 5000, logicCycles: 1000, movementUpdates: 250 }, maxSearches: 4 },
  );
  assert.equal(result.status, "reached", JSON.stringify(result));
}

const SPELLS: Record<string, { commands: string[]; incantation: string[] }> = {
  II: {
    commands: [
      "put chicken feather in bowl",
      "put dog hair in bowl",
      "put snake skin in bowl",
      "put spoonful of fish bone in bowl",
      "put thimble of dew in bowl",
      "knead mixture with hands",
      "divide mixture into two pieces",
      "put dough in ears",
      "wave wand",
    ],
    incantation: [
      "feather of fowl and bone of fish,",
      "molded together in this dish,",
      "give me wisdom to understand",
      "creatures of air, sea and land.",
    ],
  },
  IV: {
    commands: ["put saffron in essence", "wave wand"],
    incantation: [
      "oh winged spirits, set me free",
      "of earthly bindings, just like thee.",
      "in this essence, behold the might",
      "to grant the precious gift of flight.",
    ],
  },
  VII: {
    commands: [
      "put salt in mortar",
      "grind mistletoe in mortar",
      "rub amber stone in mixture",
      "kiss stone",
      "wave wand",
    ],
    incantation: [
      "with this kiss, I thee impart,",
      "power most dear to my heart.",
      "take me now from this place hither,",
      "to another place far thither.",
    ],
  },
  XIV: {
    commands: [
      "grind acorns in mortar",
      "put acorn powder in bowl",
      "put nightshade juice in bowl",
      "stir mixture with spoon",
      "heat mixture on brazier",
      "spread mixture on table",
      "wave wand",
      "put sleep powder in pouch",
    ],
    incantation: [
      "acorn powder ground so fine,",
      "nightshade juice, like bitter wine,",
      "silently in darkness you creep,",
      "to bring a soporific sleep.",
    ],
  },
  XXV: {
    commands: [
      "put mandrake root powder in bowl",
      "put cat hair in bowl",
      "put two spoonfuls of fish oil in bowl",
      "stir mixture",
      "put mixture on table",
      "pat mixture into cookie",
      "wave wand",
    ],
    incantation: [
      "mandrake root and hair of cat,",
      "mix oil of fish and give a pat,",
      "a feline from the one who eats",
      "this appetizing magic treat.",
    ],
  },
  LXXXIV: {
    commands: [
      "put ocean water in bowl",
      "heat bowl on brazier",
      "put mud in bowl",
      "put pinch of toadstool powder in bowl",
      "blow into bowl",
      "wave wand",
      "pour brew into jar",
    ],
    incantation: [
      "elements from the earth and sea,",
      "combine to set the heavens free.",
      "when i stir this magic brew,",
      "great god thor, i call on you.",
    ],
  },
  CLXIX: {
    commands: [
      "cut cactus with knife",
      "squeeze cactus into spoon",
      "put cactus juice in bowl",
      "put lard in bowl",
      "put toad spittle in bowl",
      "stir mixture with spoon",
      "wave wand",
      "put ointment in jar",
    ],
    incantation: [
      "cactus plant and horny toad,",
      "i now start down a dangerous road.",
      "combine with fire and mist to make",
      "me disappear without a trace.",
    ],
  },
};

function cast(run: Speedrun, page: string): void {
  const recipe = SPELLS[page]!;
  run.walkPath({ x0: 94, x1: 115, y0: 139, y1: 139 });
  run.command(`open book to page ${page}`);
  assert.equal(run.state().room, 43);
  if (page === "XIV" || page === "LXXXIV") run.command("light brazier");
  for (const line of recipe.incantation) run.answer(line);
  for (const command of recipe.commands) run.command(command);
  run.waitForRoom(10, "spell completed");
}

/** Player-input route through Llewdor and Daventry. */
export function kq3Complete(run: Speedrun): void {
  run.repeatUntil(
    () => {
      run.key(AGI_KEY.ENTER);
      run.advance(30);
    },
    () => run.state().room === 7 && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "Gwydion receives control",
    200,
  );
  run.wait(
    () =>
      run.engine.flags[129] !== 0 &&
      run.engine.flags[99] === 0 &&
      run.engine.movementControlEnabled,
    "Manannan assigns the first chore",
  );
  run.checkpoint("A servant in the wizard’s house", { room: 7, score: 0 });
  enter(run, 135, 139, 8);
  enter(run, 105, 120, 6);
  run.walkPath({ x0: 58, x1: 68, y0: 126, y1: 131 });
  run.command("get knife");
  run.assertCarried(33);
  run.command("get spoon");
  run.assertCarried(41);
  run.command("clean kitchen");
  run.wait(() => run.engine.vars[44] === 0, "finish sweeping");
  run.walkPath({ x0: 30, x1: 45, y0: 126, y1: 131 });
  run.command("get bowl");
  run.assertCarried(40);
  run.walkPath({ x0: 115, x1: 123, y0: 128, y1: 141 });
  run.command("get food");
  for (const item of [49, 50, 51]) run.assertCarried(item);
  run.checkpoint("Kitchen supplies gathered", { room: 6, score: 6 });
  run.walkTo(105, 150);
  run.exit("S", 8);
  run.walkPath({ x0: 65, x1: 75, y0: 132, y1: 142 });
  run.command("get cup");
  run.assertCarried(42);
  enter(run, 23, 138, 7);
  upstairs(run);
  enter(run, 140, 145, 4);
  run.walkPath(90, 149);
  run.command("drop all");
  run.wait(
    () => run.engine.vars[84] === 0 && run.engine.vars[83] === 0,
    "Manannan prepares to leave",
    20000,
  );
  enter(run, 12, 145, 3);
  run.wait(() => run.engine.vars[127] === 2, "Manannan leaves on his journey", 5000);
  run.checkpoint("Manannan leaves Llewdor", { room: 3, score: 11 });
  enter(run, 140, 145, 4);
  run.walkPath(90, 149);
  run.command("get all");
  enter(run, 12, 145, 3);
  enter(run, 45, 115, 2);
  run.walkPath({ x0: 60, x1: 66, y0: 135, y1: 140 });
  run.command("open drawer");
  run.wait(() => run.carried(43) && run.engine.movementControlEnabled, "mirror recovered");
  run.walkPath({ x0: 98, x1: 108, y0: 128, y1: 130 });
  run.command("open closet");
  run.wait(() => run.engine.vars[230] !== 0, "closet opens");
  run.command("look behind clothes");
  run.assertCarried(54);
  run.command("close closet");
  run.command("look on top of closet");
  run.assertCarried(38);
  run.walkPath({ x0: 103, x1: 106, y0: 137, y1: 141 });
  run.command("open drawer");
  run.wait(() => run.carried(12) && run.engine.movementControlEnabled, "rose essence recovered");
  run.checkpoint("The wizard’s secrets", { room: 2, score: 23 });
  run.walkPath(43, 160);
  run.exit("S", 3);
  enter(run, 133, 52, 1);
  run.walkPath({ x0: 98, x1: 108, y0: 135, y1: 138 });
  run.command("get fly");
  run.assertCarried(10);
  run.checkpoint("A small ingredient in the observatory", { room: 1, score: 24 });
  run.walkPath(36, 160);
  run.exit("S", 3);
  run.walkPath(95, 160);
  run.exit("S", 7);
  run.walkPath(38, 101, {
    avoidTriggers: false,
    geometry: "current",
    avoidRegions: stairHazards(run),
  });
  run.walkTo(38, 99);
  run.walkDirection("N", () => run.engine.flags[221] === 0, "leave stair crossing mode");
  run.walkPath(90, 140, { avoidTriggers: false, geometry: "current" });
  enter(run, 99, 118, 5);

  run.walkPath({ x0: 25, x1: 30, y0: 157, y1: 164 });
  run.command("open cabinet");
  run.wait(
    () => run.carried(37) && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "wizard’s wand recovered",
  );
  run.walkPath({ x0: 114, x1: 119, y0: 128, y1: 137 });
  run.command("move book");
  run.wait(
    () =>
      run.engine.vars[95] === 1 &&
      run.engine.vars[224] === 0 &&
      run.engine.inputEnabled &&
      run.engine.movementControlEnabled,
    "lever revealed",
  );
  run.command("move lever");
  run.wait(
    () =>
      run.engine.vars[95] === 2 &&
      run.engine.vars[225] === 0 &&
      run.engine.inputEnabled &&
      run.engine.movementControlEnabled,
    "trapdoor opens",
  );
  enter(run, 97, 126, 9);
  leave(run, 5, 10);
  run.walkPath(30, 150, { avoidTriggers: true, geometry: "current" });
  run.walkTo(60, 150);
  assert.equal(run.engine.flags[228], 0, "leave the laboratory stairs");
  run.walkPath({ x0: 65, x1: 85, y0: 100, y1: 108 });
  for (const name of [
    "mandrake root powder",
    "saffron",
    "toad spittle",
    "nightshade juice",
    "toadstool powder",
    "fish bone powder",
  ])
    run.command(`get ${name}`);
  run.checkpoint("The hidden laboratory", { room: 10, score: 39 });

  cast(run, "IV");
  run.checkpoint("The secret of flight", { room: 10, score: 49 });
  run.walkPath(60, 150);
  run.walkTo(30, 150);
  leave(run, 1, 9);
  leave(run, 1, 5);
  run.walkPath({ x0: 114, x1: 119, y0: 128, y1: 137 });
  run.command("move lever");
  run.wait(
    () =>
      run.engine.vars[95] === 1 &&
      run.engine.vars[225] === 0 &&
      run.engine.inputEnabled &&
      run.engine.movementControlEnabled,
    "close trapdoor",
  );
  run.command("move book");
  run.wait(() => run.engine.vars[95] === 0 && run.engine.vars[224] === 0, "conceal lever");
  run.walkPath({ x0: 25, x1: 30, y0: 157, y1: 164 });
  run.command("open cabinet");
  run.wait(
    () =>
      !run.carried(37) &&
      run.engine.vars[223] === 0 &&
      run.engine.inputEnabled &&
      run.engine.movementControlEnabled,
    "return wand",
  );
  run.walkPath(98, 160);
  run.exit("S", 7);
  run.walkPath(98, 165);
  run.command("open door");
  run.waitForRoom(34);
  run.walkPath({ x0: 81, x1: 87, y0: 120, y1: 130 });
  run.command("open gate");
  run.wait(
    () => run.engine.flags[227] !== 0 && run.engine.movementControlEnabled,
    "enter chicken coop",
  );
  run.walkPath(118, 124);
  run.repeatUntil(
    () => run.command("get chicken"),
    () => run.engine.vars[225]! > 0,
    "catch chicken",
    30,
  );
  run.command("get feather");
  run.assertCarried(1);
  run.wait(() => run.engine.movementControlEnabled, "release chicken");
  run.walkPath({ x0: 94, x1: 98, y0: 121, y1: 129 });
  run.command("open gate");
  run.wait(
    () => run.engine.flags[227] === 0 && run.engine.movementControlEnabled,
    "leave chicken coop",
  );
  run.checkpoint("A feather for an animal spell", { room: 34, score: 50 });
  leave(run, 5, 33);
  leave(run, 5, 18);
  run.checkpoint("Down the mountain to Llewdor", { room: 18, score: 50 });

  leave(run, 3, 19);
  leave(run, 1, 14);
  leave(run, 7, 13);
  leave(run, 7, 12);
  leave(run, 7, 11);
  run.walkTo(145, run.state().y);
  run.direction("E");
  run.advance(6);
  run.direction(0);
  run.wait(() => run.engine.flags[242] !== 0, "Medusa appears", 3000);
  run.type("show mirror to medusa");
  run.wait(() => run.engine.vars[242]! <= 45, "Medusa approaches the mirror", 3000);
  run.submit("show mirror to medusa");
  run.wait(() => run.engine.flags[111] !== 0, "Medusa turns to stone");
  run.wait(
    () => run.messages.at(-1)?.includes("turned herself to stone") === true,
    "Medusa’s transformation completes",
    2000,
  );
  run.dismiss();
  run.checkpoint("Medusa meets her reflection", { room: 11, score: 55 });

  run.walkPath({ x0: 80, x1: 100, y0: 102, y1: 109 });
  run.command("get snake skin");
  run.assertCarried(4);
  leave(run, 5, 16);
  leave(run, 5, 21);
  run.walkPath(54, 86, { geometry: "current" });
  run.command("get cactus");
  run.assertCarried(34);
  run.checkpoint("Desert ingredients", { room: 21, score: 57 });
  leave(run, 5, 26);
  leave(run, 5, 11);
  leave(run, 3, 12);
  leave(run, 3, 13);
  run.walkPath({ x0: 112, x1: 125, y0: 132, y1: 142 });
  run.command("get mud");
  run.assertCarried(27);
  run.repeatUntil(
    () => {
      run.wait(
        () =>
          run.engine.flags[191] !== 0 ||
          (run.engine.vars[184] === 0 &&
            !run.engine.screenObjects[10]!.active &&
            !run.engine.screenObjects[11]!.active),
        "watch the eagle",
        3000,
      );
      if (run.engine.flags[191] !== 0) {
        const feather = run.engine.screenObjects[11]!;
        run.walkPath({
          x0: feather.x - 8,
          x1: feather.x + 8,
          y0: feather.y - 8,
          y1: feather.y + 8,
        });
        run.command("get eagle feather");
      } else if (run.state().room === 13) leave(run, 7, 12);
      else leave(run, 3, 13);
    },
    () => run.carried(9),
    "find an eagle feather",
    32,
  );
  run.checkpoint("An eagle’s gift", { score: 60 });
  if (run.state().room === 12) leave(run, 3, 13);
  leave(run, 3, 14);
  leave(run, 3, 15);
  run.walkToUntil(120, 135, () => run.engine.flags[0] !== 0, "reach ocean water");
  run.command("get water");
  run.assertCarried(26);
  run.walkPath(20, 110);
  leave(run, 1, 29);
  run.walkPath({ x0: 16, x1: 23, y0: 112, y1: 120 });
  run.command("get mistletoe");
  run.assertCarried(15);
  run.checkpoint("Sea water and mistletoe", { room: 29, score: 62 });
  leave(run, 1, 24);
  run.walkPath({ x0: 73, x1: 80, y0: 126, y1: 130 });
  run.command("open door");
  run.wait(() => run.engine.flags[226] !== 0, "shop door opens");
  run.walkTo(74, 130);
  enter(run, 69, 129, 39);
  run.walkPath({ x0: 51, x1: 61, y0: 133, y1: 138 });
  run.command("pet dog");
  run.assertCarried(3);
  run.checkpoint("A friendly dog in the village", { room: 39, score: 63 });

  enter(run, 121, 136, 24);
  leave(run, 5, 29);
  leave(run, 7, 28);
  run.repeatUntil(
    () => {
      leave(run, 3, 29);
      leave(run, 7, 28);
    },
    () => [50, 250].includes(run.engine.vars[221]!),
    "wait for the bears to leave",
    12,
  );
  run.walkPath({ x0: 74, x1: 80, y0: 111, y1: 115 });
  run.command("open door");
  run.waitForRoom(41, "enter the bears’ cottage", 3000);
  if (run.engine.vars[190]! > 0) {
    run.walkPath({ x0: 82, x1: 94, y0: 141, y1: 144 });
    run.command("get porridge");
  }
  enter(run, 53, 49, 42);
  run.walkPath({ x0: 96, x1: 99, y0: 109, y1: 110 });
  run.command("open drawer");
  run.command("get thimble");
  run.assertCarried(6);
  run.command("close drawer");
  enter(run, 51, 118, 41);
  run.repeatUntil(
    () => {
      run.walkPath(68, 160);
      run.exit("S", 28);
      run.walkPath({ x0: 74, x1: 80, y0: 111, y1: 115 });
      run.command("open door");
      run.waitForRoom(41, "return for porridge", 3000);
      if (run.engine.vars[190]! > 0) {
        run.walkPath({ x0: 82, x1: 94, y0: 141, y1: 144 });
        run.command("get porridge");
      }
    },
    () => run.carried(24),
    "find just-right porridge",
    12,
  );
  run.checkpoint("Borrowing from the three bears", { room: 41, score: 66 });
  run.walkPath(68, 160);
  run.exit("S", 28);
  run.walkPath(40, 145);
  run.command("get dew");
  run.assertCarried(7);
  run.checkpoint("Dew gathered in a thimble", { room: 28, score: 67 });
  leave(run, 7, 27);
  leave(run, 1, 22);

  run.repeatUntil(
    () => {
      run.walkPath({ x0: 106, x1: 123, y0: 131, y1: 138 });
      run.command("get acorns");
      if (!run.carried(18)) {
        leave(run, 7, 21);
        leave(run, 3, 22);
      }
    },
    () => run.carried(18),
    "find dried acorns",
    16,
  );
  run.command("reach in hole");
  run.wait(
    () => run.engine.flags[112] !== 0 && run.engine.movementControlEnabled,
    "reveal the hidden ladder",
  );
  run.walkToUntil(131, 119, () => run.engine.vars[44] === 15, "mount the oak ladder");
  run.exit("N", 37);
  run.repeatUntil(
    () => {
      run.exit("S", 22);
      run.walkDirection("S", () => run.engine.vars[44] === 0, "step off the oak ladder");
      run.walkToUntil(131, 119, () => run.engine.vars[44] === 15, "climb back to the hideout");
      run.exit("N", 37);
    },
    () => run.engine.vars[172] === 0,
    "wait for the bandit to fall asleep",
    16,
  );
  run.walkTo(93, 113);
  run.walkToUntil(89, 113, () => run.engine.vars[44] === 0, "step onto the treehouse porch");
  enter(run, 73, 110, 38);
  run.walkPath({ x0: 55, x1: 69, y0: 117, y1: 139 }, { geometry: "current" });
  run.command("get purse");
  run.assertCarried(48);
  run.checkpoint("Gold from the sleeping bandit", { room: 38, score: 77 });

  run.command("look at map");
  run.walkTo(110, 104);
  run.command("go here");
  run.wait(() => run.engine.movementControlEnabled, "arrive in the village");
  run.walkPath({ x0: 73, x1: 80, y0: 126, y1: 130 });
  run.command("open door");
  run.wait(() => run.engine.flags[226] !== 0, "shop door opens");
  run.walkTo(74, 130);
  enter(run, 69, 129, 39);
  run.walkPath({ x0: 75, x1: 100, y0: 131, y1: 133 });
  for (const ingredient of ["salt", "lard", "fish oil", "pouch"]) run.command(`buy ${ingredient}`);
  for (const item of [13, 32, 22, 19]) run.assertCarried(item);
  run.checkpoint("Magic ingredients from the merchant", { room: 39, score: 81 });
  run.wait(
    () =>
      run.engine.movementControlEnabled && run.engine.inputEnabled && run.engine.vars[222] === 3,
    "finish the purchase",
  );
  run.walkPath(107, 151, { geometry: "current" });
  enter(run, 121, 136, 24);
  const tavern = () => {
    run.walkPath({ x0: 112, x1: 120, y0: 84, y1: 86 });
    run.command("open door");
    run.wait(() => run.engine.flags[232] !== 0, "tavern door opens");
    run.walkDirection("N", () => run.state().room === 40, "enter the tavern");
  };
  tavern();
  run.repeatUntil(
    () => {
      run.walkTo(72, 165);
      run.exit("S", 24);
      tavern();
    },
    () => run.engine.vars[221] === 2,
    "find the bandits at the tavern",
    16,
  );
  run.command("dip fly wings in essence");
  run.wait(() => run.engine.vars[44] === 25 && run.engine.movementControlEnabled, "become a fly");
  run.walkTo(72, 150);
  run.wait(() => run.engine.flags[221] !== 0, "overhear the bandits", 1000);
  run.checkpoint("A fly overhears the bandits", { room: 40, score: 84 });
  run.walkTo(72, 165);
  run.exit("S", 24);
  leave(run, 7, 23);
  leave(run, 7, 22);
  run.walkToUntil(117, 137, () => run.state().room === 35, "explore the hollow oak");
  run.dismiss();
  run.walkDirection("S", () => run.state().room === 22, "leave the hollow oak");
  run.command("fly begone myself return");
  run.wait(
    () => run.engine.vars[44] === 0 && run.engine.movementControlEnabled,
    "return to human form",
  );
  run.checkpoint("Inside the hollow oak", { room: 22, score: 89 });
  run.command("look at map");
  run.walkTo(110, 38);
  run.command("go here");
  run.wait(() => run.engine.movementControlEnabled, "arrive below the Oracle cave");
  run.command("dip eagle feather in essence");
  run.wait(
    () => run.engine.vars[44] === 26 && run.engine.movementControlEnabled,
    "become an eagle",
  );
  run.walkToUntil(94, 64, () => run.engine.flags[115] !== 0, "seize the spider");
  run.wait(
    () =>
      run.engine.vars[220] === 0 && run.engine.movementControlEnabled && run.engine.inputEnabled,
    "return from the sea",
    5000,
  );
  assert.equal(run.engine.vars[44], 0);
  run.checkpoint("The eagle clears the Oracle cave", { room: 14, score: 93 });
  run.walkPath(92, 88, { avoidTriggers: false, geometry: "current" });
  run.walkToUntil(92, 70, () => run.state().room === 36, "enter the Oracle cave");
  run.wait(
    () => run.carried(14) && run.engine.movementControlEnabled && run.engine.inputEnabled,
    "receive the amber stone",
    6000,
  );
  run.checkpoint("The Oracle reveals Gwydion’s identity", { room: 36, score: 96 });
  run.walkPath(72, 165);
  run.exit("S", 14);

  run.command("look at map");
  run.walkTo(79, 71);
  run.command("go here");
  run.wait(
    () => run.engine.movementControlEnabled && run.engine.inputEnabled,
    "return to the mountain",
  );
  const climb = run.traverse({
    passage: { kind: "position", planned: true, target: { x0: 0, x1: 10, y0: 41, y1: 47 } },
    expectedRoom: 33,
    passageOptions: { avoidTriggers: true, geometry: "current", maxSearchNodes: 241920 },
    landing: { label: "mountain path", test: (e) => e.vars[0] === 33 && e.movementControlEnabled },
  });
  assert.equal(climb.status, "reached", JSON.stringify(climb));
  leave(run, 1, 34);
  run.walkPath({ x0: 35, x1: 43, y0: 131, y1: 136 });
  run.command("open door");
  run.waitForRoom(7, "return to the wizard’s house");
  run.repeatUntil(
    () => {
      enter(run, 135, 139, 8);
      enter(run, 23, 138, 7);
    },
    () => run.engine.flags[116] === 1,
    "find the cat in the hall",
    20,
  );
  run.repeatUntil(
    () => {
      const cat = run.engine.screenObjects[13]!;
      run.walkPath(
        {
          x0: Math.max(0, cat.x - 5),
          x1: Math.min(150, cat.x + 5),
          y0: Math.max(42, cat.y - 5),
          y1: Math.min(167, cat.y + 5),
        },
        { geometry: "current" },
      );
      run.command("get cat");
      if (run.engine.flags[240] === 1) run.command("get cat hair");
    },
    () => run.carried(2),
    "catch the cat and take hair",
    40,
  );
  run.wait(() => run.engine.vars[44] === 0 && run.engine.movementControlEnabled, "release the cat");
  run.checkpoint("The last ingredient from Manannan’s cat", { room: 7, score: 97 });
  enter(run, 99, 118, 5);
  run.walkPath({ x0: 25, x1: 30, y0: 157, y1: 164 });
  run.command("open cabinet");
  run.wait(
    () => run.carried(37) && run.engine.vars[223] === 0 && run.engine.movementControlEnabled,
    "recover the wand",
  );
  run.walkPath({ x0: 114, x1: 119, y0: 128, y1: 137 });
  run.command("move book");
  run.wait(
    () =>
      run.engine.vars[95] === 1 &&
      run.engine.vars[224] === 0 &&
      run.engine.inputEnabled &&
      run.engine.movementControlEnabled,
    "reveal the lever",
  );
  run.command("move lever");
  run.wait(
    () =>
      run.engine.vars[95] === 2 &&
      run.engine.vars[225] === 0 &&
      run.engine.inputEnabled &&
      run.engine.movementControlEnabled,
    "open the trapdoor",
  );
  enter(run, 97, 126, 9);
  leave(run, 5, 10);
  run.walkPath(30, 150, { avoidTriggers: true, geometry: "current" });
  run.walkTo(60, 150);
  cast(run, "XXV");
  run.command("put cookie in porridge");
  run.assertCarried(25);
  run.checkpoint("A cookie for Manannan", { room: 10, score: 107 });
  for (const page of ["II", "VII", "XIV", "LXXXIV", "CLXIX"]) cast(run, page);
  run.checkpoint("All seven spells mastered", { room: 10, score: 157 });
  run.walkPath(60, 150);
  run.walkTo(30, 150);
  leave(run, 1, 9);
  leave(run, 1, 5);
  run.walkPath({ x0: 114, x1: 119, y0: 128, y1: 137 });
  run.command("move lever");
  run.wait(
    () =>
      run.engine.vars[95] === 1 &&
      run.engine.vars[225] === 0 &&
      run.engine.inputEnabled &&
      run.engine.movementControlEnabled,
    "close trapdoor",
  );
  run.command("move book");
  run.wait(() => run.engine.vars[95] === 0 && run.engine.vars[224] === 0, "conceal lever");
  run.walkPath({ x0: 25, x1: 30, y0: 157, y1: 164 });
  run.command("open cabinet");
  run.wait(
    () =>
      !run.carried(37) &&
      run.engine.vars[223] === 0 &&
      run.engine.inputEnabled &&
      run.engine.movementControlEnabled,
    "return wand",
  );
  run.walkPath(98, 160);
  run.exit("S", 7);
  upstairs(run);
  enter(run, 140, 145, 4);
  run.walkPath(90, 149);
  run.command("drop all");
  run.wait(
    () => run.engine.inputEnabled && run.engine.movementControlEnabled,
    "hide the magic supplies",
  );
  run.command("get porridge");
  run.wait(
    () => run.carried(25) && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "retrieve the enchanted supper",
  );
  run.checkpoint("The enchanted supper is ready", { room: 4, score: 157 });
  enter(run, 12, 145, 3);
  run.wait(
    () =>
      run.engine.vars[127] === 3 && run.engine.movementControlEnabled && run.engine.inputEnabled,
    "Manannan returns for supper",
    20000,
  );
  run.checkpoint("Manannan returns for supper", { room: 3, score: 157 });
  run.walkPath(95, 160);
  run.exit("S", 7);
  run.walkPath(38, 101, {
    avoidTriggers: false,
    geometry: "current",
    avoidRegions: stairHazards(run),
  });
  run.walkTo(38, 99);
  run.walkDirection("N", () => run.engine.flags[221] === 0, "leave the stair crossing");
  run.walkPath(90, 140, { avoidTriggers: false, geometry: "current" });
  enter(run, 135, 139, 8);
  run.wait(() => run.engine.vars[128] === 106, "Manannan sits at the table", 3000);
  run.walkPath({ x0: 80, x1: 95, y0: 136, y1: 145 });
  run.command("give porridge to manannan");
  run.wait(
    () =>
      run.engine.vars[128] === 20 &&
      run.engine.vars[124] === 0 &&
      run.engine.movementControlEnabled,
    "Manannan becomes a cat",
    6000,
  );
  run.checkpoint("Gwydion is free of Manannan", { room: 8, score: 169 });
  const diningExit = run.traverse({
    passage: { kind: "position", planned: true, target: { x0: 21, x1: 25, y0: 132, y1: 144 } },
    expectedRoom: 7,
    passageOptions: { avoidTriggers: false, geometry: "current" },
    landing: {
      label: "leave the dining room",
      test: (e) => e.vars[0] === 7 && e.movementControlEnabled,
    },
  });
  assert.equal(diningExit.status, "reached", JSON.stringify(diningExit));
  upstairs(run);
  enter(run, 140, 145, 4);
  run.walkPath(90, 149);
  run.command("get all");
  run.wait(
    () => run.carried(54) && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "retrieve the magic supplies",
  );
  run.command("look at map");
  run.walkTo(110, 104);
  run.command("go here");
  run.wait(
    () => run.engine.movementControlEnabled && run.engine.inputEnabled,
    "return to the village",
  );
  tavern();
  run.command("talk to pirates");
  run.wait(() => run.engine.vars[222] === 29, "the captain asks for his fare", 500);
  run.command("give gold to pirates");
  assert.equal(run.engine.flags[79], 1);
  run.checkpoint("Passage to Daventry", { room: 40, score: 172 });
  run.walkTo(72, 165);
  run.exit("S", 24);
  leave(run, 3, 25);
  run.walkTo(0, 105);
  run.walkTo(20, 105);
  run.walkTo(38, 105);
  leave(run, 3, 75);
  run.walkPath({ x0: 28, x1: 37, y0: 71, y1: 77 }, { avoidTriggers: true, geometry: "current" });
  run.waitForRoom(77, "board the ship", 3000);
  run.wait(
    () => run.state().room === 85 && run.engine.movementControlEnabled,
    "the pirates reveal their intentions",
    6000,
  );
  run.checkpoint("Captive aboard the pirate ship", { room: 85, score: 174 });
  leave(run, 3, 86);
  run.walkPath({ x0: 53, x1: 62, y0: 147, y1: 157 });
  run.command("get box");
  run.wait(() => run.engine.vars[44] === 202, "carry the small crate");
  leave(run, 7, 85);
  run.walkPath({ x0: 93, x1: 121, y0: 140, y1: 151 }, { geometry: "current" });
  run.command("drop box");
  run.command("jump on box");
  run.wait(() => run.engine.vars[44] === 200, "jump onto the small crate");
  run.command("jump on box");
  run.wait(() => run.engine.vars[44] === 201, "jump onto the large crate");
  run.command("jump");
  run.wait(() => run.engine.vars[44] === 15, "catch the rope ladder");
  run.exit("N", 83);
  run.checkpoint("Escape from the cargo hold", { room: 83, score: 176 });
  run.walkDirection("S", () => run.state().room === 85, "return below deck");
  run.walkDirection("S", () => run.engine.vars[44] === 201, "land on the large crate");
  run.walkDirection("E", () => run.engine.vars[44] === 0, "jump down from the crate");
  leave(run, 3, 86);
  run.repeatUntil(
    () => {
      if (run.engine.flags[221] === 0) {
        leave(run, 7, 85);
        leave(run, 3, 86);
      } else
        run.wait(
          () => run.engine.flags[194] !== 0 || run.engine.vars[62]! >= 3,
          "listen to the mice during the voyage",
          60000,
        );
    },
    () => run.engine.flags[194] !== 0 || run.engine.vars[62]! >= 3,
    "hear the mice’s treasure clue",
    20,
  );
  if (run.engine.flags[194] !== 0)
    run.checkpoint("The mice reveal a buried treasure", { room: 86, score: 176 });
  run.wait(() => run.engine.vars[62] === 3, "land comes into sight", 60000);
  run.checkpoint("Land ho: Daventry ahead", { room: 86, score: 176 });
  run.wait(() => run.engine.vars[62] === 4, "the pirates drop anchor", 15000);
  run.checkpoint("The pirates go ashore", { room: 86, score: 176 });
  leave(run, 7, 85);
  run.walkPath({ x0: 110, x1: 125, y0: 139, y1: 148 }, { geometry: "current" });
  run.command("jump on box");
  run.wait(() => run.engine.vars[44] === 200, "climb the small crate");
  run.command("jump on box");
  run.wait(() => run.engine.vars[44] === 201, "climb the large crate");
  run.command("jump");
  run.wait(() => run.engine.vars[44] === 15, "catch the rope");
  run.exit("N", 83);
  run.walkDirection("W", () => run.engine.vars[44] === 0, "leave the rope ladder");
  run.walkTo(136, 140);
  run.walkPath({ x0: 28, x1: 48, y0: 148, y1: 162 }, { geometry: "current" });
  run.command("open chest");
  run.wait(() => run.engine.flags[188] !== 0, "open the captain’s chest");
  run.command("get all");
  run.wait(() => run.engine.flags[206] !== 0, "recover the stolen possessions");
  run.checkpoint("Magic recovered from the captain’s chest", { room: 83, score: 179 });
  run.walkPath(136, 140, { geometry: "current" });
  run.walkTo(153, 140);
  run.exit("E", 84);
  run.walkPath(17, 138, { geometry: "current" });
  run.command("get shovel");
  run.assertCarried(52);
  run.walkTo(0, 137);
  run.exit("W", 83);
  run.walkToUntil(144, 131, () => run.engine.vars[44] === 15, "climb onto the rope");
  run.walkDirection("S", () => run.state().room === 85, "return to the hold");
  run.walkDirection("S", () => run.engine.vars[44] === 201, "land on the crate");
  assert.equal(run.engine.vars[62], 4, "cast sleep only after anchoring");
  run.command("pour sleep powder on floor");
  run.command("slumber henceforth");
  run.wait(() => run.engine.flags[181] !== 0, "the crew falls asleep");
  run.checkpoint("The sleeping ship", { room: 85, score: 180 });
  run.command("jump");
  run.wait(() => run.engine.vars[44] === 15, "reach the rope");
  run.exit("N", 83);
  run.walkDirection("N", () => run.state().room === 80, "climb to the deck");
  run.walkTo(113, 142);
  run.walkDirection("E", () => run.engine.vars[44] === 0, "step onto the deck");
  leave(run, 3, 81);
  run.walkPath({ x0: 99, x1: 130, y0: 110, y1: 150 }, { avoidTriggers: true, geometry: "current" });
  run.walkToUntil(120, 138, () => run.engine.vars[44] === 6, "jump overboard");
  run.waitForRoom(48, "reach Daventry", 3000);
  run.checkpoint("At last, the shores of Daventry", { room: 48, score: 185 });
  leave(run, 3, 49);
  run.walkPath({ x0: 53, x1: 58, y0: 82, y1: 85 }, { geometry: "current" });
  run.command("dig");
  run.wait(() => run.carried(53), "uncover the pirates’ treasure");
  run.checkpoint("Treasure beneath the lone palm", { room: 49, score: 192 });
  run.walkPath(60, 71, { geometry: "current" });
  run.exit("N", 50);
  run.command("dip fly wings in essence");
  run.wait(
    () => run.engine.vars[44] === 25 && run.engine.movementControlEnabled,
    "fly above the mountain paths",
    1000,
  );
  run.walkTo(150, 60);
  run.exit("E", 51);
  run.walkToUntil(68, 0, () => run.state().room === 52, "fly to the ridge");
  run.walkToUntil(159, 80, () => run.state().room === 53, "fly east along the ridge");
  run.walkToUntil(48, 0, () => run.state().room === 54, "fly up the waterfall");
  run.checkpoint("A fly above the waterfall", { room: 54, score: 192 });
  run.walkToUntil(159, 95, () => run.state().room === 55, "fly toward the summit");
  run.walkToUntil(159, 140, () => run.state().room === 56, "fly past the snowy cave");
  run.command("fly begone myself return");
  run.wait(
    () => run.engine.vars[44] === 0 && run.engine.movementControlEnabled,
    "land safely at the summit",
    2000,
  );
  run.walkPath(40, 165, { avoidTriggers: true, geometry: "current" });
  leave(run, 5, 57);
  run.wait(() => run.engine.flags[171] !== 0, "elude the snowman", 1000);
  run.checkpoint("Beyond the abominable snowman", { room: 57, score: 196 });
  run.wait(() => run.engine.modalKind === null, "prepare for the cliff descent");
  run.walkWaypoints([
    [49, 48],
    [47, 50],
    [47, 53],
    [38, 62],
    [21, 62],
    [18, 59],
    [19, 58],
    [23, 58],
    [24, 57],
  ]);
  run.walkToUntil(35, 57, () => run.engine.vars[222] === 6, "enter the first cliff cave");
  run.direction(0);
  run.wait(() => run.engine.vars[222] === 0, "emerge from the first cave", 600);
  run.walkWaypoints([
    [128, 43],
    [132, 47],
    [131, 48],
    [130, 48],
    [129, 49],
    [125, 49],
    [124, 50],
    [110, 50],
    [108, 48],
    [99, 48],
    [98, 49],
    [98, 92],
    [96, 94],
    [96, 108],
    [94, 110],
    [94, 111],
    [92, 113],
    [92, 114],
    [91, 115],
    [91, 116],
    [90, 117],
    [90, 118],
    [88, 120],
    [88, 121],
    [87, 122],
    [87, 123],
    [86, 124],
    [86, 128],
    [85, 129],
    [85, 132],
    [84, 133],
    [84, 134],
    [82, 136],
    [82, 157],
    [83, 158],
    [100, 158],
    [103, 155],
    [103, 154],
    [99, 150],
    [98, 150],
    [97, 149],
    [94, 149],
    [93, 148],
  ]);
  run.walkToUntil(91, 148, () => run.engine.vars[222] === 4, "enter the second cliff cave");
  run.direction(0);
  run.wait(() => run.engine.vars[222] === 0, "emerge from the second cave", 500);
  run.walkWaypoints([
    [27, 146],
    [18, 155],
    [18, 157],
    [22, 161],
    [31, 161],
    [32, 160],
    [32, 155],
    [33, 154],
    [33, 153],
    [34, 152],
    [34, 151],
    [35, 150],
    [35, 102],
    [34, 101],
    [34, 96],
    [35, 95],
    [63, 95],
    [64, 94],
    [70, 94],
    [71, 93],
  ]);
  run.walkToUntil(79, 93, () => run.engine.vars[222] === 5, "enter the final cliff cave");
  run.direction(0);
  run.wait(() => run.engine.vars[222] === 0, "emerge from the final cave", 500);
  run.walkWaypoints([
    [137, 140],
    [141, 144],
    [140, 145],
    [137, 145],
    [136, 146],
    [135, 146],
    [126, 155],
    [131, 160],
    [149, 160],
    [150, 161],
  ]);
  run.exit("E", 58);
  run.checkpoint("Across the cliff’s hidden passages", { room: 58, score: 196 });
  leave(run, 3, 59);
  const descent = run.traverse({
    passage: { kind: "exit", direction: 5, room: 61, planned: true },
    passageOptions: { avoidTriggers: true, geometry: "current" },
    landing: {
      label: "the mountain foothills",
      test: (e) =>
        e.vars[0] === 61 &&
        e.vars[44] === 0 &&
        e.screenObjects[0]!.y >= 90 &&
        e.movementControlEnabled,
    },
  });
  assert.ok(
    ["reached", "needs_input", "movement_control_unavailable"].includes(descent.status),
    JSON.stringify(descent),
  );
  run.wait(
    () =>
      run.state().room === 61 &&
      run.engine.vars[44] === 0 &&
      run.engine.screenObjects[0]!.y >= 90 &&
      run.engine.movementControlEnabled,
    "recover footing below the mountain",
    2000,
  );
  const cave = run.traverse({
    passage: { kind: "position", planned: true, target: { x0: 118, x1: 125, y0: 59, y1: 68 } },
    expectedRoom: 62,
    passageOptions: { avoidTriggers: true, geometry: "current" },
    landing: {
      label: "enter the stone stairway",
      test: (e) => e.vars[0] === 62 && e.movementControlEnabled,
    },
  });
  assert.equal(cave.status, "reached", JSON.stringify(cave));
  const stairs = run.traverse({
    passage: { kind: "position", planned: true, target: { x0: 0, x1: 150, y0: 35, y1: 39 } },
    expectedRoom: 63,
    passageOptions: { avoidTriggers: true, geometry: "current" },
    landing: {
      label: "climb the stone stairs",
      test: (e) => e.vars[0] === 63 && e.movementControlEnabled,
    },
  });
  assert.equal(stairs.status, "reached", JSON.stringify(stairs));
  leave(run, 1, 64);
  leave(run, 7, 67);
  run.command("rub ointment on self");
  run.wait(
    () =>
      run.engine.flags[49] !== 0 && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "become invisible before the dragon",
  );
  leave(run, 7, 66);
  run.command("stir storm brew with finger");
  run.command("brew of storms churn it up");
  run.wait(
    () => run.engine.flags[183] !== 0 && run.engine.movementControlEnabled,
    "defeat the three-headed dragon",
    5000,
  );
  run.checkpoint("The storm defeats the dragon", { room: 66, score: 203 });
  run.wait(
    () =>
      run.engine.flags[49] === 0 && run.engine.inputEnabled && run.engine.movementControlEnabled,
    "become visible to Rosella",
  );
  run.walkPath({ x0: 0, x1: 20, y0: 100, y1: 116 }, { avoidTriggers: true, geometry: "current" });
  run.command("untie rosella");
  run.wait(
    () => run.engine.flags[182] !== 0 && run.engine.movementControlEnabled,
    "free Princess Rosella",
    3000,
  );
  run.checkpoint("Alexander frees his sister", { room: 66, score: 206 });
  leave(run, 3, 67);
  enter(run, 151, 105, 64);
  leave(run, 5, 63);
  leave(run, 5, 62);
  leave(run, 7, 61);
  run.walkTo(118, 74);
  run.wait(
    () => run.engine.screenObjects[15]!.direction === 0,
    "let Rosella reach the stair landing",
    120,
  );
  run.walkPath({ x0: 0, x1: 15, y0: 100, y1: 140 }, { avoidTriggers: true });
  leave(run, 7, 68);
  leave(run, 1, 69);
  run.checkpoint("Brother and sister return to Daventry", { room: 69, score: 206 });
  for (let attempt = 0; attempt < 8 && run.state().room === 69; attempt++) {
    const castle = run.traverse({
      passage: { kind: "exit", direction: 1, room: 71, planned: true },
      passageOptions: { avoidTriggers: true, geometry: "current" },
      landing: { label: "the castle welcomes its children", test: (e) => e.vars[0] === 71 },
    });
    assert.ok(
      ["reached", "needs_input", "movement_control_unavailable"].includes(castle.status),
      JSON.stringify(castle),
    );
    run.dismiss();
    if (run.state().room === 69)
      run.wait(() => run.engine.movementControlEnabled, "the gnome announces the return", 2000);
  }
  assert.equal(run.state().room, 71);
  run.checkpoint("The castle gates stand open", { room: 71, score: 206 });
  run.wait(
    () => run.state().room === 74 && run.engine.vars[220]! >= 27,
    "the royal family is reunited",
    20000,
  );
  run.dismiss();
  assert.equal(run.engine.vars[7], 210);
  assert.equal(run.engine.screenObjects[0]!.view, 77);
  assert.equal(run.engine.screenObjects[0]!.cel, 1);
  assert.equal(run.engine.inputEnabled, false);
  assert.equal(run.engine.modalKind, null);
  assert.equal(run.engine.flags[44], 0);
  run.checkpoint("The royal family reunited", { room: 74, score: 210 });
}

export const kq3Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.KQ3,
  alias: "kq3",
  label: "completed royal reunion with maximum score",
  coverage: "complete-game",
  seed: 1,
  route: kq3Complete,
  expected: {
    room: 74,
    score: 210,
    vars: { 7: 210, 220: 27 },
    flags: { 151: 1, 152: 1, 153: 1, 154: 1, 155: 1, 156: 1, 157: 1, 182: 1, 183: 1, 198: 1 },
    inputEnabled: false,
    egoView: 77,
  },
  requiresAnswer: true,
};
