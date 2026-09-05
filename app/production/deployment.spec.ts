import { test, expect } from "@playwright/test";

test("production origin, isolation, worker and provider policy", async ({ page, request }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(response?.headers()["cross-origin-embedder-policy"]).toBe("credentialless");
  const policy = response?.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("https://api.openai.com");
  expect(policy).toContain("https://api.anthropic.com");
  expect(policy).not.toContain("unsafe-eval");
  expect(
    await page.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer === "function"),
  ).toBe(true);
  await expect(page.getByRole("heading", { name: "AGI IS HERE." })).toBeVisible();
  await expect(page.getByTestId("installed-game-select")).toBeHidden();
  const script = await page.locator('script[type="module"]').getAttribute("src");
  expect(script).toMatch(/^\/assets\//);
  const source = await (await request.get(script!)).text();
  const workerPath = source.match(/\/assets\/engine\.worker-[^"'`]+\.js/)?.[0];
  expect(workerPath, "production worker asset is bundled beneath /assets/").toBeTruthy();
  const workerResponse = await request.get(workerPath!);
  expect(workerResponse.ok()).toBe(true);
  expect(workerResponse.headers()["content-type"]).toMatch(/javascript/);
  const workerReady = await page.evaluate(async (url) => {
    const worker = new Worker(url, { type: "module" });
    try {
      await new Promise<void>((resolve, reject) => {
        worker.onerror = () => reject(new Error("Worker failed to load"));
        setTimeout(resolve, 1500);
      });
      return true;
    } finally {
      worker.terminate();
    }
  }, workerPath!);
  expect(workerReady).toBe(true);
  expect((await request.get("/fixtures/kq1/LOGDIR")).status()).toBe(404);
});
