import { expect, test, reviewShot } from "./test.ts";
import { prepareIsolatedPage, seedLocalProject, openStudio } from "./logicDebugShared.ts";
import { encodePngRgb } from "../../src/picture/png.ts";

test("a newly prepared imported sprite defaults to a free VIEW and permits explicit replacement @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  await page.goto("/");
  await seedLocalProject(page, "Safe sprite destination");
  await page.reload();
  await openStudio(page, "Safe sprite destination");
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-view:1").click();
  await page.getByTestId("logic-resource-edit").click();
  const panel = page.getByTestId("creative-workspace");
  await panel.getByTestId("creative-choose").setInputFiles({
    name: "new-character.png",
    mimeType: "image/png",
    buffer: Buffer.from(encodePngRgb(24, 24, new Uint8Array(24 * 24 * 3).fill(90))),
  });
  await expect(panel.locator(".source-preview").getByText("new-character.png")).toBeVisible();
  await panel.getByRole("button", { name: "Use as a character or object", exact: true }).click();
  const destination = panel.getByTestId("view-destination");
  await reviewShot(page, "creative-default-new-view");
  await expect(
    destination,
    "the existing hero is replaced only after an explicit destination choice",
  ).toHaveValue("0");
  await destination.fill("1");
  await destination.press("Tab");
  await expect(destination).toHaveValue("1");
  await expect(panel).toContainText("replaces the existing view");
});
