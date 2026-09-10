import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { inspectGame } from "../src/gameInspection.ts";
import { readdirSync, readFileSync } from "node:fs";
import { readGameFiles } from "../src/gameZip.ts";
import { fixtureSkip, fixtureDir, KNOWN_GAME_HASH } from "../../test/fixtures.ts";

test("preview stops at an unanswered modal and leaves source resources untouched", () => {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic('print("Hello! Press Enter to begin."); call(99); return;', {
      dictionary: new Map(),
    }).payload,
  );
  const files = Object.fromEntries(container.files);
  const before = structuredClone(files);
  const opening = inspectGame({ files, words: [] });
  assert.equal(opening.status, "needs-input");
  assert.ok(opening.rows.join(" ").includes("Hello!"));
  assert.deepEqual(files, before);
});

test("preview never invents an answer to a game's text prompt", () => {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic('get.string(s1, "What is your name?", 3, 0, 12); call(99); return;', {
      dictionary: new Map(),
    }).payload,
  );
  const opening = inspectGame({ files: Object.fromEntries(container.files), words: [] });
  assert.equal(opening.status, "needs-input");
  assert.ok(opening.rows.join(" ").includes("What is your name?"));
});

for (const [targetHash, gameId, profile] of [
  [KNOWN_GAME_HASH.KQ1, "kq1", "2.917"],
  [KNOWN_GAME_HASH.KQ2, "kq2", "2.411"],
  [KNOWN_GAME_HASH.KQ3, "kq3", "2.936"],
] as const) {
  test(
    `${gameId} opening preview renders local game bytes without authoring or player input`,
    { skip: fixtureSkip(targetHash, ["AGIDATA.OVL"]) },
    () => {
      const dir = fixtureDir(targetHash);
      const game = readGameFiles(
        new Map(
          readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => [entry.name, new Uint8Array(readFileSync(dir + entry.name))]),
        ),
      );
      const opening = inspectGame(game);
      assert.equal(opening.rgba.length, 320 * 200 * 4);
      assert.ok(
        new Set(opening.rgba).size > 2,
        "The opening has visible color, not a blank thumbnail.",
      );
      assert.equal(opening.profile, profile);
    },
  );
}
