import { expect, test, reviewShot } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { enterCreateMode, isolateStorage, textHook } from "./engineProbe.ts";
import { ROOM_GROUP_HINT } from "../src/studio/studioHelp.ts";

/**
 * Room Studio opens at its essentials: with two items selected the inspector
 * shows exactly their name, one line ("Art · 6 steps"), three actions, Ask
 * and a closed Details, with the movement hint at its foot, at 1440×900 and
 * at 1024×600, where nothing in the side panels or the page scrolls
 * sideways or runs out of its column. The lock is a chip by the lens tabs.
 * Details opened stays open for this viewer, across a reopened Studio.
 */

async function openRoomOne(page: Page): Promise<Locator> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

/** The inspector's own parts, top to bottom, as the viewer sees them. */
function inspectorParts(studio: Locator): Promise<string[]> {
  return studio.getByTestId("studio-inspector").evaluate((aside) =>
    [...aside.children]
      .filter((child) => {
        const box = child.getBoundingClientRect();
        return box.height > 0 && getComputedStyle(child).visibility !== "hidden";
      })
      .map(
        (child) =>
          child.getAttribute("data-testid") ??
          child.querySelector("[data-testid]")?.getAttribute("data-testid") ??
          child.className,
      ),
  );
}

/** Content taller or wider than its box: [scroll size, client size], or null when it fits. */
const overflow = (locator: Locator, axis: "x" | "y") =>
  locator.evaluate((element, axis) => {
    const [scroll, client] =
      axis === "y"
        ? [element.scrollHeight, element.clientHeight]
        : [element.scrollWidth, element.clientWidth];
    return scroll > client + 1 ? [scroll, client] : null;
  }, axis);

/** Elements in `root` that scroll sideways: a horizontal scrollbar the viewer would see. */
const sidewaysScrollers = (root: Locator) =>
  root.evaluate((root) =>
    [root, ...root.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const { overflowX } = getComputedStyle(element);
        return (
          (overflowX === "auto" || overflowX === "scroll") &&
          element.scrollWidth > element.clientWidth + 1
        );
      })
      .map((element) => `${element.className}: ${element.scrollWidth} > ${element.clientWidth}`),
  );

for (const [width, height] of [
  [1440, 900],
  [1024, 600],
] as const) {
  test(`at ${width}×${height} two selected items show their essentials and nothing overflows`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const studio = await openRoomOne(page);
    await studio.getByRole("treeitem", { name: /^Text band/ }).click();
    await studio.getByRole("treeitem", { name: /^Corners & floor line/ }).click({
      modifiers: ["Shift"],
    });

    const inspector = studio.getByTestId("studio-inspector");
    expect(await inspectorParts(studio)).toEqual([
      "inspector-title",
      "group-editor",
      "studio-assist",
      "inspector-details",
      "inspector__grow",
      "inspector-foot",
    ]);
    await expect(inspector.getByRole("heading", { level: 2 })).toHaveText("2 items");
    await expect(studio.getByTestId("inspector-subtitle")).toHaveText(/^Art · \d+ steps$/);
    await expect(studio.getByTestId("group-editor").getByRole("button")).toHaveText([
      /^Duplicate/,
      /^Delete/,
      /^Group/,
    ]);
    const ask = studio.getByTestId("studio-assist");
    await expect(ask.getByRole("heading", { level: 3 })).toHaveText(/^Ask/);
    await expect(ask.getByTestId("assist-chip")).toHaveText(["These 2 items"]);
    await expect(ask.getByTestId("studio-lock-chip")).toHaveText("Depth");
    await expect(studio.getByTestId("inspector-details")).toHaveAttribute("aria-expanded", "false");
    await expect(studio.getByTestId("inspector-commands")).toHaveCount(0);
    await expect(studio.getByTestId("inspector-foot")).toHaveText(ROOM_GROUP_HINT);
    // The lens's lock is one chip beside the tabs; the Scene footer counts and offers Group.
    await expect(studio.locator(".top-bar__lens").getByTestId("studio-lock-chip")).toHaveText(
      "Depth",
    );
    await expect(studio.locator('[data-role="scene-count"]')).toHaveText("30 items");
    await expect(studio.getByTestId("scene-group")).toBeVisible();
    await expect(studio.getByTestId("studio-status")).toHaveText("Point at a pixel");

    expect(await overflow(inspector, "y"), "the inspector fits its column").toBeNull();
    expect(await overflow(studio.locator(".scene-list"), "y"), "the Scene panel fits").toBeNull();
    // Nothing in Studio scrolls sideways.
    expect(await sidewaysScrollers(studio)).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);

    // The pixel under the pointer reads in plain words in the status bar.
    const pane = studio.locator(".studio-pane").last();
    const box = (await pane.boundingBox())!;
    await page.mouse.move(box.x + (35.5 / 160) * box.width, box.y + (50.5 / 168) * box.height);
    await expect(studio.getByTestId("studio-status")).toHaveText(
      /^x 35 y 50 · colour \d+ · depth \d+( · step \d+)?$/,
    );
    await page.mouse.move(box.x + box.width + 40, box.y);
    await reviewShot(page, `room-${width}-selection`);
  });
}

test("Details opened stays open for this viewer when Studio opens again", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let studio = await openRoomOne(page);
  await studio.getByRole("treeitem", { name: /^Text band/ }).click();
  const details = studio.getByTestId("inspector-details");
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  const steps = studio.getByTestId("inspector-commands").getByRole("button");
  await expect(steps.first()).toBeVisible();
  // A step scrubs the draw order there.
  await steps.first().click();
  await expect(studio.getByTestId("scrubber-step")).toHaveText(/^Step \d+ of \d+$/);

  await studio.getByTestId("studio-close").click();
  await expect(studio).toBeHidden();
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("world-open-studio").click();
  studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await studio.getByRole("treeitem", { name: /^Text band/ }).click();
  await expect(studio.getByTestId("inspector-details")).toHaveAttribute("aria-expanded", "true");
  await expect(studio.getByTestId("inspector-commands")).toBeVisible();

  // Closed again, it stays closed.
  await studio.getByTestId("inspector-details").click();
  await studio.getByTestId("studio-close").click();
  await panel.getByTestId("world-open-studio").click();
  await expect(page.getByTestId("inspector-details")).toHaveAttribute("aria-expanded", "false");
});

test("the lock chip's Unlock for now lets a depth edit through in the Art lens, until Studio reopens @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let studio = await openRoomOne(page);
  const chip = studio.locator(".top-bar__lens").getByTestId("studio-lock-chip");
  await expect(chip).toHaveAttribute("data-locked", "true");
  await studio.getByRole("treeitem", { name: /^Text band/ }).click();
  // Locked: the depth picker in the options bar is off and says why.
  await studio.getByTestId("selection-priority").click();
  await expect(studio.getByTestId("selection-picker")).toContainText(
    "Depth is locked in the Art lens.",
  );
  await page.keyboard.press("Escape");

  await chip.getByTestId("explain-lens-lock-depth").click();
  const pop = page.getByTestId("explain-pop");
  await expect(pop).toContainText("Depth locked");
  await pop.getByTestId("studio-unlock").click();
  await expect(pop).toBeHidden();
  await expect(chip).toHaveAttribute("data-locked", "false");
  await expect(chip).toHaveText("Depth unlocked");
  await expect(chip.getByTestId("explain-lens-lock-depth")).toBeFocused();

  await studio.getByTestId("selection-priority").click();
  await studio.getByTestId("selection-picker").locator('[data-value="9"]').click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  await expect(studio.getByTestId("selection-priority")).toHaveText(/Depth 9/);

  await studio.getByTestId("studio-undo").click();
  await studio.getByTestId("studio-close").click();
  await expect(studio).toBeHidden();
  await page.getByTestId("world-panel").getByTestId("world-open-studio").click();
  studio = page.getByTestId("room-studio");
  await expect(studio.locator(".top-bar__lens").getByTestId("studio-lock-chip")).toHaveAttribute(
    "data-locked",
    "true",
  );
});
