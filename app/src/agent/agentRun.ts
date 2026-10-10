import {
  beginProviderBudget,
  subscribeProviderBudget,
  recordProviderSpend,
  providerBudgetReached,
  extendProviderBudget,
  type ProviderBudget,
} from "./providerBudget.ts";
import type { LlmUsage } from "./llmClient.ts";
import type { AgentToolResult } from "../../../src/agent/agentState.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import {
  MODEL_CAPABILITIES,
  modelCapability,
  requestRates,
} from "../../../src/agent/modelEffort.ts";
export interface AgentRunState {
  usageUrl?: string;
  progress: AgentProgress | null;
  status: "idle" | "running" | "paused";
  reason: string;
  spent: number;
  /** Provider-reported charges in this task, excluding shared image activity. */
  reportedSpent: number;
  budget: number;
  allowance: number;
  requests: number;
  usageIncomplete: boolean;
  priceKnown: boolean;
  /** Share of this task's input tokens served from the provider's prompt cache; null before any input. */
  cacheHitShare: number | null;
}

/** Ephemeral provider activity; never part of a saved conversation or game. */
export interface AgentProgress {
  phase: "waiting" | "thinking" | "text" | "tool";
  tool: string | null;
  text: string;
  startedAt: number;
  lastEventAt: number;
}

/** A pause suspends the existing async task, including its staged resource container. */
/** A task's budget until the player chooses another; evals start from it too. */
export { DEFAULT_TASK_BUDGET_USD } from "../settings/aiSettings.ts";
import { DEFAULT_TASK_BUDGET_USD } from "../settings/aiSettings.ts";

export class AgentRun {
  private state: AgentRunState;
  private account: ProviderBudget | null = null;
  private readonly model: string;
  private readonly changed: (state: AgentRunState) => void;
  private readonly allowance: number;
  private wake: (() => void) | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private cancelled = false;
  private signatures: string[] = [];
  private streamUsage: Record<string, { charge: number; input: number; cachedInput: number }> = {};
  /** This task's input tokens and the cached share of them, for the hit share. */
  private taskInput = 0;
  private taskCachedInput = 0;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    model: string,
    changed: (state: AgentRunState) => void,
    budget = DEFAULT_TASK_BUDGET_USD,
  ) {
    if (!Number.isFinite(budget) || budget <= 0) throw new Error("Task budget must be positive.");
    this.model = model;
    this.changed = changed;
    this.allowance = budget;
    this.state = {
      usageUrl:
        MODEL_CAPABILITIES[model]?.provider === "anthropic"
          ? "https://console.anthropic.com/settings/usage"
          : "https://platform.openai.com/usage",
      progress: null,
      status: "idle",
      reason: "",
      spent: 0,
      reportedSpent: 0,
      budget,
      allowance: budget,
      requests: 0,
      usageIncomplete: false,
      priceKnown: !!MODEL_CAPABILITIES[model]?.price,
      cacheHitShare: null,
    };
  }
  snapshot(): AgentRunState {
    return {
      ...this.state,
      ...(this.account
        ? {
            spent: this.account.spent,
            budget: this.account.limit,
            usageIncomplete: this.state.usageIncomplete || this.account.usageIncomplete,
          }
        : {}),
      progress: this.state.progress ? { ...this.state.progress } : null,
    };
  }
  private publish(): void {
    this.changed(this.snapshot());
  }
  updateProgress(phase?: AgentProgress["phase"], text = "", tool?: string): void {
    const progress = this.state.progress;
    if (!progress) return;
    const previous = progress.phase;
    if (phase) progress.phase = phase;
    if (tool !== undefined) progress.tool = tool;
    progress.text = (progress.text + text).slice(0, 16000);
    progress.lastEventAt = Date.now();
    // Phase changes appear immediately; token bursts cause at most ten UI updates a second.
    if (previous !== progress.phase) this.publish();
    if (this.progressTimer === undefined)
      this.progressTimer = setTimeout(() => {
        this.progressTimer = undefined;
        this.publish();
      }, 100);
  }
  markUsageIncomplete(): void {
    this.state.usageIncomplete = true;
    this.publish();
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.state.status !== "idle") throw new Error("An agent task is already active.");
    this.state = {
      ...this.state,
      status: "running",
      reason: "",
      spent: 0,
      reportedSpent: 0,
      budget: this.allowance,
      requests: 0,
      usageIncomplete: false,
      cacheHitShare: null,
    };
    this.account = beginProviderBudget(this.allowance);
    const unsubscribeBudget = subscribeProviderBudget(this.account, () => this.publish());
    this.taskInput = 0;
    this.taskCachedInput = 0;
    this.stopped = false;
    this.cancelled = false;
    this.signatures = [];
    this.publish();
    try {
      return await work();
    } finally {
      unsubscribeBudget();
      this.state.status = "idle";
      this.controller = undefined;
      this.publish();
    }
  }
  pause(reason: string): void {
    this.stopped = true;
    this.state.reason = reason;
  }
  stop(): void {
    if (this.state.status === "idle") return;
    this.stopped = true;
    this.state.reason = "Stopped. Your work is kept in this tab.";
    this.controller?.abort();
    this.publish();
  }
  assertActive(): void {
    if (this.cancelled) throw new Error("Agent task cancelled. Unapplied changes were discarded.");
  }
  cancel(): void {
    this.cancelled = true;
    this.controller?.abort();
    this.wake?.();
  }
  resume(_requestLimit?: number): void {
    if (this.state.status !== "paused") return;
    if (this.account && providerBudgetReached(this.account)) {
      extendProviderBudget(this.account);
      this.state.budget = this.account.limit;
    }
    this.stopped = false;
    this.state.reason = "";
    this.signatures = [];
    this.wake?.();
  }
  recordUsage(usage: LlmUsage, model = this.model): void {
    this.applyUsage(usage, model, false);
  }
  /** Providers report cumulative usage for the current stream; count each token once. */
  recordStreamUsage(usage: LlmUsage, model = this.model): void {
    this.applyUsage(usage, model, true);
  }
  private applyUsage(usage: LlmUsage, model: string, cumulative: boolean): void {
    const previous = cumulative ? this.streamUsage[model] : undefined;
    this.taskInput += usage.input - (previous?.input ?? 0);
    this.taskCachedInput += Math.min(usage.input, usage.cachedInput) - (previous?.cachedInput ?? 0);
    this.state.cacheHitShare = this.taskInput > 0 ? this.taskCachedInput / this.taskInput : null;
    const rate = MODEL_CAPABILITIES[model]?.price;
    if (!rate) {
      this.state.priceKnown = false;
      this.state.usageIncomplete = true;
      this.publish();
      return;
    }
    const { input, cacheRead, output: outputRate } = requestRates(rate, usage.input);
    const reads = Math.min(usage.input, usage.cachedInput);
    const writes = Math.min(usage.input - reads, usage.cacheWriteInput);
    // A cache write costs 1.25x the input rate for a 5-minute entry and 2x
    // for a 1-hour one (the static prefix, llmClient.ts); where the provider
    // reports the split, price each part, else assume the 5-minute rate.
    const writes1h = Math.min(writes, usage.cacheWrite1h ?? 0);
    const writes5m = writes - writes1h;
    const inputCost =
      ((usage.input - reads - writes) * input +
        reads * cacheRead +
        writes5m * input * 1.25 +
        writes1h * input * 2) /
      1e6;
    const cost = inputCost + (usage.output * outputRate) / 1e6;
    const charge = cost - (previous?.charge ?? 0);
    if (cumulative)
      this.streamUsage[model] = {
        charge: cost,
        input: usage.input,
        cachedInput: Math.min(usage.input, usage.cachedInput),
      };
    this.state.reportedSpent += charge;
    this.state.spent += charge;
    if (this.account) recordProviderSpend(this.account, charge);
    this.publish();
  }
  recordTool(
    name: string,
    args: Record<string, unknown>,
    result: AgentToolResult,
    revision?: string | number,
  ): void {
    // Compare recent observations, not call IDs. Different results remain productive.
    const signature = JSON.stringify([
      name,
      args,
      revision,
      result.images?.map(({ png, caption, mime }) => [sha256Hex(png), caption, mime]),
      result.audio?.map(({ wav, caption, mimeType }) => [sha256Hex(wav), caption, mimeType]),
      { ...result, images: undefined, audio: undefined },
    ]);
    this.signatures.push(signature);
    if (this.signatures.length > 16) this.signatures.shift();
    if (this.signatures.filter((value) => value === signature).length >= 8) {
      this.stopped = true;
      this.state.reason = "The agent is repeating the same operation without new results.";
    }
  }
  async checkpoint(billable = true): Promise<void> {
    if (this.cancelled) throw new Error("Agent task cancelled. Unapplied changes were discarded.");
    if (billable && this.account && providerBudgetReached(this.account)) {
      this.stopped = true;
      this.state.reason = "Budget reached. Continue adds another task budget. Your work is kept.";
    }
    if (!this.stopped) return;
    this.state.status = "paused";
    const waiting = new Promise<void>((resolve) => {
      this.wake = resolve;
    });
    this.publish();
    await waiting;
    this.wake = undefined;
    if (this.cancelled) throw new Error("Agent task cancelled. Unapplied changes were discarded.");
    this.state.status = "running";
    this.publish();
  }
  async request<T>(send: (signal: AbortSignal, maxTokens: number) => Promise<T>): Promise<T> {
    for (;;) {
      await this.checkpoint();
      // No wall-clock cut: a long turn at high effort is normal, and the SDKs
      // swallow keep-alive pings, so silence cannot be told from a stall.
      // The budget and Stop (which aborts here) are the controls.
      const controller = new AbortController();
      this.controller = controller;
      const maxTokens = modelCapability(this.model).maxOutputTokens;
      this.streamUsage = {};
      this.state.requests++;
      this.state.progress = {
        phase: "waiting",
        tool: null,
        text: "",
        startedAt: Date.now(),
        lastEventAt: Date.now(),
      };
      this.publish();
      let response: T;
      try {
        response = await send(controller.signal, maxTokens);
      } catch (error) {
        this.state.usageIncomplete = true;
        if (!controller.signal.aborted || this.cancelled) throw error;
        // An aborted provider request may still be billed; do not call this total exact.
        continue;
      } finally {
        clearTimeout(this.progressTimer);
        this.progressTimer = undefined;
        this.state.progress = null;
        this.controller = undefined;
        this.publish();
      }
      await this.checkpoint();
      return response;
    }
  }
}
