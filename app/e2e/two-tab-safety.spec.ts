import { expect, keepDetectedProfile, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import {
  cacheGame,
  configureAi,
  enterCreateMode,
  isolateStorage,
  openGameOptions,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";

/**
 * Two tabs of one browser share its storage. Tab B keeps a Room Studio edit
 * while tab A still runs the revision it booted; nothing tab A does after
 * that — Download game, Ask, leaving — may put its older game back in
 * storage, and when the browser can say so, tab A hears of the Keep at once.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const PROJECT = testProjectId("two-tab-safety");
/** A labelled wall and a movable occluder: a Keep changes bytes and notes. */
const SOURCE = [
  '# @item wall "Wall" art',
  "vis 7",
  "rect 0,0 159,111",
  "fill 80,40",
  "# @end",
  '# @item occluder "Bench occluder" depth',
  "vis off",
  "pri 10",
  "polygon 40,90 119,90 126,98 119,105 40,105",
  "fill 80,97",
  "# @end",
  "end",
].join("\n");

function sharedGame(): Record<string, Uint8Array> {
  const game = createContainer();
  const dictionary = new Map<string, number>();
  const logic = (source: string) => assembleLogic(source, { dictionary }).payload;
  game.putFile("WORDS.TOK", buildWordsTok([{ word: "look", id: 1 }]));
  game.putResource("picture", 5, compilePictureSource(SOURCE).bytes);
  game.putResource(
    "logic",
    0,
    logic("if(!isset(f200)){set(f200);accept.input();new.room(1);}call.v(v0);return;"),
  );
  game.putResource(
    "logic",
    1,
    logic(
      "if(isset(f5)){assignn(v30,5);load.pic(v30);draw.pic(v30);discard.pic(v30);show.pic();}return;",
    ),
  );
  return Object.fromEntries(game.files);
}

/** Tab A: store the project, connect the offline provider, and play it. */
async function bootTabA(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await cacheGame(page, {
    projectId: PROJECT,
    title: "Two tabs",
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
    files: sharedGame(),
    words: [["look", 1]],
  });
  await configureAi(page, { provider: "stub" });
  await page.reload();
  await resume(page);
}

async function resume(page: Page): Promise<void> {
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
}

/** Tab B: the same project, one Room Studio edit, kept. Returns Studio. */
async function keepInTabB(page: Page): Promise<Locator> {
  const tabB = await page.context().newPage();
  await keepDetectedProfile(tabB);
  await tabB.goto("/");
  await resume(tabB);
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
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  return studio;
}

/** Tab B: the same project, one Room Studio edit of a label alone, kept. */
async function keepLabelInTabB(page: Page): Promise<void> {
  const tabB = await page.context().newPage();
  await keepDetectedProfile(tabB);
  await tabB.goto("/");
  await resume(tabB);
  await enterCreateMode(tabB);
  const panel = tabB.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await panel.getByTestId("world-open-studio").click();
  const studio = tabB.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await tabB.keyboard.press("2");
  await studio.locator('[data-row="occluder"]').click();
  const label = studio.getByTestId("item-label");
  await label.fill("Low bench");
  await label.press("Enter");
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
}

/** What storage holds for the project: its revision, its notes and its checkpoint's revision. */
function stored(page: Page) {
  return page.evaluate(async (id) => {
    const path = "/src/project/gameStorage.ts";
    const { loadAuthoredGame } = await import(path);
    const body = await loadAuthoredGame(id);
    const checkpoint = JSON.parse(localStorage.getItem(`monotio_agi.autosave.${id}`) ?? "null");
    return {
      revision: body?.library?.revision as string | undefined,
      generation: body?.generation as number | undefined,
      authoringState: JSON.stringify(body?.authoringState ?? null),
      checkpoint: checkpoint?.game?.identity?.revision as string | undefined,
    };
  }, PROJECT);
}

async function downloadGame(page: Page): Promise<void> {
  await openGameOptions(page, "settings-menu");
  const download = page.waitForEvent("download");
  await page.getByTestId("btn-download-game").click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
  await page.keyboard.press("Escape");
}

test("a stale tab's Download game, Ask and Exit leave another tab's Keep in storage", async ({
  page,
}) => {
  // This tab has no BroadcastChannel: it never hears of the Keep, so every
  // write it attempts must find out from storage itself.
  await page.addInitScript(() => Reflect.deleteProperty(window, "BroadcastChannel"));
  await bootTabA(page);
  const booted = await stored(page);
  await keepInTabB(page);
  const kept = await stored(page);
  expect(kept.revision).not.toBe(booted.revision);
  expect(kept.authoringState).not.toBe(booted.authoringState);
  // The Keep took a checkpoint of the kept bytes.
  expect(kept.checkpoint).toBe(kept.revision);

  await downloadGame(page);
  expect(await stored(page)).toEqual(kept);

  await enterCreateMode(page);
  await page.getByTestId("power-up").click();
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await page.getByTestId("agent-mode-ask").click();
  await page.getByTestId("agent-bubble-input").fill("What is in this room?");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-bubble-error")).toContainText("changed elsewhere");
  await expect(page.getByTestId("agent-bubble-reload")).toBeVisible();
  expect(await stored(page)).toEqual(kept);

  // Leaving saves nothing over the Keep, and is not refused for it.
  await page.getByRole("button", { name: "Back to game", exact: true }).click();
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  expect(await stored(page)).toEqual(kept);
});

test("a tab running an older revision hears of another tab's Keep at once and reloads it", async ({
  page,
}) => {
  await bootTabA(page);
  const booted = await stored(page);
  await keepInTabB(page);
  const kept = await stored(page);
  expect(kept.revision).not.toBe(booted.revision);

  // Playing, assistant closed: the stage says so, once, and nothing is modal.
  const note = page.getByTestId("stale-tab-note");
  await expect(note).toHaveText(
    /This game changed in another tab\. Reload game to continue from the saved version\./,
  );
  await expect(note).toHaveAttribute("role", "status");
  await expect(page.getByTestId("agent-bubble")).toHaveCount(0);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const cycle = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
  await downloadGame(page);
  expect(await stored(page)).toEqual(kept);
  await note.getByRole("button", { name: "Dismiss" }).click();
  await expect(note).toHaveCount(0);

  // The Assistant still offers the same reload, which brings the Keep in.
  await page.getByTestId("menu-assistant").click();
  await expect(page.getByTestId("agent-bubble-error")).toContainText("changed elsewhere");
  await page.getByTestId("agent-bubble-reload").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
  await expect(note).toHaveCount(0);
  // Running the kept revision now, this tab's checkpoint is the Keep's own.
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  expect(await stored(page)).toMatchObject({
    revision: kept.revision,
    authoringState: kept.authoringState,
    checkpoint: kept.revision,
  });
});

test("a label kept in another tab is heard at once, and nothing this tab saves drops it", async ({
  page,
}) => {
  await bootTabA(page);
  const booted = await stored(page);
  await keepLabelInTabB(page);
  const kept = await stored(page);
  // The bytes, their revision and the checkpoint stay; only the notes moved.
  expect(kept.revision).toBe(booted.revision);
  expect(kept.authoringState).toContain("Low bench");

  const note = page.getByTestId("stale-tab-note");
  await expect(note).toHaveText(
    /This game changed in another tab\. Reload game to continue from the saved version\./,
  );
  await page.getByTestId("menu-assistant").click();
  await expect(page.getByTestId("agent-bubble-error")).toContainText("changed elsewhere");
  await expect(page.getByTestId("agent-bubble-reload")).toBeVisible();
  await page.getByRole("button", { name: "Back to game", exact: true }).click();

  // Leaving writes this tab's older notes over nothing, and is not refused.
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  expect((await stored(page)).authoringState).toContain("Low bench");
});
