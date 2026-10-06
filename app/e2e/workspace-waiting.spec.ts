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
    test("Update clears the waiting message and repeated death launches keep saved progress @webkit-desktop", async ({
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
      expect((await textHook(page)).room).toBe(1);
      await expect(page.getByTestId("workspace-update")).toBeVisible();
      await expect(page.getByTestId("workspace-update")).toHaveText("Play Garden");
      await page.getByTestId("workspace-update").click();
      await expect.poll(async () => (await textHook(page)).room).toBe(8);
      await expect.poll(() => screenText(page)).toContain("Preview death");
      await page.getByTestId("workspace-update").click();
      await expect.poll(() => screenText(page)).toContain("Preview death");
      await page.reload();
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await expect.poll(() => screenText(page)).toContain("New waiting message");
    });
  });
}

test("keep-playing Update settles during a message and Restart clears the old continuation @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
            'accept.input(); print("Message before update");',
          ),
        },
      ],
      true,
    );
  });
  await expect.poll(() => screenText(page)).toContain("Message before update");
  await open(page, "part-room:1:logic");
  const source = await runningWorkspaceDocument(page, "logic:1");
  await focusWorkspaceLogic(page);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(source.replace("Message before update", "Message after update"));
  await page.keyboard.press("Escape");
  await workspaceSaved(page);
  await page.getByTestId("workspace-update-menu").click();
  const keep = page.getByRole("menuitem", { name: "Update and keep playing", exact: true });
  await expect(keep).toBeVisible();
  await keep.click();
  await expect(page.getByTestId("workspace-updated")).toBeVisible();
  await expect(page.getByTestId("workspace-updated")).toContainText(
    "Updated · applies after this message",
  );
  await expect(page.getByTestId("workspace-pending")).toBeHidden();
  expect(await screenText(page)).toContain("Message before update");
  await page.getByTestId("workspace-update").click();
  await expect.poll(() => screenText(page)).toContain("Message after update");
});
