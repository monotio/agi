import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { test, expect } from "./test.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import { waitForRoom } from "./engineProbe.ts";

async function screenshot(page: Page, name: string, browserName: string): Promise<void> {
  const bytes = await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    animations: "disabled",
    scale: "css",
  });
  if (process.env["CI"] && browserName === "webkit")
    console.log(`FOLLOWUP_SHOT:${name}:${bytes.toString("base64")}`);
}

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test.describe(`touch Back ${width}`, () => {
    test.use({ hasTouch: true });
    test("Back stays clear of the game canvas @webkit-desktop", async ({ page, browserName }) => {
      await page.setViewportSize({ width, height });
      await start(page);
      await open(page, "part-room:8:logic");
      const action = page.getByTestId("workspace-update");
      await expect(action).toBeVisible();
      await action.click();
      await waitForRoom(page, 8);
      if (width === 390) await page.getByRole("button", { name: "Game", exact: true }).click();
      const back = page
        .getByTestId("workspace-game-bar")
        .getByRole("button", { name: "Back to Room 1", exact: true });
      await expect(back).toBeVisible();
      await screenshot(page, `back-${width}`, browserName);
      expect(
        await back.evaluate((button) => {
          const rect = button.getBoundingClientRect();
          return button.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
          );
        }),
      ).toBe(true);
      await back.click();
      await waitForRoom(page, 1);
    });
  });
}

test("Undo after choosing a Launch undoes the last change @webkit-desktop", async ({ page }) => {
  await start(page);
  await open(page, "part-room:8:logic");
  const before = await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const capture = session.model.capture();
    const source = String(capture.read("logic:8")!.content);
    const result = await session.submit({
      proposal: session.model.propose(capture, "Last code change", [
        { key: "logic:8", content: `${source}\n// Last change` },
      ]),
      label: "Last code change",
      origin: "logic",
      author: "creator",
    });
    if (result.status !== "committed") throw new Error(result.status);
    return source;
  });
  await page.getByTestId("workspace-update-menu").click();
  const beginning = page.getByRole("menuitem", { name: "From the beginning", exact: true });
  await expect(beginning).toBeVisible();
  await beginning.click();
  const action = page.getByTestId("workspace-update");
  await expect(action).toBeVisible();
  await expect(action).toContainText("beginning");
  const after = await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const result = await session.undo();
    if (result?.status !== "committed") throw new Error(result?.status);
    return String(session.model.capture().read("logic:8")!.content);
  });
  expect(after).toBe(before);
});
