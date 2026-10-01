import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // Temporary (1.2 workspace integration): remove each entry when the file is mounted.
  ignore: [
    "app/e2e/fixtures/creativeDockReview.ts",
    "app/e2e/fixtures/studioFrameReview.ts",
    "app/e2e/fixtures/studioFrameTabsReview.ts",
    "app/src/studio/host/ProjectExplorer.vue",
    "app/src/studio/host/ProjectOverview.vue",
    "app/src/studio/host/ProjectTabs.vue",
  ],
  workspaces: {
    ".": {
      entry: [
        // node --test glob from the root `test` script.
        "test/*.test.ts",
        // Standalone capture tools run by hand; the reproduction commands are
        // documented in docs/media/README.md, not package.json.
        "scripts/benchmark-media.ts",
        "scripts/capture-feedback.ts",
        // Spawned as a shell string by app/playwright.production.config.ts
        // (webServer command), which knip cannot resolve as an import.
        "scripts/serve-production.ts",
        // Loaded by scripts/lint-deps.mjs as a `plugin:` reporter URL.
        "scripts/dependency-report.mjs",
      ],
      project: ["src/**/*.ts", "scripts/**/*.{ts,mjs}", "test/**/*.ts", "games/**/*.ts"],
      // The built-in command runner plugin resolves to this specifier inside
      // @stryker-mutator/core, not a separately installed package.
      ignoreDependencies: ["@stryker-mutator/command-runner"],
    },
    app: {
      entry: [
        // index.html is resolved by the Vite plugin; the extra harness/gallery
        // pages reference their module scripts by vite-root-absolute paths
        // (`/src/...`) that knip does not follow from html entry files.
        "src/ui/gallery.ts",
        "src/studio/harness.ts",
        "src/studio/sprite/harness.ts",
        // The default playwright.config.ts is auto-detected; the variant
        // configs (phone/capture/production/speedrun/media) are not.
        "playwright*.config.ts",
        // Documentation captures, matched by playwright.media.config.ts.
        "e2e/media/*.media.ts",
        // Loaded by the review spec through a Vite-root runtime URL.
        "e2e/fixtures/creativeGenerationReview.ts",
        "production/**/*.spec.ts",
        // node --test glob from the app `test:app` script.
        "test/*.test.ts",
      ],
      project: ["src/**/*.{ts,vue}", "e2e/**/*.ts", "test/**/*.ts", "production/**/*.ts"],
    },
    evals: {
      entry: [
        // promptfoo TS configs referenced by `npm --prefix evals run eval`.
        "configs/*.ts",
        "tests/**/*.test.ts",
        // Loaded by promptfoo through file:// ids inside evals/configs/*.ts —
        // runtime string references knip cannot see.
        "lib/asserts.ts",
        "lib/picture-provider.ts",
        "prompts/genesis.ts",
        "providers/genesis-session.ts",
      ],
      project: ["**/*.ts"],
      // promptfoo is invoked through `npm --prefix evals run eval`; the binary
      // and dependency are real, only invisible to static analysis.
      ignoreDependencies: ["promptfoo"],
      ignoreBinaries: ["promptfoo"],
    },
  },
};

export default config;
