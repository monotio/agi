#!/usr/bin/env node
/**
 * Standalone CLI Genesis Evaluation Runner.
 *
 * Runs the AGI Genesis world-authoring loop directly from the terminal against
 * OpenAI, Anthropic, or the offline deterministic stub, logging exact tool
 * arguments, byte lengths, and compiler diagnostics.
 *
 * Framework-free TypeScript, runs directly with Node >= 22.6:
 *   node --experimental-strip-types scripts/eval-genesis.ts --template knights-trial --provider stub
 *   node --experimental-strip-types scripts/eval-genesis.ts --template knights-trial --provider openai --model gpt-5.6-sol
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  createAgentSessionState,
  executeAgentTool,
  AGENT_TOOLS,
  type AgentToolResult,
} from "../src/agent/tools.ts";
import {
  splitToolResult,
  openAiToolContent,
  anthropicToolDefinitions,
  anthropicToolResult,
  serializeAgentLog,
} from "../src/agent/toolTransport.ts";
import { validateGenesis } from "../src/agent/playtest.ts";
import { createGenesisPrompt, AGI_SYSTEM_PROMPT } from "../src/agent/prompt.ts";

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

function metrics(
  provider: CliArgs["provider"],
  trace: TraceEntry[],
  elapsedMs: number,
  playtest: AgentToolResult,
) {
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
      const data = (
        entry.payload as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
          };
        }
      ).usage;
      const cached =
        provider === "anthropic"
          ? (data?.cache_read_input_tokens ?? 0)
          : (data?.input_tokens_details?.cached_tokens ?? 0);
      const written =
        provider === "anthropic"
          ? (data?.cache_creation_input_tokens ?? 0)
          : (data?.input_tokens_details?.cache_write_tokens ?? 0);
      usage.input += (data?.input_tokens ?? 0) + (provider === "anthropic" ? cached + written : 0);
      usage.output += data?.output_tokens ?? 0;
      usage.cachedInput += cached;
      usage.cacheWriteInput += written;
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

const GENESIS_TOOLS = AGENT_TOOLS.filter(
  (tool) => !["read_frames", "read_objects", "read_state"].includes(tool.name),
);

interface CliArgs {
  template: string;
  provider: "openai" | "anthropic" | "stub";
  model: string;
  apiKey: string;
  outDir?: string;
  tracePath: string;
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

  const model =
    options["model"] ||
    (provider === "openai" ? "gpt-5.6-sol" : provider === "anthropic" ? "claude-opus-5" : "stub");

  const outDir = options["out"];
  const tracePath = options["trace"] || "evals/last-genesis-trace.json";

  return {
    template,
    provider,
    model,
    apiKey,
    ...(outDir === undefined ? {} : { outDir }),
    tracePath,
  };
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
      spec: {
        description: "Ego sprite",
        loops: [
          {
            cels: [
              {
                width: 4,
                height: 4,
                transparentColor: 0,
                mirror: false,
                pixels: new Array(16).fill(1),
              },
            ],
          },
          { mirrorLoop: 0 },
        ],
      },
    });
    // Write room 1 picture
    executeAgentTool(session, "write_picture", {
      room: 1,
      source: "vis 1\nline 0,0 159,167\nend\n",
    });
    // Write logic 0
    executeAgentTool(session, "write_logic_source", {
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
    executeAgentTool(session, "write_logic_source", {
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
    const finish = executeAgentTool(session, "handover", {
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
      const genesisPrompt = createGenesisPrompt(templateText);
      if (args.provider === "openai") await runOpenAiGenesis(args, genesisPrompt, session, trace);
      else await runAnthropicGenesis(args, genesisPrompt, session, trace);
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      trace.push({ turn: 0, type: "run_error", payload: { error: runError } });
      console.error(`${ANSI.red}${runError}${ANSI.reset}`);
    }
  }
  const playtest = validateGenesis(session);
  const summary = metrics(args.provider, trace, performance.now() - started, playtest);

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

async function runOpenAiGenesis(
  args: CliArgs,
  prompt: string,
  session: ReturnType<typeof createAgentSessionState>,
  trace: TraceEntry[],
): Promise<void> {
  const client = new OpenAI({
    apiKey: args.apiKey,
  });

  const tools: OpenAI.Responses.Tool[] = GENESIS_TOOLS.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: true,
  }));

  const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "user", content: prompt }];
  const sessionId = crypto.randomUUID();

  let turn = 0;
  const maxTurns = 20;

  while (turn < maxTurns && !session.genesisComplete) {
    turn++;
    console.log(`\n${ANSI.bold}--- Turn ${turn} (OpenAI: ${args.model}) ---${ANSI.reset}`);

    const requestedAt = performance.now();
    const response = await client.responses.create({
      model: args.model,
      instructions: AGI_SYSTEM_PROMPT,
      prompt_cache_key: `monotio_agi.eval.${sessionId}`,
      prompt_cache_options: {
        mode: "implicit",
        ttl: "30m",
      },
      tools,
      input,
      include: ["reasoning.encrypted_content"],
      store: false,
    });

    trace.push({
      turn,
      type: "model_output",
      payload: response,
      durationMs: performance.now() - requestedAt,
    });
    if (response.status && response.status !== "completed")
      throw new Error(
        response.incomplete_details?.reason === "max_output_tokens"
          ? "The model reached its output limit. Ask for a smaller change or fewer resources per turn."
          : `The model stopped before completing the turn (${response.incomplete_details?.reason ?? response.status}).`,
      );

    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    for (const item of response.output) {
      input.push(item as OpenAI.Responses.ResponseInputItem);

      if (item.type === "message" && item.role === "assistant") {
        for (const content of item.content) {
          if (content.type === "output_text") {
            console.log(`${ANSI.gray}${content.text}${ANSI.reset}`);
          }
        }
      } else if (item.type === "function_call") {
        let parsedInput: Record<string, unknown>;
        try {
          parsedInput = JSON.parse(item.arguments);
          if (!parsedInput || typeof parsedInput !== "object" || Array.isArray(parsedInput))
            throw new Error("expected an object");
        } catch {
          throw new Error(
            `The model returned invalid JSON arguments for ${item.name}. No tools from this response were executed.`,
          );
        }
        toolCalls.push({
          id: item.call_id,
          name: item.name,
          args: parsedInput,
        });
      }
    }

    if (toolCalls.length === 0) {
      console.log(`${ANSI.yellow}Model provided text without tool calls. Nudging...${ANSI.reset}`);
      input.push({
        role: "user",
        content:
          "Genesis is not yet complete. Please call write_words, write_view, write_picture, write_logic_source, and handover.",
      });
      continue;
    }

    for (const tc of toolCalls) {
      console.log(`${ANSI.cyan}▶ [Tool Call] ${ANSI.bold}${tc.name}${ANSI.reset}`);
      const toolStarted = performance.now();
      const toolRes: AgentToolResult = session.genesisComplete
        ? { success: false, error: "Not executed: genesis was completed earlier in this response." }
        : GENESIS_TOOLS.some((tool) => tool.name === tc.name)
          ? executeAgentTool(session, tc.name, tc.args)
          : { success: false, error: `Tool ${tc.name} is unavailable during genesis.` };
      if (toolRes.success) {
        console.log(
          `  ${ANSI.green}✔ ${tc.name} succeeded${ANSI.reset} ${ANSI.gray}${JSON.stringify(toolRes.details || {})}${ANSI.reset}`,
        );
      } else {
        console.log(`  ${ANSI.red}✖ ${tc.name} failed: ${toolRes.error}${ANSI.reset}`);
        console.log(`  ${ANSI.gray}Args: ${JSON.stringify(tc.args, null, 2)}${ANSI.reset}`);
      }
      trace.push({
        turn,
        type: "tool_execution",
        durationMs: performance.now() - toolStarted,
        payload: JSON.parse(serializeAgentLog({ tool: tc.name, args: tc.args, result: toolRes })),
      });

      input.push({
        type: "function_call_output",
        call_id: tc.id,
        output: openAiToolContent(splitToolResult(toolRes)),
      });
    }
  }
}

async function runAnthropicGenesis(
  args: CliArgs,
  prompt: string,
  session: ReturnType<typeof createAgentSessionState>,
  trace: TraceEntry[],
): Promise<void> {
  // Claude Opus 5 and Fable think by default and max_tokens caps thinking plus
  // tool arguments together; an explicit timeout keeps the non-streaming path.
  const client = new Anthropic({
    apiKey: args.apiKey,
    timeout: 600000,
  });

  const tools: Anthropic.Tool[] = anthropicToolDefinitions(GENESIS_TOOLS).map((tool, idx) => ({
    ...(tool as unknown as Anthropic.Tool),
    ...(idx === GENESIS_TOOLS.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }));

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

  let turn = 0;
  const maxTurns = 20;

  while (turn < maxTurns && !session.genesisComplete) {
    turn++;
    console.log(`\n${ANSI.bold}--- Turn ${turn} (Anthropic: ${args.model}) ---${ANSI.reset}`);

    const requestedAt = performance.now();
    const response = await client.messages.create({
      model: args.model,
      max_tokens: 32000,
      system: [{ type: "text", text: AGI_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages,
      tools,
    });

    trace.push({
      turn,
      type: "model_output",
      payload: response,
      durationMs: performance.now() - requestedAt,
    });
    if (
      response.stop_reason &&
      !["end_turn", "tool_use", "stop_sequence"].includes(response.stop_reason)
    )
      throw new Error(
        response.stop_reason === "max_tokens"
          ? "The model reached its output limit. Ask for a smaller change or fewer resources per turn."
          : `The model stopped before completing the turn (${response.stop_reason}).`,
      );
    messages.push({ role: "assistant", content: response.content });

    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    for (const c of response.content) {
      if (c.type === "tool_use") {
        if (!c.input || typeof c.input !== "object" || Array.isArray(c.input))
          throw new Error(`Invalid tool arguments for ${c.name}; expected an object.`);
        toolCalls.push({
          id: c.id,
          name: c.name,
          args: (c.input as Record<string, unknown>) || {},
        });
      } else if (c.type === "text") {
        console.log(`${ANSI.gray}${c.text}${ANSI.reset}`);
      }
    }

    if (toolCalls.length === 0) {
      console.log(`${ANSI.yellow}Model provided text without tool calls. Nudging...${ANSI.reset}`);
      messages.push({
        role: "user",
        content:
          "Genesis is not yet complete. Please call write_words, write_view, write_picture, write_logic_source, and handover.",
      });
      continue;
    }

    const toolResultsContent: Anthropic.ToolResultBlockParam[] = [];
    for (const tc of toolCalls) {
      console.log(`${ANSI.cyan}▶ [Tool Call] ${ANSI.bold}${tc.name}${ANSI.reset}`);
      const toolStarted = performance.now();
      const toolRes: AgentToolResult = session.genesisComplete
        ? { success: false, error: "Not executed: genesis was completed earlier in this response." }
        : GENESIS_TOOLS.some((tool) => tool.name === tc.name)
          ? executeAgentTool(session, tc.name, tc.args)
          : { success: false, error: `Tool ${tc.name} is unavailable during genesis.` };
      if (toolRes.success) {
        console.log(
          `  ${ANSI.green}✔ ${tc.name} succeeded${ANSI.reset} ${ANSI.gray}${JSON.stringify(toolRes.details || {})}${ANSI.reset}`,
        );
      } else {
        console.log(`  ${ANSI.red}✖ ${tc.name} failed: ${toolRes.error}${ANSI.reset}`);
        console.log(`  ${ANSI.gray}Args: ${JSON.stringify(tc.args, null, 2)}${ANSI.reset}`);
      }
      trace.push({
        turn,
        type: "tool_execution",
        durationMs: performance.now() - toolStarted,
        payload: JSON.parse(serializeAgentLog({ tool: tc.name, args: tc.args, result: toolRes })),
      });

      toolResultsContent.push(anthropicToolResult(tc.id, toolRes));
    }

    messages.push({ role: "user", content: toolResultsContent });
  }
}

runCliGenesis().catch((e) => {
  console.error("Fatal Genesis error:", e);
  process.exit(1);
});
