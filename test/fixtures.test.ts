import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadGame } from "./game-fixture.ts";
import {
  combinedDirectory,
  fixtureDir,
  fixtureReadiness,
  fixtureSkip,
  hasFixture,
} from "./fixtures.ts";

test("missing fixtures report the installation folder instead of passing silently", () => {
  const slug = "missing-fixture-test";
  assert.equal(hasFixture(slug), false);
  assert.match(
    String(fixtureSkip(slug)),
    /Place your own game files in games\/missing-fixture-test\//,
  );
});

test("fixture readiness checks required files and every referenced volume", (t) => {
  const dir = mkdtempSync(fixtureDir("fixture-check-").slice(0, -1));
  const slug = basename(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "LOGDIR"), Uint8Array.of(0x20, 0, 0));
  assert.equal(hasFixture(slug), false, "a directory file alone is not a complete installation");
  assert.match(String(fixtureSkip(slug)), /WORDS\.TOK/);
  for (const name of ["PICDIR", "VIEWDIR", "SNDDIR", "OBJECT", "WORDS.TOK", "VOL.0"]) {
    writeFileSync(join(dir, name), new Uint8Array());
  }
  assert.match(String(fixtureSkip(slug)), /VOL\.2/);
  writeFileSync(join(dir, "VOL.2"), new Uint8Array());
  assert.equal(fixtureSkip(slug), false);
  assert.equal(hasFixture(slug), true);
  assert.match(String(fixtureSkip(slug, ["AGIDATA.OVL"])), /AGIDATA\.OVL/);
});

test("a v3 combined installation is checked through its prefixed directory and volumes", (t) => {
  const dir = mkdtempSync(fixtureDir("fixture-v3-check-").slice(0, -1));
  const slug = basename(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Sections at 8/11/14/17: logic 0 in volume 0, picture absent (exact ff ff ff),
  // view 0 in volume 1, sound 0 in volume 15 (a v2 reader would call it absent).
  writeFileSync(
    join(dir, "DMDIR"),
    Uint8Array.of(8, 0, 11, 0, 14, 0, 17, 0, 0, 0, 0, 255, 255, 255, 0x10, 0, 0, 0xf0, 0, 0),
  );
  assert.deepEqual(combinedDirectory(slug), { name: "DMDIR", prefix: "DM" });
  assert.equal(combinedDirectory("missing-fixture-test"), null);
  assert.match(String(fixtureSkip(slug)), /WORDS\.TOK.*DMVOL\.0.*DMVOL\.1.*DMVOL\.15/);
  assert.doesNotMatch(String(fixtureSkip(slug)), /LOGDIR/);
  for (const name of ["OBJECT", "WORDS.TOK", "DMVOL.0", "DMVOL.1", "DMVOL.15"]) {
    writeFileSync(join(dir, name), new Uint8Array());
  }
  assert.equal(fixtureSkip(slug), false);
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
