import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { enterCreateMode, isolateStorage, textHook } from "./engineProbe.ts";

/**
 * Room Studio's tool rail fits its column. The Walk lens adds three tools,
 * so the rail's tools scroll inside the column while the values under them
 * stay put. At a laptop's 1280×720 and at Studio's shortest layout (a touch
 * screen must be taller than 600 to host it, App.vue studioFits), in every
 * lens, each rail button brought into view (by focus, or by scrolling a
 * disabled one) sits inside the rail column, above the draw-order scrubber,
 * and is the element under its own centre; the page never scrolls.
 */
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1280, height: 601 },
];

async function openLabStudio(page: Page): Promise<Locator> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-2").click();
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

type Box = { x: number; y: number; width: number; height: number };
const bottom = (box: Box) => box.y + box.height;

for (const viewport of VIEWPORTS) {
  test(`the tool rail stays in its column at ${viewport.width}×${viewport.height} in every lens`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const studio = await openLabStudio(page);
    const rail = studio.getByRole("toolbar", { name: "Tools" });
    const scrubber = studio.getByRole("region", { name: "Draw order" });
    for (const [key, lens, tools] of [
      ["1", "Art", 10],
      ["2", "Depth", 10],
      ["3", "Walk", 13],
    ] as const) {
      await page.keyboard.press(key);
      await expect(rail.locator("[data-tool], [data-testid=studio-probe-toggle]")).toHaveCount(
        tools,
      );
      const column = (await rail.boundingBox())!;
      const scrubberTop = (await scrubber.boundingBox())!.y;
      expect(bottom(column), `${lens}: the rail ends above the scrubber`).toBeLessThanOrEqual(
        scrubberTop,
      );
      const buttons = rail.getByRole("button");
      const count = await buttons.count();
      expect(count).toBe(tools + 2);
      for (let k = 0; k < count; k++) {
        const button = buttons.nth(k);
        const name = `${lens}: ${await button.getAttribute("aria-label")}`;
        if (await button.isEnabled()) await button.focus();
        else await button.scrollIntoViewIfNeeded();
        const box = (await button.boundingBox())!;
        expect(box.x, name).toBeGreaterThanOrEqual(column.x);
        expect(box.x + box.width, name).toBeLessThanOrEqual(column.x + column.width);
        expect(box.y, name).toBeGreaterThanOrEqual(column.y);
        expect(bottom(box), name).toBeLessThanOrEqual(bottom(column));
        expect(bottom(box), name).toBeLessThanOrEqual(scrubberTop);
        // Nothing covers it and no ancestor clips it: its centre hits the button.
        const hit = await button.evaluate((element) => {
          const r = element.getBoundingClientRect();
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return top !== null && element.contains(top);
        });
        expect(hit, `${name} is under its own centre`).toBe(true);
      }
      // No ancestor scrolled to reveal a tool: the scrubber stayed where it was.
      expect((await scrubber.boundingBox())!.y).toBe(scrubberTop);
    }
    // A tool picked by its key scrolls into view: back at the top, H is out of sight.
    const tools = studio.getByTestId("studio-rail-tools");
    await tools.evaluate((element) => (element.scrollTop = 0));
    await page.locator(".studio__stage").focus();
    await page.keyboard.press("h");
    const hand = rail.locator('[data-tool="hand"]');
    await expect(hand).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => bottom((await hand.boundingBox())!))
      .toBeLessThanOrEqual(bottom((await tools.boundingBox())!));
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(overflow, "the page does not scroll").toBeLessThanOrEqual(0);
  });
}
