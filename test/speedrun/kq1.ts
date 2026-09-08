import type { Speedrun } from "./runner.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { firstHalf, beans } from "./kq1-first.ts";
import { middle } from "./kq1-middle.ts";
import { secondHalf } from "./kq1-second.ts";

/** Recover the three royal treasures and finish the throne-room ending. */
export function kq1Complete(run: Speedrun): void {
  run.advance(30);
  run.checkpoint("Title", { room: 83, score: 0 });
  run.key(AGI_KEY.ENTER);
  run.advance(30);
  run.dismiss();
  run.checkpoint("Opening", { room: 1, score: 0 });
  firstHalf(run);
  middle(run);
  beans(run);
  secondHalf(run);
  run.checkpoint("Completed", { room: 53, score: 159 });
}
