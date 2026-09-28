#!/usr/bin/env node
/**
 * Prompt-cache probe: how much of each provider request the previous one
 * already paid for.
 *
 *   npm run eval:cache -- --dry-run [--scenario remix-references,room-build,studio-assist,ask]
 *                                   [--shape anthropic,openai] [--out evals/results/cache]
 *   npm run eval:cache -- --provider anthropic|openai --live --budget-usd 3 [--model <id>]
 *                         [--effort low] [--scenario ask,studio-assist,remix-references] [--diagnostics]
 *
 * The dry run plays the scenarios in evals/lib/cache-scenarios.ts through the
 * production AgentSession and the real Anthropic and OpenAI clients with a
 * scripted model behind a mocked fetch: no key, no network, no spend. For
 * every consecutive request pair it reports the byte-identical prefix, where
 * the two diverge and why, and the share of the later request a warm cache
 * could serve. The stable-prefix floors in evals/tests/cache-prefix.test.ts
 * guard the result.
 *
 * A live run plays the same turns with a real model and is billed to the
 * key's account. It refuses to start without both --live and --budget-usd,
 * whatever keys the environment holds (evals/lib/live-guard.ts), or for a
 * model without a price in MODEL_CAPABILITIES; each scenario gets the remaining
 * allowance as its task budget, a run that pauses is cancelled and recorded,
 * and once the cap is spent the remaining scenarios are skipped. It reports
 * the provider's own cache reads, writes and hit rate per request beside the
 * client-side prefix analysis of the bodies it actually sent. The room build
 * is off by default: it is the longest and dearest scenario. --diagnostics
 * asks the provider to name where two requests diverged (Anthropic's
 * cache-diagnosis beta header and `diagnostics.previous_message_id`, OpenAI's
 * `prompt_cache_options.comparison_response_id`); the field may come back
 * unavailable, which the report records as is.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmConfig, LlmRequestTelemetry, LlmUsage } from "../app/src/agent/llmClient.ts";
import { DEFAULT_MODELS, MODEL_CAPABILITIES } from "../src/agent/modelEffort.ts";
import { analyseRequests, renderReports, type ScenarioReport } from "./lib/cache-prefix.ts";
import { probeScenario, scenarioSession, SCENARIOS } from "./lib/cache-scenarios.ts";
import { captureLive } from "./lib/live-capture.ts";
import { assertLiveRun } from "./lib/live-guard.ts";
import type { ScriptProvider } from "./lib/scripted-provider.ts";
import { requestCost } from "./lib/usage.ts";

/** Below this remaining allowance no further scenario starts. */
const MIN_RUN_USD = 0.01;
/** A scenario still going after this long is cancelled and recorded. */
const RUN_TIMEOUT_MS = 20 * 60_000;
/** The live default: the short tasks; the room build is opt-in. */
const LIVE_SCENARIOS = ["ask", "studio-assist", "remix-references"];

interface Args {
  dryRun: boolean;
  live: boolean;
  provider: ScriptProvider | "stub";
  model?: string;
  effort?: LlmConfig["effort"];
  budgetUsd?: number;
  diagnostics: boolean;
  scenarios: string[];
  shapes: ScriptProvider[];
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    live: false,
    provider: "stub",
    diagnostics: false,
    scenarios: [],
    shapes: ["anthropic", "openai"],
    out: "evals/results/cache",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (key === "--diagnostics") {
      args.diagnostics = true;
      continue;
    }
    if (key === "--live") {
      args.live = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${key} needs a value.`);
    if (key === "--scenario") args.scenarios = value.split(",");
    else if (key === "--shape") args.shapes = value.split(",") as ScriptProvider[];
    else if (key === "--provider") args.provider = value as Args["provider"];
    else if (key === "--model") args.model = value;
    else if (key === "--effort") args.effort = value as LlmConfig["effort"];
    else if (key === "--budget-usd") args.budgetUsd = Number(value);
    else if (key === "--out") args.out = value;
    else throw new Error(`Unknown option ${key}`);
  }
  if (args.dryRun) args.provider = "stub";
  if (args.provider === "stub" && !args.dryRun)
    throw new Error(
      "Use --dry-run for the offline probe or --provider anthropic|openai for a live run.",
    );
  if (args.provider !== "stub" && args.provider !== "anthropic" && args.provider !== "openai")
    throw new Error(`--provider takes anthropic or openai, not ${String(args.provider)}.`);
  if (!args.scenarios.length)
    args.scenarios = args.dryRun ? SCENARIOS.map((scenario) => scenario.id) : LIVE_SCENARIOS;
  for (const id of args.scenarios)
    if (!SCENARIOS.some((scenario) => scenario.id === id))
      throw new Error(`Unknown scenario ${id}; known: ${SCENARIOS.map((s) => s.id).join(", ")}.`);
  for (const shape of args.shapes)
    if (shape !== "anthropic" && shape !== "openai")
      throw new Error(`--shape takes anthropic and/or openai, not ${shape}.`);
  if (args.provider !== "stub") {
    const model = args.model ?? DEFAULT_MODELS[args.provider];
    if (!MODEL_CAPABILITIES[model]?.price)
      throw new Error(`No price is known for ${model}, so --budget-usd could not be enforced.`);
    args.budgetUsd = assertLiveRun({
      live: args.live,
      budgetUsd: args.budgetUsd,
      plan: `${args.scenarios.join(", ")} with ${args.provider} ${model}`,
      offline: "--dry-run",
    });
  }
  return args;
}

function liveConfig(args: Args, budgetUsd: number): LlmConfig {
  const provider = args.provider as ScriptProvider;
  const apiKey =
    provider === "openai"
      ? (process.env["OPENAI_API_KEY"] ?? "")
      : (process.env["ANTHROPIC_API_KEY"] ?? "");
  if (!apiKey)
    throw new Error(
      `Set ${provider === "openai" ? "OPENAI" : "ANTHROPIC"}_API_KEY for a live run.`,
    );
  return {
    provider,
    apiKey,
    model: args.model ?? DEFAULT_MODELS[provider],
    budgetUsd,
    ...(args.effort !== undefined ? { effort: args.effort } : {}),
  };
}

interface RequestRow {
  request: number;
  phase: string;
  usage: LlmUsage;
  hitShare: number | null;
  /** The share of this request the previous one's prompt covered, client-side. */
  expectedCacheable: number | null;
  costUsd: number | null;
  diagnostics: unknown;
}

interface LiveReport {
  scenario: string;
  rows: RequestRow[];
  totals: {
    input: number;
    cached: number;
    write: number;
    ordinary: number;
    hitShare: number | null;
  };
  costUsd: number;
  prefix: ScenarioReport;
  usageIncomplete: boolean;
  error?: string;
  wallMs: number;
}

async function runLive(
  args: Args,
  id: string,
  allowance: number,
  dir: string,
): Promise<LiveReport> {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id)!;
  const config = liveConfig(args, allowance);
  const provider = config.provider as ScriptProvider;
  const telemetry: { phase: string; telemetry: LlmRequestTelemetry }[] = [];
  let usageIncomplete = false;
  // The clients bind fetch when the session builds them: wrap it first.
  const captured = captureLive(provider, args.diagnostics);
  const session = scenarioSession(config, (kind, _message, data) => {
    const details = data as Record<string, unknown> | undefined;
    if (kind === "telemetry" && details?.["telemetry"]) {
      const entry = details["telemetry"] as LlmRequestTelemetry;
      telemetry.push({ phase: String(details["phase"]), telemetry: entry });
      if (entry.usageIncomplete) usageIncomplete = true;
    }
  });
  let paused = "";
  const monitor = setInterval(() => {
    const task = session.task.snapshot();
    if (task.status !== "paused") return;
    paused = task.reason;
    session.task.cancel();
  }, 20);
  const timeout = setTimeout(() => {
    paused = "timed out";
    session.task.cancel();
  }, RUN_TIMEOUT_MS);
  const t0 = performance.now();
  let error: string | undefined;
  try {
    for (const turn of scenario.turns) {
      console.log(`  ${id}: ${turn.label}`);
      await turn.run(session);
    }
  } catch (caught) {
    error = paused ? `paused: ${paused}` : String(caught);
  } finally {
    clearInterval(monitor);
    clearTimeout(timeout);
    captured.restore();
  }
  const prefix = analyseRequests(id, provider, captured.bodies);
  const rows: RequestRow[] = telemetry.map(({ phase, telemetry: entry }, index) => {
    const usage = entry.usage ?? { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 };
    const pair = prefix.pairs.find((candidate) => candidate.request === index + 1);
    return {
      request: index + 1,
      phase,
      usage,
      hitShare: entry.cacheHitShare ?? null,
      expectedCacheable: pair ? pair.cacheableShare : index === 0 ? 0 : null,
      costUsd: requestCost(config.model, usage),
      diagnostics: captured.diagnostics[index] ?? null,
    };
  });
  const totals = { input: 0, cached: 0, write: 0, ordinary: 0, hitShare: null as number | null };
  for (const row of rows) {
    totals.input += row.usage.input;
    totals.cached += row.usage.cachedInput;
    totals.write += row.usage.cacheWriteInput;
    totals.ordinary += row.usage.ordinaryInput ?? 0;
  }
  totals.hitShare = totals.input ? totals.cached / totals.input : null;
  writeFileSync(
    join(dir, `${id}.transcript.json`),
    JSON.stringify(session.getTranscript(), (_key, value: unknown) =>
      typeof value === "string" && value.length > 2000 ? `[${value.length} chars]` : value,
    ),
  );
  return {
    scenario: id,
    rows,
    totals,
    costUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
    prefix,
    usageIncomplete,
    ...(error !== undefined ? { error } : {}),
    wallMs: performance.now() - t0,
  };
}

const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

function renderLive(reports: readonly LiveReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(
      `\n### ${report.scenario}${report.error ? ` — ${report.error}` : ""}`,
      "",
      "| # | Phase | Input | Cache read | Cache write | Ordinary | Hit rate | Client-side cacheable | Cost |",
      "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const row of report.rows)
      lines.push(
        `| ${row.request} | ${row.phase} | ${row.usage.input} | ${row.usage.cachedInput} | ${row.usage.cacheWriteInput} | ${row.usage.ordinaryInput ?? "n/a"} | ${percent(row.hitShare)} | ${percent(row.expectedCacheable)} | ${row.costUsd === null ? "n/a" : `$${row.costUsd.toFixed(4)}`} |`,
      );
    lines.push(
      `| total | | ${report.totals.input} | ${report.totals.cached} | ${report.totals.write} | ${report.totals.ordinary} | ${percent(report.totals.hitShare)} | ${percent(report.prefix.meanCacheableShare)} | $${report.costUsd.toFixed(4)} |`,
    );
    const named = report.rows.filter((row) => row.diagnostics !== null);
    for (const row of named)
      lines.push(`\nrequest ${row.request} diagnostics: ${JSON.stringify(row.diagnostics)}`);
    if (report.usageIncomplete) lines.push("\nUsage incomplete: a request ended before its usage.");
  }
  lines.push("\n## Client-side prefix analysis of the bodies sent\n");
  lines.push(renderReports(reports.map((report) => report.prefix)));
  return lines.join("\n");
}

async function dryRun(args: Args): Promise<void> {
  const reports: ScenarioReport[] = [];
  const captured: Record<string, unknown> = {};
  for (const id of args.scenarios) {
    const scenario = SCENARIOS.find((candidate) => candidate.id === id)!;
    for (const shape of args.shapes) {
      const requests = await probeScenario(scenario, shape, DEFAULT_MODELS[shape]);
      const bodies = requests.map((request) => request.body);
      reports.push(analyseRequests(scenario.id, shape, bodies));
      captured[`${scenario.id}/${shape}`] = bodies;
    }
  }
  const markdown = renderReports(reports);
  console.log(markdown);
  mkdirSync(args.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(args.out, `${stamp}-dry-run.md`), `${markdown}\n`);
  writeFileSync(
    join(args.out, `${stamp}-dry-run.json`),
    JSON.stringify({ reports, requests: captured }, (_key, value: unknown) =>
      typeof value === "string" && value.length > 4000 ? `[${value.length} chars]` : value,
    ),
  );
  console.log(`\nReports written to ${args.out}/${stamp}-dry-run.{md,json}`);
}

async function liveRun(args: Args): Promise<void> {
  const cap = args.budgetUsd!;
  const model = args.model ?? DEFAULT_MODELS[args.provider as ScriptProvider];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(args.out, `${stamp}-${args.provider}-${model}`);
  mkdirSync(dir, { recursive: true });
  const reports: LiveReport[] = [];
  const skipped: { scenario: string; reason: string }[] = [];
  let spent = 0;
  for (const id of args.scenarios) {
    const remaining = cap - spent;
    if (remaining < MIN_RUN_USD) {
      skipped.push({ scenario: id, reason: `budget spent ($${spent.toFixed(4)} of $${cap})` });
      continue;
    }
    console.log(`${id} (allowance $${remaining.toFixed(2)})`);
    const report = await runLive(args, id, remaining, dir);
    spent += report.costUsd;
    reports.push(report);
    console.log(
      `  ${report.rows.length} requests, ${report.totals.input} input tokens, ` +
        `${percent(report.totals.hitShare)} cache reads, $${report.costUsd.toFixed(4)}` +
        (report.error ? ` — ${report.error}` : ""),
    );
  }
  const markdown = renderLive(reports);
  console.log(markdown);
  const summary = {
    provider: args.provider,
    model,
    effort: args.effort ?? null,
    budgetUsd: cap,
    diagnostics: args.diagnostics,
    reports,
    skipped,
    totals: {
      costUsd: spent,
      overshootUsd: Math.max(0, spent - cap),
      usageIncomplete: reports.some((report) => report.usageIncomplete),
    },
  };
  writeFileSync(join(dir, "report.md"), `${markdown}\n`);
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nReport: ${join(dir, "report.md")}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) await dryRun(args);
  else await liveRun(args);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
