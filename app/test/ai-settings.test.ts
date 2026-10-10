import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultModelEffort,
  MODEL_CAPABILITIES,
  modelEffortOptions,
} from "../../src/agent/modelEffort.ts";
import { DEFAULT_MODELS, MODEL_OPTIONS } from "../../src/agent/modelEffort.ts";
import {
  AI_SETTINGS_KEY,
  loadAiSettings,
  saveAiSettings,
  type AiSettings,
} from "../src/settings/aiSettings.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  getItem(key: string): string | null {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const defaults = {
  openai: "gpt-default",
  anthropic: "claude-default",
  stub: "offline-stub",
} as const;

test("settings load defaults when absent without writing storage", () => {
  const storage = new MemoryStorage();
  const loaded = loadAiSettings(storage, defaults, true);
  assert.equal(loaded.provider, "openai");
  assert.equal(loaded.profiles.openai.apiKey, "");
  assert.equal(loaded.profiles.anthropic.apiKey, "");
  assert.equal(loaded.profiles.anthropic.model, defaults.anthropic);
  assert.deepEqual(storage.reads, [AI_SETTINGS_KEY]);
  assert.equal(storage.values.size, 0, "loading writes no settings record");
});

test("an unparsable stored record is treated as absent when saving", () => {
  const storage = new MemoryStorage();
  storage.values.set(AI_SETTINGS_KEY, "{not json");
  const current = loadAiSettings(storage, defaults, true);
  assert.equal(current.profiles.openai.model, defaults.openai);
  saveAiSettings(storage, current);
  assert.deepEqual(JSON.parse(storage.values.get(AI_SETTINGS_KEY)!), current);
});

test("a stored model outside the allowed list falls back to the default model and effort", () => {
  const storage = new MemoryStorage();
  const stored = (openai: string, anthropic: string): string =>
    JSON.stringify({
      version: 1,
      provider: "openai",
      profiles: {
        openai: { model: openai, apiKey: "openai-secret", effort: "xhigh" },
        anthropic: { model: anthropic, apiKey: "anthropic-secret", effort: "max" },
        stub: { model: "offline-stub", apiKey: "", effort: "medium" },
      },
    });
  storage.values.set(AI_SETTINGS_KEY, stored("gpt-retired", "claude-kept"));
  const explicit = loadAiSettings(storage, defaults, true, {
    openai: ["gpt-current"],
    anthropic: ["claude-kept"],
    stub: [],
  });
  assert.equal(explicit.profiles.openai.model, defaults.openai);
  assert.equal(explicit.profiles.openai.effort, defaultModelEffort(defaults.openai));
  assert.equal(explicit.profiles.openai.apiKey, "openai-secret", "the key outlives the model");
  assert.equal(explicit.profiles.anthropic.model, "claude-kept");
  assert.equal(explicit.profiles.anthropic.effort, "max");

  const shipped = MODEL_OPTIONS.openai.find((option) => option.id !== DEFAULT_MODELS.openai)!;
  storage.values.set(AI_SETTINGS_KEY, stored(shipped.id, "claude-retired"));
  const catalog = loadAiSettings(storage, DEFAULT_MODELS, true);
  assert.equal(catalog.profiles.openai.model, shipped.id);
  assert.equal(catalog.profiles.openai.effort, "xhigh");
  assert.equal(catalog.profiles.anthropic.model, DEFAULT_MODELS.anthropic);
  assert.equal(catalog.profiles.anthropic.effort, defaultModelEffort(DEFAULT_MODELS.anthropic));
});

test("future AI settings are not interpreted or overwritten by an older app", () => {
  const storage = new MemoryStorage();
  const current = loadAiSettings(storage, defaults, true);
  const future = JSON.stringify({
    ...current,
    version: 2,
    profiles: {
      ...current.profiles,
      openai: { ...current.profiles.openai, apiKey: "future-secret" },
    },
  });
  storage.values.set("monotio_agi.aiSettings", future);
  assert.equal(loadAiSettings(storage, defaults, true).profiles.openai.apiKey, "");
  assert.throws(() => saveAiSettings(storage, current), /newer|unsupported|update/i);
  assert.equal(storage.values.get("monotio_agi.aiSettings"), future);
});

test("one atomic record keeps provider keys and models isolated", () => {
  const storage = new MemoryStorage();
  const settings: AiSettings = {
    version: 1,
    provider: "openai",
    profiles: {
      openai: { model: "gpt-picked", apiKey: "openai-secret", effort: "xhigh" },
      anthropic: { model: "claude-picked", apiKey: "anthropic-secret", effort: "high" },
      stub: { model: "offline-stub", apiKey: "", effort: "medium" },
    },
  };
  saveAiSettings(storage, settings);

  const restored = loadAiSettings(storage, defaults, true, {
    openai: ["gpt-picked"],
    anthropic: ["claude-picked"],
    stub: [],
  });
  assert.deepEqual(restored, settings);
  assert.equal(storage.values.size, 1);
});

test("the app offers the current models, each with its published price and effort", () => {
  // Provider model pages and list prices at the time of this release.
  assert.deepEqual(
    MODEL_OPTIONS.anthropic.map((option) => option.id),
    ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-5-5"],
  );
  assert.deepEqual(
    MODEL_OPTIONS.openai.map((option) => option.id),
    ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
  );
  assert.equal(DEFAULT_MODELS.anthropic, "claude-opus-5-5");
  assert.equal(DEFAULT_MODELS.openai, "gpt-6.1-sol");
  assert.deepEqual(MODEL_CAPABILITIES["claude-opus-5-5"]?.price, {
    input: 4,
    output: 20,
    cacheRead: 0.2,
  });
  // Sonnet 5.5 reads cache at the default 10% of input: $0.20.
  assert.deepEqual(MODEL_CAPABILITIES["claude-sonnet-5-5"]?.price, {
    input: 2,
    output: 10,
  });
  // Haiku 5.5 has a second rate card for prompts over 100K tokens.
  assert.deepEqual(MODEL_CAPABILITIES["claude-haiku-5-5"]?.price, {
    input: 0.1,
    output: 0.5,
    longContext: { above: 100000, inputFactor: 5, outputFactor: 5 },
  });
  // GPT-6.1 Sol lists cache reads at 5% of input ($0.10/M), not the usual 10%.
  assert.deepEqual(MODEL_CAPABILITIES["gpt-6.1-sol"]?.price, {
    input: 2,
    output: 10,
    longContext: { above: 272000, inputFactor: 2, outputFactor: 1.5 },
    cacheRead: 0.1,
  });
  assert.deepEqual(MODEL_CAPABILITIES["gpt-6-sol"]?.price, {
    input: 2,
    output: 10,
    longContext: { above: 272000, inputFactor: 2, outputFactor: 1.5 },
  });
  assert.deepEqual(MODEL_CAPABILITIES["gpt-6-luna"]?.price, {
    input: 0.1,
    output: 0.5,
    longContext: { above: 272000, inputFactor: 2, outputFactor: 1.5 },
  });
  // GPT-6 Sol and Luna accept none through max and default to medium.
  for (const id of ["gpt-6-sol", "gpt-6-luna"]) {
    assert.deepEqual(modelEffortOptions(id), ["none", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(defaultModelEffort(id), "medium");
  }
  // GPT-6.1 Sol requires reasoning: none and minimal are not offered.
  assert.deepEqual(modelEffortOptions("gpt-6.1-sol"), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(defaultModelEffort("gpt-6.1-sol"), "medium");
  for (const option of [...MODEL_OPTIONS.anthropic, ...MODEL_OPTIONS.openai])
    assert.ok(MODEL_CAPABILITIES[option.id]?.price, `${option.id} has a known price`);
});

test("fresh settings default to GPT-6.1 Sol at medium without writing storage", () => {
  const storage = new MemoryStorage();
  const loaded = loadAiSettings(storage, DEFAULT_MODELS, true);
  assert.equal(loaded.provider, "openai");
  assert.equal(loaded.profiles.openai.model, "gpt-6.1-sol");
  assert.equal(loaded.profiles.openai.effort, "medium");
  assert.equal(storage.values.size, 0);
});

test("a stored GPT-6 Sol at effort none stays selected; GPT-6.1 Sol refuses none on save", () => {
  const storage = new MemoryStorage();
  storage.values.set(
    AI_SETTINGS_KEY,
    JSON.stringify({
      version: 1,
      provider: "openai",
      profiles: {
        openai: { model: "gpt-6-sol", apiKey: "openai-secret", effort: "none" },
        anthropic: { model: "claude-opus-5-5", apiKey: "", effort: "medium" },
        stub: { model: "offline-stub", apiKey: "", effort: "medium" },
      },
    }),
  );
  const loaded = loadAiSettings(storage, DEFAULT_MODELS, true);
  assert.equal(loaded.profiles.openai.model, "gpt-6-sol");
  assert.equal(loaded.profiles.openai.effort, "none");
  saveAiSettings(storage, loaded);
  assert.equal(
    (JSON.parse(storage.values.get(AI_SETTINGS_KEY)!) as AiSettings).profiles.openai.effort,
    "none",
  );
  assert.throws(
    () =>
      saveAiSettings(storage, {
        ...loaded,
        profiles: {
          ...loaded.profiles,
          openai: { ...loaded.profiles.openai, model: "gpt-6.1-sol", effort: "none" },
        },
      }),
    /supported reasoning effort/i,
  );
});
