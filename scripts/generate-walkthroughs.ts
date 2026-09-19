import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fixtureSkip } from "../test/fixtures.ts";
import { WALKTHROUGHS } from "../test/speedrun/walkthroughs.ts";

// Every catalog entry ships its tape; a missing fixture is an explicit skip.
const failed: string[] = [];
for (const route of WALKTHROUGHS) {
  const missing = fixtureSkip(route.hash, ["AGIDATA.OVL"], { checkVolumes: "shipped" });
  if (missing) {
    process.stdout.write(`SKIP ${route.alias}: ${missing}\n`);
    continue;
  }
  const target = resolve(`app/public/walkthroughs/${route.alias}.json`);
  process.stdout.write(`Generating walkthrough artifact for ${route.alias} -> ${target}...\n`);
  try {
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/walkthrough.ts", route.hash, target],
      { stdio: "inherit" },
    );
  } catch {
    // A failed route writes its own report; keep generating the others.
    failed.push(route.alias);
  }
}
if (failed.length > 0) {
  process.stderr.write(`Failed walkthroughs: ${failed.join(", ")}\n`);
  process.exitCode = 1;
}
