import assert from "node:assert/strict";
import { KNOWN_GAME_HASH } from "../../src/games/knownGames.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import type { Speedrun } from "./runner.ts";
import type { Walkthrough } from "./route.ts";

const ITEM = {
  patrolKeys: 1,
  corvetteKeys: 2,
  cadillacKeys: 3,
  extender: 4,
  revolver: 5,
  ammunition: 6,
  briefcase: 7,
  notebook: 8,
  pen: 9,
  ticketBook: 10,
  newspaper: 11,
  wallet: 12,
  nightstick: 13,
  loadedRevolver: 14,
  hoffmanFile: 15,
  wantedPoster: 16,
  whiteSuit: 17,
  cane: 18,
  bleach: 19,
  markedMoney: 20,
  transmitter: 21,
  roomKey: 22,
  warrant: 23,
  handcuffs: 24,
} as const;

function score(run: Speedrun, expected: number, label: string): void {
  assert.equal(run.state().score, expected, label);
}

type Box = { x0: number; x1: number; y0: number; y1: number };

/**
 * Walk to a position box. Colleagues and timed remarks open message windows
 * mid-walk; a player dismisses them and keeps walking, so the helper does too.
 */
function go(run: Speedrun, target: Box, room?: number): void {
  const from = run.state().room;
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = run.traverse({
      passage: { kind: "position", planned: true, target },
      ...(room === undefined ? {} : { expectedRoom: room }),
      passageOptions: { avoidTriggers: false, geometry: "current" },
      landing: {
        label: room === undefined ? "arrive" : `enter ${room}`,
        test: (e) => (room === undefined ? e.vars[0] === from : e.vars[0] === room),
      },
    });
    if (result.status === "needs_input" || result.status === "movement_control_unavailable") {
      run.dismiss();
      run.wait(() => run.engine.movementControlEnabled, "control returns", 3000);
      if (room !== undefined && run.state().room === room) return;
      continue;
    }
    assert.equal(result.status, "reached", JSON.stringify(result));
    return;
  }
  assert.fail(`too many interruptions walking in room ${from}`);
}

function at(x: number, y: number): Box {
  return { x0: x, x1: x, y0: y, y1: y };
}

/** Title screen: any key starts the shift in the station hallway. */
function startShift(run: Speedrun): void {
  run.advance(30);
  run.checkpoint("Title screen", { room: 1, score: 0 });
  run.key(AGI_KEY.ENTER);
  run.wait(() => run.state().room === 6 && run.engine.inputEnabled, "station hallway", 600);
}

function gearUp(run: Speedrun): void {
  go(run, { x0: 143, x1: 145, y0: 140, y1: 150 }, 5);
  go(run, { x0: 84, x1: 97, y0: 132, y1: 140 });
  run.command("open locker");
  run.waitForRoom(47, "locker opens");
  run.command("get all");
  run.assertCarried(ITEM.revolver);
  run.assertCarried(ITEM.handcuffs);
  run.assertCarried(ITEM.ammunition);
  run.assertCarried(ITEM.briefcase);
  run.command("close locker");
  run.waitForRoom(5, "locker closes");
  score(run, 4, "locker opened and duty gear collected");
}

export const PQ1_SEGMENTS: readonly ((run: Speedrun) => void)[] = [startShift, gearUp];

export function pq1Complete(run: Speedrun): void {
  for (const segment of PQ1_SEGMENTS) segment(run);
}

export const pq1Walkthrough: Walkthrough = {
  hash: KNOWN_GAME_HASH.PQ1,
  alias: "pq1",
  label: "route under construction",
  coverage: "partial",
  seed: 1,
  route: pq1Complete,
  expected: { room: 0 },
};
