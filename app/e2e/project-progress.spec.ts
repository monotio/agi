import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { readGameZip } from "../src/gameZip.ts";
import { buildProjectZip } from "../src/projectArchive.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { Engine } from "../../src/runtime/engine.ts";
import {
  isolateStorage,
  openGameOptions,
  storedAutosave,
  textHook,
  waitForAutosaveAfter,
  waitForCycles,
} from "./engineProbe.ts";

const TUTORIAL_PROJECT_ID = "catalog-adventure-department-1.0.0";

test("project import names each stored and refused progress entry", async ({ page }, testInfo) => {
  const container = createContainer();
  container.putFile("WORDS.TOK", new Uint8Array(52));
  container.putResource("picture", 1, Uint8Array.of(0xff));
  for (const [room, source] of [
    [0, "if(!isset(f200)){set(f200);new.room(1);}call(1);return;"],
    [1, "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();accept.input();}return;"],
  ] as const)
    container.putResource("logic", room, assembleLogic(source, { dictionary: new Map() }).payload);
  const engine = new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  });
  engine.tick();
  const image = engine.autosaveImage();
  expect(image).not.toBeNull();
  const archive = await buildProjectZip(
    {
      projectId: "storage-report",
      title: "Storage report",
      authoredAt: new Date(0).toISOString(),
      provider: "stub",
      model: "stub",
      files: Object.fromEntries(container.files),
      words: [],
    },
    {
      saves: { "1": engine.serialize(), "7": engine.serialize() },
      autosave: {
        format: "monotio.agi.autosave",
        version: 1,
        image: Buffer.from(image!).toString("base64"),
        cycle: 1,
        room: 1,
        savedAt: 1,
        game: { projectId: "storage-report", installed: false, revision: "ab".repeat(32) },
      },
    },
  );
  await isolateStorage(page);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (
        key.startsWith("monotio_agi.autosave.") ||
        (key.startsWith("monotio_agi.saves.") && JSON.parse(value).slots["7"])
      )
        throw new Error("Injected storage refusal");
      original.call(this, key, value);
    };
  });
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "storage-report.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });
  const notice = page.locator(".import-notice");
  await expect(notice).toContainText("save slot 1 stored");
  await expect(notice).toContainText("save slot 7 could not be stored");
  await expect(notice).toContainText("autosave could not be stored");
  const stored = await page.evaluate(async () => {
    const { listCachedGames } = await import("/src/gameStorage.ts");
    const { readGameSaves } = await import("/src/gameSaves.ts");
    const projectId = listCachedGames()[0]!.projectId;
    return {
      slots: Object.keys(readGameSaves(localStorage, projectId)),
      autosave: localStorage.getItem(`monotio_agi.autosave.${projectId}`),
    };
  });
  expect(stored).toEqual({ slots: ["1"], autosave: null });
  await page.screenshot({
    path: testInfo.outputPath("partial-progress-import.png"),
    fullPage: true,
  });
});

/**
 * A project archive carries the player's progress; a game export never does.
 * Imported on another browser, the project's card offers Resume and lands
 * where the walk stopped.
 */
test("the project archive moves the autosave to another browser; the game export carries none", async ({
  page,
  browser,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
  const spawnX = (await textHook(page)).egoX;
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(spawnX + 12);
  await page.keyboard.press("ArrowRight");
  await waitForCycles(page, 4);
  const stopped = await textHook(page);
  await waitForCycles(page, 2);
  expect((await textHook(page)).egoX, "ego stands still before the checkpoint").toBe(stopped.egoX);
  await waitForAutosaveAfter(page, stopped.cycle);
  expect((await storedAutosave(page, TUTORIAL_PROJECT_ID))?.room).toBe(1);

  // The project download from the running game carries the checkpoint.
  const projectDownload = page.waitForEvent("download");
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-save-live-project").click();
  const saved = await projectDownload;
  const savedPath = (await saved.path())!;
  const project = await readGameZip(new Uint8Array(await readFile(savedPath)));
  expect(project.progress?.autosave?.room).toBe(1);
  expect(project.progress?.autosave?.game.projectId).toBe(TUTORIAL_PROJECT_ID);
  expect(Object.keys(project.progress?.saves ?? {})).toEqual([]);

  // The game export is for publishing: no progress in it.
  const publicDownload = page.waitForEvent("download");
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-export-live-zip").click();
  const published = await publicDownload;
  const publicGame = await readGameZip(new Uint8Array(await readFile((await published.path())!)));
  // Publication safety: tests, saves and authoring context each excluded on their own.
  expect(
    publicGame.files["TESTS.JSON"],
    "tests travel with the project archive only",
  ).toBeUndefined();
  expect(publicGame.progress, "saves travel with the project archive only").toBeUndefined();
  expect(
    publicGame.project,
    "authoring context travels with the project archive only",
  ).toBeUndefined();
  expect(project.files["TESTS.JSON"]).toBeDefined();

  const fresh = await browser.newContext();
  try {
    const other = await fresh.newPage();
    await other.goto(page.url());
    await other.getByTestId("game-zip-input").setInputFiles(savedPath);
    await expect(other.getByText(/added to your library.*autosave stored/)).toBeVisible();
    const resume = other.getByTestId("btn-resume-cached");
    await expect(resume).toHaveText("Resume");
    const projectId = await other.evaluate(async () => {
      const path = "/src/gameStorage.ts";
      const store = await import(path);
      return store.listCachedGames()[0].projectId as string;
    });
    expect(projectId).not.toBe(TUTORIAL_PROJECT_ID);
    expect((await storedAutosave(other, projectId))?.room).toBe(1);
    await resume.click();
    await expect.poll(async () => (await textHook(other)).room).toBe(1);
    await expect
      .poll(async () => (await textHook(other)).egoX, {
        message: "the imported checkpoint is restored, not a boot from room 1",
      })
      .toBe(stopped.egoX);
    await expect(other.getByTestId("resume-caption")).toBeVisible();
  } finally {
    await fresh.close();
  }
});
