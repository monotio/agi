import type { Locator, Page } from "@playwright/test";
import {
  closeWorkspaceEditor,
  enterCreateMode,
  isolateStorage,
  openWorkspacePicture,
  openWorkspaceView,
  textHook,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

/**
 * At 1024 wide, each part of Studio's top bars and options bars keeps to
 * its own place: no child's visible content runs under another's, in Room
 * Studio (a selection and the Walk lens) and in Sprite Studio (a painting
 * tool, whose colour names itself).
 */
test.use({ viewport: { width: 1024, height: 600 } });

async function playTutorial(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await enterCreateMode(page);
}

/**
 * Pairs of `bar`'s children whose visible content intersects: each child's
 * extent is the union of its descendants' boxes, each clipped by the boxes
 * of its clipping ancestors within the child.
 */
function overlaps(bar: Locator): Promise<string[]> {
  return bar.evaluate((bar) => {
    type Box = { left: number; top: number; right: number; bottom: number };
    const clip = (a: Box, b: Box): Box => ({
      left: Math.max(a.left, b.left),
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom),
    });
    const visible = (element: Element, child: Element): Box | null => {
      let box: Box = element.getBoundingClientRect();
      for (let at = element.parentElement; at && at !== child.parentElement; at = at.parentElement)
        if (getComputedStyle(at).overflowX !== "visible")
          box = clip(box, at.getBoundingClientRect());
      return box.right - box.left > 0.5 && box.bottom - box.top > 0.5 ? box : null;
    };
    const parts = [...bar.children].map((child) => ({
      name: child.className || child.tagName,
      boxes: [child, ...child.querySelectorAll("*")]
        .filter((element) => getComputedStyle(element).visibility !== "hidden")
        .map((element) => visible(element, child))
        .filter((box): box is Box => box !== null),
    }));
    const found: string[] = [];
    for (let i = 0; i < parts.length; i++)
      for (let j = i + 1; j < parts.length; j++)
        if (
          parts[i]!.boxes.some((a) =>
            parts[j]!.boxes.some(
              (b) =>
                a.left < b.right - 0.5 &&
                b.left < a.right - 0.5 &&
                a.top < b.bottom - 0.5 &&
                b.top < a.bottom - 0.5,
            ),
          )
        )
          found.push(`${parts[i]!.name} × ${parts[j]!.name}`);
    return found;
  });
}

test("at 1024 no part of a Studio bar runs under another", async ({ page }) => {
  await playTutorial(page);
  const seen: string[] = [];
  const look = async (name: string, bar: Locator) => {
    await expect(bar).toBeVisible();
    seen.push(...(await overlaps(bar)).map((pair) => `${name}: ${pair}`));
  };

  await openWorkspacePicture(page, 2);
  const studio = page.getByTestId("room-studio");
  await studio.getByRole("treeitem", { name: /^West doorway/ }).click();
  await page.getByTestId("workspace-focus").click();
  await look("room top", studio.getByRole("radiogroup", { name: "Lens", exact: true }));
  await look("room options", studio.getByTestId("studio-options-bar"));
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("3");
  await look("room walk top", studio.getByRole("radiogroup", { name: "Lens", exact: true }));
  await look("room walk options", studio.getByTestId("studio-options-bar"));
  await closeWorkspaceEditor(page);

  await openWorkspaceView(page, 0, false);
  const sprite = page.getByTestId("sprite-studio");
  await sprite.getByTestId("sprite-stage").focus();
  await page.keyboard.press("b");
  await look("sprite top", page.locator(".workspace-editor__header"));
  await look("sprite options", sprite.getByTestId("sprite-options-bar"));
  expect(seen).toEqual([]);
});

/**
 * Every tool in either rail is on screen, or behind a chevron that shows
 * more lie that way: Fill, Brush, Pick, Probe and Hand included.
 */
function hiddenTools(rail: Locator): Promise<string[]> {
  return rail.evaluate((rail) => {
    const scroller = rail.querySelector('[data-testid="studio-rail-tools"]') ?? rail;
    const view = scroller.getBoundingClientRect();
    const shown = (id: string) => {
      const chevron = rail.querySelector<HTMLElement>(`[data-testid="studio-rail-more-${id}"]`);
      return chevron !== null && chevron.offsetParent !== null;
    };
    const found: string[] = [];
    for (const tool of rail.querySelectorAll<HTMLElement>(
      "[data-tool], [data-testid$='probe-toggle']",
    )) {
      const box = tool.getBoundingClientRect();
      const name = tool.getAttribute("aria-label") ?? tool.dataset["tool"] ?? "?";
      if (box.top < view.top - 0.5 && !shown("above")) found.push(`${name}: above, no chevron`);
      else if (box.bottom > Math.min(view.bottom, innerHeight) + 0.5 && !shown("below"))
        found.push(`${name}: below, no chevron`);
    }
    return found;
  });
}

test("at 1024×600 every rail tool is on screen or behind a chevron", async ({ page }) => {
  await playTutorial(page);
  await openWorkspacePicture(page, 2);
  const studio = page.getByTestId("room-studio");
  const rail = studio.getByRole("toolbar", { name: "Tools" });
  const seen: string[] = [];
  for (const lens of ["1", "3"]) {
    await studio.getByRole("group", { name: /^Canvas/ }).focus();
    await page.keyboard.press(lens);
    seen.push(...(await hiddenTools(rail)).map((line) => `room lens ${lens}: ${line}`));
  }
  await closeWorkspaceEditor(page);

  await openWorkspaceView(page, 0, false);
  const sprite = page.getByTestId("sprite-studio");
  const spriteRail = sprite.getByRole("toolbar", { name: "Tools" });
  for (const tool of await spriteRail.locator("[data-tool]").all()) {
    await tool.scrollIntoViewIfNeeded();
    expect(
      await tool.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      }),
    ).toBe(true);
  }
  expect(seen).toEqual([]);
});
