import { test, expect } from "./test.ts";
import {
  isolateStorage,
  configureAi,
  workspaceSaved,
  waitForRoom,
  canvasColors,
  openLibraryActions,
  savedGameCard,
} from "./engineProbe.ts";

for (const [width, height] of [
  [390, 844],
  [1063, 815],
  [1440, 900],
] as const) {
  test.describe("Workspace viewport " + width, () => {
    test.use({ hasTouch: width === 390 });
    test(`workspace tips and agent at ${width} @webkit-desktop`, async ({ page, browserName }) => {
      await page.setViewportSize({ width, height });
      await isolateStorage(page);
      await page.goto("/");
      await configureAi(page, { provider: "stub" });
      await page.evaluate(async () => {
        const { prepareLocalProject } = await import("/src/project/localProject.ts");
        await prepareLocalProject({ title: "My adventure", kind: "starter" }).save();
      });
      await page.reload();
      await openLibraryActions(page, savedGameCard(page, "My adventure"));
      await page.getByTestId("edit-library-game").click();
      await waitForRoom(page, 1);
      await expect(page.getByTestId("game-canvas")).toBeAttached();
      await expect.poll(() => canvasColors(page)).toBeGreaterThan(8);
      await workspaceSaved(page);
      if (width === 390) await page.getByTestId("workspace-parts").click();
      else {
        const show = page.getByTestId("workspace-show-game");
        if (await show.isVisible()) await show.click();
      }
      await page.getByTestId("part-room:1:logic").click();
      await expect(page.getByTestId("workspace-editor")).toBeVisible();
      await expect(page.getByTestId("workspace-logic-editor").locator(".view-lines")).toBeVisible();
      await expect(page.getByTestId("workspace-logic-editor").locator(".view-lines")).toContainText(
        "draw.pic",
      );
      const workspaceShot = await page.screenshot({
        scale: "css",
        path: test.info().outputPath(`workspace-${width}.png`),
        animations: "disabled",
      });
      if (process.env["CI"] && browserName === "webkit" && width === 390)
        console.log("PHONE_WORKSPACE_SHOT:" + workspaceShot.toString("base64"));
      await page.getByTestId("workspace-agent").click();
      await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
      await page.screenshot({
        scale: "css",
        path: test.info().outputPath(`agent-${width}.png`),
        animations: "disabled",
      });
    });
  });
}
