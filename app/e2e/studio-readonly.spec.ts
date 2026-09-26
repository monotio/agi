import { expect, test, type Page } from "@playwright/test";
import type { StudioHarnessProbe } from "../src/studio/harness.ts";

/**
 * The read-only Room Studio on its harness (studio-harness.html). Expected
 * pixels and masks come from the kernel evaluated in the page on its own
 * compile of the source, or are hand-placed in the demo picture
 * (src/studio/demoPicture.ts), never from the component's state.
 */

type HarnessWindow = Window & { studioHarness: StudioHarnessProbe };

async function open(page: Page, pic: string): Promise<void> {
  await page.goto(`/studio-harness.html?pic=${pic}`);
  await expect(page.locator(".studio-pane canvas")).toHaveCount(1);
}

/** Cells covered by the hover highlight: its fill path is one `M x y h w v1 h-w z` per row run. */
function highlightCells(page: Page): Promise<number[]> {
  return page.locator('[data-role="hover-fill"]').evaluate((path) => {
    const cells: number[] = [];
    for (const [, x, y, w] of (path.getAttribute("d") ?? "").matchAll(/M(\d+) (\d+)h(\d+)/g))
      for (let i = 0; i < Number(w); i++) cells.push(Number(y) * 160 + Number(x) + i);
    return cells.sort((a, b) => a - b);
  });
}

/** The kernel's mask for an item, on a fresh compile of the harness source. */
function kernelMaskCells(
  page: Page,
  itemId: string,
  plane: "visual" | "priority",
): Promise<number[]> {
  return page.evaluate(
    ([id, which]) => {
      const { kernel, source, profile } = (window as unknown as HarnessWindow).studioHarness;
      const annotated = kernel.inferNativeItems(source, { profile });
      const { document } = kernel.parsePictureDocument(annotated);
      const mask = kernel.itemMask(
        kernel.compileDocument(document, profile),
        document,
        id!,
        which!,
      );
      const cells: number[] = [];
      mask.forEach((bit, i) => bit === 1 && cells.push(i));
      return cells;
    },
    [itemId, plane] as const,
  );
}

/** Move the pointer to the centre of logical cell x,y, placed with the kernel's toScreen. */
async function hoverCell(page: Page, x: number, y: number): Promise<void> {
  const point = await page.locator(".studio-pane").evaluate(
    (pane, [cx, cy]) => {
      const rect = pane.getBoundingClientRect();
      const zoom = rect.height / 168;
      const { toScreen } = (window as unknown as HarnessWindow).studioHarness.kernel;
      const viewport = { zoom, pixelAspect: 2 as const, offsetX: rect.left, offsetY: rect.top };
      const at = toScreen(viewport, cx!, cy!)!;
      return { x: at.x + zoom, y: at.y + zoom / 2 };
    },
    [x, y],
  );
  await page.mouse.move(point.x, point.y);
}

test("hovering a scene row highlights exactly that item's pixels", async ({ page }) => {
  await open(page, "demo");
  await page.locator('[data-row="bench-occluder"]').hover();
  // The occluder is the filled rectangle 40,90..119,105 on the priority plane.
  const box = await page.locator('[data-role="hover-fill"]').evaluate((path) => {
    const { x, y, width, height } = (path as SVGGraphicsElement).getBBox();
    return { x, y, width, height };
  });
  expect(box).toEqual({ x: 40, y: 90, width: 80, height: 16 });
  const expected: number[] = [];
  for (let y = 90; y <= 105; y++) for (let x = 40; x <= 119; x++) expected.push(y * 160 + x);
  expect(await highlightCells(page)).toEqual(expected);

  await open(page, "1");
  for (const id of ["el-1", "el-20"]) {
    await page.locator(`[data-row="${id}"]`).hover();
    const cells = await highlightCells(page);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells).toEqual(await kernelMaskCells(page, id, "visual"));
  }
});

for (const deviceScaleFactor of [1, 2]) {
  test(`hovering a canvas pixel hovers its owner at two zooms (devicePixelRatio ${deviceScaleFactor})`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      deviceScaleFactor,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await open(page, "demo");
    const zoomLevel = page.locator(".studio__zoom-level");
    const zooms: string[] = [];
    for (const step of ["fit", "+"]) {
      if (step === "+") await page.keyboard.press("+");
      zooms.push((await zoomLevel.textContent()) ?? "");
      // 80,97 is inside the art bench and the depth occluder drawn over it.
      await page.keyboard.press("1");
      await hoverCell(page, 80, 97);
      await expect(page.locator(".scene-list__row.is-hover")).toHaveAttribute("data-row", "bench");
      await page.keyboard.press("2");
      await hoverCell(page, 80, 97);
      await expect(page.locator(".scene-list__row.is-hover")).toHaveAttribute(
        "data-row",
        "bench-occluder",
      );
      await expect(page.locator('[data-role="status"]')).toContainText("x 80  y 97");
      // 80,60 is bare wall: the Depth lens falls back to the visual owner.
      await hoverCell(page, 80, 60);
      await expect(page.locator(".scene-list__row.is-hover")).toHaveAttribute("data-row", "wall");
    }
    expect(new Set(zooms).size).toBe(2);
    // The backing store carries the device ratio, so pixels stay crisp.
    const ratio = await page
      .locator(".studio-pane canvas")
      .evaluate(
        (canvas) => (canvas as HTMLCanvasElement).width / canvas.getBoundingClientRect().width,
      );
    expect(ratio).toBe(deviceScaleFactor);

    await hoverCell(page, 80, 97);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('[data-row="bench-occluder"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator('[data-role="announce"]')).toHaveText(
      "Bench occluder, depth, 18 commands",
    );
    await context.close();
  });
}

test("dragging the scrubber to command k paints exactly renderUpTo(k)", async ({ page }) => {
  await open(page, "1");
  const slider = page.getByRole("slider", { name: "Draw order playhead" });
  const total = Number(await slider.getAttribute("aria-valuemax"));
  const k = 38;
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + (box.width * k) / total, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(slider).toHaveAttribute("aria-valuenow", String(k));
  await expect(page.locator(".scrubber__label")).toContainText(`#${k} of ${total}`);

  const mismatches = await page.locator(".studio-pane canvas").evaluate((element, count) => {
    const canvas = element as HTMLCanvasElement;
    const { kernel, source, profile, palette } = (window as unknown as HarnessWindow).studioHarness;
    const { document } = kernel.parsePictureDocument(kernel.inferNativeItems(source, { profile }));
    const expected = kernel.renderUpTo(
      kernel.compileDocument(document, profile),
      count,
      profile,
    ).visual;
    const scaleX = canvas.width / 160;
    const scaleY = canvas.height / 168;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let wrong = 0;
    for (let y = 0; y < 168; y++)
      for (let x = 0; x < 160; x++) {
        const o =
          (Math.floor((y + 0.5) * scaleY) * canvas.width + Math.floor((x + 0.5) * scaleX)) * 4;
        const [r, g, b] = palette[expected[y * 160 + x]!]!;
        if (pixels[o] !== r || pixels[o + 1] !== g || pixels[o + 2] !== b) wrong++;
      }
    return wrong;
  }, k);
  expect(mismatches).toBe(0);

  // The full picture differs from the partial one, so the comparison is not vacuous.
  const differs = await page.evaluate((count) => {
    const { kernel, source, profile } = (window as unknown as HarnessWindow).studioHarness;
    const { document } = kernel.parsePictureDocument(kernel.inferNativeItems(source, { profile }));
    const compiled = kernel.compileDocument(document, profile);
    const partial = kernel.renderUpTo(compiled, count, profile).visual;
    return compiled.visual.some((value, i) => value !== partial[i]);
  }, k);
  expect(differs).toBe(true);
});

test("lens keys switch lenses and studio keys never reach a window listener", async ({ page }) => {
  await open(page, "demo");
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { seenKeys: string[] }).seenKeys = seen;
    for (const type of ["keydown", "keyup", "keypress"])
      window.addEventListener(type, (event) =>
        seen.push(`${type}:${(event as KeyboardEvent).key}`),
      );
  });
  const lens = (name: string) => page.getByRole("radio", { name: new RegExp(`^${name}`) });
  await page.keyboard.press("2");
  await expect(lens("Depth")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-role="band-guides"]')).toHaveCount(1);
  await page.keyboard.press("3");
  await expect(lens("Walk")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-role="control-legend"]')).toContainText("0 · barrier");
  await page.keyboard.press("1");
  await expect(lens("Art")).toHaveAttribute("aria-checked", "true");

  const slider = page.getByRole("slider", { name: "Draw order playhead" });
  const total = Number(await slider.getAttribute("aria-valuemax"));
  await page.keyboard.press(",");
  await expect(slider).toHaveAttribute("aria-valuenow", String(total - 1));
  await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuenow", "0");

  // A keydown dispatched on the studio root itself is handled and stopped there.
  await page
    .locator(".studio")
    .evaluate((root) =>
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true })),
    );
  await expect(lens("Depth")).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => (window as unknown as { seenKeys: string[] }).seenKeys)).toEqual(
    [],
  );

  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as unknown as HarnessWindow).studioHarness.closes)).toBe(
    1,
  );
  expect(await page.evaluate(() => (window as unknown as { seenKeys: string[] }).seenKeys)).toEqual(
    [],
  );
});
