import { readFile } from "node:fs/promises";
import type { Download } from "@playwright/test";
import { expect, test } from "./test.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { isolateStorage, openGameOptions, workspaceSaved } from "./engineProbe.ts";
import { openWorkspaceLogic } from "./workspaceShared.ts";

test("project download preserves the last update while LOGIC stays a draft", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Export boundary");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await workspaceSaved(page);
  await openWorkspaceLogic(page);
  await openGameOptions(page, "settings-menu");
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const model = monaco.editor
      .getModels()
      .find((model) => model.getValue().includes("sunny clearing"))!;
    (window as unknown as { editExportSource(): void }).editExportSource = () =>
      model.setValue(model.getValue().replace("sunny clearing", "exported clearing"));
  });
  const downloads: Download[] = [];
  page.on("download", (download) => downloads.push(download));
  await page.evaluate(() => {
    (window as unknown as { editExportSource(): void }).editExportSource();
    document.querySelector<HTMLButtonElement>("[data-testid='btn-download-game']")!.click();
  });
  await expect
    .poll(async () => ({
      downloads: downloads.length,
      refusal: (await page.getByTestId("export-refusal").count())
        ? await page.getByTestId("export-refusal").textContent()
        : "",
    }))
    .toEqual({ downloads: 1, refusal: "" });
  const downloaded = await readGameZip(
    new Uint8Array(await readFile((await downloads[0]!.path())!)),
  );
  const logic = downloaded.project?.workspace?.documents.find(
    ({ key }) => key === "logic:1",
  )?.content;
  expect(logic?.type).toBe("text");
  if (logic?.type === "text") expect(logic.text).toContain("sunny clearing");
});
