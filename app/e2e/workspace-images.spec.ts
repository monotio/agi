import { test, expect } from "./test.ts";
import { isolateStorage, workspaceUpdated, textHook } from "./engineProbe.ts";
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
  await expect(page.getByTestId("create-adventure-disclosure")).toBeHidden();
  await expect(page.getByTestId("input-line")).toBeEnabled();
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
  // Retain a transparent corner inside each figure's bounding box.
  for (let f = 0; f < 4; f++) pixels.set([0, 0, 0, 0], (2 * 40 + f * 10 + 2) * 4);
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
  await workspaceUpdated(page);
  await page.getByTestId("trace-opacity").fill("0.7");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
          ).__AGI_PROJECT__
            .getSession()
            .workingSnapshot()
            .read("images")?.content,
      ),
    )
    .toContain('"opacity":0.7');
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  const referencePixel = await page.locator('[data-layer="art"] canvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return [
      ...canvas
        .getContext("2d")!
        .getImageData(
          Math.floor((canvas.width * 32) / 160),
          Math.floor((canvas.height * 80) / 168),
          1,
          1,
        ).data,
    ];
  });
  expect(Math.abs(referencePixel[0]! - (170 * 0.7 + 255 * 0.3))).toBeLessThanOrEqual(1);
  // Cover samples the second figure, whose orange snaps to EGA brown (170, 85, 0).
  expect(Math.abs(referencePixel[1]! - (85 * 0.7 + 255 * 0.3))).toBeLessThanOrEqual(1);
  expect(Math.abs(referencePixel[2]! - 255 * 0.3)).toBeLessThanOrEqual(1);
  await workspaceUpdated(page);
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
  await workspaceUpdated(page);
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
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __AGI_PROJECT__: {
                getSession(): ProjectSession;
              };
            }
          ).__AGI_PROJECT__
            .getSession()
            .workingSnapshot()
            .read("images")?.content,
      ),
    )
    .toContain('"opacity":0.7');
  await imageShot(page, "trace-drawing");
  await page
    .getByTestId("image-reference")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  await expect(page.getByTestId("trace-opacity")).toHaveValue("0.7");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("trace-opacity")).toBeVisible();
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
            .workingSnapshot()
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
  const toggle = page.getByRole("button", { name: "Pause animation", exact: true });
  await expect(toggle.locator("svg")).toBeVisible();
  await toggle.click();
  await expect(page.getByRole("button", { name: "Play animation", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByRole("button", { name: "Play animation", exact: true }).click();
  const transparency = page.getByRole("switch", { name: "Background is see-through", exact: true });
  await expect(transparency).toHaveAttribute("aria-checked", "true");
  await transparency.click();
  await expect(transparency).toHaveAttribute("aria-checked", "false");
  const preview = page.getByRole("img", { name: "Loop 0 animation", exact: true });
  await expect
    .poll(() =>
      preview.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data[3];
      }),
    )
    .toBe(255);
  await transparency.click();
  await expect
    .poll(() =>
      preview.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data[3];
      }),
    )
    .toBe(0);
  const size = await preview.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      celWidth: canvas.width,
      celHeight: canvas.height,
      panel: canvas.parentElement!.clientWidth,
    };
  });
  expect(size.width / (size.celWidth * 2)).toBe(size.height / size.celHeight);
  expect(Number.isInteger(size.height / size.celHeight)).toBe(true);
  expect(size.width).toBeGreaterThan(size.panel - size.celWidth * 2);
  const celHeight = page.getByLabel("Cel height", { exact: true });
  await expect(celHeight).toBeVisible();
  const originalHeight = await celHeight.inputValue();
  await celHeight.fill("168");
  await expect
    .poll(() =>
      preview.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return [canvas.clientWidth / (canvas.width * 2), canvas.clientHeight / canvas.height];
      }),
    )
    .toEqual([1, 1]);
  await celHeight.fill(originalHeight);
  await page.getByTestId("image-preview-hero").click();
  await expect(page.getByTestId("image-preview-hero")).toBeVisible();
  await expect(page.getByTestId("image-preview-hero")).toHaveText("Stop preview");
  const before = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(before);
  const colours = new Set<number>();
  let previewStarted = false;
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
        // The worker loads the preview after the button changes state. Begin
        // collecting once its first cel is visible, then retain every colour.
        if (!previewStarted) previewStarted = colour === 4 || colour === 6;
        if (previewStarted && colour !== undefined) colours.add(colour);
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
  // Hold staging so Update cannot overtake the image operation.
  await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const stage = session.stage.bind(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (window as unknown as { releaseImageStage: () => void }).releaseImageStage = release;
    session.stage = async (changes) => {
      await gate;
      return stage(changes);
    };
  });
  await page.getByTestId("image-add-cels").click();
  await expect(page.getByTestId("workspace-update")).toBeDisabled();
  await page.evaluate(() => {
    (window as unknown as { releaseImageStage: () => void }).releaseImageStage();
  });
  await expect(page.getByTestId("image-status")).toHaveText("Added 4 cels");
  await page.getByTestId("workspace-update").click();
  await expect(page.getByTestId("workspace-updated")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await expect(page.getByTestId("image-status")).toBeVisible();
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
test("Generate sends one styled request and Use image opens tracing @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
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
    expect(request.prompt).toContain("Sierra AGI");
    expect(request.prompt).toContain("A tree reference");
    expect(request.size).toBe("1536x1024");
    const pixels = new Uint8Array(1536 * 1024 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([255, 0, 0, 255], i);
    await route.fulfill({
      json: {
        data: [{ b64_json: Buffer.from(encodePngRgba(1536, 1024, pixels)).toString("base64") }],
      },
    });
  });
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByTestId("room-studio")).not.toHaveClass(/is-live-game/);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('[data-layer="art"] canvas').hover();
  const normalCanvas = (await page.locator('[data-layer="art"] canvas').boundingBox())!;
  const normalEditor = (await page.getByTestId("workspace-editor").boundingBox())!;
  await page.getByRole("button", { name: "Generate", exact: true }).click({ timeout: 8000 });
  await page.getByTestId("generate-prompt").fill("A tree reference");
  await page.getByTestId("generate-review").click();
  await expect(page.getByTestId("generate-review-sheet")).toHaveCount(0);
  await expect(page.getByTestId("generate-offer")).toBeVisible();
  await expect(page.getByTestId("generate-use")).toHaveText("Use image");
  await expect(page.getByTestId("generate-again")).toHaveText("Generate again");
  await expect(page.getByTestId("generate-dismiss")).toHaveText("Edit prompt");
  // Use decodes and hashes the offered image before staging it. Await the
  // staging receipt so these assertions follow that work even on a busy browser.
  await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const stage = session.stage.bind(session);
    const admission = new Promise<void>((resolve, reject) => {
      session.stage = async (changes) => {
        try {
          const result = await stage(changes);
          if (changes.some(({ key }) => key.startsWith("attachment:"))) resolve();
          return result;
        } catch (cause) {
          reject(cause);
          throw cause;
        }
      };
    });
    (window as unknown as { traceAdmission: Promise<void> }).traceAdmission = admission;
  });
  await page.getByTestId("generate-use").click();
  await page.evaluate(
    () => (window as unknown as { traceAdmission: Promise<void> }).traceAdmission,
  );
  await expect(page.getByTestId("trace-opacity")).toBeVisible();
  await expect(page.getByTestId("generate-offer")).toBeHidden();
  // Flush the admitted image before checking its saved document.
  await page.evaluate(() =>
    (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
      .getSession()
      .flush(),
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
          .getSession()
          .workingSnapshot()
          .read("images")?.content,
    ),
  ).toContain("A tree reference");
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await expect(page.getByTestId("room-studio")).not.toHaveClass(/is-live-game/);
  const generatedCanvas = (await page.locator('[data-layer="art"] canvas').boundingBox())!;
  const generatedEditor = (await page.getByTestId("workspace-editor").boundingBox())!;
  expect(generatedCanvas.width).toBe(normalCanvas.width);
  expect(generatedCanvas.height).toBe(normalCanvas.height);
  expect(generatedEditor.width).toBe(normalEditor.width);
  expect(generatedEditor.x).toBe(normalEditor.x);
  expect(requests).toBe(1);
  await imageShot(page, "generated-trace");
});

for (const viewport of [
  { width: 1063, height: 815 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`image controls ${viewport.width} @webkit-desktop`, async ({ page, browserName }) => {
    await page.setViewportSize(viewport);
    await start(page);
    if (viewport.width < 600)
      await page.getByRole("button", { name: "Parts", exact: true }).click();
    await page.getByTestId("part-room:1:picture:1").click();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect(page.getByTestId("generate-prompt")).toBeVisible();
    await page.getByTestId("generate-prompt").fill("A quiet forest with a path to a cottage");
    const shot = await page.screenshot({
      path: test.info().outputPath(`image-controls-${viewport.width}.png`),
      animations: "disabled",
      scale: "css",
    });
    if (process.env["CI"] && browserName === "webkit" && viewport.width === 390)
      console.log(`FRAME_SHOT:image-controls-${viewport.width}:${shot.toString("base64")}`);
    const panel = page.getByTestId("image-reference");
    await expect(panel).toBeVisible();
    await expect
      .poll(async () => {
        const box = (await panel.boundingBox())!;
        const generation = (await panel.locator(".image-reference__generation").boundingBox())!;
        return Math.max(box.y + box.height, generation.y + generation.height);
      })
      .toBeLessThanOrEqual(viewport.height);
    await panel.getByTestId("generate-review").scrollIntoViewIfNeeded();
    await expect(panel.getByTestId("generate-review")).toBeInViewport({ ratio: 1 });
  });
  test(`cel image controls receive clicks at ${viewport.width} @webkit-desktop`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize(viewport);
    await start(page);
    if (viewport.width < 600)
      await page.getByRole("button", { name: "Parts", exact: true }).click();
    await page.getByTestId("part-view:0").click();
    await page.getByRole("button", { name: "Make cels from an image", exact: true }).click();
    await upload(page);
    await expect(page.getByTestId("image-frame")).toHaveCount(4);
    const preview = page.getByTestId("image-preview-hero");
    await expect(preview).toHaveText("Preview on hero");
    await preview.scrollIntoViewIfNeeded();
    const shot = await page.screenshot({
      path: test.info().outputPath(`image-cels-${viewport.width}.png`),
      animations: "disabled",
      scale: "css",
    });
    if (process.env["CI"] && browserName === "webkit" && viewport.width === 390)
      console.log(`FRAME_SHOT:image-cels-${viewport.width}:${shot.toString("base64")}`);
    await expect(
      page.getByTestId("workspace-status").getByRole("button", { name: "Zoom in", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        preview.evaluate((button) => {
          const box = button.getBoundingClientRect();
          return button.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          );
        }),
      )
      .toBe(true);
    await expect(preview).toBeInViewport({ ratio: 1 });
    await preview.click();
    await expect(preview).toHaveText("Stop preview");
    await preview.click();
    const add = page.getByTestId("image-add-cels");
    await expect(add).toBeVisible();
    await add.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(add).toBeInViewport({ ratio: 1 });
  });
}

test("rewind preserves saved PNG attachments and trace settings", async ({ page }) => {
  await start(page);
  await blankRoom(page);
  await page.getByTestId("part-room:1:picture:1").click();
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  await upload(page);
  const images = () =>
    page.evaluate(() => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      return session.workingSnapshot().read("images")?.content;
    });
  await expect.poll(images).toContain('"opacity":0.4');
  await workspaceUpdated(page);
  await page.evaluate(() =>
    (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
      .getSession()
      .flush(),
  );
  const saved = await images();
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await page.getByTestId("btn-transport-pause").click();
  const timeline = page.getByTestId("history-timeline");
  await expect(timeline).toBeVisible();
  await expect(timeline).toHaveAttribute("aria-valuenow", "100");
  const box = (await timeline.boundingBox())!;
  await timeline.click({ position: { x: box.width * 0.2, y: box.height / 2 } });
  await expect(page.getByTestId("btn-history-resume")).toBeEnabled();
  await page.getByTestId("btn-history-resume").click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__AGI_STATE__;
        return (
          state?.powerUp.busy === false &&
          !state.historyView.parked &&
          !state.historyView.loading &&
          !state.historyView.active
        );
      }),
    )
    .toBe(true);
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(images).toBe(saved);
});

for (const close of [false, true]) {
  test(`trace opacity set before upload commits keeps the latest release${close ? " after Done" : ""}`, async ({
    page,
  }) => {
    await start(page);
    await blankRoom(page);
    await page.getByTestId("part-room:1:picture:1").click();
    await page.getByRole("button", { name: "Trace an image", exact: true }).click();
    // Hold admission at the upload boundary so the visible slider can be used first.
    await page.evaluate(() => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const stage = session.stage.bind(session);
      const admitted = new Promise<void>((resolve) =>
        window.addEventListener("admit-trace-upload", () => resolve(), { once: true }),
      );
      session.stage = async (changes) => {
        if (changes.some(({ key }) => key.startsWith("attachment:"))) await admitted;
        return stage(changes);
      };
    });
    await upload(page);
    const slider = page.getByTestId("trace-opacity");
    await expect(slider).toBeVisible();
    await slider.fill("0.7");
    await slider.fill("0.9");
    if (close)
      await page
        .getByTestId("image-reference")
        .getByRole("button", { name: "Done", exact: true })
        .click();
    await page.evaluate(() => window.dispatchEvent(new Event("admit-trace-upload")));
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
            ).__AGI_PROJECT__
              .getSession()
              .workingSnapshot()
              .read("images")?.content,
        ),
      )
      .toContain('"opacity":0.9');
    if (close) await page.getByRole("button", { name: "Trace an image", exact: true }).click();
    await expect(slider).toHaveValue("0.9");
    await expect(page.getByTestId("image-reference").getByRole("alert")).toHaveCount(0);
    await expect(page.getByTestId("workspace-saved")).toBeVisible();
    await expect(page.getByTestId("workspace-saved")).toBeVisible();
    await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  });
}

test("trace opacity previews during input and serializes quick releases", async ({ page }) => {
  await start(page);
  await blankRoom(page);
  await page.getByTestId("part-room:1:picture:1").click();
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  // Keep upload completion parked after its draft exists, as a slow admission can.
  await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const stage = session.stage.bind(session);
    const completion = new Promise<void>((resolve) =>
      window.addEventListener("complete-trace-upload", () => resolve(), { once: true }),
    );
    session.stage = async (changes) => {
      const result = await stage(changes);
      if (changes.some(({ key }) => key.startsWith("attachment:"))) await completion;
      return result;
    };
  });
  await upload(page);
  const slider = page.getByTestId("trace-opacity");
  await expect(slider).toBeVisible();
  const art = page.locator('[data-layer="art"] canvas');
  await expect(art).toBeVisible();
  const traceRed = () =>
    art.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return canvas
        .getContext("2d")!
        .getImageData(
          Math.floor((canvas.width * 32) / 160),
          Math.floor((canvas.height * 80) / 168),
          1,
          1,
        ).data[0]!;
    });
  const saved = () =>
    page.evaluate(() => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      return {
        images: session.workingSnapshot().read("images")?.content,
        commits: session.capture().history.commits.length,
      };
    });
  await expect.poll(async () => (await saved()).images).toContain('"opacity":0.4');
  const before = await saved();
  await slider.evaluate((element) => {
    const slider = element as HTMLInputElement;
    slider.value = "0.9";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    window.dispatchEvent(new Event("complete-trace-upload"));
  });
  // EGA brown (170) over white at 0.9 opacity: 170 * 0.9 + 255 * 0.1 = 178.5.
  await expect.poll(async () => Math.abs((await traceRed()) - 178.5)).toBeLessThanOrEqual(1);
  expect(await saved()).toEqual(before);
  await slider.evaluate((element) => {
    const slider = element as HTMLInputElement;
    for (const value of ["0.6", "0.8"]) {
      slider.value = value;
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await expect.poll(async () => (await saved()).images).toContain('"opacity":0.8');
  await expect(page.getByTestId("image-reference").getByRole("alert")).toHaveCount(0);
  await expect(slider).toHaveValue("0.8");
  await expect.poll(async () => Math.abs((await traceRed()) - 187)).toBeLessThanOrEqual(1);
});

test("trace arrow keys stay draft until Update makes one History step", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await page.getByTestId("part-room:1:picture:1").click();
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  await upload(page);
  const handle = page.getByRole("button", { name: "Move trace", exact: true });
  await expect(handle).toBeVisible();
  const count = () =>
    page.evaluate(
      () =>
        (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
          .getSession()
          .capture().history.commits.length,
    );
  const before = await count();
  await handle.focus();
  for (let index = 0; index < 4; index++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Tab");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__
          .getSession()
          .workingSnapshot()
          .read("images")?.content;
        return typeof content === "string"
          ? JSON.parse(content).traces["picture:1"].transform.x
          : undefined;
      }),
    )
    .toBe(4);
  expect(await count()).toBe(before);
  await expect(page.getByTestId("workspace-pending")).toBeVisible();
  await workspaceUpdated(page);
  expect(await count()).toBe(before + 1);
});
