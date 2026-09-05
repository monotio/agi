import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { detectProfile, detectVersionString } from "../src/runtime/profile.ts";
import { fixtureDir, fixtureSkip } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";

/**
 * Interpreter-profile detection against the local, gitignored authentic
 * fixtures (games/kq1, kq2, kq3 — never shipped, skipped when absent).
 *
 * The version string is not in the resource data: each installation carries it
 * as ASCII in AGIDATA.OVL ("Adventure Game Interpreter\n      Version 2.917"),
 * verified by hand on all three folders. KQ1 ships the 2.917 interpreter, KQ2
 * the 2.411 interpreter, and KQ3 the 2.936 interpreter — which is exactly the
 * profile split the spec records for the selected KQ1/KQ2/KQ3 data.
 */

const EXPECTED: readonly { slug: string; version: string; profile: string; maxAction: number }[] = [
  { slug: "kq1", version: "2.917", profile: "2.917", maxAction: 0xad },
  { slug: "kq2", version: "2.411", profile: "2.411", maxAction: 0xa9 },
  { slug: "kq3", version: "2.936", profile: "2.936", maxAction: 0xaf },
];

/** The interpreter binary that carries the version string, if the fixture is present. */
function interpreterFiles(slug: string): Map<string, Uint8Array> {
  const dir = fixtureDir(slug);
  const files = new Map<string, Uint8Array>();
  for (const name of ["AGIDATA.OVL", "AGI", "SIERRA.COM", "KQ1.COM"]) {
    if (existsSync(dir + name)) files.set(name, new Uint8Array(readFileSync(dir + name)));
  }
  return files;
}

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

describe("installed game profiles", () => {
  for (const game of EXPECTED) {
    test(
      `${game.slug} reports interpreter ${game.version}`,
      { skip: fixtureSkip(game.slug, ["AGIDATA.OVL"]) },
      () => {
        const files = interpreterFiles(game.slug);
        assert.equal(detectVersionString(files), game.version);
        const profile = detectProfile(files);
        assert.equal(profile.id, game.profile);
        assert.equal(profile.maxAction, game.maxAction);
      },
    );

    test(
      `${game.slug} boots on its detected profile`,
      { skip: fixtureSkip(game.slug, ["AGIDATA.OVL"]) },
      () => {
        // The container carries only the resource files, so detection from the
        // container alone falls back to the v2 default; the loader must pass the
        // interpreter binary alongside for the real profile to be selected.
        const { container, dict } = loadGame(game.slug);
        assert.equal(new Engine(container, new Host(), dict).profile.id, "2.936");
        const engine = new Engine(container, new Host(), dict, {
          profile: detectProfile(interpreterFiles(game.slug)),
        });
        assert.equal(engine.profile.id, game.profile);
        engine.tick();
        assert.equal(engine.strings.length, 12, "every detected profile is post-2.411");
      },
    );
  }
});
