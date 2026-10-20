import { expect, test } from "./test.ts";
import type { Page } from "@playwright/test";
import type { StudioHarnessProbe } from "../src/studio/harness.ts";

/**
 * The standIn actor probe on its harness (studio-harness.html?probe=1): the
 * demo picture's art pane at zoom 3 with the tutorial's character VIEWs. The
 * expected masks come from `probeActor` evaluated in the page on the kernel's
 * own compile of the demo source, never from the component's state.
 */

type HarnessWindow = Window & { studioHarness: StudioHarnessProbe };

async function open(page: Page): Promise<void> {
  await page.goto("/studio-harness.html?pic=demo&probe=1");
  await expect(page.getByTestId("stand-in-probe-handle")).toBeVisible();
}

/** Screen point of the centre of logical cell x,y, placed with the kernel's toScreen. */
function cellPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.locator(".studio-pane").evaluate(
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
}

/** Drag the standIn by its baseline-left cell from (fromX, fromY) to (toX, toY). */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const start = await cellPoint(page, from[0], from[1]);
  const end = await cellPoint(page, to[0], to[1]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

/** Cells of a `maskFillPath` path: one `M x y h w v1 h-w z` per row run. */
function pathCells(page: Page, selector: string): Promise<number[]> {
  return page.locator(selector).evaluate((path) => {
    const cells: number[] = [];
    for (const [, x, y, w] of (path.getAttribute("d") ?? "").matchAll(/M(\d+) (\d+)h(\d+)/g))
      for (let i = 0; i < Number(w); i++) cells.push(Number(y) * 160 + Number(x) + i);
    return cells.sort((a, b) => a - b);
  });
}

/** probeActor for VIEW 0 loop 0 cel 0 at x, baselineY on a fresh compile of the demo source. */
function expected(page: Page, x: number, baselineY: number) {
  return page.evaluate(
    ([px, py]) => {
      const { kernel, source, profile, standInViews } = (window as unknown as HarnessWindow)
        .studioHarness;
      const { document } = kernel.parsePictureDocument(
        kernel.inferNativeItems(source, { profile }),
      );
      const compiled = kernel.compileDocument(document, profile);
      const view = kernel.parseView(Uint8Array.from(standInViews[0]!), profile);
      const result = kernel.probeActor({
        picture: compiled,
        cel: kernel.selectViewCel(view, 0, 0)!,
        x: px!,
        baselineY: py!,
        priority: "band",
        profile,
      });
      const hidden: number[] = [];
      result.hiddenMask.forEach((bit, i) => bit === 1 && hidden.push(i));
      return { hidden, bandPriority: result.bandPriority, controlHits: result.controlHits };
    },
    [x, baselineY],
  );
}

test("a standIn dragged behind the bench occluder is hidden exactly where probeActor says @webkit-desktop", async ({
  page,
}) => {
  await open(page);
  const readout = page.getByTestId("stand-in-probe-readout");
  await expect(readout.getByRole("heading")).toHaveText("Stand-in");
  // The readout sits beside the picture: on the art, only the standIn and its handle.
  const art = (await page.locator(".studio-pane").boundingBox())!;
  expect((await readout.boundingBox())!.x).toBeGreaterThanOrEqual(art.x + art.width);
  // The harness starts the standIn at x 60, baseline 100; take it to the open floor first.
  await drag(page, [60, 100], [70, 150]);
  await expect(readout.locator('[data-role="stand-in-band"]')).toContainText("x 70 y 150");
  await expect(readout.locator('[data-role="stand-in-verdict"]')).toHaveAttribute(
    "data-kind",
    "front",
  );
  expect(await pathCells(page, '[data-role="stand-in-hidden"]')).toEqual([]);

  // Behind the bench: the occluder is priority 10 over 40..119 x 90..105.
  await drag(page, [70, 150], [60, 100]);
  const want = await expected(page, 60, 100);
  expect(want.bandPriority).toBe(9);
  expect(want.hidden.length).toBeGreaterThan(0);
  expect(await pathCells(page, '[data-role="stand-in-hidden"]')).toEqual(want.hidden);
  await expect(readout.locator('[data-role="stand-in-band"]')).toContainText(
    "x 60 y 100 → priority band 9",
  );
  const verdict = readout.locator('[data-role="stand-in-verdict"]');
  await expect(verdict).toHaveAttribute("data-kind", "behind");
  await expect(verdict).toContainText("Behind Bench priority");
  await expect(verdict).toContainText(`${want.hidden.length} of`);
  await expect(verdict).toContainText("hidden");
  await page.screenshot({
    path: test.info().outputPath("stand-in-probe-occlusion.png"),
    animations: "disabled",
  });
});

test("moving onto the floor-edge barrier reports its cells; keys nudge, cycle and toggle @webkit-desktop", async ({
  page,
}) => {
  await open(page);
  const readout = page.getByTestId("stand-in-probe-readout");
  // Row 113 is plain floor; the barrier segment runs along y 114 from x 30 to 129.
  await drag(page, [60, 100], [60, 113]);
  await expect(readout.locator('[data-role="stand-in-controls"]')).toContainText(
    "No walk lines under the feet",
  );
  await page.keyboard.press("Shift+ArrowDown");
  const want = await expected(page, 60, 114);
  const barrier = want.controlHits.find((hit) => hit.value === 0)!;
  expect(barrier.cells.map((cell) => cell.x)).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
  const hit = readout.locator('[data-role="stand-in-control-hit"][data-value="0"]');
  await expect(hit).toHaveText("0 · Wall: x 60–69 at y 114");
  await expect(readout).toContainText("Stopped at a Wall");
  const marked = await page
    .locator('rect[data-role="stand-in-control"][data-value="0"]')
    .evaluateAll((rects) => rects.map((r) => `${r.getAttribute("x")},${r.getAttribute("y")}`));
  expect(marked).toEqual(barrier.cells.map((cell) => `${cell.x},${cell.y}`));

  // Arrows cycle cel and loop while the standIn has focus.
  await page.keyboard.press("ArrowRight");
  await expect(readout.locator('[data-role="stand-in-cel"]')).toContainText("loop 0/4 · cel 1/4");
  await page.keyboard.press("ArrowDown");
  await expect(readout.locator('[data-role="stand-in-cel"]')).toContainText("loop 1/4 · cel 1/4");

  // G hides the probe; the tool button brings it back.
  await page.keyboard.press("g");
  await expect(page.getByTestId("stand-in-probe")).toHaveCount(0);
  await page.getByTestId("stand-in-probe-toggle").click();
  await expect(page.getByTestId("stand-in-probe")).toBeVisible();
});

test("a standIn handle can disappear mid-drag and be used again @webkit-desktop", async ({
  page,
}) => {
  await open(page);
  const handle = page.getByTestId("stand-in-probe-handle");
  const readout = page.getByTestId("stand-in-probe-readout").locator('[data-role="stand-in-band"]');
  const before = await readout.textContent();
  const rect = (await handle.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await handle.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 1,
        clientX: rect.x + 50,
        clientY: rect.y + 20,
        bubbles: true,
      }),
    );
    document.querySelector<HTMLButtonElement>('[data-testid="stand-in-probe-toggle"]')!.click();
  });
  await expect(handle).toHaveCount(0);
  await page.mouse.up();
  await page.getByTestId("stand-in-probe-toggle").click();
  await expect(handle).toBeVisible();
  await expect(readout).toHaveText(before!);
  const next = (await handle.boundingBox())!;
  await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2);
  await page.mouse.down();
  await handle.dispatchEvent("lostpointercapture", { pointerId: 1 });
  await page.mouse.move(next.x + 50, next.y + 20);
  await page.mouse.up();
  await expect(readout).toHaveText(before!);
  await handle.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(readout).not.toHaveText(before!);
});
