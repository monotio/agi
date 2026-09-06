import { test, expect } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { textHook } from "../e2e/engineProbe.ts";

test("bundled tutorial previews and plays on the production origin without a provider", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  await page.route(/^https:\/\//, async (route) => {
    externalRequests.push(route.request().url());
    await route.abort();
  });
  await page.goto("/");
  await expect(page.getByTestId("catalog-adventure-department").getByRole("img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect(page.getByTestId("input-line")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).rows[2] ?? "").toContain("HELP");
  await page.getByTestId("input-line").fill("help");
  await page.getByTestId("input-line").press("Enter");
  await expect(page.getByText("[ Press Enter to continue ]", { exact: true })).toBeVisible();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Useful commands");
  await page.screenshot({ path: test.info().outputPath("tutorial-production.png") });
  expect(externalRequests).toEqual([]);
});

test("production origin, isolation, worker and provider policy", async ({ page, request }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(response?.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
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
  const scriptResponse = await request.get(script!);
  expect(scriptResponse.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  const source = await scriptResponse.text();
  const workerPath = source.match(/\/assets\/engine\.worker-[^"'`]+\.js/)?.[0];
  expect(workerPath, "production worker asset is bundled beneath /assets/").toBeTruthy();
  const workerResponse = await request.get(workerPath!);
  expect(workerResponse.ok()).toBe(true);
  expect(workerResponse.headers()["content-type"]).toMatch(/javascript/);
  expect(workerResponse.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  const cartridge = createContainer();
  cartridge.putResource(
    "logic",
    0,
    assembleLogic('display(5, 2, "Production worker ready."); return;', { dictionary: new Map() })
      .payload,
  );
  const profile = await page.evaluate(
    async ({ url, files }) => {
      const worker = new Worker(url, { type: "module" });
      try {
        return await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Worker did not boot and render")),
            10000,
          );
          let profile: string | null = null;
          let rendered = false;
          worker.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("Worker failed to load"));
          };
          worker.onmessage = ({ data }) => {
            if (data.type === "error") {
              clearTimeout(timeout);
              reject(new Error(data.message));
            }
            if (data.type === "booted") profile = data.profile;
            if (data.type === "frame") rendered = data.text.some((cell: number) => cell !== 0);
            if (profile && rendered) {
              clearTimeout(timeout);
              resolve(profile);
            }
          };
          worker.postMessage({ type: "boot", files, words: [], sab: new SharedArrayBuffer(65536) });
        });
      } finally {
        worker.terminate();
      }
    },
    { url: workerPath!, files: Object.fromEntries(cartridge.files) },
  );
  expect(profile).toBe("2.936");
  expect((await request.get("/fixtures/kq1/LOGDIR")).status()).toBe(404);
  const catalog = await request.get("/catalog.json");
  expect(catalog.ok()).toBe(true);
  expect(await catalog.json()).toMatchObject({ format: "monotio.agi.catalog", version: 1 });
});
