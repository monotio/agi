import { expect, test } from "./test.ts";
import { configureAi, isolateStorage, openWorkspaceAgent } from "./engineProbe.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import type { Page } from "@playwright/test";

async function start(page: Page) {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Spend proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await configureAi(page, {
    provider: "openai",
    key: "test-placeholder",
    model: "gpt-6-sol",
    budget: 5,
  });
}

for (const size of [
  { width: 1063, height: 815 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`agent reports completed task spend ${size.width} @webkit-desktop`, async ({ page }) => {
    await page.setViewportSize(size);
    await start(page);
    await openWorkspaceAgent(page);
    const panel = page.getByTestId("workspace-agent-panel");
    await expect(panel).toBeVisible();
    expect(await panel.innerText()).not.toContain("$");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/openai/v1/responses", async (route) => {
      await pending;
      await route.fulfill(
        providerReply("openai", {
          id: "spent",
          usage: { input_tokens: 10000, output_tokens: 5000 },
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "The room is ready." }],
            },
          ],
        }),
      );
    });
    try {
      await page.getByTestId("agent-message").fill("Describe this room.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByTestId("agent-stop")).toBeVisible();
      await expect(page.getByTestId("agent-spent")).toBeHidden();
      release();
      await expect(page.getByTestId("agent-message")).toBeEnabled();
      await page.screenshot({
        path: test.info().outputPath(`spent-agent-${size.width}.png`),
        animations: "disabled",
      });
      await expect(page.getByTestId("agent-spent")).toBeVisible();
      await expect(page.getByTestId("agent-spent")).toHaveText("Spent $0.07 of your $5.00 budget");
      await expect(panel.getByRole("link", { name: "See your usage", exact: true })).toBeVisible();
    } finally {
      release();
    }
  });

  test(`image reports completed request spend ${size.width} @webkit-desktop`, async ({ page }) => {
    await page.setViewportSize(size);
    await start(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/test-images/v1/images/generations", async (route) => {
      await pending;
      const pixels = new Uint8Array(1536 * 1024 * 4);
      for (let i = 0; i < pixels.length; i += 4) pixels.set([0, 170, 170, 255], i);
      await route.fulfill({
        json: {
          data: [{ b64_json: Buffer.from(encodePngRgba(1536, 1024, pixels)).toString("base64") }],
          usage: {
            input_tokens_details: { text_tokens: 2000, image_tokens: 3000 },
            output_tokens: 1200,
          },
        },
      });
    });
    if (size.width === 390) await page.getByTestId("workspace-parts").click();
    await page.getByTestId("part-room:1:picture:1").click();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const form = page.getByTestId("generate-form");
    await expect(form).toBeVisible();
    const generator = page.locator(".generate");
    await expect(generator).toBeVisible();
    expect(await generator.innerText()).not.toContain("$");
    await expect(page.getByTestId("generate-spent")).toBeHidden();
    try {
      await page.getByTestId("generate-prompt").fill("A quiet clearing");
      await page.getByTestId("generate-review").click();
      await expect(page.getByTestId("generate-flight")).toBeVisible();
      await expect(page.getByTestId("generate-spent")).toBeHidden();
      release();
      await expect(page.getByTestId("generate-offer")).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath(`spent-image-${size.width}.png`),
        animations: "disabled",
      });
      await expect(page.getByTestId("generate-spent")).toBeVisible();
      await expect(page.getByTestId("generate-spent")).toHaveText(
        "Spent $0.07 of your $5.00 budget",
      );
      await expect(
        page
          .getByTestId("generate-offer")
          .getByRole("link", { name: "See your usage", exact: true }),
      ).toBeVisible();
    } finally {
      release();
    }
  });
}
