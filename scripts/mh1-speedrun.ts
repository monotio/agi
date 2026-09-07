/** Local-only deterministic Manhunter: New York Day 1 run. Original game files are never exported. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtureDir, fixtureSkip } from "../test/fixtures.ts";
import { Speedrun } from "../test/speedrun/runner.ts";
import { day1 } from "../test/speedrun/mh1-day1.ts";

const missing = fixtureSkip("mh1", ["AGIDATA.OVL"]);
if (missing) {
  process.stdout.write(`SKIP: ${missing}\n`);
} else {
  const output = resolve(process.argv[2] ?? "/tmp/agi-mh1-speedrun.json");
  const started = performance.now();
  const run = new Speedrun("mh1", 1);
  const fixtureHashes: Record<string, string> = {};
  for (const name of readdirSync(fixtureDir("mh1")).sort()) {
    if (!/^(MHDIR|MHVOL\.\d+|WORDS\.TOK|OBJECT|AGIDATA\.OVL)$/.test(name)) continue;
    fixtureHashes[name] = createHash("sha256")
      .update(readFileSync(fixtureDir("mh1") + name))
      .digest("hex");
  }
  let failure: string | null = null;
  try {
    day1(run);
    assert.equal(run.state().room, 104, "Day 1 ends at home");
    assert.equal(run.engine.vars[60], 2, "the day counter advanced to Day 2");
    const carried = run.engine
      .readState()
      .inventory.filter((item) => item.room === 255)
      .map((item) => item.name);
    assert.deepEqual(carried, ["Twelve Keycards", "Medallion", "MAD", "Data Card"]);
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.exitCode = 1;
  }
  const elapsedMs = Math.round(performance.now() - started);
  const artifact = {
    schema: "monotio_agi.walkthrough.v1",
    game: "mh1",
    profile: run.engine.profile.id,
    seed: run.seed,
    fixtureHashes,
    status: failure === null ? "completed" : "failed",
    failure,
    elapsedMs,
    virtualTicks: run.ticks,
    cycles: run.cycles,
    actions: run.actions,
    finalState: run.engine.readState(),
  };
  writeFileSync(output, JSON.stringify(artifact, null, 2) + "\n");
  process.stdout.write(
    `${artifact.status}: ${run.cycles} cycles, ${(run.ticks / 60).toFixed(1)} virtual seconds in ${elapsedMs}ms; ${output}\n`,
  );
  if (failure) process.stderr.write(failure + "\n");
}
