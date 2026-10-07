import { test, expect } from "./test.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import { focusWorkspaceGame, runningWorkspaceDocument } from "./workspaceShared.ts";
import { textHook, workspaceSaved, waitForGameInput } from "./engineProbe.ts";

async function focusGame(page: Page): Promise<void> {
  if (page.viewportSize()!.width > 600) return focusWorkspaceGame(page);
  const input = page.getByRole("textbox", { name: "Game command", exact: true });
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  // Commands exercise the door through the native input capture; touch-keyboard
  // focus belongs to the phone-input suite.
  await input.focus();
  await waitForGameInput(page);
}

async function roomTwo(page: Page): Promise<void> {
  await start(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const source =
      "if(isset(f5)){assignn(v100,1);load.pic(v100);draw.pic(v100);show.pic();animate.obj(o0);load.view(0);set.view(o0,0);position(o0,60,140);draw(o0);accept.input();}return;";
    const result = await session.submit({
      proposal: session.model.propose(session.model.capture(), "Door", [
        {
          key: "logic:1",
          content: source.replace("return;", 'if (said("look")) { new.room(2); } return;'),
        },
        {
          key: "logic:2",
          content: 'if (isset(f5)) { accept.input(); } if (said("look")) { new.room(1); } return;',
        },
        { key: "logic:90", content: "call.v(v40); return;" },
        {
          key: "world",
          content: JSON.stringify({
            rooms: {
              "1": { title: "Home", description: "", exits: { door: 2 } },
              "2": { title: "", description: "", exits: { back: 1 } },
            },
            facts: {},
            quests: {},
          }),
        },
      ]),
      label: "Door",
      author: "creator",
      origin: "logic",
    });
    if (result.status !== "committed") throw new Error(JSON.stringify(result));
  });
  await workspaceSaved(page);
  await open(page, "part-room:2:logic");
}
async function shot(page: Page, name: string, browserName: string): Promise<void> {
  const bytes = await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    animations: "disabled",
    scale: "css",
  });
  if (process.env["CI"] && browserName === "webkit")
    console.log(`RENUMBER_SHOT:${name}:${bytes.toString("base64")}`);
}
for (const [width, height] of [
  [1440, 900],
  [1063, 815],
  [390, 844],
] as const) {
  test.describe(`Change number ${width}`, () => {
    test.use({ hasTouch: width === 390 });
    test("room 2 moves to 7, its door still enters it, and one Undo restores it @webkit-desktop", async ({
      page,
      browserName,
    }) => {
      await page.setViewportSize({ width, height });
      await roomTwo(page);
      await shot(page, `before-field-${width}`, browserName);
      const button = page.getByRole("button", { name: "Change number…", exact: true });
      await expect(button).toBeVisible();
      await button.click();
      const dialog = page.getByRole("dialog", { name: "Change number", exact: true });
      await expect(dialog).toBeVisible();
      const number = dialog.getByLabel("Number", { exact: true });
      await expect(number).toBeVisible();
      await number.fill("1");
      await dialog.getByRole("button", { name: "Continue", exact: true }).click();
      const refusal = dialog.getByRole("alert");
      await expect(refusal).toBeVisible();
      await expect(refusal).toContainText("LOGIC 1 is already taken");
      expect(await runningWorkspaceDocument(page, "logic:2")).toContain("new.room(1)");
      await number.fill("2");
      await dialog.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(dialog).toBeHidden();
      await button.click();
      await number.fill("7");
      await shot(page, `after-field-${width}`, browserName);
      await dialog.getByRole("button", { name: "Continue", exact: true }).click();
      const computed = dialog.getByTestId("renumber-computed");
      await expect(computed).toBeVisible();
      await expect(computed).toContainText("LOGIC 90 · Line 1");
      await shot(page, `after-computed-${width}`, browserName);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await runningWorkspaceDocument(page, "logic:2")).toContain("new.room(1)");
      await button.click();
      await number.fill("7");
      await dialog.getByRole("button", { name: "Continue", exact: true }).click();
      await dialog.getByRole("button", { name: "Change number", exact: true }).click();
      const restart = dialog.getByRole("button", { name: "Update and restart", exact: true });
      await expect(restart).toBeVisible();
      expect(await runningWorkspaceDocument(page, "logic:1")).toContain("new.room(2)");
      await restart.click();
      await expect(dialog).toBeHidden();
      await workspaceSaved(page);
      expect(await runningWorkspaceDocument(page, "logic:1")).toContain("new.room(7)");
      await expect(page.getByTestId("project-tab-logic:7")).toBeVisible();
      // Return from the selected room, then enter through its door.
      if (width === 390) {
        const playtest = page.getByRole("button", { name: "Playtest", exact: true });
        await expect(playtest).toBeVisible();
        await playtest.click();
      }
      await focusGame(page);
      await page.getByTestId("input-line").fill("look");
      await page.getByTestId("input-line").press("Enter");
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await page.getByTestId("input-line").fill("look");
      await page.getByTestId("input-line").press("Enter");
      await expect.poll(async () => (await textHook(page)).room).toBe(7);
      await page.getByTestId("input-line").fill("look");
      await page.getByTestId("input-line").press("Enter");
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await page.getByTestId("workspace-undo").click();
      await workspaceSaved(page);
      expect(await runningWorkspaceDocument(page, "logic:1")).toContain("new.room(2)");
      expect(await runningWorkspaceDocument(page, "logic:2")).toContain("new.room(1)");
      await open(page, "part-room:2:logic");
      const update = page.getByTestId("workspace-update");
      await expect(update).toBeVisible();
      await update.click();
      await expect.poll(async () => (await textHook(page)).room).toBe(2);
      await focusGame(page);
      await page.getByTestId("input-line").fill("look");
      await page.getByTestId("input-line").press("Enter");
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await page.getByTestId("input-line").fill("look");
      await page.getByTestId("input-line").press("Enter");
      await expect.poll(async () => (await textHook(page)).room).toBe(2);
    });
  });
}
