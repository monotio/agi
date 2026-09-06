/** Local-only deterministic walkthrough. Original game files are never exported. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtureDir, fixtureSkip } from "../test/fixtures.ts";
import { Speedrun } from "../test/speedrun/runner.ts";
import { firstHalf, beans } from "../test/speedrun/kq1-first.ts";
import { middle } from "../test/speedrun/kq1-middle.ts";
import { secondHalf } from "../test/speedrun/kq1-second.ts";

const missing = fixtureSkip("kq1", ["AGIDATA.OVL"]);
if (missing) {
  process.stdout.write(`SKIP: ${missing}\n`);
} else {
  const output = resolve(process.argv[2] ?? "/tmp/agi-kq1-speedrun.json");
  const started = performance.now();
  const run = new Speedrun("kq1", 1);
  const fixtureHashes: Record<string, string> = {};
  for (const name of readdirSync(fixtureDir("kq1")).sort()) {
    if (!/^(LOGDIR|PICDIR|VIEWDIR|SNDDIR|WORDS\.TOK|OBJECT|VOL\.\d+|AGIDATA\.OVL)$/.test(name))
      continue;
    fixtureHashes[name] = createHash("sha256")
      .update(readFileSync(fixtureDir("kq1") + name))
      .digest("hex");
  }
  let failure: string | null = null;
  try {
    run.advance(30);
    run.checkpoint("Title", { room: 83, score: 0 });
    run.key(13);
    run.advance(30);
    run.dismiss();
    run.checkpoint("Opening", { room: 1, score: 0 });
    firstHalf(run);
    middle(run);
    beans(run);
    secondHalf(run);
    assert.equal(run.state().room, 53, "Ending takes place in the throne room");
    assert.equal(run.engine.vars[74], 3, "All three royal treasures were recovered");
    assert.equal(run.engine.flags[195], 1, "The game's ending sequence actually completed");
    assert.equal(run.engine.screenObjects[0]!.view, 142, "Graham appears in his royal ending view");
    assert.equal(run.engine.inputEnabled, false, "The completed game has closed parser input");
    run.checkpoint("Completed", { room: 53, score: 159 });
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.exitCode = 1;
  }
  const elapsedMs = Math.round(performance.now() - started);
  const artifact = {
    schema: "monotio_agi.walkthrough.v1",
    game: "kq1",
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
