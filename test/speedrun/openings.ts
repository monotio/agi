import assert from "node:assert/strict";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { Speedrun } from "./runner.ts";

/**
 * The opening catalog: every documented fixture's expected interpreter
 * profile and the room its title or intro shows right after a cold boot.
 * The Node opening suite, the browser title smoke checks and the browser
 * route replays all consume these definitions.
 */
import { KNOWN_GAME_HASH, resolveGameHash } from "../../src/games/knownGames.ts";

export interface Opening {
  readonly hash: string;
  readonly gameId: string;
  /** Supported profiles selected from the supplied interpreter binary. */
  readonly profiles: readonly string[];
  /** First title or introductory room after a cold boot. */
  readonly titleRoom: number;
  /** Present when the suite has a route through player-controlled movement. */
  readonly openingRoom?: number;
}

export const OPENINGS: readonly Opening[] = [
  { hash: KNOWN_GAME_HASH.BC, gameId: "bc", profiles: ["2.440"], titleRoom: 67, openingRoom: 8 },
  {
    hash: KNOWN_GAME_HASH.DDP,
    gameId: "ddp",
    profiles: ["2.272", "2.440"],
    titleRoom: 1,
  },
  { hash: KNOWN_GAME_HASH.DEMOPAC4, gameId: "demopac4", profiles: ["3.002.102"], titleRoom: 1 },
  { hash: KNOWN_GAME_HASH.GR1, gameId: "gr1", profiles: ["3.002.149"], titleRoom: 129 },
  { hash: KNOWN_GAME_HASH.KQ1, gameId: "kq1", profiles: ["2.917"], titleRoom: 83 },
  { hash: KNOWN_GAME_HASH.KQ2, gameId: "kq2", profiles: ["2.411"], titleRoom: 97 },
  { hash: KNOWN_GAME_HASH.KQ3, gameId: "kq3", profiles: ["2.936"], titleRoom: 45 },
  { hash: KNOWN_GAME_HASH.KQ4, gameId: "kq4", profiles: ["3.002.086"], titleRoom: 140 },
  { hash: KNOWN_GAME_HASH.LSL1, gameId: "lsl1", profiles: ["2.440"], titleRoom: 1 },
  { hash: KNOWN_GAME_HASH.MH1, gameId: "mh1", profiles: ["3.002.102"], titleRoom: 153 },
  { hash: KNOWN_GAME_HASH.MH2, gameId: "mh2", profiles: ["3.002.149"], titleRoom: 153 },
  {
    hash: KNOWN_GAME_HASH.MUMG,
    gameId: "mumg",
    profiles: ["2.917"],
    titleRoom: 96,
    openingRoom: 32,
  },
  { hash: KNOWN_GAME_HASH.PQ1, gameId: "pq1", profiles: ["2.936"], titleRoom: 1 },
  { hash: KNOWN_GAME_HASH.SQ1, gameId: "sq1", profiles: ["2.917"], titleRoom: 67 },
  { hash: KNOWN_GAME_HASH.SQ2, gameId: "sq2", profiles: ["2.936"], titleRoom: 140, openingRoom: 2 },
];

/** Catalog entry for one fixture, resolved by content hash or alias. */
export function opening(hashOrAlias: string): Opening {
  const norm = hashOrAlias.toLowerCase();
  const resolved = resolveGameHash(norm) ?? norm;
  const entry = OPENINGS.find(
    (game) => game.hash.toLowerCase() === resolved || game.gameId.toLowerCase() === norm,
  );
  assert.ok(entry, `unknown opening fixture ${hashOrAlias}`);
  return entry;
}

/** Full opening routes include their own title checks. */
export const TITLE_SCREENS = OPENINGS.filter((game) => game.openingRoom === undefined);
export const OPENING_ROUTES = OPENINGS.filter((game) => game.openingRoom !== undefined);

/** Cold-boot routes through the introductions, followed by a player-controlled step. */
export function openingRoute(hashOrAlias: string): Speedrun {
  const entry = opening(hashOrAlias);
  const { hash, gameId, profiles, titleRoom, openingRoom } = entry;
  assert.ok(openingRoom !== undefined, `${gameId}: no opening movement route`);
  const run = new Speedrun(hash, 1);
  assert.ok(profiles.includes(run.engine.profile.id), `${gameId}: supported interpreter profile`);
  if (gameId === "sq2" || gameId === "mumg") run.answer("PLAYER");
  run.advance(120);
  run.checkpoint("Title", { room: titleRoom, score: 0 });
  run.key(gameId === "mumg" ? AGI_KEY.SPACE : AGI_KEY.ENTER);
  run.advance(120);
  run.dismiss();
  if (gameId !== "bc") {
    run.key(AGI_KEY.ENTER);
    run.advance(120);
    run.dismiss();
  }
  run.wait(() => run.state().room === openingRoom, "opening scene");
  // Parser availability cannot identify control in games that use only keys.
  if (gameId === "mumg")
    run.wait(() => run.engine.flags[115] === 0 && run.engine.flags[117] === 0, "arrival complete");
  if (gameId === "sq2") run.wait(() => run.engine.inputEnabled, "janitor introduction complete");
  if (gameId === "ddp") run.advance(120);
  run.dismiss();
  const label = gameId === "ddp" ? "Difficulty selection" : "Player control";
  run.checkpoint(label, { room: openingRoom, score: 0 });
  const before = run.state();
  run.direction(gameId === "ddp" ? 1 : 3);
  run.advance(gameId === "ddp" ? 100 : 24);
  run.dismiss();
  assert.ok(
    gameId === "ddp" ? run.state().y < before.y : run.state().x > before.x,
    "an arrow key moves the player",
  );
  run.direction(0);
  run.checkpoint(gameId === "ddp" ? "Difficulty selection movement" : "Opening movement", {
    room: openingRoom,
    score: 0,
  });
  assert.ok(run.engine.getFrame().visual.some((pixel) => pixel !== 0));
  return run;
}
