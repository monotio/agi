import { expect, test, reviewShot } from "./test.ts";
import { prepareIsolatedPage } from "./logicDebugShared.ts";
import type { Page } from "@playwright/test";

/**
 * The frame's stage-A components mounted in a real browser under a
 * controlled parent (e2e/fixtures/studioFrameReview.ts). These observe
 * component behavior only — the production frame mount is a later owner's
 * composition and stays out of scope here.
 */

async function mountReview(page: Page): Promise<void> {
  await prepareIsolatedPage(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const url: string = "/e2e/fixtures/studioFrameReview.ts";
    await (await import(url)).mount();
  });
  await expect(page.getByTestId("project-studio-overview")).toBeVisible();
}

async function emittedEvents(page: Page): Promise<readonly { type: string; detail: string }[]> {
  return page.evaluate(async () => {
    const url: string = "/e2e/fixtures/studioFrameReview.ts";
    return (await import(url)).emittedEvents();
  });
}

test("needs-review rows are real buttons that select their exact key @webkit-desktop", async ({
  page,
}) => {
  await mountReview(page);

  // One roving tab stop in the explorer even though logic:1 also has a
  // normal family row — the rejected row roves on its own row identifier.
  await expect(page.locator("[data-explorer-item][tabindex='0']")).toHaveCount(1);
  const missing = page.getByTestId("project-rejected-sound:9");
  await expect(missing).toHaveJSProperty("tagName", "BUTTON");
  await expect(missing).toContainText("SND 9");

  // Keyboard: End lands on the last row — the rejected rows are inside the
  // roving order — then Enter selects the exact, unavailable key.
  await page.getByTestId("project-studio-explorer-overview").focus();
  await page.keyboard.press("End");
  await expect(page.getByTestId("project-rejected-logic:1")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(missing).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(missing).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("frame-review-document")).toContainText("sound:9");
  const events = await emittedEvents(page);
  expect(events.at(-1)).toEqual({
    type: "explorer-select",
    detail: JSON.stringify({ kind: "document", key: "sound:9" }),
  });

  // The opened tab marks the absent document truthfully, and the tab strip
  // advertises its keyboard close.
  const missingTab = page.getByTestId("project-tab-sound:9");
  await expect(missingTab).toHaveAttribute("aria-label", /missing/);
  await expect(missingTab).toContainText("Missing");
  await expect(missingTab).toHaveAttribute("aria-keyshortcuts", "Delete");

  // Click selects the exact key too, including one that also exists as a
  // normal family row — the rejected row reports the same destination.
  await page.getByTestId("project-rejected-logic:1").click();
  await expect(page.getByTestId("project-rejected-logic:1")).toHaveAttribute(
    "aria-current",
    "true",
  );
  const after = await emittedEvents(page);
  expect(after.at(-1)).toEqual({
    type: "explorer-select",
    detail: JSON.stringify({ kind: "document", key: "logic:1" }),
  });
});

test("an unavailable project action shows its cause @webkit-desktop", async ({ page }) => {
  await mountReview(page);

  const playtest = page.getByTestId("project-action-playtest");
  await expect(playtest).toBeDisabled();
  const cause = page.getByTestId("project-action-note-playtest");
  await expect(cause).toHaveText("A playtest is already running.");
  await expect(cause).toHaveAttribute("id", "project-action-note-playtest");
  await expect(playtest).toHaveAttribute("aria-describedby", "project-action-note-playtest");
  const exportAction = page.getByTestId("project-action-export");
  await expect(exportAction).toBeEnabled();
  await expect(page.getByTestId("project-action-note-export")).toHaveText("Write a game archive");

  // Single-file families name themselves; other families keep real counts.
  await expect(page.getByTestId("project-stat-words")).toHaveText("Words");
  await expect(page.getByTestId("project-stat-inventory")).toHaveText("Inventory");
  await expect(page.getByTestId("project-stat-logic")).toHaveText("Logic 2 · 1 room");
  await expect(page.getByTestId("project-stat-pictures")).toHaveText("Pictures 1");

  await expect(page.getByRole("heading", { name: "Start here" })).toBeVisible();
  await expect(page.getByTestId("project-studio-overview")).toContainText(
    "Make a change, then playtest.",
  );
  await expect(page.getByTestId("project-overview-start")).toHaveText("Open Clearing");

  // The component layout — not the production frame — for review.
  await reviewShot(page, "studio-frame-components");
});
