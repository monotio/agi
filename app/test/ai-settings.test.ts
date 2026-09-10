import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultModelEffort } from "../../src/agent/modelEffort.ts";
import { DEFAULT_MODELS, MODEL_OPTIONS } from "../src/agent/llmClient.ts";
import {
  AI_SETTINGS_KEY,
  loadAiSettings,
  saveAiSettings,
  type AiSettings,
} from "../src/aiSettings.ts";

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
