import type { LlmUsage } from "./llmClient.ts";
import type { AgentToolResult } from "../../../src/agent/tools.ts";

// Standard API USD per million tokens, checked September 5, 2026.
// https://developers.openai.com/api/docs/models/gpt-6-astra
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
// https://developers.openai.com/api/docs/models/gpt-5.6-terra
// https://platform.claude.com/docs/en/about-claude/pricing
// cacheRead overrides the default cache-read price of 10% of input.
const RATES: Record<
  string,
  { input: number; output: number; longContext: boolean; cacheRead?: number }
> = {
  "gpt-6-astra": { input: 10, output: 50, longContext: true },
  "gpt-5.6-sol": { input: 4, output: 20, longContext: true },
  "gpt-5.6-terra": { input: 2, output: 12, longContext: true },
  "claude-opus-5": { input: 5, output: 25, longContext: false },
  "claude-fable-5": { input: 10, output: 50, longContext: false },
  "claude-fable-5-1": { input: 10, output: 50, longContext: false, cacheRead: 0.25 },
};
export interface AgentRunState {
  progress: AgentProgress | null;
  status: "idle" | "running" | "paused";
  reason: string;
  spent: number;
  budget: number;
  allowance: number;
  requests: number;
  usageIncomplete: boolean;
  priceKnown: boolean;
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
export class AgentRun {
  private state: AgentRunState;
  private readonly model: string;
  private readonly changed: (state: AgentRunState) => void;
  private readonly allowance: number;
  private wake: (() => void) | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private cancelled = false;
  private since = 0;
  private signatures: string[] = [];
  private lastInputCost = 0;
  private outputRate = 0;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(model: string, changed: (state: AgentRunState) => void, budget = 5) {
    if (!Number.isFinite(budget) || budget <= 0) throw new Error("Task budget must be positive.");
    this.model = model;
    this.changed = changed;
    this.allowance = budget;
    this.state = {
      progress: null,
      status: "idle",
      reason: "",
      spent: 0,
      budget,
      allowance: budget,
      requests: 0,
      usageIncomplete: false,
      priceKnown: !!RATES[model],
    };
    this.outputRate = RATES[model]?.output ?? 0;
  }
  snapshot(): AgentRunState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : null };
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
      budget: this.allowance,
      requests: 0,
      usageIncomplete: false,
    };
    this.stopped = false;
    this.cancelled = false;
    this.signatures = [];
    this.since = Date.now();
    this.publish();
    try {
      return await work();
    } finally {
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
  }
  cancel(): void {
    this.cancelled = true;
    this.controller?.abort();
    this.wake?.();
  }
  resume(): void {
    if (this.state.status !== "paused") return;
    if (this.state.reason.startsWith("Budget"))
      this.state.budget = Math.max(this.state.budget, this.state.spent) + this.allowance;
    this.stopped = false;
    this.state.reason = "";
    this.signatures = [];
    this.since = Date.now();
    this.wake?.();
  }
  recordUsage(usage: LlmUsage): void {
    const rate = RATES[this.model];
    if (!rate) {
      this.state.usageIncomplete = true;
      return;
    }
    const long = rate.longContext && usage.input > 272000;
    const input = rate.input * (long ? 2 : 1);
    const cacheRead = (rate.cacheRead ?? rate.input * 0.1) * (long ? 2 : 1);
    this.outputRate = rate.output * (long ? 1.5 : 1);
    const reads = Math.min(usage.input, usage.cachedInput);
    const writes = Math.min(usage.input - reads, usage.cacheWriteInput);
    this.lastInputCost =
      ((usage.input - reads - writes) * input + reads * cacheRead + writes * input * 1.25) / 1e6;
    this.state.spent += this.lastInputCost + (usage.output * this.outputRate) / 1e6;
    this.publish();
  }
  recordTool(name: string, args: Record<string, unknown>, result: AgentToolResult): void {
    // Compare recent observations, not call IDs. Different results remain productive.
    const signature = JSON.stringify([name, args, { ...result, images: undefined }]);
    this.signatures.push(signature);
    if (this.signatures.length > 16) this.signatures.shift();
    if (this.signatures.filter((value) => value === signature).length >= 8) {
      this.stopped = true;
      this.state.reason = "The agent is repeating the same operation without new results.";
    }
  }
  async checkpoint(billable = true): Promise<void> {
    if (this.cancelled) throw new Error("Agent task cancelled. Unapplied changes were discarded.");
    if (billable && this.state.spent + this.lastInputCost >= this.state.budget) {
      this.stopped = true;
      this.state.reason = "Budget reached. Work is kept; continuing adds another task allowance.";
    }
    if (Date.now() - this.since >= 15 * 60_000 && !this.stopped) {
      this.stopped = true;
      this.state.reason = "The agent has been working for 15 minutes. Continue when ready.";
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
      const controller = new AbortController();
      this.controller = controller;
      const timer = setTimeout(() => {
        this.stopped = true;
        this.state.reason = "The provider did not finish within 10 minutes. Continue to retry.";
        controller.abort();
      }, 10 * 60_000);
      const remaining = Math.max(0, this.state.budget - this.state.spent - this.lastInputCost);
      const maxTokens = this.outputRate
        ? Math.max(1, Math.min(128000, Math.floor((remaining * 1e6) / this.outputRate)))
        : 128000;
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
        if (!controller.signal.aborted || this.cancelled) throw error;
        // An aborted provider request may still be billed; do not call this total exact.
        this.state.usageIncomplete = true;
        continue;
      } finally {
        clearTimeout(timer);
        clearTimeout(this.progressTimer);
        this.progressTimer = undefined;
        this.state.progress = null;
        this.controller = undefined;
        this.publish();
      }
      if (this.stopped) await this.checkpoint(false);
      return response;
    }
  }
}
