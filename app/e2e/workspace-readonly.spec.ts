import type { Page } from "@playwright/test";
import { createSoundDocument } from "../../src/sound/document.ts";
import { exportMidi } from "../../src/sound/midi.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { test, expect } from "./test.ts";
import { isolateStorage, workspaceSaved } from "./engineProbe.ts";
import { openStoredWorkspace } from "./workspaceShared.ts";

async function documents(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    return session.model.capture().documents();
  });
}

for (const size of [
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  for (const kind of ["picture", "view", "sound", "words"] as const) {
    test(`stale ${kind} stays inspectable at ${size.width}`, async ({ page, context }) => {
      await page.setViewportSize(size);
      await isolateStorage(page);
      await page.goto("/#create-adventure");
      await page.getByTestId("local-create-kind-starter").click();
      await page.getByRole("button", { name: "Start building", exact: true }).click();
      await workspaceSaved(page);
      if (size.width === 390) await page.getByTestId("workspace-parts").click();
      const part = {
        picture: "room:1:picture:1",
        view: "view:0",
        sound: "sound:1",
        words: "words",
      }[kind];
      await page.getByTestId(`part-${part}`).click();
      if (kind === "sound") {
        const music = createSoundDocument().insertEvent(0, 0, {
          ticks: 30,
          data: { kind: "tone", note: "C4", attenuation: 3 },
        });
        await page.getByLabel("Music file", { exact: true }).setInputFiles({
          name: "pending.mid",
          mimeType: "audio/midi",
          buffer: Buffer.from(exportMidi(music)),
        });
        await expect(
          page.getByRole("button", { name: "Replace SOUND 1", exact: true }),
        ).toBeVisible();
      }
      const other = await context.newPage();
      await other.setViewportSize({ width: 1440, height: 900 });
      await other.goto("/");
      await openStoredWorkspace(other, "My adventure");
      await other.getByTestId("part-notes").click();
      await other.getByLabel("Game notes", { exact: true }).fill("Other tab's version");
      await workspaceSaved(other);
      await page.bringToFront();
      const note = page.getByTestId("stale-tab-note");
      await expect(note).toBeVisible();
      const before = await documents(page);
      if (kind === "picture" || kind === "view") {
        const editor = page.locator(kind === "picture" ? ".studio" : ".sprite-studio");
        const stage = editor.locator(
          kind === "picture" ? ".studio__stage" : ".sprite-studio__stage",
        );
        await stage.focus();
        await expect(stage).toBeFocused();
        const bytes = await page.evaluate(
          (kind) => [
            ...(kind === "picture" ? window.__AGI_STUDIO__! : window.__AGI_SPRITE__!).bytes(),
          ],
          kind,
        );
        await stage.press(kind === "picture" ? "l" : "b");
        await stage.press("Enter");
        await stage.press("ArrowRight");
        await stage.press("Enter");
        expect(
          await page.evaluate(
            (kind) => [
              ...(kind === "picture" ? window.__AGI_STUDIO__! : window.__AGI_SPRITE__!).bytes(),
            ],
            kind,
          ),
        ).toEqual(bytes);
        await expect(
          editor.getByRole("button", { name: kind === "picture" ? "Line" : "Pencil", exact: true }),
        ).toBeDisabled();
        const zoom = editor.getByRole("group", { name: "Zoom", exact: true });
        const prior = await zoom.innerText();
        await zoom.getByRole("button", { name: "Zoom in", exact: true }).click();
        await expect(zoom).not.toHaveText(prior);
        if (kind === "view" && size.width === 1063) {
          await page.getByTestId("workspace-focus").click();
          const details = editor.getByTestId("sprite-cel-details");
          if ((await details.getAttribute("aria-expanded")) !== "true") await details.click();
          await expect(editor.getByLabel("Width in pixels")).toBeDisabled();
          await expect(editor.getByTestId("sprite-transparent-colour")).toBeDisabled();
        }
      } else if (kind === "sound") {
        const editor = page.getByTestId("workspace-sound");
        const preview = editor.getByTestId("sound-import-summary");
        await expect(preview).toBeVisible();
        await expect(preview).toContainText("pending.mid");
        await expect(
          preview.getByRole("button", { name: "Replace SOUND 1", exact: true }),
        ).toBeDisabled();
        await expect(preview.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
        await editor.getByRole("button", { name: "Tracker", exact: true }).click();
        const cell = editor.locator("[data-note-id] input.note").first();
        await cell.focus();
        await expect(cell).toBeFocused();
        const prior = await cell.inputValue();
        await cell.press("Delete");
        await cell.press("A");
        await cell.press("Tab");
        await expect(cell).toHaveValue(prior);
        await editor.getByRole("button", { name: "Grid", exact: true }).click();
        const grid = editor.locator("canvas").filter({ visible: true }).first();
        await grid.focus();
        await expect(grid).toBeFocused();
        await grid.press("Enter");
        await grid.press("ArrowRight");
        await grid.press("Delete");
        await editor.getByRole("button", { name: "Tracker", exact: true }).click();
        await expect(cell).toHaveValue(prior);
        await expect(editor.getByLabel("Tempo", { exact: true })).toBeDisabled();
        await editor.getByTestId("sound-play").click();
        await expect(editor.getByTestId("sound-play")).toHaveAttribute("aria-label", "Stop");
        await editor.getByTestId("sound-play").click();
      } else {
        const editor = page.getByTestId("workspace-words-editor");
        await editor.getByRole("textbox", { name: "Find a word", exact: true }).fill("100");
        await expect(editor.locator(".meaning-row")).toHaveCount(1);
        const remove = editor.getByRole("button", { name: "Remove look", exact: true });
        await expect(remove).toBeDisabled();
        await remove.dispatchEvent("click");
        await editor.getByRole("textbox", { name: "A sentence a player might type" }).fill("look");
        await expect(editor.getByTestId("sentence-outcome")).toContainText("Answers “You stand");
      }
      expect(await documents(page)).toEqual(before);
      await page.keyboard.press("Escape");
      await expect(note.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
      for (const name of ["Download unsaved edits", "Download game", "Reload", "Exit"]) {
        const button = note.getByRole("button", { name, exact: true });
        await expect(button).toBeVisible();
        const box = (await button.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(size.width);
        expect(box.y + box.height).toBeLessThanOrEqual(size.height);
      }
      await page.screenshot({
        path: test.info().outputPath(`stale-${kind}-${size.width}.png`),
        animations: "disabled",
      });
    });
  }
}
