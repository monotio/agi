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
  await page.getByTestId("scene-toggle-groups").click();
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

test("a group row highlights the union of its members, and a canvas click opens its group", async ({
  page,
}) => {
  await open(page, "1");
  const groups = page.locator('[role="treeitem"][aria-expanded]');
  // More than 40 items: every group starts closed, and no member row is shown.
  expect(await groups.count()).toBeGreaterThan(0);
  for (const expanded of await groups.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("aria-expanded")),
  ))
    expect(expanded).toBe("false");
  await expect(page.locator('[role="treeitem"][aria-level="2"]')).toHaveCount(0);

  // Open the largest group and read its members from the list.
  const header = page.locator(
    await groups.evaluateAll((rows) => {
      const size = (row: Element): number =>
        Number(/· (\d+)$/.exec(row.querySelector(".scene-list__label")?.textContent ?? "")?.[1]);
      const best = rows.reduce((a, b) => (size(b) > size(a) ? b : a));
      return `[data-row="${best.getAttribute("data-row")}"]`;
    }),
  );
  await header.locator('[data-role="twisty"]').click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  const members = await header.evaluate((row) => {
    const ids: string[] = [];
    let next = row.nextElementSibling;
    while (next?.getAttribute("aria-level") === "2") {
      ids.push(next.getAttribute("data-row")!);
      next = next.nextElementSibling;
    }
    return ids;
  });
  expect(members.length).toBeGreaterThan(1);

  await header.hover();
  const union = new Set<number>();
  for (const id of members)
    for (const cell of await kernelMaskCells(page, id, "visual")) union.add(cell);
  expect(await highlightCells(page)).toEqual([...union].sort((a, b) => a - b));

  // Close it again; a click on a member's pixel selects that item and reopens the group.
  await header.locator('[data-role="twisty"]').click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  const cell = (await kernelMaskCells(page, members[0]!, "visual"))[0]!;
  await hoverCell(page, cell % 160, Math.floor(cell / 160));
  await page.mouse.down();
  await page.mouse.up();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`[data-row="${members[0]}"]`)).toHaveAttribute("aria-selected", "true");
});

test("a long list folds into draw-order sections, and a canvas click opens one", async ({
  page,
}) => {
  // 70 one-line items alternating blue and green: 70 rows, more than 60.
  const source = `${Array.from({ length: 70 }, (_, k) =>
    [
      `# @item i${k} "Item ${k}" art`,
      `vis ${1 + (k % 2)}`,
      `line ${2 * k},0 ${2 * k},5`,
      "# @end",
    ].join("\n"),
  ).join("\n")}\nend\n`;
  await page.addInitScript((text) => {
    (window as unknown as { studioHarnessInput: { source: string } }).studioHarnessInput = {
      source: text,
    };
  }, source);
  await open(page, "injected");
  const sections = page.locator('[role="treeitem"][aria-level="1"][aria-expanded]');
  await expect(sections).toHaveCount(36);
  expect(
    new Set(
      await sections.evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-expanded"))),
    ),
  ).toEqual(new Set(["false"]));
  await expect(page.locator('[role="treeitem"][aria-level="2"]')).toHaveCount(0);

  // The first section holds items 0 and 1 (commands 1-4): lines at x 0 and 2, y 0-5.
  const first = page.locator('[data-row="(section)i0"]');
  await expect(first.locator(".scene-list__label")).toHaveText("Steps 1–4");
  await expect(first.locator('[data-role="section-swatches"] i')).toHaveCount(2);
  await first.hover();
  const expected: number[] = [];
  for (let y = 0; y <= 5; y++) expected.push(y * 160, y * 160 + 2);
  expect(await highlightCells(page)).toEqual(expected);

  // Item 40's line is at x 80: clicking it selects the item and opens its section only.
  await hoverCell(page, 80, 3);
  await page.mouse.down();
  await page.mouse.up();
  const item = page.locator('[data-row="i40"]');
  await expect(item).toHaveAttribute("aria-selected", "true");
  await expect(item).toHaveAttribute("aria-level", "2");
  await expect(page.locator('[role="treeitem"][aria-level="1"][aria-expanded="true"]')).toHaveCount(
    1,
  );
});

test("arrow keys on the canvas step through items and Tab leaves it", async ({ page }) => {
  await open(page, "demo");
  const canvas = page.getByRole("group", { name: /^Canvas/ });
  await canvas.focus();
  const selected = page.locator('[role="treeitem"][aria-selected="true"]');
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveAttribute("data-row", "floor");
  await page.keyboard.press("ArrowRight");
  await expect(selected).toHaveAttribute("data-row", "wall");
  await page.keyboard.press("ArrowUp");
  await expect(selected).toHaveAttribute("data-row", "floor");
  await page.keyboard.press("ArrowLeft");
  await expect(selected).toHaveAttribute("data-row", "floor");
  // Tab is never taken by the canvas: one press moves focus on.
  await page.keyboard.press("Tab");
  await expect(canvas).not.toBeFocused();
  await expect(selected).toHaveAttribute("data-row", "floor");
  await page.keyboard.press("Shift+Tab");
  await expect(canvas).toBeFocused();
});

test("studio shortcuts keep working after clicking studio controls", async ({ page }) => {
  await open(page, "demo");
  const lens = (name: string) => page.getByRole("radio", { name: new RegExp(`^${name}`) });
  await lens("Walk").click();
  await page.keyboard.press("2");
  await expect(lens("Depth")).toHaveAttribute("aria-checked", "true");
  // Bands shows only under Depth and Walk: after "1" hides it, keys still land in the studio.
  await page.getByRole("button", { name: "Bands" }).click();
  await page.keyboard.press("1");
  await expect(lens("Art")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("2");
  await expect(lens("Depth")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.keyboard.press("0");
  await expect(page.getByRole("button", { name: "Zoom to fit" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("dragging the scrubber to command k paints exactly renderUpTo(k)", async ({ page }) => {
  await open(page, "1");
  const slider = page.getByRole("slider", { name: "Draw order playhead" });
  const total = Number(await slider.getAttribute("aria-valuemax"));
  // The playhead counts drawing commands: every compiled span but the closing end.
  expect(total).toBe(
    await page.evaluate(() => {
      const { kernel, source, profile } = (window as unknown as HarnessWindow).studioHarness;
      const { document } = kernel.parsePictureDocument(
        kernel.inferNativeItems(source, { profile }),
      );
      return kernel.compileDocument(document, profile).spans.length - 1;
    }),
  );
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
