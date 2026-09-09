import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fixtureSkip } from "../test/fixtures.ts";

const SLUGS = ["kq1", "kq2", "sq1", "mh1"];

for (const slug of SLUGS) {
  const missing = fixtureSkip(slug, ["AGIDATA.OVL"]);
  if (missing) {
    process.stdout.write(`SKIP ${slug}: ${missing}\n`);
    continue;
  }
  const target = resolve(`app/public/walkthroughs/${slug}.json`);
  process.stdout.write(`Generating walkthrough artifact for ${slug} -> ${target}...\n`);
  execFileSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/walkthrough.ts", slug, target],
    { stdio: "inherit" },
  );
}
