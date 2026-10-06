import { test, expect } from "./test.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import { focusWorkspaceLogic, runningWorkspaceDocument } from "./workspaceShared.ts";
import { screenText, textHook, workspaceSaved } from "./engineProbe.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test.describe(`Waiting messages ${width}`, () => {
    test.use({ hasTouch: width === 390 });
    test("Update closes the old message and visits draw the selected room @webkit-desktop", async ({
      page,
      browserName,
    }) => {
      await page.setViewportSize({ width, height });
      await start(page);
      await page.evaluate(async () => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        const source = String(session.model.capture().read("logic:1")!.content);
        await session.update(
          [
            {
              key: "logic:1",
              content: source.replace(
                "accept.input();",
                'accept.input(); print("Old waiting message");',
              ),
            },
          ],
          true,
        );
      });
      await expect.poll(() => screenText(page)).toContain("Old waiting message");
      await open(page, "part-room:1:logic");
      const editor = page.getByTestId("workspace-logic-editor").filter({ visible: true });
      await expect(editor).toBeVisible();
      const source = await runningWorkspaceDocument(page, "logic:1");
      await focusWorkspaceLogic(page);
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.insertText(source.replace("Old waiting message", "New waiting message"));
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("workspace-pending")).toBeVisible();
      await workspaceSaved(page);
      if (width === 390) await page.getByRole("button", { name: "Playtest", exact: true }).click();
      const before = await page.screenshot({
        path: test.info().outputPath(`before-${width}.png`),
        animations: "disabled",
        scale: "css",
      });
      if (process.env["CI"] && browserName === "webkit" && width === 390)
        console.log(`WAIT_BEFORE_SHOT:${before.toString("base64")}`);
      await page.getByTestId("workspace-update").click();
      await expect.poll(() => screenText(page)).toContain("New waiting message");
      await workspaceSaved(page);
      await expect(page.getByTestId("workspace-pending")).toBeHidden();
      const after = await page.screenshot({
        path: test.info().outputPath(`after-${width}.png`),
        animations: "disabled",
        scale: "css",
      });
      if (process.env["CI"] && browserName === "webkit" && width === 390)
        console.log(`WAIT_AFTER_SHOT:${after.toString("base64")}`);
      await page.evaluate(async () => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        const source = String(session.model.capture().read("logic:8")!.content);
        await session.update([
          {
            key: "logic:8",
            content: source.replace(
              "accept.input();",
              'accept.input(); set(f220); print("Preview death");',
            ),
          },
        ]);
      });
      await open(page, "part-room:8:logic");
      await expect(page.getByTestId("workspace-visit")).toBeVisible();
      await expect(page.getByTestId("workspace-visit")).toContainText("Visiting Room 8");
      await expect.poll(async () => (await textHook(page)).room).toBe(8);
      await expect.poll(() => screenText(page)).toContain("Preview death");
      await open(page, "part-room:1:logic");
      await expect(
        page.getByTestId("workspace-logic-editor").filter({ visible: true }),
      ).toBeVisible();
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await expect.poll(() => screenText(page)).toContain("New waiting message");
      await page.reload();
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await expect.poll(() => screenText(page)).toContain("New waiting message");
    });
  });
}
