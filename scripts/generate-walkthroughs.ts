import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fixtureSkip, KNOWN_GAME_HASH } from "../test/fixtures.ts";
import { getKnownGameByHash } from "../src/games/knownGames.ts";

const TARGET_HASHES = [
  KNOWN_GAME_HASH.KQ1,
  KNOWN_GAME_HASH.KQ2,
  KNOWN_GAME_HASH.SQ1,
  KNOWN_GAME_HASH.MH1,
  KNOWN_GAME_HASH.SYNTHETIC,
];

for (const hash of TARGET_HASHES) {
  const missing = fixtureSkip(hash, ["AGIDATA.OVL"]);
  const known = getKnownGameByHash(hash);
  const alias = known?.alias ?? hash.slice(0, 8);
  if (missing) {
    process.stdout.write(`SKIP ${alias}: ${missing}\n`);
    continue;
  }
  const target = resolve(`app/public/walkthroughs/${alias}.json`);
  process.stdout.write(`Generating walkthrough artifact for ${alias} -> ${target}...\n`);
  execFileSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/walkthrough.ts", hash, target],
    { stdio: "inherit" },
  );
}
