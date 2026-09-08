import assert from "node:assert/strict";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { Speedrun } from "./runner.ts";

/**
 * The opening catalog: every documented fixture's expected interpreter
 * profile and the room its title or intro shows right after a cold boot.
 * The Node opening suite, the browser title smoke checks and the browser
 * route replays all consume these definitions.
 */
export interface Opening {
  readonly slug: string;
  /** Supported profiles selected from the supplied interpreter binary. */
  readonly profiles: readonly string[];
  /** First title or introductory room after a cold boot. */
  readonly titleRoom: number;
  /** Present when the suite has a route through player-controlled movement. */
  readonly openingRoom?: number;
  /** Browser movement keys remain held while advancing the replay clock. */
  readonly holdMovement?: boolean;
}

export const OPENINGS: readonly Opening[] = [
  { slug: "bc", profiles: ["2.440"], titleRoom: 67, openingRoom: 8 },
  { slug: "ddp", profiles: ["2.272", "2.440"], titleRoom: 1, openingRoom: 3 },
  { slug: "demopac4", profiles: ["3.002.102"], titleRoom: 1 },
  { slug: "gr1", profiles: ["3.002.149"], titleRoom: 129 },
  { slug: "kq1", profiles: ["2.917"], titleRoom: 83 },
  { slug: "kq2", profiles: ["2.411"], titleRoom: 97 },
  { slug: "kq3", profiles: ["2.936"], titleRoom: 45 },
  { slug: "kq4", profiles: ["3.002.086"], titleRoom: 140 },
  { slug: "lsl1", profiles: ["2.440"], titleRoom: 1 },
  { slug: "mh1", profiles: ["3.002.102"], titleRoom: 153 },
  { slug: "mh2", profiles: ["3.002.149"], titleRoom: 153 },
  { slug: "mumg", profiles: ["2.917"], titleRoom: 96, openingRoom: 32, holdMovement: true },
  { slug: "pq1", profiles: ["2.936"], titleRoom: 1 },
  { slug: "sq1", profiles: ["2.917"], titleRoom: 67 },
  { slug: "sq2", profiles: ["2.936"], titleRoom: 140, openingRoom: 2 },
];

/** Catalog entry for one fixture. */
export function opening(slug: string): Opening {
  const entry = OPENINGS.find((game) => game.slug === slug);
  assert.ok(entry, `unknown opening fixture ${slug}`);
  return entry;
}

/** Full opening routes include their own title checks. */
export const TITLE_SCREENS = OPENINGS.filter((game) => game.openingRoom === undefined);
export const OPENING_ROUTES = OPENINGS.filter((game) => game.openingRoom !== undefined);

/** Cold-boot routes through the introductions, followed by a player-controlled step. */
export function openingRoute(slug: string): Speedrun {
  const { profiles, titleRoom, openingRoom } = opening(slug);
  assert.ok(openingRoom !== undefined, `${slug}: no opening movement route`);
  const run = new Speedrun(slug, 1);
  assert.ok(profiles.includes(run.engine.profile.id), `${slug}: supported interpreter profile`);
  if (slug === "sq2" || slug === "mumg") run.answer("PLAYER");
  run.advance(120);
  run.checkpoint("Title", { room: titleRoom, score: 0 });
  run.key(slug === "mumg" ? AGI_KEY.SPACE : AGI_KEY.ENTER);
  run.advance(120);
  run.dismiss();
  if (slug !== "bc") {
    run.key(13);
    run.advance(120);
    run.dismiss();
  }
  run.wait(() => run.state().room === openingRoom, "opening scene");
  // Parser availability cannot identify control in games that use only keys.
  if (slug === "mumg")
    run.wait(() => run.engine.flags[115] === 0 && run.engine.flags[117] === 0, "arrival complete");
  if (slug === "sq2") run.wait(() => run.engine.inputEnabled, "janitor introduction complete");
  if (slug === "ddp") run.advance(120);
  run.dismiss();
  const label = slug === "ddp" ? "Difficulty selection" : "Player control";
  run.checkpoint(label, { room: openingRoom, score: 0 });
  const before = run.state();
  run.direction(slug === "ddp" ? 1 : 3);
  run.advance(slug === "ddp" ? 100 : 24);
  run.dismiss();
  assert.ok(
    slug === "ddp" ? run.state().y < before.y : run.state().x > before.x,
    "an arrow key moves the player",
  );
  run.direction(0);
  run.checkpoint(slug === "ddp" ? "Difficulty selection movement" : "Opening movement", {
    room: openingRoom,
    score: 0,
  });
  assert.ok(run.engine.getFrame().visual.some((pixel) => pixel !== 0));
  return run;
}
