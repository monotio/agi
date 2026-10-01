import { test, expect, reviewShot } from "./test.ts";
import { isolateStorage } from "./engineProbe.ts";
import { VOCABULARY } from "../../src/vocabulary.ts";

test("PICTURE items show their drawing lenses", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await page.getByTestId("part-room:1:picture:1").click();
  const tree = page.locator('[role="treeitem"][data-row="tree"]');
  await expect(tree.getByRole("img", { name: "Art", exact: true })).toHaveAttribute(
    "title",
    `Art: ${VOCABULARY.art.help}`,
  );
  await expect(tree.getByRole("img", { name: "Depth", exact: true })).toHaveAttribute(
    "title",
    `Depth: ${VOCABULARY.depth.help}`,
  );
  await expect(tree).not.toContainText("mixed");
  await expect(page.locator('[role="treeitem"][data-row="sun"]').getByRole("img")).toHaveCount(0);
  await expect(page.locator('[role="treeitem"][data-row="tree-base"]')).toContainText("Wall");
  await reviewShot(page, "picture-item-lenses-1440");
});
