/**
 * Promptfoo provider that evaluates the production Genesis agent loop.
 *
 * The promptfoo prompt is deliberately ignored: AgentSession.startGenesis builds
 * the same user prompt and provider payload as the app. A fetch observer records
 * only the exact first JSON request body (never headers or credentials).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { AgentSession, type BootResources } from "../../app/src/agent/agentSession.ts";
import { validateGenesis } from "../../src/agent/playtest.ts";
import { RESOURCE_KINDS } from "../../src/types.ts";

import type { LlmConfig, LlmUsage } from "../../app/src/agent/llmClient.ts";
import type { AgentSessionState, AgentToolResult } from "../../src/agent/tools.ts";

export type EffortProvider = "openai" | "anthropic";
export interface EffortStage {
  promptVariant: "baseline" | "lean" | "current";
  effort?: LlmConfig["effort"];
}
export interface RequestTool {
  name: string;
  description?: string | undefined;
  parameters?: unknown;
  input_schema?: unknown;
  cache_control?: unknown;
  [key: string]: unknown;
}
export interface RequestMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}
/** Fields observed or rewritten in captured provider requests. Other fields survive unchanged. */
export interface ProviderBody {
  instructions?: unknown;
  system?: unknown;
  tools?: RequestTool[];
  input?: RequestMessage[] | string;
  messages?: RequestMessage[];
  reasoning?: { effort?: unknown };
  output_config?: { effort?: unknown };
  [key: string]: unknown;
}
interface PromptVariant {
  systemPrompt?: string;
  tools?: RequestTool[];
  userPrompt?: string;
  baselineRequestPath?: string;
}
export interface GenesisOptions {
  provider: EffortProvider;
  model: string;
  templateText: string;
  promptVariant?: EffortStage["promptVariant"];
  effort?: LlmConfig["effort"];
  lane?: string;
  caseName?: string;
  repeat?: number;
  outputRoot?: string;
  baselineRequestPath?: string;
  timeoutMs?: number;
  budgetUsd?: number;
  fetchImpl?: typeof fetch;
}

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
let fetchQueue = Promise.resolve();

function safeName(value: unknown) {
  return String(value ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export function bodyText(input: RequestInfo | URL, init?: RequestInit) {
  if (typeof init?.body === "string") return Promise.resolve(init.body);
  if (init?.body instanceof Uint8Array) return Promise.resolve(new TextDecoder().decode(init.body));
  if (typeof Request !== "undefined" && input instanceof Request) return input.clone().text();
  throw new Error("The provider request body could not be captured as JSON text.");
}

function textOf(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function promptSectionEstimates(body: ProviderBody, provider: EffortProvider) {
  const system =
    provider === "openai"
      ? textOf(body.instructions)
      : textOf(
          Array.isArray(body.system)
            ? body.system.map((part: { text?: unknown } | null) => part?.text ?? "")
            : body.system,
        );
  const user = provider === "openai" ? textOf(body.input) : textOf(body.messages);
  const tools = textOf(body.tools);
  const section = (text: string) => ({
    characters: text.length,
    estimatedTokens: Math.ceil(text.length / 4),
  });
  return {
    method: "characters/4 estimate; firstResponseInputTokens is the provider-reported exact count",
    system: section(system),
    userAndHistory: section(user),
    tools: section(tools),
  };
}

function resourceCounts(state: AgentSessionState) {
  return Object.fromEntries(
    RESOURCE_KINDS.map((kind) => {
      let count = 0;
      for (let num = 0; num <= 255; num++) if (state.container.getResource(kind, num)) count++;
      return [kind, count];
    }),
  );
}

function summarizedPlaytest(result: AgentToolResult) {
  return {
    success: result.success,
    simulation: result.details?.["simulation"] ?? "failed",
    cycles: result.details?.["cycles"] ?? 0,
    room: (result.details?.["state"] as { room?: number } | undefined)?.room ?? null,
    ...(result.error ? { error: result.error } : {}),
  };
}

async function loadVariant(
  variant: EffortStage["promptVariant"],
  baselineRequestPath: string | undefined,
  templateText: string,
): Promise<PromptVariant> {
  if (variant === "current" || variant === "lean") return {};
  if (variant === "baseline") {
    const path = resolve(
      baselineRequestPath ??
        process.env["EVAL_EFFORT_BASELINE_REQUEST"] ??
        resolve(
          import.meta.dirname,
          "../results/effort/baseline-before-pruning/openai-gpt-5.6-sol-baseline-default--knights-trial--r1.first-request.json",
        ),
    );
    if (!existsSync(path))
      throw new Error(
        "Baseline request capture is missing. Set EVAL_EFFORT_BASELINE_REQUEST to the preserved first-request JSON.",
      );
    const body = JSON.parse(readFileSync(path, "utf8")) as ProviderBody;
    const capturedUser = Array.isArray(body.input)
      ? body.input.find((item) => item?.role === "user")?.content
      : undefined;
    if (
      typeof body.instructions !== "string" ||
      !Array.isArray(body.tools) ||
      typeof capturedUser !== "string"
    )
      throw new Error(
        "Baseline request must be an OpenAI startup body with instructions and tools.",
      );
    const templateMarker = capturedUser.indexOf("\n---\n");
    if (templateMarker < 0)
      throw new Error("Baseline request does not contain the captured Genesis template boundary.");
    return {
      systemPrompt: body.instructions,
      tools: structuredClone(body.tools),
      userPrompt: `${capturedUser.slice(0, templateMarker + "\n---\n".length)}${templateText.trim()}\n---`,
      baselineRequestPath: path,
    };
  }
  throw new Error(`Unknown prompt variant: ${variant}`);
}

export function applyBaselineOverride(
  body: ProviderBody,
  variant: PromptVariant,
  provider: EffortProvider,
): ProviderBody {
  if (!variant.tools) return body;
  if (!Array.isArray(body.tools)) throw new Error("Provider request omitted the production tools.");
  const capturedByName = new Map(variant.tools.map((tool) => [tool.name, tool]));
  const tools = body.tools.map((current) => {
    const captured = capturedByName.get(current.name);
    if (!captured)
      throw new Error(
        `Production Genesis tool ${current.name} is absent from the baseline catalog.`,
      );
    if (provider === "openai") return structuredClone(captured);
    return {
      ...current,
      description: captured.description,
      input_schema: structuredClone(captured.parameters),
    };
  });
  const replaceUser = (items: RequestMessage[]) =>
    items.map((item) =>
      item?.role === "user" &&
      typeof item.content === "string" &&
      item.content.startsWith("### GENESIS PHASE:")
        ? { ...item, content: variant.userPrompt }
        : item,
    );
  return {
    ...body,
    tools,
    ...(provider === "openai" && Array.isArray(body.input)
      ? { input: replaceUser(body.input) }
      : {}),
    ...(provider === "anthropic" && Array.isArray(body.messages)
      ? { messages: replaceUser(body.messages) }
      : {}),
  };
}

export function requestWithBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  body: string,
): [RequestInfo | URL, RequestInit | undefined] {
  if (init?.body !== undefined) return [input, { ...init, body }];
  if (typeof Request !== "undefined" && input instanceof Request)
    return [new Request(input, { body }), undefined];
  return [input, init];
}

function apiKey(provider: EffortProvider) {
  return provider === "openai"
    ? (process.env["OPENAI_API_KEY"] ?? "")
    : (process.env["ANTHROPIC_API_KEY"] ?? "");
}

function outputDirectory(options: GenesisOptions) {
  const root = resolve(
    options.outputRoot ??
      process.env["EVAL_EFFORT_OUTPUT"] ??
      resolve(import.meta.dirname, "../results/effort"),
  );
  const run = safeName(process.env["EVAL_EFFORT_RUN_ID"] ?? "latest");
  mkdirSync(resolve(root, run), { recursive: true });
  return resolve(root, run);
}

async function exclusiveFetch<T>(work: () => Promise<T>): Promise<T> {
  const previous = fetchQueue;
  let release!: () => void;
  fetchQueue = new Promise((resolveQueue) => {
    release = resolveQueue;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

export async function runGenesisSession(options: GenesisOptions) {
  const provider = options.provider;
  if (provider !== "openai" && provider !== "anthropic")
    throw new Error("Genesis effort evaluation requires provider openai or anthropic.");
  if (typeof options.fetchImpl !== "function" && !apiKey(provider))
    throw new Error(`Missing ${provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}.`);

  return exclusiveFetch(async () => {
    const lane = safeName(
      options.lane ??
        `${provider}-${options.model}-${options.promptVariant}-${options.effort ?? "default"}`,
    );
    const caseName = safeName(options.caseName ?? "case");
    const repeat =
      options.repeat !== undefined && Number.isInteger(options.repeat) && options.repeat > 0
        ? options.repeat
        : 1;
    const stem = `${lane}--${caseName}--r${repeat}`;
    const directory = outputDirectory(options);
    const requestPath = resolve(directory, `${stem}.first-request.json`);
    const reportPath = resolve(directory, `${stem}.report.json`);
    const framePath = resolve(directory, `${stem}.first-frame.png`);
    const transcriptPath = resolve(directory, `${stem}.transcript.json`);
    const eventsPath = resolve(directory, `${stem}.events.json`);
    const resourcesPath = resolve(directory, `${stem}.resources`);
    const delegate = options.fetchImpl ?? globalThis.fetch;
    const originalFetch = globalThis.fetch;
    const firstRequest: { text?: string; body?: ProviderBody } = {};
    const requestStarts = [];
    const requestLatenciesMs: number[] = [];
    const usageTurns: LlmUsage[] = [];
    let repairTurns = 0;
    let failureSinceUsage = false;
    let actionableFailureSinceUsage = false;
    let expectedExitSinceUsage = false;
    let actionableRepairTurns = 0;
    let expectedExitRepairTurns = 0;
    let toolFailures = 0;
    let actionableToolFailures = 0;
    let expectedExitDiagnostics = 0;
    let toolCalls = 0;
    let pendingToolStartedAt: number | undefined;
    let toolLatencyMs = 0;
    let session: AgentSession | undefined;
    const events: Array<{ elapsedMs: number; type: string; message: string; data: unknown }> = [];
    let runError: string | undefined;
    let cancellationReason: string | undefined;
    let bootResources: BootResources | undefined;
    const startedAtIso = new Date().toISOString();
    const startedAt = performance.now();

    let variant: PromptVariant = {};
    globalThis.fetch = async (input, init) => {
      const requestedAt = performance.now();
      requestStarts.push(requestedAt);
      const originalBodyText = await bodyText(input, init);
      const outgoingBody = applyBaselineOverride(
        JSON.parse(originalBodyText) as ProviderBody,
        variant,
        provider,
      );
      const outgoingText = variant.tools ? JSON.stringify(outgoingBody) : originalBodyText;
      if (firstRequest.text === undefined) {
        const text = outgoingText;
        if (Buffer.byteLength(text) > MAX_REQUEST_BYTES)
          throw new Error(`First provider request exceeds ${MAX_REQUEST_BYTES} bytes.`);
        firstRequest.body = outgoingBody;
        firstRequest.text = text;
        writeFileSync(requestPath, text, "utf8");
      }
      const [requestInput, requestInit] = requestWithBody(input, init, outgoingText);
      const response = await delegate(requestInput, requestInit);
      requestLatenciesMs.push(performance.now() - requestedAt);
      return response;
    };

    let monitor: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      variant = await loadVariant(
        options.promptVariant ?? "baseline",
        options.baselineRequestPath,
        options.templateText,
      );
      session = new AgentSession(
        {
          provider,
          apiKey: options.fetchImpl ? "test-placeholder" : apiKey(provider),
          model: options.model,
          ...(options.effort ? { effort: options.effort } : {}),
          ...(variant.systemPrompt ? { systemPrompt: variant.systemPrompt } : {}),
          budgetUsd: options.budgetUsd ?? 1.25,
        },
        (type, message, data) => {
          events.push({ elapsedMs: performance.now() - startedAt, type, message, data });
          const detail = data as { usage?: LlmUsage; result?: AgentToolResult } | undefined;
          if (message.startsWith("[Usage]") && detail?.usage) {
            usageTurns.push({ ...detail.usage });
            if (failureSinceUsage) repairTurns++;
            if (actionableFailureSinceUsage) actionableRepairTurns++;
            if (expectedExitSinceUsage) expectedExitRepairTurns++;
            failureSinceUsage = false;
            actionableFailureSinceUsage = false;
            expectedExitSinceUsage = false;
          }
          if (message.startsWith("[Genesis]") && type === "request") {
            toolCalls++;
            pendingToolStartedAt = performance.now();
          }
          if (message.startsWith("[Genesis]") && (type === "response" || type === "error")) {
            if (pendingToolStartedAt !== undefined)
              toolLatencyMs += performance.now() - pendingToolStartedAt;
            pendingToolStartedAt = undefined;
            if (type === "error") {
              toolFailures++;
              failureSinceUsage = true;
              if (detail?.result?.details?.["simulation"] === "needs_authoring") {
                expectedExitDiagnostics++;
                expectedExitSinceUsage = true;
              } else {
                actionableToolFailures++;
                actionableFailureSinceUsage = true;
              }
            }
          }
        },
      );
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      monitor = setInterval(() => {
        if (session?.task.snapshot().status === "paused") {
          cancellationReason = `Production agent paused: ${session.task.snapshot().reason}`;
          session.task.cancel();
        }
      }, 20);
      timer = setTimeout(() => {
        cancellationReason = `Evaluation timed out after ${timeoutMs} ms.`;
        session?.task.cancel();
      }, timeoutMs);
      try {
        bootResources = await session.startGenesis(options.templateText);
      } catch (error) {
        runError = cancellationReason ?? (error instanceof Error ? error.message : String(error));
      }
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    } finally {
      clearInterval(monitor);
      clearTimeout(timer);
      globalThis.fetch = originalFetch;
    }

    const playtest = session
      ? validateGenesis(session.state)
      : { success: false, error: runError ?? "Session was not created." };
    const frame = playtest.images?.[0];
    if (frame) writeFileSync(framePath, frame.png);
    const totalUsage = usageTurns.reduce(
      (sum, usage) => ({
        input: sum.input + usage.input,
        output: sum.output + usage.output,
        cachedInput: sum.cachedInput + usage.cachedInput,
        cacheWriteInput: sum.cacheWriteInput + usage.cacheWriteInput,
      }),
      { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 },
    );
    const task = session?.task.snapshot();
    const completion = Boolean(
      bootResources && session?.state.genesisComplete && playtest.success && !runError,
    );
    if (bootResources) {
      mkdirSync(resourcesPath, { recursive: true });
      for (const [name, bytes] of Object.entries(bootResources.files))
        writeFileSync(resolve(resourcesPath, safeName(name)), bytes);
      if (bootResources.transcript)
        writeFileSync(
          transcriptPath,
          `${JSON.stringify(bootResources.transcript, null, 2)}\n`,
          "utf8",
        );
    }
    writeFileSync(eventsPath, `${JSON.stringify(events, null, 2)}\n`, "utf8");
    const report = {
      schemaVersion: 1,
      startedAt: startedAtIso,
      lane,
      case: caseName,
      repeat,
      provider,
      model: options.model,
      effort: options.effort ?? "model-default",
      effectiveEffort:
        (provider === "openai"
          ? firstRequest.body?.reasoning?.effort
          : firstRequest.body?.output_config?.effort) ?? null,
      promptVariant: options.promptVariant ?? "baseline",
      ...(variant.baselineRequestPath ? { baselineRequestPath: variant.baselineRequestPath } : {}),
      completion,
      ...(runError ? { error: runError } : {}),
      firstResponseInputTokens: usageTurns[0]?.input ?? null,
      firstRequestSha256: firstRequest.text ? sha256(firstRequest.text) : null,
      promptSectionSha256: firstRequest.body
        ? {
            system: sha256(
              provider === "openai"
                ? textOf(firstRequest.body.instructions)
                : textOf(firstRequest.body.system),
            ),
            tools: sha256(textOf(firstRequest.body.tools)),
          }
        : null,
      promptSections: firstRequest.body
        ? promptSectionEstimates(firstRequest.body, provider)
        : null,
      usage: totalUsage,
      costUsd: task?.spent ?? 0,
      usageIncomplete: Boolean(runError || cancellationReason || (task?.usageIncomplete ?? true)),
      latency: {
        totalMs: performance.now() - startedAt,
        providerFetchMs: requestLatenciesMs,
        providerFetchDefinition:
          "Elapsed time until fetch resolves; streaming body consumption may occur afterward.",
        toolMs: toolLatencyMs,
      },
      repairs: {
        turns: repairTurns,
        toolFailures,
        definition: "A provider response after a turn containing at least one failed tool call.",
        categories: {
          actionable: {
            turns: actionableRepairTurns,
            toolFailures: actionableToolFailures,
          },
          expectedFutureRoomExit: {
            turns: expectedExitRepairTurns,
            toolFailures: expectedExitDiagnostics,
          },
        },
      },
      providerRequests: requestStarts.length,
      modelTurns: usageTurns.length,
      toolCalls,
      resources: session ? resourceCounts(session.state) : {},
      files: bootResources ? Object.keys(bootResources.files).sort() : [],
      playtest: summarizedPlaytest(playtest),
      artifacts: {
        firstRequest: requestPath,
        report: reportPath,
        firstFrame: frame ? framePath : null,
        transcript: bootResources?.transcript ? transcriptPath : null,
        resources: bootResources ? resourcesPath : null,
        events: eventsPath,
      },
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  });
}

export default class GenesisSessionProvider {
  private readonly config: Partial<GenesisOptions>;
  private readonly providerId: string;

  constructor(options?: { id?: string; config?: Partial<GenesisOptions> }) {
    this.config = options?.config ?? {};
    this.providerId = options?.id ?? "genesis-session";
  }

  id() {
    return this.providerId;
  }

  async callApi(
    _prompt: string,
    context: { vars: { caseName: string; repeat?: number | string; templateText: string } },
  ) {
    const { provider, model } = this.config;
    if ((provider !== "openai" && provider !== "anthropic") || !model)
      throw new Error("Genesis provider configuration requires a provider and model.");
    const report = await runGenesisSession({
      ...this.config,
      provider,
      model,
      caseName: context.vars.caseName,
      repeat: Number(context.vars.repeat ?? 1),
      templateText: context.vars.templateText,
    });
    return {
      output: JSON.stringify(report),
      tokenUsage: {
        prompt: report.usage.input,
        completion: report.usage.output,
        total: report.usage.input + report.usage.output,
      },
      cost: report.costUsd,
    };
  }
}
