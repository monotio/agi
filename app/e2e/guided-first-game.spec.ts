import { storedDocument } from "./workspaceShared.ts";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openContainer } from "../../src/container/container.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import {
  closeWorkspaceEditor,
  isolateStorage,
  openLibraryActions,
  openWorkspacePicture,
  openWorkspaceView,
  savedGameCard,
  screenText,
  textHook,
  workspaceSaved,
} from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";
import {
  addWorkspaceAction,
  addWorkspaceResponse,
  openWorkspaceLogic,
  replaceWorkspaceDocument,
  workspaceDocument,
} from "./workspaceShared.ts";

/** The first guided game uses real editors, coordinated Add operations, native play and export. */
test.use({ viewport: { width: 1440, height: 900 } });

let providerCalls = 0;
test.beforeEach(async ({ page }) => {
  providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
});
test.afterEach(() => expect(providerCalls).toBe(0));

/** The no-key Starter flow exactly as a newcomer runs it. */
async function createStarter(page: Page, title: string): Promise<string> {
  await page.goto("/");
  await page.getByTestId("create-adventure-toggle").click();
  const form = page.locator(".local-create");
  await expect(form.getByRole("button", { name: "Start building", exact: true })).toBeEnabled();
  await form.getByRole("textbox").fill(title);
  await form.getByRole("radio", { name: /starter/i }).check();
  await form.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page).toHaveURL(/#create\/local-/);
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const projectId = await page.evaluate(async () => {
    const storage = await import("/src/project/gameStorage.ts");
    const entry = (await storage.listStoredProjects()).find((game) =>
      game.projectId.startsWith("local-"),
    );
    if (!entry) throw new Error("Created project missing");
    return entry.projectId as string;
  });
  return projectId;
}

async function storedFiles(page: Page, projectId: string): Promise<Map<string, Uint8Array>> {
  const files = await page.evaluate(async (id) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const game = await loadAuthoredGame(id as never);
    return Object.fromEntries(
      Object.entries(game!.files as Record<string, Uint8Array>).map(([name, bytes]) => [
        name,
        [...bytes],
      ]),
    );
  }, projectId);
  return new Map(Object.entries(files).map(([name, bytes]) => [name, Uint8Array.from(bytes)]));
}

/** Read the numbered save from this stored body's own live physical address. */
async function storedSlot(page: Page, projectId: string, slot: number): Promise<number[] | null> {
  return page.evaluate(
    async ({ projectId, slot }) => {
      const { bindSavedProgressTarget } = await import("/src/project/progressBinding.ts");
      const { readGameProgress } = await import("/src/saves/gameProgress.ts");
      const target = await bindSavedProgressTarget(projectId);
      if (target === null) return null;
      const image = readGameProgress(localStorage, target).saves[String(slot)];
      return image === undefined ? null : [...image];
    },
    { projectId, slot },
  );
}

/**
 * Recent host-request traffic, for diagnosing a parked interpreter: each
 * entry is `{ kind: "request"|"response"|..., detail }` — a `request` whose
 * op never saw a `response` names the suspended interaction.
 */
async function hostTrace(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const log = (
      window as {
        __AGI_TRACE__?: { kind: string; detail: string; seq: number }[];
      }
    ).__AGI_TRACE__;
    return log?.slice(-14).map((entry) => `${entry.kind}: ${entry.detail}`) ?? null;
  });
}

/** Walk ego along an axis until the room changes — the authored doorway. */
async function walkToRoom(page: Page, key: string, room: number): Promise<void> {
  // Arrows are movement only outside the command line; blur it first.
  await page.getByTestId("input-line").evaluate((el: HTMLElement) => el.blur());
  let lastHook: unknown = null;
  // A modal window acks with one Enter per NEW instance — keyed on its kind
  // plus drawn text so a fresh window gets its own ack, and a stray repeat
  // can never fall through to a later prompt or selector.
  let ackedModal: string | null = null;
  // One held keydown sends a single direction message; a press landing while
  // the interpreter is parked (modal ack, input wait) can be consumed as the
  // wait's answer instead. Re-press only when movement has stopped.
  let held = false;
  let position: string | null = null;
  let positionCycle = 0;
  try {
    await expect
      .poll(
        async () => {
          const hook = await textHook(page);
          lastHook = hook;
          if (hook.room === room) return hook.room;
          if (hook.modal === null) {
            ackedModal = null;
          } else {
            const instance = `${hook.modal}:${hook.rows.join("\n")}`;
            if (instance !== ackedModal) {
              ackedModal = instance;
              await page.keyboard.press("Enter");
              held = false;
            }
            return hook.room;
          }
          const nextPosition = `${hook.room}:${hook.egoX}:${hook.egoY}`;
          if (position !== nextPosition) {
            position = nextPosition;
            positionCycle = hook.cycle;
          }
          // AGI direction presses toggle walking. Keep a moving ego walking;
          // send another press only after a modal or several idle cycles.
          if (!held || hook.cycle - positionCycle >= 4) {
            await page.keyboard.up(key);
            await page.keyboard.down(key);
            held = true;
            positionCycle = hook.cycle;
          }
          return hook.room;
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBe(room);
  } catch (error) {
    const [trace, screen] = await Promise.all([hostTrace(page), screenText(page)]);
    throw new Error(
      `walkToRoom(${key} → room ${room}) never arrived; last engine state: ${JSON.stringify(lastHook)}; host trace: ${JSON.stringify(trace)}; screen: ${JSON.stringify(screen)}`,
      { cause: error },
    );
  } finally {
    if (held) await page.keyboard.up(key);
  }
}

test("the first guided game: starter, editors, five actions, play both ways and export @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const projectId = await createStarter(page, "Guided grove");

  const roomStudio = await openWorkspacePicture(page, 1);
  await roomStudio.locator("[data-row]").first().click();
  await roomStudio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowDown");
  await workspaceSaved(page);
  await closeWorkspaceEditor(page);

  const sprite = await openWorkspaceView(page, 0);
  await sprite.locator('[data-loop="0"][data-cel="0"]').click();
  await sprite.getByTestId("sprite-stage").focus();
  await page.keyboard.press("c");
  const recolor = sprite.getByTestId("sprite-recolor");
  await page.keyboard.press("Space");
  await recolor.getByRole("radio", { name: "To colour 2, green" }).click();
  await recolor.getByTestId("sprite-recolor-apply").click();
  await workspaceSaved(page);
  await closeWorkspaceEditor(page);

  await openWorkspaceLogic(page, 1);
  await addWorkspaceAction(page, "Place hero", { VIEW: "0", X: "40", Y: "140" }, "logic:1");
  expect(await workspaceDocument(page, "logic:1")).toContain("position(o0, 40, 140)");
  await addWorkspaceAction(page, "Add a room", { "Room name": "Moonlit grove" }, "world");
  await expect(page.getByTestId("part-room:2:picture:2")).toBeVisible();
  await openWorkspaceLogic(page, 2);
  expect(await workspaceDocument(page, "logic:2")).toContain("Moonlit grove");
  await addWorkspaceAction(page, "Place hero", { VIEW: "0", X: "80", Y: "120" }, "logic:2");
  await addWorkspaceAction(
    page,
    "Door",
    { "Destination ROOM": "1", X: "30", Y: "105", Right: "55", Bottom: "135" },
    "logic:2",
  );
  await openWorkspaceLogic(page, 1);
  await addWorkspaceResponse(page, "sing", "The clearing hums back.");
  await expect.poll(() => workspaceDocument(page, "logic:1")).toContain('said("sing")');
  await addWorkspaceAction(
    page,
    "Door",
    { "Destination ROOM": "2", X: "110", Y: "130", Right: "140", Bottom: "155" },
    "logic:1",
  );
  const beforeCue = await workspaceDocument(page, "logic:1");
  await addWorkspaceAction(page, "Play sound", { SOUND: "1", Command: "sing" }, "logic:1");
  const withCue = await workspaceDocument(page, "logic:1");
  expect(withCue).toContain("sound(");
  await page.getByTestId("workspace-undo").click();
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(beforeCue);
  await page.getByTestId("workspace-redo").click();
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(withCue);
  await workspaceSaved(page);
  await reviewShot(page, "guided-workspace-saved");

  // Play for real: cross the door both directions, type the command, hear it.
  await page.getByTestId("btn-exit").click();
  const card = savedGameCard(page, "Guided grove");
  await openLibraryActions(page, card);
  await page.getByTestId("start-library-game-over").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const input = page.getByTestId("input-line");
  await expect(input).toBeEnabled();
  await input.fill("sing");
  await input.press("Enter");
  // The reply uses the game's native modal print window.
  await expect
    .poll(async () => (await screenText(page)).replace(/#/g, " ").replace(/\s+/g, " "))
    .toContain("The clearing hums back.");
  await input.press("Enter");
  await walkToRoom(page, "ArrowRight", 2);
  await reviewShot(page, "guided-play-grove");

  // The editable Starter's real native menu saves this authored second room.
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await textHook(page)).modal).toBe("menu");
  const menuText = await screenText(page);
  for (const label of ["File", "Speed", "Sound", "Help", "Save Game", "Restore Game"])
    expect(menuText).toContain(label);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe("save");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  await input.fill("Moonlit checkpoint");
  await input.press("Enter");
  await expect.poll(() => screenText(page)).toContain("Save in slot 1?");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await expect.poll(() => storedSlot(page, projectId, 1)).not.toBeNull();
  const checkpoint = (await storedSlot(page, projectId, 1))!;

  await walkToRoom(page, "ArrowLeft", 1);

  // Death and Restore use the actual edited project and its saved room state.
  await input.fill("die");
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  await expect.poll(() => screenText(page)).toContain("The ground gives way");
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(page)).toContain("You have died.");
  await page.keyboard.press("1");
  await expect.poll(async () => (await textHook(page)).modal).toBe("restore");
  await expect.poll(() => screenText(page)).toContain("Moonlit checkpoint");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await expect(input).toBeEnabled();
  await reviewShot(page, "guided-restored-grove");
  await walkToRoom(page, "ArrowLeft", 1);

  // Reload keeps the saved game; export/import re-imports the same project.
  await page.goto("/");
  const download = page.waitForEvent("download");
  await openLibraryActions(page, card);
  await page.getByTestId("download-library-game").click();
  const archive = test.info().outputPath("guided-grove-project.zip");
  await (await download).saveAs(archive);
  const downloaded = await readGameZip(new Uint8Array(await readFile(archive)));
  expect(downloaded.progress?.saves["1"]).toBeDefined();
  expect([...(downloaded.progress?.saves["1"] ?? [])]).toEqual(checkpoint);
  await page.getByTestId("game-zip-input").setInputFiles(archive);
  await expect(page.getByTestId("game-import-ready")).toContainText("to your library");

  // The imported copy is a genuine project: new room's LOGIC/PIC bytes, the
  // door rules and the cue live in ordinary source, the dictionary grew.
  const importedId = await page.evaluate(async (original) => {
    const storage = await import("/src/project/gameStorage.ts");
    const entry = (await storage.listStoredProjects()).find(
      (game) => game.projectId !== original && game.title.includes("Guided grove"),
    );
    if (!entry) throw new Error("Imported copy missing");
    return entry.projectId as string;
  }, projectId);
  const files = openContainer(await storedFiles(page, importedId), {
    profile: DEFAULT_V2_PROFILE,
  });
  expect(files.getResource("logic", 2)).toBeDefined();
  expect(files.getResource("picture", 2)).toBeDefined();
  expect(files.getResource("view", 0)).toBeDefined();
  expect(files.getResource("sound", 1)).toBeDefined();
  const room1 = await storedDocument(page, importedId, "logic:1");
  expect(room1).toContain('said("sing")');
  expect(room1).toContain("new.room(2)");
  expect(room1).toContain("sound(");
  expect(room1).toContain("position(o0, 40, 140)");
  const room2 = await storedDocument(page, importedId, "logic:2");
  expect(room2).toContain("Moonlit grove");
  expect(room2).toContain("new.room(1)");
  const words = await storedDocument(page, importedId, "words");
  expect(words).toContain("sing");
});

test("custom code stays precise: a rewritten entry block refuses Custom code, guidance still applies @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const projectId = await createStarter(page, "Custom grove");
  await openWorkspaceLogic(page, 1);
  const source = await workspaceDocument(page, "logic:1");
  const custom = source.replace(
    "player.control();",
    "player.control();\n  position.v(o0, v200, v201);",
  );
  expect(custom).not.toBe(source);
  await replaceWorkspaceDocument(page, "logic:1", custom);
  await page.getByTestId("workspace-add").click();
  await page.getByRole("menuitem", { name: "Place hero", exact: true }).click();
  const form = page.getByTestId("workspace-guided-form");
  await form.getByLabel("X", { exact: true }).fill("60");
  await form.getByLabel("Y", { exact: true }).fill("140");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(".workspace-error[role=alert]")).toContainText("custom code");
  expect(await workspaceDocument(page, "logic:1")).toBe(custom);
  await reviewShot(page, "guided-custom-code");
  await addWorkspaceResponse(page, "hum", "A low hum answers.");
  await expect.poll(() => workspaceDocument(page, "logic:1")).toContain('said("hum")');
  const saved = await storedDocument(page, projectId, "logic:1");
  expect(saved).toContain('said("hum")');
  expect(saved).toContain("position.v(o0, v200, v201);");
});
