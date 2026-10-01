import { expect, test, reviewShot } from "./test.ts";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";

test("a picture opened from Logic Studio has a usable art surface beside its creative panel @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await isolateStorage(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    await prepareLocalProject({ title: "Art workspace", kind: "starter" }).save();
  });
  await page.reload();
  await openLibraryActions(page, savedGameCard(page, "Art workspace"));
  await page.getByTestId("edit-library-game").click();
  await expect(page.getByTestId("logic-studio")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-picture:1").click();
  await page.getByTestId("logic-resource-edit").click();
  const room = page.getByTestId("room-studio");
  await expect(room).toBeVisible();
  await expect(page.getByTestId("creative-workspace")).toBeVisible();
  const pixels = room.locator(".studio-pane__pixels").first();
  await expect(pixels).toBeVisible();
  const visibleHeight = await pixels.evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    let top = Math.max(0, rect.top);
    let bottom = Math.min(window.innerHeight, rect.bottom);
    for (let parent = canvas.parentElement; parent; parent = parent.parentElement) {
      if (/(hidden|clip|auto|scroll)/.test(getComputedStyle(parent).overflowY)) {
        const clip = parent.getBoundingClientRect();
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
    }
    return Math.max(0, bottom - top);
  });
  await reviewShot(page, "creative-resource-art-area");
  expect(
    visibleHeight,
    "visible picture pixels need room to draw at a normal laptop size",
  ).toBeGreaterThanOrEqual(200);
});
