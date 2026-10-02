import type { LlmUsage } from "./llmClient.ts";
import type { AgentToolResult } from "../../../src/agent/agentState.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import { MODEL_CAPABILITIES, modelCapability } from "../../../src/agent/modelEffort.ts";
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
/** A task's spending allowance until the player chooses another; evals start from it too. */
export { DEFAULT_TASK_BUDGET_USD } from "../settings/aiSettings.ts";
import { DEFAULT_TASK_BUDGET_USD } from "../settings/aiSettings.ts";

export class AgentRun {
  private state: AgentRunState;
  private readonly model: string;
  private readonly changed: (state: AgentRunState) => void;
  private readonly allowance: number;
  private wake: (() => void) | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private cancelled = false;
  private signatures: string[] = [];
  private lastInputCost = 0;
  /** Projected input cost of the next request: last cost grown by the observed ratio. */
  private expectedInputCost = 0;
  private outputRate = 0;
  private outputReserve = 25000;
  private requestAllowance = 0;
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
      progress: null,
      status: "idle",
      reason: "",
      spent: 0,
      budget,
      allowance: budget,
      requests: 0,
      usageIncomplete: false,
      priceKnown: !!MODEL_CAPABILITIES[model]?.price,
      cacheHitShare: null,
    };
    this.outputRate = MODEL_CAPABILITIES[model]?.price?.output ?? 0;
    this.outputReserve = MODEL_CAPABILITIES[model]?.provider === "anthropic" ? 64000 : 25000;
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
      cacheHitShare: null,
    };
    this.taskInput = 0;
    this.taskCachedInput = 0;
    this.stopped = false;
    this.cancelled = false;
    this.signatures = [];
    this.requestAllowance = 0;
    this.expectedInputCost = this.lastInputCost;
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
  resume(requestLimit?: number): void {
    if (this.state.status !== "paused") return;
    if (!this.state.priceKnown) {
      if (!Number.isSafeInteger(requestLimit) || requestLimit === undefined || requestLimit < 1)
        return;
      this.requestAllowance = this.state.requests + requestLimit;
    }
    if (this.state.reason.startsWith("Budget"))
      this.state.budget = Math.max(this.state.budget, this.state.spent) + this.allowance;
    this.stopped = false;
    this.state.reason = "";
    this.signatures = [];
    this.wake?.();
  }
  recordUsage(usage: LlmUsage, model = this.model): void {
    this.outputReserve = Math.min(
      modelCapability(this.model).maxOutputTokens,
      Math.max(
        MODEL_CAPABILITIES[this.model]?.provider === "anthropic" ? 64000 : 25000,
        Math.ceil((3 * this.outputReserve + usage.output) / 4),
      ),
    );
    this.taskInput += usage.input;
    this.taskCachedInput += Math.min(usage.input, usage.cachedInput);
    this.state.cacheHitShare = this.taskInput > 0 ? this.taskCachedInput / this.taskInput : null;
    const rate = MODEL_CAPABILITIES[model]?.price;
    if (!rate) {
      this.state.priceKnown = false;
      this.state.usageIncomplete = true;
      this.publish();
      return;
    }
    const long = rate.longContext && usage.input > 272000;
    const input = rate.input * (long ? 2 : 1);
    const cacheRead = (rate.cacheRead ?? rate.input * 0.1) * (long ? 2 : 1);
    this.outputRate = rate.output * (long ? 1.5 : 1);
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
    // Conversation input grows each request; the next one costs at least this
    // request's input scaled by the observed growth ratio, bounded at 2x.
    this.expectedInputCost =
      this.lastInputCost > 0
        ? inputCost * Math.min(2, Math.max(1, inputCost / this.lastInputCost))
        : inputCost;
    this.lastInputCost = inputCost;
    this.state.spent += inputCost + (usage.output * this.outputRate) / 1e6;
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
    if (
      billable &&
      this.state.priceKnown &&
      this.state.spent + this.expectedInputCost + (this.outputReserve * this.outputRate) / 1e6 >
        this.state.budget
    ) {
      this.stopped = true;
      this.state.reason =
        "Budget pause. Another productive request needs more allowance. Work is kept; continuing adds another task allowance.";
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
  async request<T>(
    send: (signal: AbortSignal, maxTokens: number) => Promise<T>,
    estimatedInputTokens = 0,
  ): Promise<T> {
    for (;;) {
      const rate = MODEL_CAPABILITIES[this.model]?.price;
      if (rate && estimatedInputTokens > 0) {
        const long = rate.longContext && estimatedInputTokens > 272000;
        this.expectedInputCost = Math.max(
          this.expectedInputCost,
          (estimatedInputTokens * rate.input * (long ? 2 : 1)) / 1e6,
        );
        this.outputRate = rate.output * (long ? 1.5 : 1);
      }
      if (!this.state.priceKnown && this.state.requests >= this.requestAllowance)
        this.pause(`Spend unknown. Enter a spend limit in requests to continue.`);
      await this.checkpoint();
      if (
        rate &&
        this.state.spent + this.expectedInputCost + (this.outputReserve * this.outputRate) / 1e6 >
          this.state.budget
      )
        continue;
      // No wall-clock cut: a long turn at high effort is normal, and the SDKs
      // swallow keep-alive pings, so silence cannot be told from a stall.
      // The budget and Stop (which aborts here) are the controls.
      const controller = new AbortController();
      this.controller = controller;
      const maxTokens = modelCapability(this.model).maxOutputTokens;
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
