// Modules in the known pre-existing value cycles — extracted dispatch and the
// worker context aggregate hand live objects back and forth. Splitting these
// is a refactor, not a mechanical fix, so `no-circular` reports them via the
// "legacy-circular" warning instead of erroring.
const LEGACY_CYCLE_MODULES =
  "^src/agent/(tools|authoringTools|roomTools)\\.ts$|^app/src/worker/(context|replay|historyView)\\.ts$";

// Modules of the AI authoring stack that reach Studio kernels. The app loads
// the stack through one dynamic import (app/src/agent/authoringLoader.ts), and
// scripts/check-bundle-budget.ts fails a build that puts these on the Play
// boot path, so their static edges into src/studio never reach it.
const LAZY_AUTHORING_MODULES = "^src/agent/(studioAssistTools|pictureTools)\\.ts$";

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      // AGENTS.md, Architecture rules: no runtime import cycles in src/ or
      // app/src/. Only cycles where every edge is a runtime import are errors: a cycle closed by an
      // `import type` edge is erased at compile time and carries no
      // module-init-order risk. The legacy clusters in LEGACY_CYCLE_MODULES
      // fall through to "legacy-circular" below; any other runtime cycle —
      // including a new one that merely passes through a legacy module — is
      // an error.
      name: "no-circular",
      severity: "error",
      from: { path: "^(?:src|app/src)/" },
      to: {
        circular: true,
        viaOnly: { dependencyTypesNot: ["type-only"] },
        via: { pathNot: LEGACY_CYCLE_MODULES },
      },
    },
    {
      name: "legacy-circular",
      severity: "warn",
      comment:
        "Pre-existing runtime import cycle inside a pinned module set — see LEGACY_CYCLE_MODULES.",
      from: { path: "^(?:src|app/src)/" },
      to: { circular: true, viaOnly: { path: LEGACY_CYCLE_MODULES } },
    },
    {
      // AGENTS.md, Architecture rules: app/ imports src/, never the reverse.
      name: "src-not-to-app",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^app/" },
    },
    {
      // AGENTS.md, Architecture rules: src/ runs in the browser, a Web Worker and Node with zero
      // runtime dependencies — no node:* core modules and no package imports;
      // platform access is injected. (Test/script folders live outside src/.)
      name: "src-no-platform-modules",
      severity: "error",
      from: { path: "^src/" },
      to: { dependencyTypes: ["core", "npm"] },
    },
    {
      // AGENTS.md, Architecture rules: Studio code (app/src/studio, src/studio)
      // stays off the Play boot path; the shell reaches it through dynamic
      // import() (defineAsyncComponent in App.vue), and `npm run check:bundle`
      // fails a build that puts it there. Type-only imports are
      // erased at build time and exempt. Warning for now: app/src/world/*,
      // app/src/worker/playHere.ts, app/src/route.worker.ts,
      // and app/src/resourceCommit.ts reach studio kernels statically,
      // pulling them into the Play/worker bundles; untangling is not small or
      // mechanical. The lazy AI authoring stack (LAZY_AUTHORING_MODULES) is
      // exempt as a source, and the walkable mask as a target: it is shared
      // with click-to-walk and boots with Play, as the bundle check allows.
      name: "studio-reached-dynamically-only",
      severity: "warn",
      from: {
        pathNot: [
          "^(?:app/src/studio/|src/studio/|test/|app/test/|app/e2e/|app/production/|evals/|games/|scripts/)",
          LAZY_AUTHORING_MODULES,
        ],
      },
      to: {
        path: "^(?:app/src/studio/|src/studio/)",
        pathNot: "^src/studio/walkable\\.ts$",
        dependencyTypesNot: ["dynamic-import", "type-only"],
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".js", ".mjs", ".cjs", ".vue", ".json"],
    },
  },
};
