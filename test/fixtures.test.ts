import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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

test("the KQ4 junk-directory exception excludes exactly four entries; any other missing volume still skips", (t) => {
  const dir = mkdtempSync(fixtureDir("fixture-kq4-junk-").slice(0, -1));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Synthetic KQ4DIR: logic 0 in volume 0; the four shipped junk entries
  // (picture 150/151 in volume 6, view 198/199 in volume 7); sound 0 in
  // volume 0 and sound 5 in volume 5, which is not junk and must still be
  // detected. Absent entries are exact ff ff ff (v3 rule).
  const section = (count: number, volumes: Record<number, number>): number[] => {
    const bytes: number[] = [];
    for (let n = 0; n < count; n++) {
      const volume = volumes[n];
      bytes.push(...(volume === undefined ? [255, 255, 255] : [volume << 4, 0, 0]));
    }
    return bytes;
  };
  const sections = [
    section(1, { 0: 0 }),
    section(152, { 150: 6, 151: 6 }),
    section(200, { 198: 7, 199: 7 }),
    section(6, { 0: 0, 5: 5 }),
  ];
  const header: number[] = [];
  let offset = 8;
  for (const entries of sections) {
    header.push(offset & 255, offset >> 8);
    offset += entries.length;
  }
  writeFileSync(join(dir, "KQ4DIR"), Uint8Array.of(...header, ...sections.flat()));
  const names = () => new Map(readdirSync(dir).map((name) => [name.toLowerCase(), name]));
  const missing = String(fixtureReadiness("kq4", `${dir}/`, names()));
  assert.match(missing, /KQ4VOL\.5/, "a non-junk missing volume is still detected");
  assert.doesNotMatch(missing, /KQ4VOL\.[67]/, "the four junk entries never gate readiness");
  for (const name of ["OBJECT", "WORDS.TOK", "KQ4VOL.0", "KQ4VOL.5"]) {
    writeFileSync(join(dir, name), new Uint8Array());
  }
  assert.equal(fixtureReadiness("kq4", `${dir}/`, names()), false);
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

test("MH2's unused sound tail exempts exact references only", (t) => {
  const dir = mkdtempSync(fixtureDir("fixture-mh2-tail-").slice(0, -1));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const soundStart = 11;
  const bytes = new Uint8Array(soundStart + 217 * 3).fill(255);
  bytes.set([8, 0, 11, 0, 11, 0, 11, 0, 0, 0, 0]);
  const reference = (id: number, volume: number, offset: number) => {
    bytes.set(
      [(volume << 4) | (offset >> 16), (offset >> 8) & 255, offset & 255],
      soundStart + id * 3,
    );
    writeFileSync(join(dir, "MH2DIR"), bytes);
  };
  for (const name of ["MH2DIR", "OBJECT", "WORDS.TOK", "MH2VOL.0"])
    writeFileSync(join(dir, name), new Uint8Array());
  const names = new Map(readdirSync(dir).map((name) => [name.toLowerCase(), name]));
  reference(215, 6, 79513);
  reference(216, 6, 79997);
  assert.equal(fixtureReadiness("mh2", `${dir}/`, names), false);
  assert.match(String(fixtureReadiness("different-game", `${dir}/`, names)), /MH2VOL\.6/);
  reference(214, 6, 79513);
  assert.match(
    String(fixtureReadiness("mh2", `${dir}/`, names)),
    /MH2VOL\.6/,
    "neighbor IDs remain required",
  );
  bytes.fill(255, soundStart + 214 * 3, soundStart + 215 * 3);
  reference(215, 6, 79514);
  assert.match(
    String(fixtureReadiness("mh2", `${dir}/`, names)),
    /MH2VOL\.6/,
    "changed offsets remain required",
  );
  reference(215, 5, 79513);
  assert.match(
    String(fixtureReadiness("mh2", `${dir}/`, names)),
    /MH2VOL\.5/,
    "changed volumes remain required",
  );
});
