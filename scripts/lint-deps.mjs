// `npm run lint:deps`: dependency-cruiser over src/ and app/ with the rules in
// .dependency-cruiser.mjs, reported by scripts/dependency-report.mjs. The
// installed dependency-cruiser loads a `plugin:` reporter with a bare
// `import()` of the text after the prefix, so the reporter is named by its
// file URL: that resolves from any working directory and survives spaces in
// the path. The CLI runs from an argument array with no shell in between, and
// its exit code (the reporter's error count) is this script's.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(
  new URL("../../bin/dependency-cruiser.mjs", import.meta.resolve("dependency-cruiser")),
);
const reporter = new URL("dependency-report.mjs", import.meta.url);

const run = spawnSync(
  process.execPath,
  [cli, "src", "app", "--output-type", `plugin:${reporter.href}`],
  { cwd: root, stdio: "inherit" },
);
if (run.error) throw run.error;
process.exit(run.status ?? 1);
