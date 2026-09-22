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
  return page.locator(".saved-game-card", { hasText: name });
}

test("installs a synthetic game without interpreter files, sees the picker, picks a profile, and boots under it", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const zip = syntheticGame();
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "synthetic-choice.zip",
    mimeType: "application/zip",
    buffer: zip,
  });

  // Sees the picker dialog
  const picker = page.getByTestId("profile-picker-dialog");
  await expect(picker).toBeVisible();

  // Container default (2.936) is preselected
  const select = page.getByTestId("profile-picker-select");
  await expect(select).toHaveValue("2.936");

  // Picks a profile, e.g. 2.411
  await select.selectOption("2.411");
  await page.getByTestId("profile-picker-confirm").click();
  await expect(picker).toBeHidden();

  // Boots under it
  const card = savedGameCard(page, "synthetic-choice");
  await card.getByTestId("btn-resume-cached").click();

  // The booted profile is visible through existing test hooks
  await expect.poll(async () => (await textHook(page)).profile).toBe("2.411");
});

test("decide later keeps container default profile", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  const zip = syntheticGame();
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "synthetic-decide-later.zip",
    mimeType: "application/zip",
    buffer: zip,
  });

  const picker = page.getByTestId("profile-picker-dialog");
  await expect(picker).toBeVisible();
  await page.getByTestId("profile-picker-decide-later").click();
  await expect(picker).toBeHidden();

  const card = savedGameCard(page, "synthetic-decide-later");
  await card.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).profile).toBe("2.936");
  await expect.poll(async () => (await textHook(page)).profileKind).toBe("default");
});

test("gallery card menu shows interpreter profile and updates profile", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  const zip = syntheticGame();
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "synthetic-reboot.zip",
    mimeType: "application/zip",
    buffer: zip,
  });

  await page.getByTestId("profile-picker-decide-later").click();
  const card = savedGameCard(page, "synthetic-reboot");

  // Open action menu on the card
  await card.getByRole("button", { name: "Game actions" }).click();
  const menuItem = page.getByTestId("interpreter-profile-menu-item");
  await expect(menuItem).toBeVisible();
  await expect(menuItem).toContainText("2.936 (container default)");

  // Click menu item to open dialog
  await menuItem.click();
  const picker = page.getByTestId("profile-picker-dialog");
  await expect(picker).toBeVisible();

  // Change to 2.440 and confirm
  const select = page.getByTestId("profile-picker-select");
  await select.selectOption("2.440");
  await page.getByTestId("profile-picker-confirm").click();
  await expect(picker).toBeHidden();

  // Now boot under the newly configured profile
  await card.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).profile).toBe("2.440");
});
