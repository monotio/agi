import { expect, test } from "@playwright/test";
import { providerReply } from "../../test/provider-stream.ts";
import { isolateStorage, openAiSettings, textHook } from "./engineProbe.ts";

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
  await page.getByTestId("cartridge-custom").click();
  await page.getByLabel("Adventure name").fill("The Quiet Observatory");
  await page.getByTestId("custom-cartridge-input").fill("Find the missing moon chart.");
  await page.getByTestId("connect-create-ai").click();
  const dialog = page.getByTestId("ai-settings-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("error-panel")).toHaveCount(0);
  await dialog.getByTestId("provider-select").selectOption("openai");
  await dialog.getByTestId("model-select").selectOption("gpt-5.6-sol");
  await expect(dialog.getByTestId("effort-select")).toHaveValue("low");
  await dialog.getByTestId("api-key-input").fill("test-openai-key");
  await dialog.getByTestId("effort-select").selectOption("low");
  await dialog.getByTestId("task-budget").fill("1.23");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Adventure name")).toHaveValue("The Quiet Observatory");
  await expect(page.getByTestId("custom-cartridge-input")).toHaveValue(
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

  await page.getByTestId("power-up").click();
  await openAiSettings(page);
  await dialog.getByTestId("provider-select").selectOption("openai");
  await dialog.getByTestId("api-key-input").fill("test-openai-key");
  await dialog.getByTestId("effort-select").selectOption("low");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await page.getByTestId("agent-mode-ask").click();
  await page.getByTestId("agent-bubble-input").fill("Where should I look next?");
  await openAiSettings(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("agent-bubble")).toBeVisible();
  await expect(page.getByTestId("agent-mode-ask")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("agent-bubble-input")).toHaveValue("Where should I look next?");
  await expect(page.getByTestId("settings-menu")).toBeFocused();
  expect((await textHook(page)).paused).toBe(true);
  expect(providerCalls).toBe(0);
  await page.getByRole("button", { name: "Back to game", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
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
  await page.route("**/api/anthropic/v1/messages", async (route) => {
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
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("power-up").click();
  await openAiSettings(page);
  const dialog = page.getByTestId("ai-settings-dialog");
  await dialog.getByTestId("provider-select").selectOption("openai");
  await dialog.getByTestId("api-key-input").fill("test-openai-key");
  await dialog.getByTestId("effort-select").selectOption("low");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  await page.getByTestId("agent-mode-ask").click();
  await page.getByTestId("agent-bubble-input").fill("What is wrong with the mural?");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-conversation")).toContainText("The mural is unfinished.");
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await openAiSettings(page);
  await dialog.getByTestId("provider-select").selectOption("anthropic");
  await expect(dialog.getByTestId("api-key-input")).toHaveValue("");
  await dialog.getByTestId("api-key-input").fill("test-anthropic-key");
  await dialog.getByTestId("effort-select").selectOption("medium");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  expect(requests).toHaveLength(1);
  await expect(page.getByTestId("agent-conversation")).toContainText("The mural is unfinished.");
  await page.getByTestId("agent-bubble-input").fill("What should I try next?");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-conversation")).toContainText("Try examining its frame.");
  expect(requests.map((request) => request.provider)).toEqual(["openai", "anthropic"]);
  expect(requests[1]!.body).toContain("What is wrong with the mural?");
  expect(requests[1]!.body).toContain("The mural is unfinished.");
  expect(requests[1]!.body).toContain("What should I try next?");
  expect(JSON.parse(requests[0]!.body).reasoning.effort).toBe("low");
  expect(JSON.parse(requests[1]!.body).output_config.effort).toBe("medium");
});
