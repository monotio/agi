import { test, expect } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
function imageShot(page: Page, name: string) {
  return page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled" });
}
async function start(page: Page) {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Image proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!(
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession | null } }
          ).__AGI_PROJECT__.getSession(),
      ),
    )
    .toBe(true);
}
function sheet() {
  const pixels = new Uint8Array(40 * 12 * 4);
  for (let f = 0; f < 4; f++)
    for (let y = 2; y < 11; y++)
      for (let x = 2; x < 8; x++) pixels.set([255, f * 50, 0, 255], (y * 40 + f * 10 + x) * 4);
  return Buffer.from(encodePngRgba(40, 12, pixels));
}
async function blankRoom(page: Page) {
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Blank room", [
        { key: "picture:1", content: "end" },
      ]),
      label: "Blank room",
      origin: "picture",
      author: "creator",
    });
  });
}
async function upload(page: Page) {
  await page
    .getByTestId("image-file")
    .setInputFiles({ name: "walk.png", mimeType: "image/png", buffer: sheet() });
}
test("trace an attachment and draw over it with normal tools", async ({ page }) => {
  await start(page);
  await blankRoom(page);
  await page.getByTestId("part-room:1:picture:1").click();
  await page.getByRole("button", { name: "Trace an image", exact: true }).click({ timeout: 8000 });
  await upload(page);
  await expect(page.getByTestId("trace-opacity")).toBeVisible();
  await page.getByTestId("trace-opacity").fill("0.7");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
          ).__AGI_PROJECT__
            .getSession()
            .model.capture()
            .read("images")?.content,
      ),
    )
    .toContain('"opacity":0.7');
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
  const referencePixel = await page.locator('[data-layer="art"] canvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return [
      ...canvas
        .getContext("2d")!
        .getImageData(
          Math.floor((canvas.width * 20) / 160),
          Math.floor((canvas.height * 80) / 168),
          1,
          1,
        ).data,
    ];
  });
  expect(referencePixel[0]).toBe(255);
  expect(referencePixel[1]).toBeLessThan(100);
  expect(referencePixel[2]).toBe(referencePixel[1]);
  const commits = await page.evaluate(
    () =>
      (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
        .getSession()
        .capture().history.commits.length,
  );
  const studio = page.getByTestId("room-studio");
  await studio.locator('[data-tool="rect"]').click();
  await studio.getByTestId("studio-tool-filled").check();
  await studio.locator('.workspace-palette [data-colour="4"]').click();
  const box = (await studio.locator('[data-layer="art"] canvas').boundingBox())!;
  const zoom = box.height / 168;
  await page.mouse.move(box.x + 20.5 * 2 * zoom, box.y + 110.5 * zoom);
  await page.mouse.down();
  await page.mouse.move(box.x + 40.5 * 2 * zoom, box.y + 130.5 * zoom, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[120 * 160 + 30]))
    .toBe(4);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
          ).__AGI_PROJECT__
            .getSession()
            .capture().history.commits.length,
      ),
    )
    .toBe(commits + 1);
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __AGI_PROJECT__: {
                getSession(): {
                  model: { capture(): { read(key: string): { content: string } | undefined } };
                };
              };
            }
          ).__AGI_PROJECT__
            .getSession()
            .model.capture()
            .read("images")?.content,
      ),
    )
    .toContain('"opacity":0.7');
  await imageShot(page, "trace-drawing");
  await page
    .getByTestId("image-reference")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  await expect(page.getByTestId("trace-opacity")).toHaveValue("0.7");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("trace-opacity")).toHaveValue("0.4");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.getByTestId("trace-opacity")).toHaveValue("0.7");
  await page.evaluate(
    (bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(bytes)], "paste.png", { type: "image/png" }));
      document.body.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    },
    [...sheet()],
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
          ).__AGI_PROJECT__
            .getSession()
            .model.capture()
            .read("images")?.content,
      ),
    )
    .toContain("Pasted image");
});
test("make a four-cel walk loop and preview it on the running hero", async ({ page }) => {
  await start(page);
  await page.getByTestId("part-view:0").click();
  await page
    .getByRole("button", { name: "Make cels from an image", exact: true })
    .click({ timeout: 8000 });
  await upload(page);
  await expect(page.getByTestId("image-frame")).toHaveCount(4);
  await page.getByTestId("image-preview-hero").click();
  await expect(page.getByTestId("image-preview-hero")).toHaveText("Stop preview");
  const before = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(before);
  const colours = new Set<number>();
  await expect
    .poll(
      async () => {
        const colour = await page.evaluate(async () => {
          const api = (
            window as unknown as {
              __AGI_PROJECT__: {
                query(type: "objects"): Promise<{ num: number; x: number; y: number }[]>;
              };
            }
          ).__AGI_PROJECT__;
          const hero = (await api.query("objects")).find((object) => object.num === 0)!;
          return window.__AGI_FRAME__?.()?.visual[(hero.y - 6) * 160 + hero.x + 2];
        });
        if (colour !== undefined) colours.add(colour);
        return [...colours].sort((a, b) => a - b);
      },
      { intervals: [80], timeout: 8000 },
    )
    .toEqual([4, 6]);
  await imageShot(page, "walk-preview");
  const commits = await page.evaluate(
    () =>
      (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
        .getSession()
        .capture().history.commits.length,
  );
  await page.getByTestId("image-add-cels").click();
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
  await expect(page.getByTestId("image-status")).toHaveText("Added 4 cels");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
          ).__AGI_PROJECT__
            .getSession()
            .capture().history.commits.length,
      ),
    )
    .toBe(commits + 1);
  await imageShot(page, "walk-cels");
});
test("generation reviews a request and sends only through the mocked provider", async ({
  page,
}) => {
  await start(page);
  await blankRoom(page);
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
  let requests = 0;
  await page.route("**/api/test-images/v1/images/generations", async (route) => {
    requests++;
    const request = route.request().postDataJSON();
    expect(request.model).toBe("gpt-image-2.5-sunburst");
    expect(request.n).toBe(1);
    const pixels = new Uint8Array(1024 * 1024 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([255, 0, 0, 255], i);
    await route.fulfill({
      json: {
        data: [{ b64_json: Buffer.from(encodePngRgba(1024, 1024, pixels)).toString("base64") }],
      },
    });
  });
  await page.getByTestId("part-room:1:picture:1").click();
  await page.getByRole("button", { name: "Generate", exact: true }).click({ timeout: 8000 });
  await page.getByTestId("generate-prompt").fill("A tree reference");
  await page.getByTestId("generate-review").click();
  await expect(page.getByTestId("generate-review-sheet")).toContainText("Estimated cost");
  expect(requests).toBe(0);
  await imageShot(page, "generation-review");
  await page.getByTestId("generate-submit").click();
  await expect(page.getByTestId("generate-offer")).toBeVisible();
  await page.getByTestId("generate-use").click();
  await expect(page.getByTestId("trace-opacity")).toBeVisible();
  await expect(page.getByTestId("generate-offer")).toBeHidden();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
            ).__AGI_PROJECT__
              .getSession()
              .model.capture()
              .read("images")?.content,
        ),
      { timeout: 15000 },
    )
    .toContain("A tree reference");
  await page.evaluate(() =>
    (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
      .getSession()
      .flush(),
  );
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
  await expect(page.getByTestId("room-studio")).not.toHaveClass(/is-live-game/);
  expect(requests).toBe(1);
  await imageShot(page, "generated-trace");
});
