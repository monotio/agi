import { test, expect } from "./test.ts";
import { isolateStorage, waitForRoom } from "./engineProbe.ts";

test("the LOGIC editor's context menu draws above the workspace @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1063, height: 640 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  await page.getByTestId("part-room:1:logic").click();
  const editor = page.getByTestId("workspace-logic-editor");
  await expect(editor).toBeVisible();
  // In a short window the menu is taller than the editor and reaches up over the
  // tabs and the context row.
  const area = (await editor.boundingBox())!;
  await page.mouse.click(area.x + 120, area.y + area.height - 12, { button: "right" });
  const menu = page.locator(".monaco-menu").first();
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.y, "the menu reaches up over the tabs and the context row").toBeLessThan(area.y);
  for (const y of [box.y + 8, box.y + box.height / 2, box.y + box.height - 8]) {
    const inside = await page.evaluate(
      ([x, y]) => {
        const hit = document.elementFromPoint(x!, y!);
        // Monaco draws its menus in a shadow root, so hit testing stops at the host.
        return Boolean(hit?.closest(".shadow-root-host"));
      },
      [box.x + box.width / 2, y],
    );
    expect(inside, `the menu is topmost at y ${Math.round(y)}`).toBe(true);
  }
});
