import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectProfile, detectVersionString } from "../src/runtime/profile.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";

/**
 * Optional profile-detection tests for the editions listed in EXPECTED.
 * Detection reads the ASCII interpreter version from AGIDATA.OVL or AGI;
 * resource files alone select a container-family fallback.
 */

const EXPECTED: readonly {
  hash: string;
  gameId: string;
  version: string;
  profile: string;
  maxAction: number;
}[] = [
  { hash: KNOWN_GAME_HASH.KQ1, gameId: "kq1", version: "2.917", profile: "2.917", maxAction: 0xad },
  { hash: KNOWN_GAME_HASH.KQ2, gameId: "kq2", version: "2.411", profile: "2.411", maxAction: 0xa9 },
  { hash: KNOWN_GAME_HASH.KQ3, gameId: "kq3", version: "2.936", profile: "2.936", maxAction: 0xaf },
];

class Host implements EngineHost {
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return [];
  }
}

describe("fixture interpreter profiles", () => {
  for (const game of EXPECTED) {
    test(
      `${game.gameId} reports interpreter ${game.version}`,
      { skip: fixtureSkip(game.hash, ["AGIDATA.OVL"]) },
      () => {
        const { files } = loadGame(game.hash, { interpreterFiles: true });
        assert.equal(detectVersionString(files), game.version);
        const profile = detectProfile(files);
        assert.equal(profile.id, game.profile);
        assert.equal(profile.maxAction, game.maxAction);
      },
    );

    test(
      `${game.gameId} boots on its detected profile`,
      { skip: fixtureSkip(game.hash, ["AGIDATA.OVL"]) },
      () => {
        // The container carries only the resource files, so detection from the
        // container alone falls back to the v2 default; the loader must pass the
        // interpreter binary alongside for the real profile to be selected.
        const { container, dict } = loadGame(game.hash);
        assert.equal(new Engine(container, new Host(), dict).profile.id, "2.936");
        const { files } = loadGame(game.hash, { interpreterFiles: true });
        const engine = new Engine(container, new Host(), dict, {
          profile: detectProfile(files),
        });
        assert.equal(engine.profile.id, game.profile);
        engine.tick();
        assert.equal(engine.strings.length, 12, "every detected profile is post-2.411");
      },
    );
  }
});
