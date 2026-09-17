import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { Speedrun, randomSource } from "./speedrun/runner.ts";
import { readWalkthroughArtifact, walkthroughServedRevisions } from "./speedrun/artifact.ts";
import { BUILTIN_GAME_BUILDERS } from "./game-fixture.ts";
import { walkthrough } from "./speedrun/walkthroughs.ts";

const TARGET_HASH = KNOWN_GAME_HASH.KQ1;

test("speedrun randomness has a stable seed contract", () => {
  // The interpreter's 16-bit stream (docs/fidelity.md, "Original RNG") —
  // bytes 50, 92, 122, 150 from state 1.
  const next = randomSource(1);
  assert.deepEqual(Array.from({ length: 4 }, next), [50, 92, 122, 150]);
});

test(
  "KQ1 speedrun builds death diagnostics only when Graham dies",
  { skip: fixtureSkip(TARGET_HASH, ["AGIDATA.OVL"]) },
  (t) => {
    const run = new Speedrun();
    const state = t.mock.method(run, "state");
    run.advance(30);
    assert.equal(state.mock.callCount(), 0, "successful ticks need no diagnostic snapshots");
    run.engine.flags[63] = 1;
    assert.throws(() => run.advance(), /Graham died: .*"room":83/);
    assert.equal(state.mock.callCount(), 1, "a death still includes its diagnostic snapshot");
  },
);

test(
  "KQ1 speedrun cold boots using inputs and rejects a false progress claim",
  {
    skip: fixtureSkip(TARGET_HASH, ["AGIDATA.OVL"]),
  },
  () => {
    const run = new Speedrun();
    run.advance(30);
    assert.equal(run.state().room, 83);
    run.key(13);
    run.advance(30);
    run.dismiss();
    run.checkpoint("Start", { room: 1, score: 0 });
    assert.equal(run.engine.profile.id, "2.917");
    assert.throws(() => run.checkpoint("False victory", { score: 159 }), /False victory/);
    assert.ok(run.ticks >= 60);
    assert.deepEqual(run.actions.slice(0, 3), [
      { kind: "advance", ticks: 30 },
      { kind: "key", code: 13 },
      { kind: "advance", ticks: 30 },
    ]);
  },
);

test(
  "Speedrun rejects ticks beyond its global ceiling",
  { skip: fixtureSkip(TARGET_HASH, ["AGIDATA.OVL"]) },
  () => {
    const run = new Speedrun(TARGET_HASH, 1, { maxTicks: 50 });
    run.advance(30);
    assert.throws(() => run.advance(25), /Speedrun tick ceiling exceeded \(55 > 50\)/);
  },
);

test(
  "Speedrun walkDirection, walkToUntil, and repeatUntil helpers navigate and terminate cleanly",
  { skip: fixtureSkip(TARGET_HASH, ["AGIDATA.OVL"]) },
  () => {
    const run = new Speedrun();
    run.advance(30);
    run.key(13);
    run.advance(30);
    run.dismiss();
    assert.equal(run.state().room, 1);

    // Test repeatUntil
    let count = 0;
    run.repeatUntil(
      () => {
        count++;
      },
      () => count >= 3,
      "test counter",
      10,
    );
    assert.equal(count, 3);

    // Test walkDirection with compass string
    const startX = run.state().x;
    run.walkDirection("E", () => run.state().x > startX + 5, "walk east a bit", 500);
    assert.ok(run.state().x > startX + 5);
    assert.equal(run.engine.screenObjects[0]?.direction, 0, "ego stopped after walkDirection");

    // Test walkToUntil
    const currentY = run.state().y;
    run.walkToUntil(
      run.state().x,
      currentY + 10,
      () => run.state().y >= currentY + 5,
      "walk south until y",
    );
    assert.ok(run.state().y >= currentY + 5);
    assert.equal(run.engine.screenObjects[0]?.direction, 0, "ego stopped after walkToUntil");

    // Test carried and assertCarried
    assert.equal(run.carried(1), false);
    assert.throws(() => run.assertCarried(1, "Test item"), /Test item \(item 1\) must be carried/);
  },
);

test("type() backspaces a diverged input row and retypes it, as a player would", () => {
  // A timed window can swallow a letter mid-word; stray keys stand in for that here.
  const run = new Speedrun(KNOWN_GAME_HASH.ADVENTURE_DEPARTMENT, 1);
  run.wait(() => run.state().room === 1 && run.engine.inputEnabled, "gallery", 300);
  for (const ch of "pant") run.key(ch.charCodeAt(0));
  run.advance(8);
  assert.equal(run.engine.inputEdit, "pant");
  run.type("paint mural");
  assert.equal(run.engine.inputEdit, "paint mural");
  const backspaces = run.actions.filter((a) => a.kind === "key" && a.code === 8).length;
  assert.equal(backspaces, 2, "only the diverged tail is erased");
});

test("every shipped walkthrough is a v2 artifact bound to its bundle revision", async () => {
  // Runs without fixtures: builtin targets resolve their served revision from
  // the builder; fixture targets still prove schema, binding field, and shape.
  const dir = "app/public/walkthroughs";
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  assert.ok(files.length > 0, "walkthrough artifacts ship with the app");
  for (const file of files) {
    const path = join(dir, file);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(raw["schema"], "monotio.agi.walkthrough.v1", `${file} schema`);
    const identity = raw["identity"] as Record<string, unknown> | undefined;
    assert.match(
      String(identity?.["revision"]),
      /^[0-9a-f]{64}$/i,
      `${file} declares the bundle revision it was recorded on`,
    );
    const project = String(identity?.["project"]);
    const hash = walkthrough(project).hash;
    if (BUILTIN_GAME_BUILDERS[hash] ?? BUILTIN_GAME_BUILDERS[project]) {
      const artifact = await readWalkthroughArtifact(path);
      const served = await walkthroughServedRevisions(hash);
      assert.equal(artifact.identity.revision, served[0], `${file} binds the served revision`);
    }
  }
});

test(
  "readWalkthroughArtifact binds the tape to the served bundle revision",
  { skip: fixtureSkip(KNOWN_GAME_HASH.KQ1, ["AGIDATA.OVL"]) },
  async () => {
    const kq1Artifact = await readWalkthroughArtifact("app/public/walkthroughs/kq1.json");
    assert.equal(kq1Artifact.identity.project, "kq1");
    const served = await walkthroughServedRevisions(KNOWN_GAME_HASH.KQ1);
    assert.equal(kq1Artifact.identity.revision, served[0]);
    assert.ok(kq1Artifact.supportedRevisions?.includes(served[0]!));

    const tempPath = join(tmpdir(), `agi-test-binding-${Date.now()}.json`);
    try {
      // Mismatch identity revision
      const badTarget = {
        ...kq1Artifact,
        identity: { ...kq1Artifact.identity, revision: KNOWN_GAME_HASH.SQ1 },
      };
      writeFileSync(tempPath, JSON.stringify(badTarget));
      await assert.rejects(
        () => readWalkthroughArtifact(tempPath),
        /identity revision matches the served bundle/,
      );

      // Mismatch supportedRevisions
      const badSupported = {
        ...kq1Artifact,
        supportedRevisions: [KNOWN_GAME_HASH.SQ1],
      };
      writeFileSync(tempPath, JSON.stringify(badSupported));
      await assert.rejects(
        () => readWalkthroughArtifact(tempPath),
        /served bundle revision included in supported revisions/,
      );
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // ignore
      }
    }
  },
);
