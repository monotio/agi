import assert from "node:assert/strict";
import { Speedrun } from "./runner.ts";

export const ADDITIONAL_OPENINGS = [
  { slug: "bc", profile: "2.440", title: 67, room: 8 },
  { slug: "mumg", profile: "2.917", title: 96, room: 32 },
  { slug: "sq2", profile: "2.936", title: 140, room: 2 },
] as const;

/** Cold-boot routes through the introductions, followed by a player-controlled step. */
export function additionalOpening(slug: (typeof ADDITIONAL_OPENINGS)[number]["slug"]): Speedrun {
  const expected = ADDITIONAL_OPENINGS.find((game) => game.slug === slug)!;
  const run = new Speedrun(slug, 1);
  assert.equal(run.engine.readState().profile, expected.profile);
  run.answer("PLAYER");
  run.advance(120);
  run.checkpoint("Title", { room: expected.title, score: 0 });
  run.key(slug === "mumg" ? 32 : 13);
  run.advance(120);
  run.dismiss();
  if (slug !== "bc") {
    run.key(13);
    run.advance(120);
    run.dismiss();
  }
  run.wait(() => run.state().room === expected.room, "opening scene");
  // Mother Goose's arrival animation clears these flags before player control.
  // Parser availability cannot identify control in games that use only keys.
  if (slug === "mumg")
    run.wait(() => run.engine.flags[115] === 0 && run.engine.flags[117] === 0, "arrival complete");
  if (slug === "sq2") run.wait(() => run.engine.inputEnabled, "janitor introduction complete");
  run.dismiss();
  run.checkpoint("Player control", { room: expected.room, score: 0 });
  const before = run.state();
  run.direction(3);
  run.advance(24);
  run.dismiss();
  assert.ok(run.state().x > before.x, "a right arrow moves the player east");
  run.direction(0);
  run.checkpoint("Opening movement", { room: expected.room, score: 0 });
  assert.ok(run.engine.getFrame().visual.some((pixel) => pixel !== 0));
  return run;
}
