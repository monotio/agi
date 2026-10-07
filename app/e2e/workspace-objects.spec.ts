import { test, expect, reviewShot } from "./test.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import { workspaceSaved } from "./engineProbe.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";

async function workingDocument(page: Page, key: string): Promise<string> {
  return page.evaluate((key) => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    return String(session.workingSnapshot().read(key)?.content);
  }, key);
}

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test.describe(`Objects locations ${width}`, () => {
    test.use({ hasTouch: width === 390, isMobile: width === 390 });
    test("named rooms and other numbers round-trip in Objects and Launch @webkit-desktop", async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await start(page);
      await open(page, "part-inventory");
      const table = page.getByTestId("workspace-table-editor");
      await table.getByRole("button", { name: "+ Add", exact: true }).click();
      const name = table.getByRole("textbox").first();
      await name.fill("toothbrush");
      await name.press("Tab");
      const room = table.getByRole("combobox").first();
      await expect(room).toHaveValue("255");
      await expect(room.locator("option:checked")).toHaveText("Carried by the player");
      await expect(room.locator('option[value="8"]')).toHaveText("Garden · Room 8");
      const fits = await room.evaluate((element) => {
        const select = element as HTMLSelectElement;
        const style = getComputedStyle(select);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d")!;
        context.font = style.font;
        return (
          select.clientWidth >=
          context.measureText(select.selectedOptions[0]!.text).width +
            parseFloat(style.paddingLeft) +
            parseFloat(style.paddingRight) +
            24
        );
      });
      expect(fits, "selected location label fits beside the dropdown arrow").toBe(true);
      await reviewShot(page, `objects-${width}`);
      await room.selectOption("8");
      await workspaceSaved(page);
      expect(JSON.parse(String(await workingDocument(page, "inventory")))[0].startingRoom).toBe(8);
      await room.selectOption("other");
      const number = table.getByRole("spinbutton").first();
      await number.fill("12");
      await number.press("Tab");
      await workspaceSaved(page);
      expect(JSON.parse(String(await workingDocument(page, "inventory")))[0].startingRoom).toBe(12);
      await page.reload();
      await workspaceSaved(page);
      await open(page, "part-inventory");
      await expect(room.locator("option:checked")).toHaveText("Room 12");
      await expect(number).toHaveValue("12");
      await reviewShot(page, `objects-other-${width}`);
      await open(page, "part-room:1:logic");
      await page.getByTestId("workspace-update-menu").click();
      await page.getByRole("menuitem", { name: "New launch…" }).click();
      await page.getByTestId("launch-add-row-menu").click();
      await page.getByRole("menuitem", { name: "Item", exact: true }).click();
      const location = page.getByTestId("launch-item-location");
      await expect(location.locator("option:checked")).toHaveText("Carried by the player");
      await location.selectOption("other");
      const launchNumber = page.getByRole("spinbutton", { name: "Item location number" });
      await launchNumber.fill("12");
      await launchNumber.press("Tab");
      await workspaceSaved(page);
      const world = JSON.parse(String(await workingDocument(page, "world")));
      expect(world.launches["1"].entries[0].items["0"]).toBe(12);
      await reviewShot(page, `launch-objects-other-${width}`);
    });
  });
}
