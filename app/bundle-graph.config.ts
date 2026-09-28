import { join } from "node:path";

/**
 * Where `vite build` records the production chunk graph (vite.config.ts's
 * bundleGraph plugin) for scripts/check-bundle-budget.ts and the bundle
 * specs. It sits outside `dist`, so no deploy of `dist` — CI's or a hand
 * copy — can ship it, and under node_modules, which every tool and
 * `.gitignore` already leave alone.
 */
export const BUNDLE_GRAPH_PATH = join(
  import.meta.dirname,
  "node_modules",
  ".agi",
  "bundle-graph.json",
);
