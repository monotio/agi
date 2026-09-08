import assert from "node:assert/strict";
import type { Speedrun } from "./runner.ts";

function takeCartridge(run: Speedrun): void {
  run.answer("ROGER"); // boot name prompt (get.string)
  for (let n = 0; n < 3000 && !(run.engine.inputEnabled && run.engine.modalKind === null); n++) {
    if (n % 120 === 0) run.key(13);
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

function assertCarried(run: Speedrun, num: number, name: string): void {
  assert.ok(
    run.engine.readState().inventory.some((item) => item.num === num && item.room === 255),
    `${name} is carried`,
  );
}
