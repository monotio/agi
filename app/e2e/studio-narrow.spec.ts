import type { Locator, Page } from "@playwright/test";
import {
  enterCreateMode,
  isolateStorage,
  openWorkspacePicture,
  openWorkspaceView,
  waitForRoom,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

/**
 * The Studios in small windows: a small laptop's 1024×600, a 900 px wide
 * window, and 900×480, the smallest window the Studios are laid out for.
 * Room Studio's top bar never draws the draft controls over the lens switch,
 * and a tool rail shorter than its tools says so with a "more tools" button
 * that scrolls the rest into view. Sprite Studio's options bar folds its view
 * options into a More menu instead of drawing the tool's options under them.
 */

type Box = { x: number; y: number; width: number; height: number };
/** Whether two boxes share any area (touching edges do not count). */
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (a: Box, b: Box) =>
  a.x >= b.x - 0.5 &&
  a.y >= b.y - 0.5 &&
  a.x + a.width <= b.x + b.width + 0.5 &&
  a.y + a.height <= b.y + b.height + 0.5;

/** Nothing covers it and no ancestor clips it: the point at its centre is inside it. */
const onTop = (locator: Locator) =>
  locator.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit !== null && element.contains(hit);
  });

async function boxes(entries: [string, Locator][]): Promise<[string, Box][]> {
  const out: [string, Box][] = [];
  for (const [name, locator] of entries)
    if (await locator.isVisible()) out.push([name, (await locator.boundingBox())!]);
  return out;
}

function expectApart(list: [string, Box][], context: string): void {
  for (const [i, [a, boxA]] of list.entries())
    for (const [b, boxB] of list.slice(i + 1))
      expect(overlaps(boxA, boxB), `${context}: ${a} overlaps ${b}`).toBe(false);
}

async function playTutorial(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await enterCreateMode(page);
}

for (const viewport of [
  { width: 1024, height: 600 },
  { width: 900, height: 700 },
  { width: 900, height: 480 },
]) {
  test(`Room Studio at ${viewport.width}×${viewport.height}: the top bar never overlaps and every tool can be reached`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    // The chevrons scroll at once, not smoothly: each click lands where it scrolled to.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await playTutorial(page);
    await openWorkspacePicture(page, 2, false);
    const studio = page.getByTestId("room-studio");
    await expect(studio).toBeVisible();
    const lens = studio.getByRole("radiogroup", { name: "Lens", exact: true });
    const bar = studio.getByRole("radiogroup", { name: "Lens", exact: true });
    const rail = studio.getByRole("toolbar", { name: "Tools" });
    const tools = studio.getByTestId("studio-rail-tools");
    const below = studio.getByTestId("studio-rail-more-below");
    const above = studio.getByTestId("studio-rail-more-above");
    for (const [key, name] of [
      ["1", "Visual"],
      ["2", "Priority"],
      ["3", "Walk"],
    ] as const) {
      await page.keyboard.press(key);
      await expect(lens.getByRole("radio", { name: new RegExp(name) })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      const context = `${name} at ${viewport.width}×${viewport.height}`;
      const top = await boxes([
        ["Visual tab", lens.getByRole("radio", { name: /Visual/ })],
        ["Priority tab", lens.getByRole("radio", { name: /Priority/ })],
        ["Walk tab", lens.getByRole("radio", { name: /Walk/ })],
      ]);
      expect(top.length, `${context}: all lens tabs show`).toBe(3);
      expectApart(top, context);
      const barBox = (await bar.boundingBox())!;
      for (const [part, box] of top) expect(inside(box, barBox), `${context}: ${part}`).toBe(true);

      // The rail is shorter than its tools: a button says more lie below and
      // scrolls them into view, down to the last tool.
      await tools.evaluate((element) => (element.scrollTop = 0));
      await expect(below, `${context}: more tools below`).toBeVisible();
      await expect(above).toBeHidden();
      expect(await onTop(below), `${context}: the more button is under its centre`).toBe(true);
      const hand = rail.locator('[data-tool="hand"]');
      const scrolled = () => tools.evaluate((element) => element.scrollTop);
      for (let k = 0; k < 12 && (await below.isVisible()); k++) {
        const before = await scrolled();
        await below.click();
        await expect.poll(scrolled).toBeGreaterThan(before);
        // The chevrons follow the scroll event, a frame later.
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
      }
      await expect(below).toBeHidden();
      await expect(above).toBeVisible();
      const column = (await tools.boundingBox())!;
      const handBox = (await hand.boundingBox())!;
      expect(inside(handBox, column), `${context}: the hand tool scrolled into the rail`).toBe(
        true,
      );
      expect(await onTop(hand), `${context}: the hand tool is under its centre`).toBe(true);
      await above.click();
      await expect(below).toBeVisible();
    }
    await page.screenshot({
      path: test.info().outputPath(`room-studio-${viewport.width}x${viewport.height}.png`),
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(overflow, "the page does not scroll").toBeLessThanOrEqual(0);
  });
}

test("Sprite Studio at 1024×600: the options bar folds its view options into More", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await playTutorial(page);
  await openWorkspaceView(page, 0);
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  const bar = studio.getByTestId("sprite-options-bar");
  const options = studio.getByTestId("sprite-tool-options");
  await expect(options).toContainText("light cyan");
  const barBox = (await bar.boundingBox())!;
  const parts: [string, Locator][] = [];
  for (const [n, child] of (await options.locator(":scope > *").all()).entries())
    parts.push([`tool option ${n}: ${(await child.textContent())?.trim()}`, child]);
  for (const [n, child] of (await bar.locator(".sprite-view-bar > *").all()).entries())
    parts.push([`view option ${n}: ${(await child.textContent())?.trim()}`, child]);
  const shown = await boxes(parts);
  expectApart(shown, "Sprite options at 1024×600");
  for (const [name, box] of shown) expect(inside(box, barBox), name).toBe(true);
  for (const [name, locator] of parts)
    if (await locator.isVisible()) expect(await onTop(locator), `${name} is on top`).toBe(true);
  await page.screenshot({ path: test.info().outputPath("sprite-studio-1024x600.png") });

  // The options bar measures its available width: at this size the backdrop
  // joins the grid, baseline and All cels in More. Onion stays in the bar.
  await expect(studio.getByTestId("sprite-backdrop")).toBeHidden();
  await expect(studio.getByTestId("sprite-onion")).toBeVisible();
  await expect(studio.getByTestId("sprite-grid")).toBeHidden();
  const more = studio.getByTestId("actor-view-more");
  await expect(more).toBeVisible();
  await more.click();
  const menu = page.getByTestId("actor-view-more-menu");
  await expect(menu).toBeVisible();
  const grid = menu.getByRole("menuitemcheckbox", { name: "Grid" });
  const gridWas = await grid.getAttribute("aria-checked");
  const gridNow = gridWas === "true" ? "false" : "true";
  await grid.click();
  await expect(grid).toHaveAttribute("aria-checked", gridNow);
  await expect(menu.getByRole("menuitemcheckbox", { name: "Feet" })).toBeVisible();
  await expect(menu.getByRole("menuitemcheckbox", { name: "All cels" })).toBeVisible();
  await expect(
    menu.getByRole("menuitemradio", { name: "Dark checker", exact: true }),
  ).toBeVisible();
  await menu.getByRole("menuitemradio", { name: "Light checker", exact: true }).click();
  await expect(
    menu.getByRole("menuitemradio", { name: "Light checker", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: test.info().outputPath("sprite-studio-1024x600-more.png") });
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // Focus gives the editor room for every option in the bar, and no More.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("workspace-focus").click();
  await expect(studio.getByTestId("sprite-backdrop")).toBeVisible();
  await expect(studio.getByTestId("sprite-backdrop")).toHaveValue("checker-light");
  await expect(studio.getByTestId("sprite-grid")).toHaveAttribute("aria-pressed", gridNow);
  await expect(more).toBeHidden();
});
