import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEV_KEYS_PATH,
  devKeysFromEnv,
  isLoopbackRequest,
  settingsWithDevKeys,
} from "../src/settings/devProviderKeys.ts";
import type { AiSettings } from "../src/settings/aiSettings.ts";

function settings(provider: AiSettings["provider"], openaiKey = "", anthropicKey = ""): AiSettings {
  return {
    version: 1,
    provider,
    profiles: {
      openai: { model: "gpt-6.1-sol", apiKey: openaiKey, effort: "medium" },
      anthropic: { model: "claude-sonnet-5-5", apiKey: anthropicKey, effort: "medium" },
      stub: { model: "stub", apiKey: "", effort: "medium" },
    },
  };
}

const respond =
  (body: unknown, ok = true) =>
  async () =>
    ({ ok, json: async () => body }) as unknown as Response;

test("only this machine, addressed as localhost, gets the keys", () => {
  assert.equal(isLoopbackRequest("127.0.0.1", "localhost:5199"), true);
  assert.equal(isLoopbackRequest("::1", "[::1]:5199"), true);
  assert.equal(isLoopbackRequest("::ffff:127.0.0.1", "127.0.0.1:5199"), true);
  assert.equal(isLoopbackRequest("192.168.1.20", "localhost:5199"), false);
  assert.equal(isLoopbackRequest("127.0.0.1", "attacker.example:5199"), false);
  assert.equal(isLoopbackRequest("127.0.0.1", undefined), false);
  assert.equal(isLoopbackRequest(undefined, "localhost"), false);
});

test("the server hands out present provider keys only", () => {
  assert.deepEqual(devKeysFromEnv({ OPENAI_API_KEY: " sk-a ", ANTHROPIC_API_KEY: "" }), {
    openai: "sk-a",
  });
  assert.deepEqual(devKeysFromEnv({}), {});
});

test("missing keys are filled and entered keys are kept", async () => {
  const next = await settingsWithDevKeys(
    settings("openai", "", "player-key"),
    respond({ openai: "dev-openai", anthropic: "dev-anthropic" }),
  );
  assert.equal(next?.profiles.openai.apiKey, "dev-openai");
  assert.equal(next?.profiles.anthropic.apiKey, "player-key");
  assert.equal(next?.provider, "openai");
});

test("a keyless current provider switches to a provider with a key", async () => {
  const next = await settingsWithDevKeys(
    settings("openai"),
    respond({ anthropic: "dev-anthropic" }),
  );
  assert.equal(next?.provider, "anthropic");
  assert.equal(next?.profiles.anthropic.apiKey, "dev-anthropic");
});

test("nothing changes without an answer or with every key already set", async () => {
  assert.equal(await settingsWithDevKeys(settings("openai"), respond({}, false)), null);
  assert.equal(
    await settingsWithDevKeys(settings("openai"), async () => {
      throw new TypeError("offline");
    }),
    null,
  );
  assert.equal(
    await settingsWithDevKeys(
      settings("openai", "a", "b"),
      respond({ openai: "x", anthropic: "y" }),
    ),
    null,
  );
  assert.equal(DEV_KEYS_PATH, "/__agi/dev-keys");
});
