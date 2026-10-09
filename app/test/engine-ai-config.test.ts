import assert from "node:assert/strict";
import { test } from "node:test";
import { createAiConfigUpdater, type AiConfigUpdateOwner } from "../src/engine/aiConfigUpdate.ts";
import type { LlmConfig } from "../src/agent/llmClient.ts";

const config: LlmConfig = { provider: "stub", apiKey: "", model: "next-model" };

function rig() {
  let owner: AiConfigUpdateOwner = {
    game: null,
    worker: null,
    mode: "play",
    modeGeneration: 0,
    project: null,
    sessionId: 1,
  };
  const attachment = Promise.withResolvers<void>();
  let delegated = false;
  const controller = {
    async updateAiConfig(_config: LlmConfig, commit?: () => void) {
      delegated = true;
      await attachment.promise;
      commit?.();
    },
  };
  const loading = Promise.withResolvers<typeof controller>();
  let loaded: typeof controller | null = null;
  let pending: Promise<typeof controller> | undefined = loading.promise;
  let published: LlmConfig | undefined;
  const update = createAiConfigUpdater({
    getController: () => loaded,
    getLoading: () => pending,
    getOwner: () => owner,
    publish(next, commit) {
      commit?.();
      published = next;
    },
  });
  return {
    update,
    loading,
    attachment,
    controller,
    get delegated() {
      return delegated;
    },
    get published() {
      return published;
    },
    replaceOwner(next: Partial<AiConfigUpdateOwner>) {
      owner = { ...owner, ...next };
    },
    unload() {
      pending = undefined;
    },
    load() {
      loaded = controller;
      loading.resolve(controller);
    },
  };
}

test("settings wait for a requested controller and its pending Assistant attachment", async () => {
  const state = rig();
  let commits = 0;
  const applying = state.update(config, () => commits++);
  await Promise.resolve();
  assert.equal(state.published, undefined, "module loading cannot publish settings early");
  assert.equal(commits, 0);
  state.load();
  await Promise.resolve();
  assert.equal(state.delegated, true);
  assert.equal(commits, 0, "the controller still owns admission while attaching");
  state.attachment.resolve();
  await applying;
  assert.equal(commits, 1);
  assert.equal(state.published, config);
});

test("Home settings publish without requesting an authoring controller", async () => {
  const state = rig();
  state.unload();
  let commits = 0;
  const applying = state.update(config, () => commits++);
  assert.equal(commits, 1, "the synchronous settings commit stays synchronous");
  await applying;
  assert.equal(state.published, config);
  assert.equal(state.delegated, false);
});

test("a rejected authoring import preserves settings", async () => {
  const state = rig();
  let commits = 0;
  const applying = state.update(config, () => commits++);
  state.loading.reject(new Error("Module unavailable"));
  await assert.rejects(applying, /Module unavailable/);
  assert.equal(commits, 0);
  assert.equal(state.published, undefined);
});

for (const changed of [
  "game",
  "worker",
  "mode",
  "modeGeneration",
  "project",
  "sessionId",
] as const) {
  test(`a changed ${changed} rejects settings waiting for an authoring import`, async () => {
    const state = rig();
    let commits = 0;
    const applying = state.update(config, () => commits++);
    const replacements = {
      game: {} as NonNullable<AiConfigUpdateOwner["game"]>,
      worker: {} as Worker,
      mode: "create" as const,
      modeGeneration: 2,
      project: {} as NonNullable<AiConfigUpdateOwner["project"]>,
      sessionId: 2,
    };
    state.replaceOwner({ [changed]: replacements[changed] });
    state.attachment.resolve();
    state.load();
    await assert.rejects(applying, /game changed/i);
    assert.equal(commits, 0);
    assert.equal(state.published, undefined);
    assert.equal(state.delegated, false);
  });
}

test("a rejected settings write preserves the active configuration", async () => {
  const state = rig();
  state.load();
  state.attachment.resolve();
  await assert.rejects(
    state.update(config, () => {
      throw new Error("Settings storage refused the write");
    }),
    /Settings storage refused/,
  );
  assert.equal(state.published, undefined);
});
