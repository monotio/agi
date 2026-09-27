import { expect, keepDetectedProfile, test } from "./test.ts";
import type { Page } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import {
  cacheGame,
  enterCreateMode,
  isolateStorage,
  openLibraryActions,
  savedGameCard,
  storedAutosave,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";

/**
 * Two tabs of one browser share its storage. Tab B plays a game; tab A
 * removes it from Home. B keeps the game playable in memory but stores
 * nothing for it again — no checkpoint, no timeline — says so once, and its
 * reload paths say the same; A's Home never offers to continue it.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const PROJECT = testProjectId("two-tab-removal");
const TITLE = "Removed elsewhere";
const REMOVED =
  "This game was removed in another tab. Download it to keep a copy, or go back to your games.";
const SOURCE = [
  '# @item occluder "Bench occluder" depth',
  "vis off",
  "pri 10",
  "polygon 40,90 119,90 126,98 119,105 40,105",
  "fill 80,97",
  "# @end",
  "end",
].join("\n");

function game(): Record<string, Uint8Array> {
  const container = createContainer();
  const dictionary = new Map<string, number>();
  const logic = (source: string) => assembleLogic(source, { dictionary }).payload;
  container.putFile("WORDS.TOK", buildWordsTok([{ word: "look", id: 1 }]));
  container.putResource("picture", 5, compilePictureSource(SOURCE).bytes);
  container.putResource(
    "logic",
    0,
    logic("if(!isset(f200)){set(f200);accept.input();new.room(1);}call.v(v0);return;"),
  );
  container.putResource(
    "logic",
    1,
    logic(
      "if(isset(f5)){assignn(v30,5);load.pic(v30);draw.pic(v30);discard.pic(v30);show.pic();}return;",
    ),
  );
  return Object.fromEntries(container.files);
}

/** Everything this browser holds for the project: its record and every key naming it. */
function held(page: Page) {
  return page.evaluate(async (id) => {
    const path = "/src/project/gameStorage.ts";
    const { loadAuthoredGame } = await import(path);
    return {
      record: (await loadAuthoredGame(id)) !== null,
      keys: Object.keys(localStorage).filter((key) => key.includes(id)),
      lastGame: localStorage.getItem("monotio_agi.lastGame"),
    };
  }, PROJECT);
}

test("a game removed in another tab stops storing, says so once, and never comes back to Home", async ({
  page,
}) => {
  // Tab A holds the game on Home.
  await isolateStorage(page);
  await page.goto("/");
  await cacheGame(page, {
    projectId: PROJECT,
    title: TITLE,
    provider: "stub",
    model: "stub",
    imported: false,
    roomGeneration: true,
    authoringState: {
      authoring: {
        version: 1,
        bindings: {},
        world: {
          rooms: { "1": { title: "Bench Hall", description: "A bench.", exits: {} } },
          facts: {},
          quests: {},
        },
      },
      sources: { logics: [], pictures: [[5, SOURCE]] },
    },
    files: game(),
    words: [["look", 1]],
  });
  await page.reload();

  // Tab B plays it until it has a checkpoint.
  const tabB = await page.context().newPage();
  await keepDetectedProfile(tabB);
  await tabB.goto("/");
  await tabB.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(tabB)).room).toBe(1);
  await expect.poll(() => storedAutosave(tabB, PROJECT), { timeout: 20_000 }).not.toBeNull();

  // Tab A removes it, confirmed.
  await page.reload();
  const card = savedGameCard(page, TITLE);
  await openLibraryActions(page, card);
  await page.getByTestId("remove-library-game").click();
  await card.getByTestId("remove-game-confirm").click();
  await expect(card).toHaveCount(0);
  expect(await held(page)).toEqual({ record: false, keys: [], lastGame: null });

  // B hears it at once: one plain note, not "changed in another tab".
  const note = tabB.getByTestId("removed-tab-note");
  await expect(note).toContainText(REMOVED);
  await expect(tabB.getByTestId("stale-tab-note")).toHaveCount(0);

  // B plays on past several checkpoint intervals; nothing is stored for the
  // game, and no "saving is retrying" banner stands for a timeline it can't store.
  const cycle = (await textHook(tabB)).cycle;
  await tabB.waitForTimeout(12_000);
  expect((await textHook(tabB)).cycle).toBeGreaterThan(cycle);
  expect(await held(tabB)).toEqual({ record: false, keys: [], lastGame: null });
  await expect(tabB.getByTestId("history-unsaved")).toHaveCount(0);

  // Home never offers to continue the removed game.
  await page.reload();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  await expect(page.getByTestId("hero-primary")).toHaveText("Play the tutorial");
  await expect(page.getByTestId("btn-resume-autosave")).toHaveCount(0);

  // Studio's Keep refuses, and its Reopen says the same as the note, never nothing.
  await note.getByRole("button", { name: "Dismiss" }).click();
  await expect(note).toHaveCount(0);
  await enterCreateMode(tabB);
  const panel = tabB.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await panel.getByTestId("world-open-studio").click();
  const studio = tabB.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await tabB.keyboard.press("2");
  await studio.locator('[data-row="occluder"]').click();
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await tabB.keyboard.press("ArrowDown");
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-keep-error")).toBeVisible();
  await studio.getByTestId("studio-recover").click();
  await tabB.getByTestId("studio-dialog-reload").click();
  await expect(studio).toHaveCount(0);
  await expect(note).toContainText(REMOVED);
  await waitForCycles(tabB, 2);
  expect(await held(tabB)).toEqual({ record: false, keys: [], lastGame: null });

  // Download game keeps a copy of the running game; Back to games leaves it.
  const download = tabB.waitForEvent("download");
  await note.getByTestId("removed-tab-download").click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
  await note.getByTestId("removed-tab-leave").click();
  await expect(tabB.getByTestId("saved-game-gallery")).toBeVisible();
  await expect(tabB.getByTestId("hero-primary")).toHaveText("Play the tutorial");
  expect(await held(tabB)).toEqual({ record: false, keys: [], lastGame: null });
});
