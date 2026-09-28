/**
 * Promptfoo custom provider wrapping evals/picture-fidelity.ts. One instance
 * per (vendor, model) lane; config: { vendor: "openai"|"anthropic"|"fake", model }.
 * Each test's `entry` var is a manifest entry JSON; the output is the
 * runner's EntryResult JSON (scored by asserts.ts:validatePictureFidelity).
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as PictureRunner from "../picture-fidelity.ts";
import { MODEL_CAPABILITIES } from "../../src/agent/modelEffort.ts";

const RUNNER = pathToFileURL(resolve(import.meta.dirname, "../picture-fidelity.ts")).href;
const ROUNDS = Number(process.env["EVAL_PICTURE_ROUNDS"] ?? 4);
/** The live lanes' cap (configs/picture.ts consents to it); a paid entry never starts past it. */
const BUDGET_USD = Number(process.env["EVAL_RUN_BUDGET_USD"] ?? Infinity);

function spentUsd(usage: { input: number; cachedInput: number; output: number }, model: string) {
  const price = MODEL_CAPABILITIES[model]?.price;
  if (!price) return 0;
  return (
    ((usage.input - usage.cachedInput) * price.input +
      usage.cachedInput * (price.cacheRead ?? price.input * 0.1) +
      usage.output * price.output) /
    1e6
  );
}

interface PictureOptions {
  id?: string;
  config?: { vendor?: string; model?: string };
}

export default class PictureProvider {
  private readonly vendor: string;
  private readonly model: string;
  private readonly providerId: string;
  private runner: ReturnType<typeof PictureRunner.createProvider> | null;

  constructor(options?: PictureOptions) {
    this.vendor = options?.config?.vendor ?? "fake";
    this.model = options?.config?.model ?? "fake";
    this.providerId = options?.id ?? `picture:${this.vendor}:${this.model}`;
    this.runner = null;
  }

  id() {
    return this.providerId;
  }

  async callApi(_prompt: string, context: { vars: { entry: string } }) {
    const mod = (await import(RUNNER)) as typeof PictureRunner;
    this.runner ??= mod.createProvider(this.vendor, this.model, undefined, "medium");
    if (this.vendor !== "fake" && spentUsd(this.runner.usage, this.model) >= BUDGET_USD)
      throw new Error(`Budget reached ($${BUDGET_USD}); the picture lane stops here.`);
    const entry = JSON.parse(context.vars.entry);
    const outDir = resolve(
      import.meta.dirname,
      `../results/promptfoo/${this.vendor}-${this.model}`,
    );
    const before = { ...this.runner.usage };
    const result = await mod.runPictureEntry(entry, {
      provider: this.runner,
      rounds: ROUNDS,
      outDir,
    });
    const prompt = this.runner.usage.input - before.input;
    const completion = this.runner.usage.output - before.output;
    return {
      output: JSON.stringify(result),
      tokenUsage: { prompt, completion, total: prompt + completion },
    };
  }
}
