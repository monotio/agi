import { test, expect } from "./test.ts";
import { enterCreateMode, isolateStorage, waitForRoom } from "./engineProbe.ts";

test.use({ hasTouch: true });

test("phone game controls stay in the play pane while LOGIC is open", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1);
  await enterCreateMode(page);
  await page.getByTestId("workspace-parts").click();
  await page.getByTestId("part-room:1:logic").click();
  const editor = page.getByTestId("workspace-logic-editor").filter({ visible: true });
  await expect(editor.locator(".view-lines")).toBeVisible();
  const controls = page.getByTestId("touch-controls");
  await expect(controls).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("phone-logic-controls.png") });
  const header = page.locator(".workspace-editor__header");
  await expect(header).toBeVisible();
  expect(
    await header.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + 15));
    }),
  ).toBe(true);
  const south = controls.getByRole("button", { name: "Walk south", exact: true });
  await expect(south).toBeVisible();
  await south.scrollIntoViewIfNeeded();
  const pane = page.locator(".shell-body--workspace > .play-area");
  const paneBox = (await pane.boundingBox())!;
  const arrowBox = (await south.boundingBox())!;
  expect(arrowBox.y + arrowBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height);
  await south.click();
});
