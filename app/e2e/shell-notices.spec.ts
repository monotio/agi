import { expect, test } from "./test.ts";
import { isolateStorage, waitForRoom } from "./engineProbe.ts";

test("recovery dialogs leave the game its space when the last notice disappears @webkit-desktop @phone", async ({
  page,
  context,
}) => {
  const phone = test.info().project.name === "iphone-webkit";
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1063, height: 815 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  const band = page.locator(".shell-notices");
  const bandHeight = async () => (await band.boundingBox())!.height;
  await expect.poll(bandHeight).toBe(0);

  const pending = await page.evaluate(async () => {
    const { listCachedGames } = await import("/src/project/gameStorage.ts");
    const { projectSaveJournalKey, markProjectSaveRecovery } =
      await import("/src/project/projectSaveJournal.ts");
    const id = listCachedGames()[0]!.projectId;
    const key = projectSaveJournalKey(id, "notice-geometry");
    localStorage.setItem(key, "retained pending edits");
    markProjectSaveRecovery(localStorage, key, "Project changed in another tab");
    return { id, key };
  });
  const notice = band.getByTestId("pending-edit-recovery");
  await expect(notice).toBeVisible();
  await expect.poll(bandHeight).toBeGreaterThan(0);
  const withNotice = await bandHeight();
  const dialog = page.getByTestId("discard-edits-dialog");
  await notice.getByRole("button", { name: "Discard edits", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await bandHeight()).toBe(withNotice);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await bandHeight()).toBe(withNotice);
  await notice.getByRole("button", { name: "Discard edits", exact: true }).click();
  await expect(dialog).toBeVisible();

  const other = await context.newPage();
  await other.goto("/");
  await other.evaluate(async (id) => {
    const { readProjectSaveRecoveries, discardProjectSaveRecoveries } =
      await import("/src/project/projectSaveJournal.ts");
    discardProjectSaveRecoveries(localStorage, id, readProjectSaveRecoveries(localStorage, id));
  }, pending.id);
  await page.bringToFront();
  await expect(notice).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect.poll(bandHeight).toBe(0);
  await page.screenshot({ path: test.info().outputPath("dialog-without-notice.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(bandHeight).toBe(0);

  await page.evaluate(async ({ key }) => {
    const { markProjectSaveRecovery } = await import("/src/project/projectSaveJournal.ts");
    localStorage.setItem(key, "retained pending edits");
    markProjectSaveRecovery(localStorage, key, "Project changed in another tab");
  }, pending);
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Discard edits", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Discard edits", exact: true }).click();
  await expect(notice).toBeHidden();
  await expect(dialog).toBeHidden();
  await expect.poll(bandHeight).toBe(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), pending.key)).toBeNull();
});
