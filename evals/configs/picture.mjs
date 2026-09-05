/**
 * Promptfoo Evaluation Lane: Picture fidelity leaderboard.
 *
 * Reuses scripts/eval-picture.ts through lib/picture-provider.mjs: one
 * promptfoo test per manifest entry, one provider per (vendor, model). The
 * score is the vision judge's overall 1..10 mapped to 0..1, gated by exact
 * metric floors (fill coverage, distinct colours) so a pretty-but-empty
 * picture cannot pass. Without any BYOK key the deterministic fake lane runs.
 *
 * Run from evals/: npx promptfoo eval -c configs/picture.mjs
 * Requires the local game fixtures (games/kq1, kq2, kq3).
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MODEL_IDS } from "./providers.mjs";

const RUNNER = pathToFileURL(resolve(import.meta.dirname, "../../scripts/eval-picture.ts")).href;

function lane(vendor, model) {
  return {
    id: "file://../lib/picture-provider.mjs",
    label: `picture:${vendor}:${model}`,
    config: { vendor, model },
  };
}

function providers() {
  const list = [];
  if (process.env.OPENAI_API_KEY) {
    list.push(lane("openai", MODEL_IDS.gpt56Sol), lane("openai", MODEL_IDS.gpt56Terra));
  } else console.error("[evals] picture: skipping OpenAI lanes (OPENAI_API_KEY not set)");
  if (process.env.ANTHROPIC_API_KEY) {
    list.push(lane("anthropic", MODEL_IDS.claudeOpus5));
  } else console.error("[evals] picture: skipping Anthropic lane (ANTHROPIC_API_KEY not set)");
  if (list.length === 0) list.push(lane("fake", "fake"));
  return list;
}

const { loadManifest } = await import(RUNNER);

export default {
  description: "agi-picture: recreate original room pictures from a brief via the picture DSL",
  prompts: ["{{entry}}"],
  providers: providers(),
  defaultTest: {
    assert: [{ type: "javascript", value: "file://../lib/asserts.mjs:validatePictureFidelity" }],
  },
  tests: loadManifest().map((entry) => ({
    description: `Picture fidelity - ${entry.id}`,
    vars: { entry: JSON.stringify(entry) },
  })),
};
