// On-demand mutation report for the deterministic kernels — not part of
// `npm run check` (it takes minutes, not seconds). Run: `npm run mutation`
// or `npx stryker run --mutate "src/studio/assistScope.ts"` for one file.
// The command runner spawns `npm run mutation:test` (node:test with
// --experimental-strip-types) per mutant in a .stryker-tmp sandbox, so no
// per-test coverage mapping exists — hence coverageAnalysis "off".
export default {
  mutate: ["src/picture/**/*.ts", "src/studio/**/*.ts"],
  testRunner: "command",
  commandRunner: { command: "npm run mutation:test" },
  coverageAnalysis: "off",
  reporters: ["html", "json", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  incremental: true,
  incrementalFile: "reports/mutation/incremental.json",
  concurrency: 4,
  timeoutMS: 60000,
};
