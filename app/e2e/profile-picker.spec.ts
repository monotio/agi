import { test, expect } from "@playwright/test";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/zip.ts";

function syntheticGame(): Buffer {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic(
      'assignn(v0, 1); display(5, 4, "Synthetic Profile Test"); accept.input(); return;',
      {
        dictionary: new Map(),
      },
    ).payload,
  );
  game.putFile("WORDS.TOK", new Uint8Array(52));
  const files = [...game.files].map(([name, data]) => ({ name, data }));
  return Buffer.from(buildZip(files));
}

function savedGameCard(page: Parameters<typeof textHook>[0], name: string) {
  return page.locator("[data-testid^='saved-game-card-']", { hasText: name });
}

async function importSynthetic(page: Parameters<typeof textHook>[0], name: string) {
  await page.getByTestId("game-zip-input").setInputFiles({
    name: `${name}.zip`,
    mimeType: "application/zip",
    buffer: syntheticGame(),
  });
}

test("an unidentified import asks for a profile in a modal and boots under the choice", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await importSynthetic(page, "synthetic-choice");

  const picker = page.getByTestId("profile-picker-dialog");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("heading")).toContainText("synthetic-choice");
  // The detected default is preselected and marked; the options are grouped by platform.
  const select = page.getByTestId("profile-picker-select");
  await expect(select).toHaveValue("2.936");
  await expect(select.locator("option:checked")).toContainText("default");
  expect(
    await select.locator("optgroup").evaluateAll((g) => g.map((e) => e.getAttribute("label"))),
  ).toEqual(["PC v2", "PC v3", "Amiga", "Apple IIgs"]);
  // A native modal: focus is inside it.
  expect(await picker.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);

  await select.selectOption("2.411");
  await page.getByTestId("profile-picker-confirm").click();
  await expect(picker).toBeHidden();

  await savedGameCard(page, "synthetic-choice").getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).profile).toBe("2.411");

  // The same bytes imported again keep the stored choice without asking.
  await page.goto("/");
  await importSynthetic(page, "synthetic-choice");
  await expect(page.getByTestId("game-import-ready")).toBeVisible();
  await expect(picker).toBeHidden();
});

test("keeping the default or pressing Escape stores no override", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await importSynthetic(page, "synthetic-keep");

  const picker = page.getByTestId("profile-picker-dialog");
  await expect(picker).toBeVisible();
  await expect(page.getByTestId("profile-picker-keep")).toHaveText("Keep 2.936");
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  const card = savedGameCard(page, "synthetic-keep");
  await card.getByRole("button", { name: "Game actions" }).click();
  await expect(page.getByTestId("interpreter-profile-menu-item")).toContainText(
    "2.936 (container default)",
  );
  await page.keyboard.press("Escape");
  await card.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).profile).toBe("2.936");
  await expect.poll(async () => (await textHook(page)).profileKind).toBe("default");
});

test("the card menu changes the profile and returns it to automatic", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await importSynthetic(page, "synthetic-menu");
  await page.getByTestId("profile-picker-keep").click();

  const card = savedGameCard(page, "synthetic-menu");
  const menuItem = page.getByTestId("interpreter-profile-menu-item");
  const picker = page.getByTestId("profile-picker-dialog");
  const select = page.getByTestId("profile-picker-select");

  await card.getByRole("button", { name: "Game actions" }).click();
  await menuItem.click();
  await expect(picker).toBeVisible();
  await expect(select).toHaveValue("");
  await select.selectOption("2.440");
  await page.getByTestId("profile-picker-confirm").click();
  await expect(picker).toBeHidden();

  await card.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).profile).toBe("2.440");

  await page.goto("/");
  await card.getByRole("button", { name: "Game actions" }).click();
  await expect(menuItem).toContainText("2.440 (your override)");
  await menuItem.click();
  await expect(select).toHaveValue("2.440");
  await select.selectOption("");
  await page.getByTestId("profile-picker-confirm").click();
  await expect(picker).toBeHidden();
  await card.getByRole("button", { name: "Game actions" }).click();
  await expect(menuItem).toContainText("2.936 (container default)");
});
