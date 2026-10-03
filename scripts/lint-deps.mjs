// `npm run lint:deps`: dependency-cruiser over src/ and app/ with the rules in
// .dependency-cruiser.mjs, then the Home static closure over that same graph. The
// installed dependency-cruiser loads a `plugin:` reporter with a bare
// `import()` of the text after the prefix, so the reporter is named by its
// file URL: that resolves from any working directory and survives spaces in
// the path. The CLI runs from an argument array with no shell in between, and
// its exit code (the reporter's error count) is this script's.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import report from "./dependency-report.mjs";
import { HOME_ENTRY, HOME_START, isHomeDeferredModule } from "./deferred-modules.mjs";

/**
 * @typedef {object} ImportModule
 * @property {string} source
 * @property {readonly {resolved: string, dependencyTypes: readonly string[], dynamic?: boolean}[]} dependencies
 */

/**
 * Dependency-cruiser's reachable rules include dynamic and type-only edges;
 * viaOnly filters cycles, not reachability. Walk its parsed/resolved graph
 * ourselves so an erased or action-triggered edge cuts off the entire tail.
 * Return one import path per deferred module, including the Home root.
 * @param {readonly ImportModule[]} modules
 * @returns {string[][]}
 */
export function homeBoundaryLeaks(modules) {
  const bySource = new Map(modules.map((module) => [module.source, module]));
  const roots = [HOME_ENTRY, ...HOME_START];
  for (const root of roots) {
    if (!bySource.has(root))
      throw new Error(`Home root is missing ${root}; its imports cannot be checked.`);
  }
  const pending = roots.map((root) => [root]);
  const seen = new Set();
  const leaks = [];
  for (let index = 0; index < pending.length; index++) {
    const path = pending[index];
    const source = path.at(-1);
    if (seen.has(source)) continue;
    seen.add(source);
    if (isHomeDeferredModule(source)) leaks.push(path);
    const module = bySource.get(source);
    // Packages are endpoints: dependency-cruiser's doNotFollow excludes their
    // internals. Their resolved paths still receive the deferred-module check.
    if (module === undefined) continue;
    for (const dependency of module.dependencies) {
      if (
        dependency.dynamic ||
        dependency.dependencyTypes.some((type) => type === "dynamic-import" || type === "type-only")
      )
        continue;
      pending.push([...path, dependency.resolved]);
    }
  }
  return leaks.sort((left, right) => {
    const a = left.join("/");
    const b = right.join("/");
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** @param {import('dependency-cruiser').ICruiseResult} result */
export default function reportDependencies(result) {
  const standard = report(result);
  const start = performance.now();
  let leaks;
  try {
    leaks = homeBoundaryLeaks(result.modules);
  } catch (error) {
    // The reporter API probes plugins with an empty graph before the real run.
    // Return a failed report for incomplete graphs, including that probe.
    return {
      output: `${standard.output}Home static boundary failed: ${String(error)}\n`,
      exitCode: standard.exitCode + 1,
    };
  }
  const duration = (performance.now() - start).toFixed(1);
  const verdict = `Home static boundary ${leaks.length === 0 ? "passed" : "failed"} (${duration} ms)`;
  const lines = leaks.map((path) => `  error home-reached-statically: ${path.join(" → ")}`);
  return {
    output: `${standard.output}${[...lines, verdict, ""].join("\n")}`,
    exitCode: standard.exitCode + leaks.length,
  };
}

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(
  new URL("../../bin/dependency-cruiser.mjs", import.meta.resolve("dependency-cruiser")),
);
const reporter = new URL(import.meta.url);

// The CLI imports this file as its reporter in the child; only direct invocation spawns it.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const run = spawnSync(
    process.execPath,
    [cli, "src", "app", "--output-type", `plugin:${reporter.href}`],
    { cwd: root, stdio: "inherit" },
  );
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}
