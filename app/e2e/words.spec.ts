import { mkdir } from "node:fs/promises";
import { test, expect } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";

for (const width of [1440, 1280])
  test(`Words sentence, local playtest miss and Same as at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await page
      .getByTestId("create-adventure-disclosure")
      .getByLabel("Name", { exact: true })
      .fill("Words proof");
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    if ((await textHook(page)).modal) {
      await page.getByTestId("input-line").focus();
      await page.keyboard.press("Enter");
    }
    await page.getByTestId("part-words").click();
    const editor = page.getByTestId("workspace-words-editor");
    await expect(editor).toBeVisible();
    const sentence = editor.getByRole("textbox", { name: "A sentence a player might type" });
    await sentence.fill("inspect around");
    await expect(page.getByTestId("sentence-parse")).toContainText("new word");
    await expect(page.getByTestId("sentence-parse")).toContainText("not read");
    await editor.getByRole("button", { name: "Type it in the game ↵", exact: true }).click();
    await expect(page.getByTestId("player-sentence")).toContainText("inspect around");
    await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
    await page.getByTestId("input-line").focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();
    await page
      .getByTestId("player-sentence")
      .getByRole("button", { name: /Same as/ })
      .click();
    const choose = editor.getByRole("combobox", { name: "Same meaning" });
    await choose.selectOption("100");
    await editor
      .getByRole("form", { name: "Same as…" })
      .getByRole("button", { name: "Add word", exact: true })
      .click();
    await expect(page.getByTestId("player-sentence")).toHaveCount(0);
    await sentence.fill("inspect");
    await expect(page.getByTestId("sentence-parse")).toContainText("· 100");
    await expect(page.getByTestId("sentence-outcome")).toContainText("LOGIC 1");
    await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
    await editor.getByRole("button", { name: "Type it in the game ↵", exact: true }).click();
    await expect
      .poll(async () => (await textHook(page)).rows.join("\n"))
      .toContain("You stand in a sunny clearing");
    await expect(page.getByTestId("player-sentence")).toHaveCount(0);
    await editor.getByRole("textbox", { name: "Find a word", exact: true }).fill("100");
    await expect(editor.locator(".meaning-row")).toHaveCount(1);
    await editor.getByRole("textbox", { name: "Find a word", exact: true }).fill("");
    await mkdir("../logs/words-shots", { recursive: true });
    await page.screenshot({ path: `../logs/words-shots/chromium-${width}-words.png` });
    await page.getByTestId("workspace-focus").click();
    await editor.getByRole("button", { name: "Move to… inspect", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(editor.getByRole("form", { name: "Move to…" })).toHaveCount(0);
    await sentence.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".play-area")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.locator(".play-area")).toBeVisible();
  });
