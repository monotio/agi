import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fixtureDir, fixtureSkip, hasFixture } from "./fixtures.ts";

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
