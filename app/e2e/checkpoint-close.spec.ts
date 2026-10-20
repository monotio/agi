import type { ProjectSession } from "../src/project/projectSession.ts";
import type { Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import {
  enterCreateMode,
  playFromCreate,
  isolateStorage,
  textHook,
  waitForCycles,
  waitForGameInput,
  workspaceSaved,
} from "./engineProbe.ts";

const SENTINEL = "CHECKPOINT_CLOSE_SENTINEL";
async function position(page: Page): Promise<{ room: number; egoX: number; egoY: number }> {
  let last = "";
  await expect
    .poll(async () => {
      const hook = await textHook(page);
      const next = `${hook.room}:${hook.egoX}:${hook.egoY}`;
      await waitForCycles(page, 4);
      const settled = next === last;
      last = next;
      return settled;
    })
    .toBe(true);
  const [room, egoX, egoY] = last.split(":").map(Number);
  return { room: room!, egoX: egoX!, egoY: egoY! };
}

// A document transaction cannot hold back progress for the already stored revision.
test("closing during a notes save resumes the progress entry stored before pagehide", async ({
  page,
  context,
}) => {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Close proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await workspaceSaved(page);

  // A stored checkpoint at the starting place.
  await playFromCreate(page);
  await waitForGameInput(page);
  await expect.poll(async () => (await textHook(page)).autosave).toBeGreaterThan(-1);
  const start = await position(page);

  // The edit's document write starts and never commits.
  await enterCreateMode(page);
  await page.getByTestId("part-notes").click();
  await page.getByLabel("Game notes", { exact: true }).fill(SENTINEL);
  await page.evaluate(async () => {
    const { serializeWrite, listCachedGames } = await import("/src/project/gameStorage.ts");
    const project = listCachedGames().find((game) => game.title === "Close proof")!;
    // Hold the document queue before its transaction starts. An open read-write
    // transaction would also block the checkpoint's independent lifetime read.
    await new Promise<void>((entered) => {
      void serializeWrite(project.projectId, () => {
        entered();
        return new Promise<void>(() => {});
      });
    });
  });
  await page.getByTestId("workspace-update-menu").click();
  await page.getByRole("menuitem", { name: "Update and keep playing", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
          ).__AGI_PROJECT__
            .getSession()
            .saveStatus().state,
      ),
    )
    .toBe("saving");

  // The player walks on while the edit saves.
  await playFromCreate(page);
  await waitForGameInput(page);
  await page.getByTestId("input-line").focus();
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(start.egoX + 8);
  await page.keyboard.up("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const walked = await position(page);
  expect(walked.egoX).not.toBe(start.egoX);

  const previousCycle = (await textHook(page)).autosave;
  await expect
    .poll(async () => (await textHook(page)).autosave, { timeout: 15_000 })
    .toBeGreaterThan(previousCycle);
  expect(await position(page)).toEqual(walked);
  const stored = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("monotio_agi.autosave.project:"))
      .map((key) => JSON.parse(localStorage.getItem(key)!) as { cycle: number; room: number }),
  );
  expect(stored).toHaveLength(1);
  expect(stored[0]!.cycle, "localStorage holds the progress entry before pagehide").toBe(
    (await textHook(page)).autosave,
  );
  expect(stored[0]!.room).toBe(walked.room);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
          .getSession()
          .saveStatus().state,
    ),
  ).toBe("saving");

  const reopened = await context.newPage();
  const journals = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith("monotio_agi.project-writes.")),
  );
  expect(journals).toHaveLength(1);
  await page.close({ runBeforeUnload: true });
  await reopened.goto("/");
  await reopened.evaluate(
    (keys) => Promise.all(keys.map((key) => navigator.locks.request(key, () => {}))),
    journals,
  );
  await reopened.getByTestId("intro-primary").click();
  await waitForGameInput(reopened);
  expect(await position(reopened)).toEqual(walked);
  await expect
    .poll(() =>
      reopened.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith("monotio_agi.project-writes.")),
      ),
    )
    .toEqual([]);
  await reopened.screenshot({ path: test.info().outputPath("checkpoint-close-resumed.png") });
  await enterCreateMode(reopened);
  await reopened.getByTestId("part-notes").click();
  await expect(reopened.getByLabel("Game notes", { exact: true })).toHaveValue(SENTINEL);
});
