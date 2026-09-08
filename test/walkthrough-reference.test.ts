import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import {
  fingerprintReference,
  prepareReference,
  queryReference,
  renderReference,
  runReferenceCli,
} from "../scripts/walkthrough-reference.ts";

function fixture(root: string): string {
  const game = join(root, "game");
  mkdirSync(game);
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic("get(0); draw.pic(v1); return;", { dictionary: new Map() }).payload,
  );
  container.putResource("picture", 1, Uint8Array.of(0xff));
  for (const [name, bytes] of container.files) writeFileSync(join(game, name.toLowerCase()), bytes);
  writeFileSync(join(game, "words.tok"), buildWordsTok([{ word: "look", id: 2 }]));
  writeFileSync(join(game, "object"), Uint8Array.of(3, 0, 0, 3, 0, 42, 107, 101, 121, 0));
  return game;
}

test("prepares static hooks separately from inventory and pictures; bounds queries and renders PNG", () => {
  const root = mkdtempSync(join(tmpdir(), "reference-test-"));
  try {
    const game = fixture(root);
    const output = join(root, "output");
    const result = prepareReference(game, output);
    assert.equal(result.cached, false);
    assert.deepEqual(queryReference(output, "inventory").hits, [{ id: 0, name: "key", room: 42 }]);
    assert.equal(queryReference(output, "inventory-hooks").matches, 1);
    assert.equal(queryReference(output, "pictures-hooks").matches, 1);
    assert.equal(queryReference(output, "pictures").matches, 1);
    assert.equal(queryReference(output, "dictionary", "LOOK").matches, 1);
    const png = readFileSync(renderReference(output, 1));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 960);
    assert.equal(png.readUInt32BE(20), 168);
    assert.throws(() => queryReference(output, "../object"), /category/);
    assert.throws(() => renderReference(output, 256), /0\.\.255/);
    assert.throws(() => runReferenceCli(["prepare", game]), /Usage/);
    assert.throws(() => runReferenceCli(["render", output, "1oops"]), /picture/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cache hashes fixture and source bytes, ignores unrelated files, and rejects overlap", () => {
  const root = mkdtempSync(join(tmpdir(), "reference-test-"));
  try {
    const game = fixture(root);
    const output = join(root, "output");
    const first = prepareReference(game, output);
    writeFileSync(join(game, "private-notes.txt"), "unrelated");
    assert.equal(prepareReference(game, output).cached, true);
    writeFileSync(
      join(game, "words.tok"),
      buildWordsTok(Array.from({ length: 40 }, (_, id) => ({ id: id + 1, word: `word${id}` }))),
    );
    const changed = prepareReference(game, output);
    assert.notEqual(changed.digest, first.digest);
    assert.equal(changed.cached, false);
    assert.equal(queryReference(output, "dictionary").shown, 30);
    assert.equal(queryReference(output, "dictionary").matches, 40);
    const files = new Map([["LOGDIR", Uint8Array.of(1)]]);
    assert.notEqual(
      fingerprintReference(files, new Map([["src/a.ts", "old"]])),
      fingerprintReference(files, new Map([["src/a.ts", "new"]])),
    );
    assert.throws(() => prepareReference(game, join(game, "cache")), /overlap/);
    assert.throws(() => prepareReference(game, root), /overlap/);
    assert.throws(() => prepareReference(game, game), /overlap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports unavailable indexed volumes and missing auxiliary resources explicitly", () => {
  const root = mkdtempSync(join(tmpdir(), "reference-test-"));
  try {
    const game = fixture(root);
    writeFileSync(join(game, "logdir"), Uint8Array.of(0x10, 0, 0));
    rmSync(join(game, "object"));
    const output = join(root, "output");
    prepareReference(game, output);
    const problems = queryReference(output, "problems");
    assert.match(JSON.stringify(problems.hits), /missing VOL\.1/);
    assert.match(JSON.stringify(problems.hits), /OBJECT/);
    assert.equal(queryReference(output, "pictures").matches, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
