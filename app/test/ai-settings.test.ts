import assert from "node:assert/strict";
import { test } from "node:test";
import { loadAiSettings, saveAiSettings, type AiSettings } from "../src/aiSettings.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const defaults = {
  openai: "gpt-default",
  anthropic: "claude-default",
  stub: "offline-stub",
} as const;

test("first-release settings ignore pre-release keys without copying credentials", () => {
  const storage = new MemoryStorage();
  storage.values.set("monotio_agi.provider", "anthropic");
  storage.values.set("monotio_agi.apiKey", "unreleased-secret");
  const loaded = loadAiSettings(storage, defaults, true);
  assert.equal(loaded.provider, "openai");
  assert.equal(loaded.profiles.openai.apiKey, "");
  assert.equal(loaded.profiles.anthropic.apiKey, "");
  assert.equal(storage.values.size, 2, "loading does not mutate storage");
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

  const restored = loadAiSettings(storage, defaults, true);
  assert.deepEqual(restored, settings);
  assert.equal(storage.values.size, 1);
});
