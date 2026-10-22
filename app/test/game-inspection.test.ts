import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { inspectGame } from "../src/library/gameInspection.ts";
import { readdirSync, readFileSync } from "node:fs";
import { readGameFiles } from "../src/archive/gameZip.ts";
import { fixtureSkip, fixtureDir, KNOWN_GAME_HASH } from "../../test/fixtures.ts";

test("preview stops at an unanswered modal and leaves source resources untouched", async () => {
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
  const opening = await inspectGame({ files, words: [] });
  assert.equal(opening.status, "needs-input");
  assert.ok(opening.rows.join(" ").includes("Hello!"));
  assert.deepEqual(files, before);
});

test("an Amiga opening shows its picture once the dissolve has finished", async () => {
  // docs/fidelity.md "Original picture dissolve": show.pic after draw.pic holds
  // the game for 801 ms on Amiga 2.202; the opening is the whole picture.
  const container = createContainer();
  container.putResource("picture", 0, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  container.putResource(
    "logic",
    0,
    assembleLogic(
      "if (!isset(f200)) { set(f200); load.pic(v0); draw.pic(v0); show.pic(); } return;",
      { dictionary: new Map() },
    ).payload,
  );
  const opening = await inspectGame({
    files: Object.fromEntries(container.files),
    words: [],
    profile: "amiga-2.202",
  });
  assert.equal(opening.status, "ready");
  // Amiga games start with the picture at the top (picture row 0 = screen line 0).
  const blue = Array.from(opening.rgba.subarray(0, 4));
  for (const [x, y] of [
    [319, 0],
    [160, 90],
    [0, 167],
    [319, 167],
  ])
    assert.deepEqual(
      Array.from(opening.rgba.subarray((y! * 320 + x!) * 4, (y! * 320 + x!) * 4 + 4)),
      blue,
      `picture colour at (${x}, ${y})`,
    );
  assert.notDeepEqual(blue, [0, 0, 0, 255], "the picture, not the black screen it dissolved from");
});

test("preview never invents an answer to a game's text prompt", async () => {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic('get.string(s1, "What is your name?", 3, 0, 12); call(99); return;', {
      dictionary: new Map(),
    }).payload,
  );
  const opening = await inspectGame({ files: Object.fromEntries(container.files), words: [] });
  assert.equal(opening.status, "needs-input");
  assert.ok(opening.rows.join(" ").includes("What is your name?"));
});

for (const [targetHash, alias, profile] of [
  [KNOWN_GAME_HASH.KQ1, "kq1", "2.917"],
  [KNOWN_GAME_HASH.KQ2, "kq2", "2.411"],
  [KNOWN_GAME_HASH.KQ3, "kq3", "2.936"],
] as const) {
  test(
    `${alias} opening preview renders local game bytes without authoring or player input`,
    { skip: fixtureSkip(targetHash, ["AGIDATA.OVL"]) },
    async () => {
      const dir = fixtureDir(targetHash);
      const game = readGameFiles(
        new Map(
          readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => [entry.name, new Uint8Array(readFileSync(dir + entry.name))]),
        ),
      );
      const opening = await inspectGame(game);
      assert.equal(opening.rgba.length, 320 * 200 * 4);
      assert.ok(
        new Set(opening.rgba).size > 2,
        "The opening has visible color, not a blank thumbnail.",
      );
      assert.equal(opening.profile, profile);
    },
  );
}
