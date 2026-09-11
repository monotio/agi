import assert from "node:assert/strict";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { Speedrun } from "./runner.ts";

/**
 * The opening catalog: every documented fixture's expected interpreter
 * profile and the room its title or intro shows right after a cold boot.
 * The Node opening suite, the browser title smoke checks and the browser
 * route replays all consume these definitions.
 */
import { getKnownGameByAlias, resolveGameHash } from "../../src/games/knownGames.ts";

export interface Opening {
  readonly hash: string;
  readonly alias: string;
  /** Supported profiles selected from the supplied interpreter binary. */
  readonly profiles: readonly string[];
  /** First title or introductory room after a cold boot. */
  readonly titleRoom: number;
  /** Present when the suite has a route through player-controlled movement. */
  readonly openingRoom?: number | undefined;
}

interface OpeningDetails {
  readonly titleRoom: number;
  readonly openingRoom?: number | undefined;
  readonly profiles?: readonly string[] | undefined;
}

const OPENING_DETAILS: Record<string, OpeningDetails> = {
  "adventure-department": { titleRoom: 1, openingRoom: 1, profiles: ["2.936"] },
  bc: { titleRoom: 67, openingRoom: 8 },
  ddp: { titleRoom: 1, profiles: ["2.272", "2.440"] },
  demopac4: { titleRoom: 1 },
  gr1: { titleRoom: 129 },
  kq1: { titleRoom: 83 },
  kq2: { titleRoom: 97 },
  kq3: { titleRoom: 45 },
  kq4: { titleRoom: 140 },
  lsl1: { titleRoom: 1 },
  mh1: { titleRoom: 153 },
  mh2: { titleRoom: 153 },
  mumg: { titleRoom: 96, openingRoom: 32 },
  pq1: { titleRoom: 1, profiles: ["2.903", "2.936"] },
  sq1: { titleRoom: 67 },
  sq2: { titleRoom: 140, openingRoom: 2 },
  synthetic: { titleRoom: 1, openingRoom: 1, profiles: ["2.936"] },
};

export const OPENINGS: readonly Opening[] = Object.entries(OPENING_DETAILS).map(
  ([alias, details]) => {
    const known = getKnownGameByAlias(alias);
    if (!known) throw new Error(`Unknown opening fixture: ${alias}`);
    return {
      hash: known.wordsSha256,
      alias: known.alias,
      profiles: details.profiles ?? [known.profile],
      titleRoom: details.titleRoom,
      ...(details.openingRoom !== undefined ? { openingRoom: details.openingRoom } : {}),
    };
  },
);

/** Catalog entry for one fixture, resolved by content hash or alias. */
export function opening(hashOrAlias: string): Opening {
  const norm = hashOrAlias.toLowerCase();
  const resolved = resolveGameHash(norm) ?? norm;
  const entry = OPENINGS.find(
    (game) => game.hash.toLowerCase() === resolved || game.alias.toLowerCase() === norm,
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
  const { hash, alias, profiles, titleRoom, openingRoom } = entry;
  assert.ok(openingRoom !== undefined, `${alias}: no opening movement route`);
  const run = new Speedrun(hash, 1);
  assert.ok(profiles.includes(run.engine.profile.id), `${alias}: supported interpreter profile`);
  if (alias === "sq2" || alias === "mumg") run.answer("PLAYER");
  run.advance(120);
  run.checkpoint("Title", { room: titleRoom, score: 0 });
  run.key(alias === "mumg" ? AGI_KEY.SPACE : AGI_KEY.ENTER);
  run.advance(120);
  run.dismiss();
  if (alias !== "bc") {
    run.key(AGI_KEY.ENTER);
    run.advance(120);
    run.dismiss();
  }
  run.wait(() => run.state().room === openingRoom, "opening scene");
  // Parser availability cannot identify control in games that use only keys.
  if (alias === "mumg")
    run.wait(() => run.engine.flags[115] === 0 && run.engine.flags[117] === 0, "arrival complete");
  if (alias === "sq2") run.wait(() => run.engine.inputEnabled, "janitor introduction complete");
  if (alias === "ddp") run.advance(120);
  run.dismiss();
  const label = alias === "ddp" ? "Difficulty selection" : "Player control";
  run.checkpoint(label, { room: openingRoom, score: 0 });
  const before = run.state();
  run.direction(alias === "ddp" ? 1 : 3);
  run.advance(alias === "ddp" ? 100 : 24);
  run.dismiss();
  assert.ok(
    alias === "ddp" ? run.state().y < before.y : run.state().x > before.x,
    "an arrow key moves the player",
  );
  run.direction(0);
  run.checkpoint(alias === "ddp" ? "Difficulty selection movement" : "Opening movement", {
    room: openingRoom,
    score: 0,
  });
  assert.ok(run.engine.getFrame().visual.some((pixel) => pixel !== 0));
  return run;
}
