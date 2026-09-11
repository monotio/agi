import test from "node:test";
import assert from "node:assert/strict";
import { usePromptController, type PromptState } from "../src/usePromptController.ts";

test("usePromptController opens and resolves string prompts", async () => {
  const logged: string[] = [];
  const state: { prompt: PromptState | null; walkthrough: { seeking: boolean } } = {
    prompt: null,
    walkthrough: { seeking: false },
  };

  const controller = usePromptController({
    state,
    logAgent: (_level, text) => {
      logged.push(text);
    },
  });

  assert.equal(controller.isPromptPending(), false);

  const promptPromise = controller.handlePromptRequest("getstring", {
    prompt: "Enter name:",
    maxLen: 20,
    row: 10,
    col: 5,
  });

  assert.equal(controller.isPromptPending(), true);
  assert.deepEqual(state.prompt, {
    kind: "getstring",
    prompt: "Enter name:",
    maxLen: 20,
    row: 10,
    col: 5,
  });

  controller.submitPrompt("Graham");
  const result = await promptPromise;

  assert.equal(result, "Graham");
  assert.equal(controller.isPromptPending(), false);
  assert.equal(state.prompt, null);
  assert.deepEqual(logged, ["Graham"]);
});

test("usePromptController formats saveDescription as JSON", async () => {
  const state: { prompt: PromptState | null; walkthrough: { seeking: boolean } } = {
    prompt: null,
    walkthrough: { seeking: false },
  };

  const controller = usePromptController({
    state,
    logAgent: () => {},
  });

  const savePromise = controller.handlePromptRequest("saveDescription", {
    prompt: "Save as:",
  });

  controller.submitPrompt("Castle Gate");
  assert.equal(await savePromise, JSON.stringify({ value: "Castle Gate" }));

  // Test cancelled save
  const cancelPromise = controller.handlePromptRequest("saveDescription", {
    prompt: "Save as:",
  });
  controller.submitPrompt("Castle Gate", true);
  assert.equal(await cancelPromise, JSON.stringify({ value: null }));
});

test("usePromptController cancelPrompt resolves with empty string and clears state", async () => {
  const state: { prompt: PromptState | null; walkthrough: { seeking: boolean } } = {
    prompt: null,
    walkthrough: { seeking: false },
  };

  const controller = usePromptController({
    state,
    logAgent: () => {},
  });

  const promptPromise = controller.handlePromptRequest("getnum", {
    prompt: "Speed:",
  });

  assert.equal(controller.isPromptPending(), true);
  controller.cancelPrompt();

  assert.equal(await promptPromise, "");
  assert.equal(controller.isPromptPending(), false);
  assert.equal(state.prompt, null);
});
