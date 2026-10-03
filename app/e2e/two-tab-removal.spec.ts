import type { Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { testProjectId } from "../test/identity.ts";
import {
  cacheGame,
  isolateStorage,
  openLibraryActions,
  savedGameCard,
  storedAutosave,
  progressStorageKey,
  textHook,
} from "./engineProbe.ts";
import { expect, keepDetectedProfile, test } from "./test.ts";

/**
 * Two tabs of one browser share its storage. Tab B plays a game; tab A
 * removes it from Home. B keeps the game playable in memory but stores
 * nothing for it again — no checkpoint, no timeline — says so once, and its
 * reload paths say the same; A's Home never offers to continue it.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const PROJECT = testProjectId("a");
const SIBLING = testProjectId("a.b");
const TITLE = "Removed elsewhere";
const REMOVED = "This project was removed. Download your unsaved edits to keep them.";
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

/** Observable data at the removed lifetime's exact addresses. */
function held(page: Page, locator: string) {
  return page.evaluate(
    async ({ id, locator }) => {
      const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
      const { autosaveKey } = await import("/src/saves/gameProgress.ts");
      const { readResumePointer } = await import("/src/saves/resumePointer.ts");
      const { readProjectSaveRecoveries } = await import("/src/project/projectSaveJournal.ts");
      return {
        record: (await loadAuthoredGame(id)) !== null,
        checkpoint: localStorage.getItem(autosaveKey(locator)) !== null,
        recovery: readProjectSaveRecoveries(localStorage, id).length,
        resume: readResumePointer(localStorage)?.value === locator,
      };
    },
    { id: PROJECT, locator },
  );
}

interface WorkerOffers {
  /** Checkpoints the game offered its host to store. */
  autosave: number;
  /** Timeline batches the game offered its host to store. */
  historyBatch: number;
}

/** Count what the game's worker offers the page to store, from the page's first script. */
async function countWorkerOffers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const offers: WorkerOffers = { autosave: 0, historyBatch: 0 };
    Object.assign(window, { workerOffers: offers });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", ({ data }: MessageEvent) => {
          if (data.type === "autosave") offers.autosave++;
          if (data.type === "historyBatch") offers.historyBatch++;
        });
      }
    };
  });
}

function workerOffers(page: Page): Promise<WorkerOffers> {
  return page.evaluate(() => ({
    ...(window as unknown as { workerOffers: WorkerOffers }).workerOffers,
  }));
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
  await cacheGame(page, {
    projectId: SIBLING,
    title: "Dotted sibling",
    files: game(),
    words: [["look", 1]],
  });
  const siblingBytes = await page.evaluate(async (id) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    return JSON.stringify(await loadAuthoredGame(id));
  }, SIBLING);
  await page.reload();
  const locator = await progressStorageKey(page, PROJECT);

  // Tab B plays it until it has a checkpoint.
  const tabB = await page.context().newPage();
  await keepDetectedProfile(tabB);
  await countWorkerOffers(tabB);
  await tabB.goto("/");
  await savedGameCard(tabB, TITLE).getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(tabB)).room).toBe(1);
  await expect.poll(() => storedAutosave(tabB, PROJECT), { timeout: 20_000 }).not.toBeNull();

  // Tab A removes it, confirmed.
  await page.reload();
  const card = savedGameCard(page, TITLE);
  await openLibraryActions(page, card);
  await page.getByTestId("remove-library-game").click();
  await card.getByTestId("remove-game-confirm").click();
  await expect(card).toHaveCount(0);
  expect(await held(page, locator)).toEqual({
    record: false,
    checkpoint: false,
    recovery: 0,
    resume: false,
  });

  // B hears it at once: one plain note, not "changed in another tab".
  const note = tabB.getByTestId("removed-tab-note");
  await expect(note).toContainText(REMOVED);
  await expect(tabB.getByTestId("stale-tab-note")).toHaveCount(0);

  // B plays on while its game offers two more checkpoints and more timeline;
  // nothing is stored for the game, and no "saving is retrying" banner
  // stands for a timeline it can't store.
  const cycle = (await textHook(tabB)).cycle;
  const offered = await workerOffers(tabB);
  await expect
    .poll(
      async () => {
        const now = await workerOffers(tabB);
        return {
          checkpoints: now.autosave - offered.autosave >= 2,
          timeline: now.historyBatch > offered.historyBatch,
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({ checkpoints: true, timeline: true });
  expect((await textHook(tabB)).cycle).toBeGreaterThan(cycle);
  expect(await held(tabB, locator)).toEqual({
    record: false,
    checkpoint: false,
    recovery: 0,
    resume: false,
  });
  await expect(tabB.getByTestId("history-unsaved")).toHaveCount(0);

  // Home never offers to continue the removed game.
  await page.reload();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  await expect(page.getByTestId("hero-primary")).toHaveText("Play the tutorial");
  await expect(page.getByTestId("btn-resume-autosave")).toHaveCount(0);

  // Download game keeps a copy of the running game; Back to games leaves it.
  const download = tabB.waitForEvent("download");
  await note.getByTestId("removed-tab-download").click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
  await note.getByTestId("removed-tab-leave").click();
  await expect(tabB.getByTestId("saved-game-gallery")).toBeVisible();
  await expect(tabB.getByTestId("hero-primary")).toHaveText("Play the tutorial");
  expect(await held(tabB, locator)).toEqual({
    record: false,
    checkpoint: false,
    recovery: 0,
    resume: false,
  });
  expect(
    await page.evaluate(async (id) => {
      const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
      return JSON.stringify(await loadAuthoredGame(id));
    }, SIBLING),
  ).toBe(siblingBytes);
  await cacheGame(page, {
    projectId: PROJECT,
    title: "Reimported",
    files: game(),
    words: [["look", 1]],
  });
  const replacement = await progressStorageKey(page, PROJECT);
  expect(replacement).not.toBe(locator);
  expect(await storedAutosave(page, PROJECT)).toBeNull();
  await page.reload();
  await expect(savedGameCard(page, "Reimported").getByTestId("pending-edit-recovery")).toHaveCount(
    0,
  );
  await savedGameCard(page, "Reimported").getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.getByTestId("pending-edit-recovery")).toHaveCount(0);
});
