#!/usr/bin/env node
/**
 * Standalone CLI Genesis Evaluation Runner.
 *
 * Runs the AGI Genesis world-authoring loop directly from the terminal against
 * OpenAI, Anthropic, or the offline deterministic stub, logging exact tool
 * arguments, byte lengths, and compiler diagnostics.
 *
 * Framework-free TypeScript, runs directly with Node >= 22.6:
 *   node --experimental-strip-types evals/genesis-cli.ts --template knights-trial --provider stub
 *   node --experimental-strip-types evals/genesis-cli.ts --template knights-trial --provider openai --model gpt-6-sol --live --budget-usd 5
 *
 * --effort overrides the production model default.
 * --max-turns N (default 100) guards a paid run against a loop that never
 * finishes; --trace and --out choose where the trace and game files go.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAnthropicConversation,
  createOpenAiConversation,
  LlmResponseError,
  type LlmTurnResult,
  type LlmUsage,
} from "../app/src/agent/llmClient.ts";
import { createAgentSessionState, type AgentToolResult } from "../src/agent/agentState.ts";
import { executeAgentTool, AGENT_TOOLS } from "../src/agent/tools.ts";
import { serializeAgentLog } from "../src/agent/toolTransport.ts";
import { validateGenesis } from "../src/agent/playtest.ts";
import { createGenesisPrompt } from "../src/agent/prompt.ts";
import { installBoilerplateSeed } from "../src/agent/baseTemplate.ts";
import {
  DEFAULT_MODELS,
  MODEL_CAPABILITIES,
  resolveModelEffort,
  type ModelEffort,
} from "../src/agent/modelEffort.ts";
import { assertLiveRun } from "./lib/live-guard.ts";
import { requestCost } from "./lib/usage.ts";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

interface TraceEntry {
  turn: number;
  type: string;
  payload: unknown;
  durationMs?: number;
}

function metrics(trace: TraceEntry[], elapsedMs: number, playtest: AgentToolResult) {
  const usage = { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 };
  const failedTurns = new Set<number>();
  let modelTurns = 0,
    repairTurns = 0,
    toolFailures = 0,
    modelLatencyMs = 0,
    toolLatencyMs = 0;
  for (const entry of trace) {
    if (entry.type === "model_output") {
      modelTurns++;
      if (failedTurns.has(entry.turn - 1)) repairTurns++;
      modelLatencyMs += entry.durationMs ?? 0;
      const data = (entry.payload as LlmTurnResult).usage;
      usage.input += data?.input ?? 0;
      usage.output += data?.output ?? 0;
      usage.cachedInput += data?.cachedInput ?? 0;
      usage.cacheWriteInput += data?.cacheWriteInput ?? 0;
    } else if (entry.type === "tool_execution") {
      toolLatencyMs += entry.durationMs ?? 0;
      if (!(entry.payload as { result: AgentToolResult }).result.success) {
        toolFailures++;
        failedTurns.add(entry.turn);
      }
    }
  }
  return {
    usage,
    modelTurns,
    repairTurns,
    toolFailures,
    modelLatencyMs,
    toolLatencyMs,
    elapsedMs,
    playtest: {
      success: playtest.success,
      simulation: playtest.details?.["simulation"] ?? "failed",
      ...(playtest.error ? { error: playtest.error } : {}),
    },
    repairDefinition:
      "A model response immediately following a turn with one or more failed tool calls.",
  };
}

// Genesis has no live game; the full catalog stays advertised anyway since
// read_room's live sections degrade cleanly without an attached game.
const GENESIS_TOOLS = AGENT_TOOLS;

interface CliArgs {
  template: string;
  provider: "openai" | "anthropic" | "stub";
  model: string;
  apiKey: string;
  effort?: ModelEffort;
  outDir?: string;
  tracePath: string;
  /** A runaway guard for a paid run, not a target: recorded Genesis runs took 15 to 37 turns. */
  maxTurns: number;
  /** The paid run's cap, charged per request at the model's rates; absent for the stub. */
  budgetUsd?: number;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = "true";
      }
    }
  }

  const template = options["template"] || "knights-trial";
  let provider = (options["provider"] as CliArgs["provider"]) || "stub";
  if (!options["provider"]) {
    if (process.env["OPENAI_API_KEY"]) provider = "openai";
    else if (process.env["ANTHROPIC_API_KEY"]) provider = "anthropic";
  }

  const apiKey =
    options["api-key"] ||
    (provider === "openai" ? process.env["OPENAI_API_KEY"] : process.env["ANTHROPIC_API_KEY"]) ||
    "";

  const model = options["model"] || (provider === "stub" ? "stub" : DEFAULT_MODELS[provider]);

  const outDir = options["out"];
  const tracePath = options["trace"] || "evals/last-genesis-trace.json";
  const maxTurns = Number(options["max-turns"] ?? 100);
  if (!Number.isInteger(maxTurns) || maxTurns < 1)
    throw new Error("--max-turns must be a positive integer.");

  let budgetUsd: number | undefined;
  if (provider !== "stub") {
    if (!MODEL_CAPABILITIES[model]?.price)
      throw new Error(`No price is known for ${model}, so --budget-usd could not be enforced.`);
    budgetUsd = assertLiveRun({
      live: options["live"] === "true",
      budgetUsd: options["budget-usd"] === undefined ? undefined : Number(options["budget-usd"]),
      plan: `genesis on ${template} with ${provider} ${model}`,
      offline: "--provider stub",
    });
  }

  return {
    template,
    provider,
    model,
    apiKey,
    ...(options["effort"] === undefined
      ? {}
      : {
          effort: resolveModelEffort(model, options["effort"] as ModelEffort, provider),
        }),
    ...(outDir === undefined ? {} : { outDir }),
    tracePath,
    maxTurns,
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
  };
}

/** Stop a paid run once its requests have cost the cap. */
function chargeBudget(args: CliArgs, spent: number, usage: LlmUsage) {
  const total = spent + (requestCost(args.model, usage) ?? 0);
  if (args.budgetUsd !== undefined && total >= args.budgetUsd)
    throw new Error(`Budget reached: $${total.toFixed(4)} of $${args.budgetUsd} spent.`);
  return total;
}

function loadTemplateText(nameOrPath: string): string {
  if (existsSync(nameOrPath)) {
    return readFileSync(nameOrPath, "utf-8");
  }
  const builtinPath = resolve(`games/${nameOrPath}/SKILL.md`);
  if (existsSync(builtinPath)) {
    return readFileSync(builtinPath, "utf-8");
  }
  throw new Error(`Template not found: ${nameOrPath} (tried ${builtinPath})`);
}

async function runCliGenesis(): Promise<void> {
  const args = parseCliArgs();
  console.log(`${ANSI.bold}${ANSI.cyan}=== AGI Genesis CLI Runner ===${ANSI.reset}`);
  console.log(`${ANSI.gray}Template:  ${ANSI.reset}${args.template}`);
  console.log(`${ANSI.gray}Provider:  ${ANSI.reset}${args.provider} (${args.model})`);

  const templateText = loadTemplateText(args.template);
  const session = createAgentSessionState();
  const trace: TraceEntry[] = [];
  const started = performance.now();
  let runError: string | undefined;

  if (args.provider === "stub") {
    console.log(`\n${ANSI.yellow}Running with offline deterministic stub...${ANSI.reset}`);
    // Write standard words
    executeAgentTool(session, "write_words", {
      words: [
        "look/examine",
        "take/get",
        "open",
        "door",
        "candle",
        "inventory",
        "north",
        "south",
        "east",
        "west",
      ],
    });
    // Write ego view
    executeAgentTool(session, "write_view", {
      num: 0,
      source: [
        "view",
        'description "Ego sprite"',
        "cel ego 4 4 0",
        ...new Array(4).fill("1111"),
        "endcel",
        "loop 0 ego",
        "loop 1 mirror 0",
        "endview",
      ].join("\n"),
    });
    // Write room 1 picture
    executeAgentTool(session, "write_picture", {
      room: 1,
      source: "vis 1\nline 0,0 159,167\nend\n",
    });
    // Write logic 0
    executeAgentTool(session, "write_logic", {
      room: 0,
      source: `
      if (!isset(f200)) {
        set(f200);
        assignn(v0, 1);
        new.room.v(v0);
      }
      call.v(v0);
      return;
      `,
    });
    // Write logic 1
    executeAgentTool(session, "write_logic", {
      room: 1,
      source: `
      #message 1 "Starting room."
      if (isset(f5)) {
        load.pic(v0);
        draw.pic(v0);
        show.pic();
        load.view(0); animate.obj(0); set.view(0,0); position(0,80,120); draw(0); accept.input();
        print(1);
      }
      return;
      `,
    });
    const finish = executeAgentTool(session, "finish", {
      notes: "Stub world genesis complete.",
    });
    if (!finish.success) {
      console.error(`${ANSI.red}Stub genesis failed: ${finish.error}${ANSI.reset}`);
      runError = finish.error ?? "Stub genesis failed.";
    } else console.log(`${ANSI.green}✔ Stub genesis completed successfully!${ANSI.reset}`);
  }

  if (args.provider !== "stub") {
    try {
      if (!args.apiKey) throw new Error(`Missing API key for ${args.provider}.`);
      // Install the same complete Boilerplate the app seeds before Genesis, then
      // describe THAT seed in the prompt — the offered tools must see what
      // the prompt claims, not a lookalike or a blank session. The offline
      // stub above keeps its own intentional direct-authoring fixture.
      const seed = installBoilerplateSeed(session);
      const genesisPrompt = createGenesisPrompt(templateText, seed);
      await runProviderGenesis(args, genesisPrompt, session, trace);
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      trace.push({ turn: 0, type: "run_error", payload: { error: runError } });
      console.error(`${ANSI.red}${runError}${ANSI.reset}`);
    }
  }
  const playtest = validateGenesis(session);
  const summary = metrics(trace, performance.now() - started, playtest);

  // Save trace
  try {
    const traceDir = resolve(args.tracePath, "..");
    if (!existsSync(traceDir)) mkdirSync(traceDir, { recursive: true });
    writeFileSync(
      args.tracePath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          template: args.template,
          provider: args.provider,
          model: args.model,
          genesisComplete: session.genesisComplete,
          ...(runError ? { error: runError } : {}),
          metrics: summary,
          trace,
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`${ANSI.gray}Trace written to: ${args.tracePath}${ANSI.reset}`);
  } catch (err) {
    console.error(`Failed to write trace: ${String(err)}`);
  }

  if (args.outDir) {
    const files = session.getFiles();
    mkdirSync(args.outDir, { recursive: true });
    for (const [filename, content] of files.entries()) {
      writeFileSync(join(args.outDir, filename), content);
    }
    console.log(`${ANSI.green}Saved ${files.size} game files to: ${args.outDir}${ANSI.reset}`);
  }

  console.log(`${ANSI.gray}Metrics: ${JSON.stringify(summary)}${ANSI.reset}`);
  if (!session.genesisComplete || runError || !playtest.success) {
    console.error(`\n${ANSI.red}${ANSI.bold}Genesis authoring failed to complete.${ANSI.reset}`);
    process.exit(1);
  } else {
    console.log(
      `\n${ANSI.green}${ANSI.bold}Genesis authoring finished successfully! All resources compiled.${ANSI.reset}`,
    );
  }
}

/** Run the CLI's authoring loop through the same conversation transport as the app. */
export async function runProviderGenesis(
  args: CliArgs,
  prompt: string,
  session: ReturnType<typeof createAgentSessionState>,
  trace: TraceEntry[],
): Promise<void> {
  const config = {
    provider: args.provider,
    apiKey: args.apiKey,
    model: args.model,
    ...(args.effort === undefined ? {} : { effort: args.effort }),
  };
  const conversation =
    args.provider === "anthropic"
      ? createAnthropicConversation(config)
      : createOpenAiConversation(config);
  let message: string | undefined = prompt;
  let spent = 0;
  let turn = 0;
  while (turn < args.maxTurns && !session.genesisComplete) {
    turn++;
    console.log(
      `\n${ANSI.bold}--- Turn ${turn} (${args.provider}: ${args.model}) ---${ANSI.reset}`,
    );
    const requestedAt = performance.now();
    const before = conversation.getTranscript().length;
    let response: LlmTurnResult;
    try {
      response =
        message === undefined
          ? await conversation.complete()
          : await conversation.sendUserMessage(message);
    } catch (error) {
      if (error instanceof LlmResponseError) {
        trace.push({
          turn,
          type: "model_output",
          payload: {
            usage: error.usage,
            telemetry: error.telemetry,
            error: error.message,
            transcript: conversation.getTranscript().slice(before),
          },
          durationMs: performance.now() - requestedAt,
        });
        chargeBudget(args, spent, error.usage);
      }
      throw error;
    }
    message = undefined;
    trace.push({
      turn,
      type: "model_output",
      payload: { ...response, transcript: conversation.getTranscript().slice(before) },
      durationMs: performance.now() - requestedAt,
    });
    spent = chargeBudget(
      args,
      spent,
      response.usage ?? {
        input: 0,
        output: 0,
        cachedInput: 0,
        cacheWriteInput: 0,
      },
    );
    if (response.text) console.log(`${ANSI.gray}${response.text}${ANSI.reset}`);
    if (response.toolCalls.length === 0) {
      console.log(`${ANSI.yellow}Model provided text without tool calls. Nudging...${ANSI.reset}`);
      message =
        "Genesis is not yet complete. Please call write_words, write_view, write_picture, write_logic, and finish.";
      continue;
    }
    const results = [];
    for (const tc of response.toolCalls) {
      console.log(`${ANSI.cyan}▶ [Tool Call] ${ANSI.bold}${tc.name}${ANSI.reset}`);
      const toolStarted = performance.now();
      const toolRes: AgentToolResult = session.genesisComplete
        ? { success: false, error: "Not executed: genesis was completed earlier in this response." }
        : GENESIS_TOOLS.some((tool) => tool.name === tc.name)
          ? executeAgentTool(session, tc.name, tc.input)
          : { success: false, error: `Tool ${tc.name} is unavailable during genesis.` };
      if (toolRes.success) {
        console.log(
          `  ${ANSI.green}✔ ${tc.name} succeeded${ANSI.reset} ${ANSI.gray}${JSON.stringify(toolRes.details || {})}${ANSI.reset}`,
        );
      } else {
        console.log(`  ${ANSI.red}✖ ${tc.name} failed: ${toolRes.error}${ANSI.reset}`);
        console.log(`  ${ANSI.gray}Args: ${JSON.stringify(tc.input, null, 2)}${ANSI.reset}`);
      }
      trace.push({
        turn,
        type: "tool_execution",
        durationMs: performance.now() - toolStarted,
        payload: JSON.parse(serializeAgentLog({ tool: tc.name, args: tc.input, result: toolRes })),
      });
      results.push({ toolCallId: tc.id, result: toolRes });
    }
    conversation.appendToolResults(results);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCliGenesis().catch((e) => {
    console.error("Fatal Genesis error:", e);
    process.exit(1);
  });
}
