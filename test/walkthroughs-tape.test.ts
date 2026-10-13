import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  readWalkthroughArtifact,
  shippedTapePath,
  type WalkthroughArtifact,
} from "./speedrun/artifact.ts";
import { Speedrun } from "./speedrun/runner.ts";
import { assertTapeMatchesRun } from "./speedrun/tape.ts";
import {
  WALKTHROUGHS,
  runWalkthrough,
  shippedSpeedrun,
  walkthrough,
} from "./speedrun/walkthroughs.ts";

// The synthetic chamber is code-assembled, so these checks run without fixtures.
const route = walkthrough("synthetic");

/** A copy of the committed tape, changed by `edit`, read back from a temp directory. */
async function alteredTape(edit: (tape: WalkthroughArtifact) => void) {
  const dir = mkdtempSync(join(tmpdir(), "agi-tape-"));
  try {
    const tape = JSON.parse(
      readFileSync(shippedTapePath(route.alias), "utf8"),
    ) as WalkthroughArtifact;
    edit(tape);
    const path = join(dir, `${route.alias}.json`);
    writeFileSync(path, JSON.stringify(tape));
    return await readWalkthroughArtifact(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every catalog route has its own shipped-tape test file", () => {
  for (const entry of WALKTHROUGHS)
    assert.ok(
      existsSync(new URL(`walkthroughs-${entry.alias}.test.ts`, import.meta.url)),
      `test/walkthroughs-${entry.alias}.test.ts`,
    );
});

test("a shipped tape that no longer matches its route fails with the first differing input", async () => {
  const run = runWalkthrough(route, shippedSpeedrun(route));
  assertTapeMatchesRun(await alteredTape(() => {}), run);
  const index = run.actions.findIndex((action) => action.kind === "advance" && action.ticks > 1);
  const longer = await alteredTape((tape) => {
    const action = tape.actions[index]!;
    assert.equal(action.kind, "advance");
    action.ticks++;
  });
  assert.throws(
    () => assertTapeMatchesRun(longer, run),
    new RegExp(`differs from its route at action ${index} `),
  );
  const ending = await alteredTape((tape) => {
    (tape.finalState as { room: number }).room++;
  });
  assert.throws(() => assertTapeMatchesRun(ending, run), /ending state/);
  const duration = await alteredTape((tape) => {
    tape.virtualTicks++;
  });
  assert.throws(() => assertTapeMatchesRun(duration, run), /tape duration/);
});

test("a Node replay of a shipped tape reaches its recorded ending, answers included", async () => {
  const tape = await readWalkthroughArtifact(shippedTapePath(route.alias));
  assert.ok(tape.actions.some((action) => action.kind === "answer"));
  const replay = new Speedrun(route.hash, tape.seed, { rngVersion: 2 });
  replay.replay(tape.actions);
  assert.equal(replay.ticks, tape.virtualTicks);
  assert.deepEqual(replay.engine.readState(), tape.finalState);

  const moved = structuredClone(tape.actions);
  const checkpoint = moved.find((action) => action.kind === "checkpoint" && action.x > 0);
  assert.ok(checkpoint?.kind === "checkpoint");
  checkpoint.x++;
  assert.throws(
    () => new Speedrun(route.hash, tape.seed, { rngVersion: 2 }).replay(moved),
    new RegExp(`checkpoint "${checkpoint.label}"`),
  );
  const unanswered = tape.actions.filter((action) => action.kind !== "answer");
  assert.throws(
    () => new Speedrun(route.hash, tape.seed, { rngVersion: 2 }).replay(unanswered),
    /explicit prompt answer/,
  );
});
