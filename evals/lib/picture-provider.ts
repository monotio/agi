/**
 * Promptfoo custom provider wrapping scripts/eval-picture.ts. One instance
 * per (vendor, model) lane; config: { vendor: "openai"|"anthropic"|"fake", model }.
 * Each test's `entry` var is a manifest entry JSON; the output is the
 * runner's EntryResult JSON (scored by asserts.ts:validatePictureFidelity).
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as PictureRunner from "../../scripts/eval-picture.ts";

const RUNNER = pathToFileURL(resolve(import.meta.dirname, "../../scripts/eval-picture.ts")).href;
const ROUNDS = Number(process.env["EVAL_PICTURE_ROUNDS"] ?? 4);

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
