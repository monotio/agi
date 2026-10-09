import { expect, test } from "./test.ts";
import { providerReply } from "../../test/provider-stream.ts";
import {
  isolateStorage,
  openAiSettings,
  enterPlayMode,
  textHook,
  waitForRoom,
} from "./engineProbe.ts";

test("one shared AI setup preserves the brief and keeps provider keys separate", async ({
  page,
}) => {
  await isolateStorage(page);
  let providerCalls = 0;
  await page.route(/\/api\/(openai|anthropic)\//, async (route) => {
    providerCalls++;
    await route.abort();
  });
  await page.goto("/");
  const create = page.getByTestId("create-adventure-disclosure");
  await expect(create.getByTestId("api-key-input")).toHaveCount(0);
  await page.getByTestId("shelf-template-custom").click();
  await page.getByTestId("local-create-kind-ai").click();
  await page.getByTestId("template-custom").click();
  await expect(page.getByTestId("template-custom")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("local-create-title").fill("The Quiet Observatory");
  await page.getByTestId("custom-adventure-input").fill("Find the missing moon chart.");
  await page.getByTestId("connect-create-ai").click();
  const dialog = page.getByTestId("ai-settings-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("error-panel")).toHaveCount(0);
  await dialog.getByTestId("provider-select").selectOption("openai");
  await dialog.getByTestId("model-select").selectOption("gpt-6-sol");
  await expect(dialog.getByTestId("effort-select")).toHaveValue("medium");
  await dialog.getByTestId("api-key-input").fill("test-openai-key");
  await dialog.getByTestId("effort-select").selectOption("low");
  await dialog.getByTestId("task-budget").fill("1.23");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("local-create-title")).toHaveValue("The Quiet Observatory");
  await expect(page.getByTestId("custom-adventure-input")).toHaveValue(
    "Find the missing moon chart.",
  );
  expect(providerCalls).toBe(0);

  await openAiSettings(page);
  await dialog.getByTestId("provider-select").selectOption("anthropic");
  await expect(dialog.getByTestId("api-key-input")).toHaveValue("");
  await dialog.getByTestId("api-key-input").fill("test-anthropic-key");
  await dialog.getByTestId("effort-select").selectOption("medium");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await page.getByTestId("create-adventure-close").click();
  await openAiSettings(page);
  await expect(dialog.getByTestId("provider-select")).toHaveValue("anthropic");
  await expect(dialog.getByTestId("api-key-input")).toHaveValue("test-anthropic-key");
  await expect(dialog.getByTestId("effort-select")).toHaveValue("medium");
  await expect(dialog.getByTestId("task-budget")).toHaveValue("1.23");
  await dialog.getByTestId("provider-select").selectOption("openai");
  await expect(dialog.getByTestId("api-key-input")).toHaveValue("test-openai-key");
  await expect(dialog.getByTestId("effort-select")).toHaveValue("low");
  await dialog.getByTestId("api-key-input").fill("discard-this-edit");
  await dialog.getByTestId("ai-settings-cancel").click();
  await openAiSettings(page);
  await expect(dialog.getByTestId("provider-select")).toHaveValue("anthropic");
  await dialog.getByTestId("provider-select").selectOption("openai");
  await expect(dialog.getByTestId("api-key-input")).toHaveValue("test-openai-key");
  await expect(dialog.getByTestId("effort-select")).toHaveValue("low");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(dialog.getByTestId("ai-settings-save")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath(`ai-settings-${width}.png`) });
  }
  expect(providerCalls).toBe(0);
});

test("AI settings pause only their own game interaction and preserve the assistant draft", async ({
  page,
}) => {
  await isolateStorage(page);
  let providerCalls = 0;
  await page.route(/\/api\/(openai|anthropic)\//, async (route) => {
    providerCalls++;
    await route.abort();
  });
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(0);
  const before = await textHook(page);
  await openAiSettings(page);
  const dialog = page.getByTestId("ai-settings-dialog");
  await expect(dialog).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  await dialog.getByTestId("api-key-input").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  expect((await textHook(page)).egoX).toBe(before.egoX);
  await expect(page.getByTestId("settings-menu")).toBeFocused();

  await enterPlayMode(page);
  await page.getByTestId("menu-assistant").click();
  await expect(page.getByTestId("agent-open-ai-settings")).toBeEnabled();
  await openAiSettings(page);
  await dialog.getByTestId("provider-select").selectOption("openai");
  await dialog.getByTestId("api-key-input").fill("test-openai-key");
  await dialog.getByTestId("effort-select").selectOption("low");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("agent-message")).toBeEnabled();
  await page.getByTestId("agent-message").fill("Where should I look next?");
  await openAiSettings(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
  await expect(page.getByTestId("agent-message")).toHaveValue("Where should I look next?");
  await expect(page.getByTestId("settings-menu")).toBeFocused();
  expect((await textHook(page)).paused).toBe(true);
  expect(providerCalls).toBe(0);
  await page.getByTestId("agent-panel-close").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
});

test("AI settings settle a pending Assistant attachment before saving @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  let providerCalls = 0;
  await page.route(/\/api\/(openai|anthropic)\//, async (route) => {
    providerCalls++;
    await route.abort();
  });
  const controller = Promise.withResolvers<void>();
  const controllerRequested = Promise.withResolvers<void>();
  const attachment = Promise.withResolvers<void>();
  const attachmentRequested = Promise.withResolvers<void>();
  await page.route("**/src/authoring/useAuthoringController.ts", async (route) => {
    controllerRequested.resolve();
    await controller.promise;
    await route.continue();
  });
  await page.route("**/src/agent/workspaceAgent.ts", async (route) => {
    attachmentRequested.resolve();
    await attachment.promise;
    await route.continue();
  });
  try {
    await page.goto("/");
    await page.getByTestId("catalog-play-adventure-department").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await enterPlayMode(page);
    await page.getByTestId("menu-assistant").click();
    await controllerRequested.promise;
    await openAiSettings(page);
    const dialog = page.getByTestId("ai-settings-dialog");
    await dialog.getByTestId("provider-select").selectOption("openai");
    await dialog.getByTestId("api-key-input").fill("test-attachment-key");
    await dialog.getByTestId("effort-select").selectOption("low");
    controller.resolve();
    await attachmentRequested.promise;
    await dialog.getByTestId("ai-settings-save").click();
    await expect(dialog.getByTestId("ai-settings-save")).toBeDisabled();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("monotio_agi.aiSettings"))).toBeNull();
    expect(providerCalls).toBe(0);
    attachment.resolve();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("agent-message")).toBeEnabled();
    await openAiSettings(page);
    await expect(dialog.getByTestId("api-key-input")).toHaveValue("test-attachment-key");
    expect(providerCalls).toBe(0);
  } finally {
    controller.resolve();
    attachment.resolve();
  }
});

test("a running Assistant task refuses settings without publishing the draft @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const requestStarted = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<void>();
  const authorizations: string[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    authorizations.push(route.request().headers()["authorization"]!);
    requestStarted.resolve();
    await answer.promise;
    await route.fulfill(
      providerReply("openai", {
        id: `held-settings-${authorizations.length}`,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Read the mural." }],
          },
        ],
      }),
    );
  });
  try {
    await page.goto("/");
    await openAiSettings(page);
    const dialog = page.getByTestId("ai-settings-dialog");
    await dialog.getByTestId("provider-select").selectOption("openai");
    await dialog.getByTestId("api-key-input").fill("test-original-key");
    await dialog.getByTestId("effort-select").selectOption("low");
    await dialog.getByTestId("ai-settings-save").click();
    await expect(dialog).toBeHidden();
    const saved = await page.evaluate(() => localStorage.getItem("monotio_agi.aiSettings"));
    await page.getByTestId("catalog-play-adventure-department").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await enterPlayMode(page);
    await page.getByTestId("menu-assistant").click();
    await expect(page.getByTestId("agent-message")).toBeEnabled();
    await page.getByTestId("agent-message").fill("Where next?");
    await page.getByTestId("agent-send").click();
    await requestStarted.promise;
    await openAiSettings(page);
    await dialog.getByTestId("api-key-input").fill("test-rejected-key");
    await dialog.getByTestId("ai-settings-save").click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText("Wait for the current agent task");
    expect(await page.evaluate(() => localStorage.getItem("monotio_agi.aiSettings"))).toBe(saved);
    await dialog.getByTestId("ai-settings-cancel").click();
    answer.resolve();
    await expect(page.getByTestId("agent-conversation")).toContainText("Read the mural.");
    await expect(page.getByTestId("agent-task-controls")).toBeHidden();
    await openAiSettings(page);
    await expect(dialog.getByTestId("api-key-input")).toHaveValue("test-original-key");
    await dialog.getByTestId("ai-settings-cancel").click();
    await page.getByTestId("agent-message").fill("What else?");
    await page.getByTestId("agent-send").click();
    await expect.poll(() => authorizations.length).toBeGreaterThan(1);
    expect(authorizations.every((value) => value === "Bearer test-original-key")).toBe(true);
  } finally {
    answer.resolve();
  }
});

test("a rejected settings write preserves the next Assistant request @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const authorizations: string[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    authorizations.push(route.request().headers()["authorization"]!);
    await route.fulfill(
      providerReply("openai", {
        id: `settings-storage-${authorizations.length}`,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Read the mural." }],
          },
        ],
      }),
    );
  });
  await page.goto("/");
  await openAiSettings(page);
  const dialog = page.getByTestId("ai-settings-dialog");
  await dialog.getByTestId("provider-select").selectOption("openai");
  await dialog.getByTestId("api-key-input").fill("test-stored-key");
  await dialog.getByTestId("effort-select").selectOption("low");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  const saved = await page.evaluate(() => localStorage.getItem("monotio_agi.aiSettings"));
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await enterPlayMode(page);
  await page.getByTestId("menu-assistant").click();
  await expect(page.getByTestId("agent-message")).toBeEnabled();
  await openAiSettings(page);
  await dialog.getByTestId("api-key-input").fill("test-refused-storage-key");
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "monotio_agi.aiSettings") {
        Storage.prototype.setItem = setItem;
        throw new DOMException("Settings storage refused the write.", "QuotaExceededError");
      }
      setItem.call(this, key, value);
    };
  });
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("Settings storage refused the write.");
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.aiSettings"))).toBe(saved);
  await dialog.getByTestId("ai-settings-cancel").click();
  await openAiSettings(page);
  await expect(dialog.getByTestId("api-key-input")).toHaveValue("test-stored-key");
  await dialog.getByTestId("ai-settings-cancel").click();
  await page.getByTestId("agent-message").fill("Where next?");
  await page.getByTestId("agent-send").click();
  await expect.poll(() => authorizations.length).toBeGreaterThan(0);
  expect(authorizations.every((value) => value === "Bearer test-stored-key")).toBe(true);
});

test("changing the shared provider affects the next Ask without losing the conversation", async ({
  page,
}) => {
  await isolateStorage(page);
  const requests: { provider: string; body: string }[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests.push({ provider: "openai", body: route.request().postData()! });
    await route.fulfill(
      providerReply("openai", {
        id: "shared-ai-openai",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The mural is unfinished." }],
          },
        ],
      }),
    );
  });
  await page.route("**/api/anthropic/v1/messages*", async (route) => {
    requests.push({ provider: "anthropic", body: route.request().postData()! });
    await route.fulfill(
      providerReply("anthropic", {
        id: "shared-ai-anthropic",
        type: "message",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Try examining its frame." }],
      }),
    );
  });
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await enterPlayMode(page);
  await page.getByTestId("menu-assistant").click();
  await openAiSettings(page);
  const dialog = page.getByTestId("ai-settings-dialog");
  await dialog.getByTestId("provider-select").selectOption("openai");
  await dialog.getByTestId("api-key-input").fill("test-openai-key");
  await dialog.getByTestId("effort-select").selectOption("low");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  await page.getByTestId("agent-message").fill("What is wrong with the mural?");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("agent-conversation")).toContainText("The mural is unfinished.");
  await expect(page.getByTestId("agent-task-controls")).toBeHidden();
  await openAiSettings(page);
  await dialog.getByTestId("provider-select").selectOption("anthropic");
  await expect(dialog.getByTestId("api-key-input")).toHaveValue("");
  await dialog.getByTestId("api-key-input").fill("test-anthropic-key");
  await dialog.getByTestId("effort-select").selectOption("medium");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  expect(requests).toHaveLength(1);
  await expect(page.getByTestId("agent-conversation")).toContainText("The mural is unfinished.");
  await page.getByTestId("agent-message").fill("What should I try next?");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("agent-conversation")).toContainText("Try examining its frame.");
  expect(requests.map((request) => request.provider)).toEqual(["openai", "anthropic", "anthropic"]);
  expect(requests[1]!.body).toContain("What is wrong with the mural?");
  expect(requests[1]!.body).toContain("The mural is unfinished.");
  expect(requests[1]!.body).toContain("What should I try next?");
  expect(JSON.parse(requests[1]!.body).tools).toEqual([]);
  expect(requests[2]!.body).toContain("Try examining its frame.");
  expect(requests[2]!.body).toContain("What should I try next?");
  expect(JSON.parse(requests[2]!.body).output_config.effort).toBe("medium");
  expect(JSON.parse(requests[0]!.body).reasoning.effort).toBe("low");
  expect(JSON.parse(requests[1]!.body).output_config.effort).toBe("medium");
});
