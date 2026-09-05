import assert from "node:assert/strict";
import { test } from "node:test";
import { detectVersionString, detectProfile } from "../src/runtime/profile.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { readGameZip } from "../app/src/gameZip.ts";
import { buildZip } from "../app/src/zip.ts";

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

test("version discovery accepts a game-named loader without a title allowlist", () => {
  assert.equal(detectVersionString(new Map([["ADVENTURE.COM", ascii("Version 2.230")]])), "2.230");
  assert.equal(
    detectVersionString(
      new Map([
        ["ADVENTURE.COM", ascii("Version 2.230")],
        ["AGIDATA.OVL", ascii("Version 2.936")],
      ]),
    ),
    "2.936",
  );
});

test("ZIP import preserves generic version metadata for profile selection", async () => {
  const game = createContainer();
  game.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  const zip = buildZip([
    ...[...game.files].map(([name, data]) => ({ name, data })),
    { name: "WORDS.TOK", data: new Uint8Array(52) },
    { name: "ADVENTURE.COM", data: ascii("Version 2.230") },
  ]);
  const imported = await readGameZip(zip);
  assert.equal(detectProfile(new Map(Object.entries(imported.files))).id, "2.230");
});

test("ZIP import preserves directory tails beyond addressable resource entries", async () => {
  const game = createContainer();
  game.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  const files = new Map(game.files);
  files.set("LOGDIR", Uint8Array.from([...files.get("LOGDIR")!, 7, 8, 9, 10]));
  files.set("WORDS.TOK", new Uint8Array(52));
  const imported = await readGameZip(buildZip([...files].map(([name, data]) => ({ name, data }))));
  assert.deepEqual(imported.files["LOGDIR"], files.get("LOGDIR"));
});
