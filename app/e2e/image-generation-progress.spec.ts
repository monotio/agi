import { createServer } from "node:http";
import { test, expect } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { encodePngRgb } from "../../scripts/png.ts";
import type { Page } from "@playwright/test";
async function start(page: Page) {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Drawing");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.evaluate(() =>
    localStorage.setItem(
      "monotio_agi.aiSettings",
      JSON.stringify({
        version: 1,
        provider: "openai",
        profiles: {
          openai: { apiKey: "test-image-key", model: "gpt-6-sol", effort: "medium" },
          anthropic: { apiKey: "", model: "claude-sonnet-5-5", effort: "medium" },
          stub: { apiKey: "", model: "stub", effort: "medium" },
        },
      }),
    ),
  );
}
const png = Buffer.from(
  encodePngRgb(1024, 1024, new Uint8Array(1024 * 1024 * 3).fill(170)),
).toString("base64");
test(
  "partial images show actual spend and Stop closes the stub stream",
  { tag: "@webkit-desktop" },
  async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let cancelled = false,
      requests = 0;
    const server = createServer(async (request, response) => {
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-headers", "authorization,content-type");
      response.setHeader("access-control-allow-methods", "POST,OPTIONS");
      if (request.method === "OPTIONS") {
        response.end();
        return;
      }
      request.resume();
      requests++;
      response.on("close", () => {
        if (!response.writableEnded) cancelled = true;
      });
      response.setHeader("content-type", "text/event-stream");
      response.write(
        `data: ${JSON.stringify({ type: "image_generation.partial_image", partial_image_index: 0, b64_json: png })}\n\n`,
      );
      await finished;
      if (!response.destroyed)
        response.end(
          `data: ${JSON.stringify({ type: "image_generation.completed", b64_json: png, output_format: "png" })}\n\n`,
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Stub image server did not start.");
    try {
      await page.route("**/api/test-images/v1/images/generations", (route) =>
        route.continue({ url: `http://127.0.0.1:${address.port}/images` }),
      );
      await start(page);
      await page.getByTestId("part-room:1:picture:1").click();
      await page.getByRole("button", { name: "Generate", exact: true }).click();
      await page.getByTestId("generate-prompt").fill("A quiet forest");
      await page.getByTestId("generate-review").click();
      await expect(page.getByTestId("generate-flight")).toBeVisible();
      await expect(page.getByTestId("generate-flight")).toContainText("Drawing your picture…");
      await expect(page.getByTestId("generate-partial")).toBeVisible();
      await expect(page.getByTestId("generate-cancel")).toBeVisible();
      await expect(page.getByTestId("generate-cancel")).toHaveText("Stop");
      await expect(page.getByTestId("generate-spent")).toBeVisible();
      await expect(page.getByTestId("generate-spent")).toHaveText(
        "Spent $0.00 of your $5.00 budget",
      );
      await expect(page.getByTestId("generate-elapsed")).toBeVisible();
      await expect(page.getByTestId("generate-elapsed")).toHaveText(/[1-9]\d*s/);
      await page.screenshot({
        path: test.info().outputPath("drawing-progress.png"),
        animations: "disabled",
      });
      await page.getByTestId("generate-cancel").click();
      await expect(page.getByTestId("generate-form")).toBeVisible();
      await expect.poll(() => cancelled).toBe(true);
      finish();
      await expect(page.getByTestId("generate-offer")).toBeHidden();
      expect(requests).toBe(1);
    } finally {
      finish();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
test("VIEW generation uses sprite style and Use this opens the cel sheet", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let requests = 0;
  await page.route("**/api/test-images/v1/images/generations", async (route) => {
    requests++;
    const request = route.request().postDataJSON();
    expect(request.prompt).toContain("small side-view sprite");
    expect(request.prompt).toContain("A fox");
    expect(request.background).toBe("transparent");
    await route.fulfill({ json: { data: [{ b64_json: png }] } });
  });
  await start(page);
  await page.getByTestId("part-view:0").click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.getByTestId("generate-prompt").fill("A fox");
  await expect(page.getByTestId("generate-options-body")).toBeHidden();
  await page.getByTestId("generate-options").click();
  await expect(page.getByTestId("generate-style")).toBeVisible();
  await expect(page.getByTestId("generate-style")).toContainText("transparent background");
  await page.getByTestId("generate-review").click();
  await expect(page.getByTestId("generate-offer")).toBeVisible();
  await page.getByTestId("generate-use").click();
  await expect(page.getByTestId("image-reference")).toBeVisible();
  await expect(page.getByTestId("image-reference")).toContainText("Cels from an image");
  await expect(page.getByTestId("generate-offer")).toBeHidden();
  expect(requests).toBe(1);
});
