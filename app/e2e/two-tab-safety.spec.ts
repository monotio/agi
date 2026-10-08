import type { Locator, Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { testProjectId } from "../test/identity.ts";
import {
  cacheGame,
  configureAi,
  downloadFromSettings,
  isolateStorage,
  openWorkspacePicture,
  textHook,
  waitForAutosaveAfter,
  waitForCycles,
  workspaceUpdated,
} from "./engineProbe.ts";
import { expect, keepDetectedProfile, test } from "./test.ts";

/**
 * Two tabs of one browser share its storage. Tab B keeps a Room Studio edit
 * while tab A still runs the revision it booted; nothing tab A does after
 * that — Download game, Ask, leaving — may put its older game back in
 * storage, and when the browser can say so, tab A hears of the edit at once.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const PROJECT = testProjectId("two-tab-safety");
/** A labelled wall and a movable occluder: an edit changes bytes and notes. */
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
  await expect(page.getByRole("heading", { name: "Two tabs", level: 1 })).toBeVisible();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
}

/** Tab B: the same project, one autosaved Room Studio edit. Returns Studio. */
async function keepInTabB(page: Page): Promise<Locator> {
  const tabB = await page.context().newPage();
  await keepDetectedProfile(tabB);
  await tabB.goto("/");
  await resume(tabB);
  const studio = await openWorkspacePicture(tabB, 1);
  await tabB.keyboard.press("2");
  await studio.locator('[data-row="occluder"]').click();
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await tabB.keyboard.press("ArrowDown");
  await workspaceUpdated(tabB);
  await tabB.getByRole("radio", { name: "Play", exact: true }).click();
  await waitForAutosaveAfter(tabB, (await textHook(tabB)).cycle);
  return studio;
}

/** Tab B: the same project, one autosaved Room Studio label edit. */
async function keepLabelInTabB(page: Page): Promise<void> {
  const tabB = await page.context().newPage();
  await keepDetectedProfile(tabB);
  await tabB.goto("/");
  await resume(tabB);
  await openWorkspacePicture(tabB, 1);
  // Annotation-only changes use the same project admission path as a picture gesture.
  const result = await tabB.evaluate(async () => {
    const probe = (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } })
      .__AGI_PROJECT__;
    const session = probe.getSession();
    const capture = session.model.capture();
    const source = capture.read("picture:5")!.content as string;
    const content = source.replace('occluder "Bench occluder"', 'occluder "Low bench"');
    if (content === source) throw new Error("Missing labelled occluder");
    const result = await session.submit({
      proposal: session.model.propose(capture, "Rename bench", [{ key: "picture:5", content }]),
      origin: "picture",
      author: "creator",
      label: "Rename bench",
    });
    await session.flush();
    return result.status;
  });
  expect(result).toBe("committed");
  await workspaceUpdated(tabB);
}

/** What storage holds for the project: its revision, its notes and its checkpoint's revision. */
function stored(page: Page) {
  return page.evaluate(async (id) => {
    const path = "/src/project/gameStorage.ts";
    const { loadAuthoredGame } = await import(path);
    const body = await loadAuthoredGame(id);
    const bindingPath = "/src/project/progressBinding.ts";
    const { bindSavedProgressTarget } = await import(bindingPath);
    const target = await bindSavedProgressTarget(id);
    const checkpoint = JSON.parse(
      localStorage.getItem(`monotio_agi.autosave.${target!.locator}`) ?? "null",
    );
    return {
      revision: body?.library?.revision as string | undefined,
      generation: body?.generation as number | undefined,
      authoringState: JSON.stringify(body?.workspace ?? body?.authoringState ?? null),
      checkpoint: checkpoint?.game?.identity?.revision as string | undefined,
    };
  }, PROJECT);
}

async function downloadGame(page: Page): Promise<void> {
  const download = page.waitForEvent("download");
  await downloadFromSettings(page, true);
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
  await page.keyboard.press("Escape");
}

test("a stale tab's Download game, Ask and Exit leave another tab's saved edit in storage", async ({
  page,
}) => {
  // This tab has no BroadcastChannel: it never hears of the edit, so every
  // write it attempts must find out from storage itself.
  await page.addInitScript(() => Reflect.deleteProperty(window, "BroadcastChannel"));
  await bootTabA(page);
  const booted = await stored(page);
  await keepInTabB(page);
  const kept = await stored(page);
  expect(kept.revision).not.toBe(booted.revision);
  expect(kept.authoringState).not.toBe(booted.authoringState);
  // Normal gameplay autosave records the edited resource revision.
  expect(kept.checkpoint).toBe(kept.revision);

  await downloadGame(page);
  expect(await stored(page)).toEqual(kept);

  await page.getByTestId("menu-assistant").click();
  await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
  // Opening the conversation discovers the refused storage base before another turn can start.
  await expect(page.getByTestId("agent-message")).toBeDisabled();
  await expect(page.getByTestId("agent-error")).toContainText(
    "Changed in another tab. Editing is paused.",
  );
  await expect(page.getByTestId("agent-reload")).toBeVisible();
  expect(await stored(page)).toEqual(kept);

  // Leaving saves nothing over the edit, and is not refused for it.
  await page.getByTestId("agent-panel-close").click();
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  expect(await stored(page)).toEqual(kept);
});

test("a tab running an older revision hears of another tab's saved edit at once and reloads it", async ({
  page,
}) => {
  await bootTabA(page);
  const booted = await stored(page);
  await keepInTabB(page);
  const kept = await stored(page);
  expect(kept.revision).not.toBe(booted.revision);

  // Playing, assistant closed: the stage says so, once, and nothing is modal.
  const note = page.getByTestId("stale-tab-note");
  await expect(note).toBeVisible();
  await expect(note).toHaveText(
    /Changed in another tab\. Editing is paused\. Download your unsaved edits, then reload\./,
  );
  await expect(note).toHaveAttribute("role", "status");
  await expect(page.getByTestId("workspace-agent-panel")).toBeHidden();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByTestId("other-tab-notice")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  const cycle = (await textHook(page)).cycle;
  await downloadGame(page);
  expect((await textHook(page)).cycle).toBe(cycle);
  expect(await stored(page)).toEqual(kept);
  await expect(note.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (const name of ["Download unsaved edits", "Download game", "Reload", "Exit"])
    await expect(note.getByRole("button", { name, exact: true })).toBeVisible();

  // The Assistant still offers the same reload, which loads the edit.
  await page.getByTestId("menu-assistant").click();
  await expect(page.getByTestId("agent-error")).toContainText(
    "Changed in another tab. Editing is paused.",
  );
  await page.getByTestId("agent-reload").click();
  // The old room and cycle remain visible until the replacement worker boots.
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
  await expect(note).toHaveCount(0);
  // Running the kept revision now, this tab's checkpoint is the saved edit's own.
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  expect(await stored(page)).toMatchObject({
    revision: kept.revision,
    authoringState: kept.authoringState,
    checkpoint: kept.revision,
  });
});

test("a label saved in another tab is heard at once, and nothing this tab saves drops it", async ({
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
  await expect(note).toBeVisible();
  await expect(note).toHaveText(
    /Changed in another tab\. Editing is paused\. Download your unsaved edits, then reload\./,
  );
  await page.getByTestId("menu-assistant").click();
  await expect(page.getByTestId("agent-error")).toContainText(
    "Changed in another tab. Editing is paused.",
  );
  await expect(page.getByTestId("agent-reload")).toBeVisible();
  await page.getByTestId("agent-panel-close").click();

  // Leaving writes this tab's older notes over nothing, and is not refused.
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  expect((await stored(page)).authoringState).toContain("Low bench");
});
