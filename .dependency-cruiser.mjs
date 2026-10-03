// Modules of the AI authoring stack that reach Studio kernels. The app loads
// the stack through one dynamic import (app/src/agent/authoringLoader.ts), and
// scripts/check-bundle-budget.ts fails a build that puts these on the Play
// boot path, so their static edges into src/studio never reach it.
const LAZY_AUTHORING_MODULES = "^src/agent/(studioAssistTools|pictureTools|referenceTools)\\.ts$";

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      // AGENTS.md, Architecture rules: no runtime import cycles in src/ or
      // app/src/. Only cycles where every edge is a runtime import are errors:
      // a cycle closed by an `import type` edge is erased at compile time and
      // carries no module-init-order risk.
      name: "no-circular",
      severity: "error",
      from: { path: "^(?:src|app/src)/" },
      to: {
        circular: true,
        viaOnly: { dependencyTypesNot: ["type-only"] },
      },
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
      // fails a build that puts it there. Type-only imports are erased at
      // build time and exempt. Helpers Play shares with the Studios live in
      // neutral modules (src/view, src/runtime, src/agent, app/src/world). The
      // lazy AI authoring stack (LAZY_AUTHORING_MODULES) is exempt as a source.
      name: "studio-reached-dynamically-only",
      severity: "error",
      from: {
        pathNot: [
          "^(?:app/src/studio/|src/studio/|test/|app/test/|app/e2e/|app/production/|evals/|games/|scripts/)",
          LAZY_AUTHORING_MODULES,
        ],
      },
      to: {
        path: "^(?:app/src/studio/|src/studio/)",
        dependencyTypesNot: ["dynamic-import", "type-only"],
      },
    },
  ],
  options: {
    // Generated builds and traces can disappear during a browser run.
    exclude: "^app/(?:dist|test-results)/",
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".js", ".mjs", ".cjs", ".vue", ".json"],
    },
  },
};
