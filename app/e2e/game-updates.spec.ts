import { readFile } from "node:fs/promises";
import { readGameZip } from "../src/archive/gameZip.ts";
import { test, expect } from "./test.ts";
import { isolateStorage, workspaceSaved, waitForRoom, openGameOptions } from "./engineProbe.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { releasedTemplates } from "../../test/released-template-fixtures.ts";

test("Create explains legacy updates and previews Add before changing code @phone", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const documents = {
    "logic:0": releasedTemplates.at(-1)!.source,
    "logic:1": "return;",
    words: "[]",
    inventory: "[]",
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const id = await page.evaluate(
    async ({ files, workspace }) => {
      const { saveAuthoredGame } = await import("/src/project/gameStorage.ts");
      const id = "legacy-updates";
      await saveAuthoredGame(id as never, {
        title: "Older adventure",
        files: Object.fromEntries(files.map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
        words: [],
        workspace,
      });
      return id;
    },
    {
      files: [...compiled.files()].map(([name, bytes]) => [name, [...bytes]] as [string, number[]]),
      workspace: writeProjectWorkspace(documents),
    },
  );
  await page.goto(`/?older#create/${encodeURIComponent(id)}`);
  await waitForRoom(page, 1, { coldBoot: true });
  await workspaceSaved(page);
  await page.getByTestId("workspace-undo").click();
  await workspaceSaved(page);
  const notice = page.getByTestId("game-updates");
  await expect(notice).toBeVisible();
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-download-game").click();
  const downloadDialog = page.getByTestId("settings-download-dialog");
  await expect(downloadDialog.getByTestId("export-room-memory")).toBeVisible();
  await expect(downloadDialog.getByTestId("export-room-memory")).toHaveText(
    "Big rooms may stop working when this game runs elsewhere. Add room memory in Game updates first.",
  );
  const downloading = page.waitForEvent("download");
  await downloadDialog.getByTestId("export-library-game").click();
  const download = await downloading;
  const exported = await readGameZip(new Uint8Array(await readFile((await download.path())!)));
  expect(exported.authoringConventions).toEqual({ version: 1, legacyRoomMemory: true });
  await expect(downloadDialog).toBeHidden();
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    if (width === 390 && !(await page.getByTestId("parts-list").isVisible()))
      await page.getByTestId("workspace-parts").click();
    await expect(notice).toBeInViewport();
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath(`updates-${width}.png`),
    });
    await page
      .getByTestId("game-update-memory")
      .getByRole("button", { name: "Add", exact: true })
      .click();
    const preview = page.getByTestId("game-update-preview");
    await expect(preview).toBeVisible();
    await expect(preview.locator("pre")).toHaveText("script.size(200);");
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath(`updates-preview-${width}.png`),
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          String(
            (
              window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
            ).__AGI_PROJECT__
              .getSession()
              .model.capture()
              .read("logic:0")!.content,
          ).includes("script.size(200)"),
        ),
      )
      .toBe(false);
    await preview.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  // The preview is bound to its document revision, including document-only edits.
  await page
    .getByTestId("game-update-memory")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await page.evaluate(async () => {
    const s = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    await s.update([{ key: "notes", content: "Changed during the preview" }], false);
    await s.flush();
  });
  await page
    .getByTestId("game-update-preview")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await expect(page.getByTestId("game-update-preview").getByRole("alert")).toHaveText(
    "The code changed. Cancel and open Add again.",
  );
  await page
    .getByTestId("game-update-preview")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page
    .getByTestId("game-update-memory")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await page
    .getByTestId("game-update-preview")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await expect(page.getByTestId("game-update-memory")).toHaveCount(0);
  await page
    .getByTestId("game-update-words")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await expect(page.getByTestId("game-update-preview").locator("pre")).toContainText(
    "word.to.string(s11, 0);",
  );
  await page
    .getByTestId("game-update-preview")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await expect(notice).toHaveCount(0);
  await workspaceSaved(page);
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-download-game").click();
  await expect(downloadDialog).toBeVisible();
  await expect(downloadDialog.getByTestId("export-library-game")).toBeEnabled();
  await expect(downloadDialog.getByTestId("export-room-memory")).toHaveCount(0);
});
