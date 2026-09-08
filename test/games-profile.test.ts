import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { detectProfile, detectVersionString } from "../src/runtime/profile.ts";
import { fixtureDir, fixtureSkip } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";

/**
 * Optional profile-detection tests for the editions listed in EXPECTED.
 * Supply their resource files and interpreter binaries under games/<slug>/.
 * Detection reads the ASCII interpreter version from AGIDATA.OVL or AGI;
 * resource files alone select a container-family fallback.
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

describe("fixture interpreter profiles", () => {
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
