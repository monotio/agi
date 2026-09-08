import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { auditFixtures } from "../scripts/audit-fixtures.ts";
import { createContainer } from "../src/container/container.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { buildWordsTok } from "../src/logic/words.ts";

function fixture(
  root: string,
  name: string,
  sound = Uint8Array.of(8, 0, 8, 0, 8, 0, 8, 0, 255, 255),
): string {
  const game = join(root, name);
  mkdirSync(game);
  const container = createContainer();
  container.putResource("logic", 0, buildLogicResource(Uint8Array.of(0), []));
  container.putResource("picture", 0, Uint8Array.of(255));
  container.putResource("sound", 0, sound);
  for (const [file, bytes] of container.files) writeFileSync(join(game, file.toLowerCase()), bytes);
  writeFileSync(join(game, "words.tok"), buildWordsTok([{ word: "look", id: 2 }]));
  writeFileSync(join(game, "object"), Uint8Array.of(3, 0, 0, 3, 0, 0, 63, 0));
  return game;
}

test("discovers immediate game directories deterministically and audits every resource family", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-fixtures-"));
  try {
    fixture(root, "zeta");
    fixture(root, "alpha");
    const notes = join(root, "notes");
    mkdirSync(notes);
    fixture(notes, "nested");
    const report = auditFixtures(root);
    assert.equal(report.scope, "static-resources");
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.games.map((game) => game.name),
      ["alpha", "zeta"],
    );
    assert.deepEqual(report.games[0]!.counts, { logic: 1, picture: 1, view: 0, sound: 1 });
    assert.equal(report.games[0]!.profile, "2.936");
    assert.equal(report.games[0]!.detectedVersion, null);
    assert.deepEqual(report.games[0]!.issues, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports strict sound errors and invalid inventory without suppressing other games", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-fixtures-"));
  try {
    fixture(root, "bad-offset", Uint8Array.of(255, 127, 8, 0, 8, 0, 8, 0, 255, 255));
    fixture(root, "truncated", Uint8Array.of(8, 0, 8, 0, 8, 0, 8, 0, 1, 0, 0));
    const invalid = fixture(root, "inventory");
    writeFileSync(join(invalid, "object"), Uint8Array.of(4, 0, 0, 4, 0, 0, 0, 63, 0));
    fixture(root, "valid");
    const report = auditFixtures(root);
    assert.equal(report.ok, false);
    for (const name of ["bad-offset", "truncated"])
      assert.ok(
        report.games
          .find((game) => game.name === name)!
          .issues.some(
            (issue) =>
              issue.kind === "sound" && issue.id === 0 && issue.category === "resource-error",
          ),
      );
    assert.ok(
      report.games
        .find((game) => game.name === "inventory")!
        .issues.some((issue) => issue.kind === "inventory" && issue.category === "resource-error"),
    );
    assert.deepEqual(report.games.find((game) => game.name === "valid")!.issues, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("separates unsupported profile instructions from resource lookup failures", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-fixtures-"));
  try {
    const unsupported = fixture(root, "profile");
    const container = createContainer();
    container.putResource("logic", 0, buildLogicResource(Uint8Array.of(0xa1, 0), []));
    for (const [file, bytes] of container.files)
      writeFileSync(join(unsupported, file.toLowerCase()), bytes);
    writeFileSync(join(unsupported, "agidata.ovl"), "Version 2.272");
    const missing = fixture(root, "missing");
    writeFileSync(join(missing, "logdir"), Uint8Array.of(0x10, 0, 0));
    const report = auditFixtures(root);
    assert.equal(report.ok, false);
    const profile = report.games.find((game) => game.name === "profile")!;
    assert.equal(profile.profile, "2.272");
    assert.equal(profile.detectedVersion, "2.272");
    assert.ok(
      profile.issues.some(
        (issue) =>
          issue.kind === "logic" &&
          issue.category === "unsupported-contract" &&
          /0xa1/.test(issue.message),
      ),
    );
    assert.ok(
      report.games
        .find((game) => game.name === "missing")!
        .issues.some(
          (issue) => issue.category === "resource-error" && /missing VOL\.1/.test(issue.message),
        ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI writes JSON, exits nonzero for findings, and refuses output in a fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-fixtures-"));
  try {
    const game = fixture(root, "sample");
    writeFileSync(join(game, "object"), Uint8Array.of(4, 0, 0));
    const output = join(root, "report.json");
    const script = fileURLToPath(new URL("../scripts/audit-fixtures.ts", import.meta.url));
    const run = spawnSync(process.execPath, ["--experimental-strip-types", script, root, output], {
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(readFileSync(output, "utf8")).ok, false);
    const before = readFileSync(join(game, "object"));
    const overwrite = spawnSync(
      process.execPath,
      ["--experimental-strip-types", script, root, join(game, "object")],
      { encoding: "utf8" },
    );
    assert.equal(overwrite.status, 1);
    assert.match(overwrite.stderr, /inside a fixture/);
    assert.deepEqual(readFileSync(join(game, "object")), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports unrecognized interpreter versions while preserving documented equivalents", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-fixtures-"));
  try {
    const unknown = fixture(root, "unknown");
    writeFileSync(join(unknown, "agidata.ovl"), "Version 2.999");
    const equivalent = fixture(root, "equivalent");
    writeFileSync(join(equivalent, "agidata.ovl"), "Version 2.915");
    const report = auditFixtures(root);
    assert.equal(report.ok, false);
    assert.ok(
      report.games
        .find((game) => game.name === "unknown")!
        .issues.some(
          (issue) => issue.kind === "profile" && issue.category === "unsupported-contract",
        ),
    );
    assert.deepEqual(report.games.find((game) => game.name === "equivalent")!.issues, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports image-only fixtures as unsupported without assigning a profile", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-fixtures-"));
  try {
    fixture(root, "resources");
    for (const extension of ["img", "IMA"]) {
      const folder = join(root, extension);
      mkdirSync(folder);
      writeFileSync(join(folder, `disk.${extension}`), Uint8Array.of(0, 1, 2, 3));
    }
    const report = auditFixtures(root);
    assert.equal(report.ok, false);
    assert.equal(report.games.length, 3);
    for (const name of ["img", "IMA"]) {
      const game = report.games.find((entry) => entry.name === name)!;
      assert.equal(game.profile, null);
      assert.equal(game.detectedVersion, null);
      assert.deepEqual(game.counts, { logic: 0, picture: 0, view: 0, sound: 0 });
      assert.equal(game.issues.length, 1);
      assert.equal(game.issues[0]!.category, "unsupported-contract");
      assert.equal(game.issues[0]!.kind, "file");
      assert.match(game.issues[0]!.message, /disk images.*not supported.*resource-file loader/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores dangling directory symlinks while auditing available fixtures", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-fixtures-"));
  try {
    fixture(root, "available");
    symlinkSync(join(root, "missing-target"), join(root, "dangling"), "dir");
    const report = auditFixtures(root);
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.games.map((game) => game.name),
      ["available"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
