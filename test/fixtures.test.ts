import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadGame } from "./game-fixture.ts";
import { createHash } from "node:crypto";
import {
  clearFixtureCache,
  combinedDirectory,
  findFixture,
  fixtureDir,
  fixtureReadiness,
  fixtureSkip,
  hasFixture,
} from "./fixtures.ts";

test("missing fixtures report the installation folder instead of passing silently", () => {
  const target = "missing-fixture-test";
  assert.equal(hasFixture(target), false);
  assert.match(
    String(fixtureSkip(target)),
    /Place your own game files in games\/missing-fixture-test\//,
  );
});

test("fixture readiness checks required files and every referenced volume", (t) => {
  const dir = mkdtempSync(fixtureDir("fixture-check-").slice(0, -1));
  const target = basename(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "LOGDIR"), Uint8Array.of(0x20, 0, 0));
  assert.equal(hasFixture(target), false, "a directory file alone is not a complete installation");
  assert.match(String(fixtureSkip(target)), /WORDS\.TOK/);
  for (const name of ["PICDIR", "VIEWDIR", "SNDDIR", "OBJECT", "WORDS.TOK", "VOL.0"]) {
    writeFileSync(join(dir, name), new Uint8Array());
  }
  assert.match(String(fixtureSkip(target)), /VOL\.2/);
  writeFileSync(join(dir, "VOL.2"), new Uint8Array());
  assert.equal(fixtureSkip(target), false);
  assert.equal(hasFixture(target), true);
  assert.match(String(fixtureSkip(target, ["AGIDATA.OVL"])), /AGIDATA\.OVL/);
});

test("a v3 combined installation is checked through its prefixed directory and volumes", (t) => {
  const dir = mkdtempSync(fixtureDir("fixture-v3-check-").slice(0, -1));
  const target = basename(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Sections at 8/11/14/17: logic 0 in volume 0, picture absent (exact ff ff ff),
  // view 0 in volume 1, sound 0 in volume 15 (a v2 reader would call it absent).
  writeFileSync(
    join(dir, "DMDIR"),
    Uint8Array.of(8, 0, 11, 0, 14, 0, 17, 0, 0, 0, 0, 255, 255, 255, 0x10, 0, 0, 0xf0, 0, 0),
  );
  assert.deepEqual(combinedDirectory(target), { name: "DMDIR", prefix: "DM" });
  assert.equal(combinedDirectory("missing-fixture-test"), null);
  assert.match(String(fixtureSkip(target)), /WORDS\.TOK.*DMVOL\.0.*DMVOL\.1.*DMVOL\.15/);
  assert.doesNotMatch(String(fixtureSkip(target)), /LOGDIR/);
  for (const name of ["OBJECT", "WORDS.TOK", "DMVOL.0", "DMVOL.1", "DMVOL.15"]) {
    writeFileSync(join(dir, name), new Uint8Array());
  }
  assert.equal(fixtureSkip(target), false);
});

test("partial fixture checks require metadata and explicit files while deferring volume checks", (t) => {
  const dir = mkdtempSync(fixtureDir("fixture-partial-").slice(0, -1));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Logic in volume 0; picture, view and sound in three additional volumes.
  writeFileSync(
    join(dir, "TESTDIR"),
    Uint8Array.of(8, 0, 11, 0, 14, 0, 17, 0, 0, 0, 0, 0x30, 0, 0, 0x50, 0, 0, 0x80, 0, 0),
  );
  for (const name of ["OBJECT", "TESTVOL.0"]) writeFileSync(join(dir, name), new Uint8Array());
  const names = () => new Map(readdirSync(dir).map((name) => [name.toLowerCase(), name]));
  const partial = { checkVolumes: false };
  assert.match(String(fixtureReadiness("example", `${dir}/`, names(), [], partial)), /WORDS\.TOK/);
  writeFileSync(join(dir, "WORDS.TOK"), new Uint8Array(52));
  assert.equal(fixtureReadiness("example", `${dir}/`, names(), [], partial), false);
  assert.match(String(fixtureReadiness("example", `${dir}/`, names(), ["AGI"], partial)), /AGI/);
  const complete = String(fixtureReadiness("example", `${dir}/`, names()));
  for (const volume of [3, 5, 8]) assert.ok(complete.includes(`TESTVOL.${volume}`));
  assert.throws(() => loadGame(basename(dir)), /TESTVOL\.3/);
  const { container } = loadGame(basename(dir), partial);
  assert.throws(() => container.getResource("picture", 0), /points to missing VOL/);
});

test("binary-only fixture requirements neither demand resources nor hide a missing named binary", (t) => {
  const dir = mkdtempSync(fixtureDir("fixture-binary-check-").slice(0, -1));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "agi"), new Uint8Array());
  const names = () => new Map(readdirSync(dir).map((name) => [name.toLowerCase(), name]));
  const options = { resourceFiles: false };
  const missing = String(
    fixtureReadiness("mh2", `${dir}/`, names(), ["AGI", "AGIDATA.OVL"], options),
  );
  assert.match(missing, /AGIDATA\.OVL/);
  assert.doesNotMatch(missing, /WORDS|VOL|LOGDIR/);
  writeFileSync(join(dir, "agidata.ovl"), new Uint8Array());
  assert.equal(fixtureReadiness("mh2", `${dir}/`, names(), ["AGI", "AGIDATA.OVL"], options), false);
  assert.match(
    String(fixtureReadiness("mh2", `${dir}/`, names())),
    /LOGDIR/,
    "normal game tests retain the complete census",
  );
  assert.throws(
    () => fixtureReadiness("mh2", `${dir}/`, names(), [], options),
    /named files/,
    "an empty dependency list cannot silently pass",
  );
});

test("fixtures resolve by content hash regardless of folder name, supporting fan and self-authored games", (t) => {
  const dir = mkdtempSync(fixtureDir("custom-fan-game-").slice(0, -1));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    clearFixtureCache();
  });
  // Write custom WORDS.TOK (26 2-byte offsets followed by word data)
  const wordsBytes = new Uint8Array(56);
  wordsBytes[0] = 0x12;
  wordsBytes[1] = 0x34;
  writeFileSync(join(dir, "WORDS.TOK"), wordsBytes);
  const targetHash = createHash("sha256").update(wordsBytes).digest("hex");

  clearFixtureCache();
  const found = findFixture(targetHash);
  assert.ok(found, "fixture found by content hash");
  assert.equal(found.wordsSha256, targetHash);
  assert.equal(found.dir, `${dir}/`);

  // Wrong hash must NOT match
  const wrongHash = createHash("sha256")
    .update(Uint8Array.of(1, 2, 3))
    .digest("hex");
  assert.equal(findFixture(wrongHash), null);
});

test("duplicate vocabulary editions remain separately resolvable by folder, while ambiguous hash queries require disambiguation", (t) => {
  const dirA = mkdtempSync(fixtureDir("edition-a-").slice(0, -1));
  const dirB = mkdtempSync(fixtureDir("edition-b-").slice(0, -1));
  const folderA = basename(dirA);
  const folderB = basename(dirB);

  t.after(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    clearFixtureCache();
  });

  // Shared WORDS.TOK bytes between both editions
  const wordsBytes = new Uint8Array(56);
  wordsBytes[0] = 0xaa;
  wordsBytes[1] = 0xbb;
  writeFileSync(join(dirA, "WORDS.TOK"), wordsBytes);
  writeFileSync(join(dirB, "WORDS.TOK"), wordsBytes);

  // Different logic/content or manifests
  writeFileSync(
    join(dirA, "GAME.JSON"),
    JSON.stringify({
      format: "monotio.agi",
      version: 1,
      title: "Edition Alpha",
      metadata: { author: "Author Alpha" },
    }),
  );
  writeFileSync(
    join(dirB, "GAME.JSON"),
    JSON.stringify({
      format: "monotio.agi",
      version: 1,
      title: "Edition Beta",
      metadata: { author: "Author Beta" },
    }),
  );

  const sharedHash = createHash("sha256").update(wordsBytes).digest("hex");

  clearFixtureCache();

  // 1. Each edition resolves unambiguously by its folder
  const fixtureA = findFixture(folderA);
  assert.ok(fixtureA);
  assert.equal(fixtureA.folder, folderA);
  assert.equal(fixtureA.title, "Edition Alpha");
  assert.equal(fixtureA.author, "Author Alpha");

  const fixtureB = findFixture(folderB);
  assert.ok(fixtureB);
  assert.equal(fixtureB.folder, folderB);
  assert.equal(fixtureB.title, "Edition Beta");
  assert.equal(fixtureB.author, "Author Beta");

  // 2. Querying by the ambiguous shared vocabulary hash throws an actionable disambiguation error
  assert.throws(
    () => findFixture(sharedHash),
    /Ambiguous fixture query.*specify the fixture folder/,
  );
});
