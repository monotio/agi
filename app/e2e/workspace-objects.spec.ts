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
      await page.reload();
      await workspaceSaved(page);
      await expect(location.locator("option:checked")).toHaveText("Room 12");
      await expect(launchNumber).toHaveValue("12");
    });
  });
}

for (const editor of ["Objects", "Launch"] as const) {
  test(`${editor} keeps an item location awaiting blur through a saved publication @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await start(page);
    await open(page, "part-inventory");
    const table = page.getByTestId("workspace-table-editor");
    await table.getByRole("button", { name: "+ Add", exact: true }).click();
    if (editor === "Launch") {
      await open(page, "part-room:1:logic");
      await page.getByTestId("workspace-update-menu").click();
      await page.getByRole("menuitem", { name: "New launch…" }).click();
      await page.getByTestId("launch-add-row-menu").click();
      await page.getByRole("menuitem", { name: "Item", exact: true }).click();
    }
    await workspaceSaved(page);
    const location =
      editor === "Objects"
        ? table.getByRole("combobox").first()
        : page.getByTestId("launch-item-location");
    await location.selectOption("other");
    const number =
      editor === "Objects"
        ? table.getByRole("spinbutton").first()
        : page.getByRole("spinbutton", { name: "Item location number" });
    await number.fill("12");
    // Publish another field while the number is still awaiting its change event.
    await page.evaluate(async (editor) => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const key = editor === "Objects" ? "inventory" : "world";
      const document = JSON.parse(String(session.workingSnapshot().read(key)!.content));
      if (editor === "Objects") document[0].name = "toothbrush";
      else document.launches["1"].entries[0].note = "Starting setup";
      await session.stage([{ key, content: JSON.stringify(document) }]);
    }, editor);
    await workspaceSaved(page);
    await expect(number).toHaveValue("12");
    await number.press("Tab");
    await workspaceSaved(page);
    const key = editor === "Objects" ? "inventory" : "world";
    const document = JSON.parse(await workingDocument(page, key));
    if (editor === "Objects") {
      expect(document[0]).toEqual({ name: "toothbrush", startingRoom: 12 });
    } else {
      expect(document.launches["1"].entries[0]).toMatchObject({
        note: "Starting setup",
        items: { "0": 12 },
      });
    }
    await page.reload();
    await workspaceSaved(page);
    await expect(number).toHaveValue("12");
    await expect(location.locator("option:checked")).toHaveText("Room 12");
  });
}
