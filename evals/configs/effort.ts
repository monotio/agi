/**
 * Production Genesis effort and prompt-size comparison.
 *
 * The default plan is one template, one repeat, four models and a bounded
 * lean/default -> lean/low sequence. Baseline and medium stages remain opt-in. Set
 * EVAL_EFFORT_STAGES, EVAL_EFFORT_CASES or EVAL_EFFORT_REPEATS to narrow or
 * expand a paid run. Promptfoo is kept at concurrency one because request
 * capture temporarily observes global fetch.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MODEL_IDS } from "./providers.ts";
import type { EffortProvider, EffortStage } from "../providers/genesis-session.ts";

const models: ReadonlyArray<readonly [EffortProvider, string]> = [
  ["openai", MODEL_IDS.gpt56Sol],
  ["openai", MODEL_IDS.gpt56Terra],
  ["anthropic", MODEL_IDS.claudeOpus5],
  ["anthropic", MODEL_IDS.claudeFable51],
];

const knownStages: Record<string, EffortStage> = {
  "baseline-default": { promptVariant: "baseline" },
  "lean-default": { promptVariant: "lean" },
  "lean-medium": { promptVariant: "lean", effort: "medium" },
  "lean-low": { promptVariant: "lean", effort: "low" },
  "baseline-medium": { promptVariant: "baseline", effort: "medium" },
  "baseline-low": { promptVariant: "baseline", effort: "low" },
};

function csv(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const stages = csv("EVAL_EFFORT_STAGES", "lean-default,lean-low").map((name) => {
  const stage = knownStages[name];
  if (!stage) throw new Error(`Unknown effort stage ${name}.`);
  return [name, stage] as const;
});
const cases = csv("EVAL_EFFORT_CASES", "knights-trial");
const laneFilters = csv("EVAL_EFFORT_LANES", "");
const repeats = Number(process.env["EVAL_EFFORT_REPEATS"] ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5)
  throw new Error("EVAL_EFFORT_REPEATS must be an integer from 1 to 5.");

interface EffortLane {
  id: string;
  label: string;
  config: Record<string, unknown>;
}

interface EffortTest {
  description: string;
  vars: { caseName: string; templateText: string; repeat: number };
}

const providers: EffortLane[] = [];
for (const [provider, model] of models) {
  const key =
    provider === "openai" ? process.env["OPENAI_API_KEY"] : process.env["ANTHROPIC_API_KEY"];
  if (!key) continue;
  for (const [stageName, stage] of stages) {
    const lane = `${provider}-${model}-${stageName}`;
    if (laneFilters.length && !laneFilters.includes(lane)) continue;
    providers.push({
      id: "file://../providers/genesis-session.ts",
      label: `genesis:${provider}:${model}:${stageName}`,
      config: {
        provider,
        model,
        lane,
        budgetUsd: Number(process.env["EVAL_EFFORT_RUN_BUDGET_USD"] ?? 1.25),
        timeoutMs: Number(process.env["EVAL_EFFORT_TIMEOUT_MS"] ?? 900000),
        ...stage,
      },
    });
  }
}
if (providers.length === 0)
  console.error("[evals] effort: no provider lanes; set OPENAI_API_KEY and/or ANTHROPIC_API_KEY");

const tests: EffortTest[] = [];
for (const caseName of cases) {
  const templateText = readFileSync(
    resolve(import.meta.dirname, `../../games/${caseName}/SKILL.md`),
    "utf8",
  );
  for (let repeat = 1; repeat <= repeats; repeat++)
    tests.push({
      description: `Genesis effort - ${caseName} repeat ${repeat}`,
      vars: { caseName, templateText, repeat },
    });
}

export default {
  description: "production AgentSession Genesis prompt and effort comparison",
  prompts: ["Run the production Genesis session for {{caseName}}."],
  providers,
  evaluateOptions: { maxConcurrency: 1 },
  defaultTest: {
    assert: [
      {
        type: "javascript",
        value: `const report = JSON.parse(output);
return {
  pass: report.completion === true && report.playtest?.success === true && report.firstResponseInputTokens > 0 && report.resources?.logic >= 2 && report.resources?.picture >= 1 && report.resources?.view >= 1,
  score: report.completion === true && report.playtest?.success === true ? 1 : 0,
  reason: report.completion === true ? "Production Genesis completed and boot validation passed." : (report.error ?? report.playtest?.error ?? "Genesis did not complete."),
};`,
      },
    ],
  },
  tests,
};
