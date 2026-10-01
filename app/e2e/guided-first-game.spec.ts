import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test, reviewShot } from "./test.ts";
import {
  isolateStorage,
  openLibraryActions,
  savedGameCard,
  screenText,
  textHook,
} from "./engineProbe.ts";
import { openContainer } from "../../src/container/container.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { readGameZip } from "../src/archive/gameZip.ts";

/**
 * The guided authoring packet end to end on the real app, no key: a newcomer
 * creates a starter, draws in Room Studio and Sprite Studio, then the Guided
 * actions panel in Logic Studio places the hero, adds a room, links a two-way
 * door, answers a command and hangs a sound cue on it. Test runs the frozen
 * draft in the private worker, Keep lands one atomic transaction, and Play
 * walks both directions, hears the reply and the cue — all before the project
 * survives reload and export/import as ordinary native resources and source.
 * Every guided write shows its proposed source first and lands through the
 * same draft the editor reads.
 */
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
  await expect(form.getByRole("button", { name: "Create game", exact: true })).toBeEnabled();
  await form.getByRole("textbox").fill(title);
  await form.getByRole("radio", { name: /starter/i }).check();
  await form.getByRole("button", { name: "Create game", exact: true }).click();
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

/** The stored project's provable text for one document key. */
async function storedDocument(page: Page, projectId: string, key: string) {
  return page.evaluate(
    async ({ projectId, key }) => {
      const storage = await import("/src/project/gameStorage.ts");
      const { inspectEditableProject } = await import("/src/project/projectWorkspaceSource.ts");
      const data = await storage.loadAuthoredGame(projectId as never);
      if (!data) return null;
      const document = inspectEditableProject(data).documents[key];
      return typeof document === "string" ? document : null;
    },
    { projectId, key },
  );
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

/** The library card's Edit verb opens Logic Studio on the stored project. */
async function openLogicStudio(page: Page, title: string) {
  const card = savedGameCard(page, title);
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  return studio;
}

/** Prepare → review shot → Show code → close → Apply, the honest shared loop. */
async function previewAndApply(page: Page, shot: string) {
  const guided = page.getByTestId("guided-actions");
  await expect(guided.getByTestId("guided-preview")).toBeVisible();
  await guided.getByTestId("guided-show-code").click();
  const dialog = page.getByRole("dialog", { name: "Proposed source" });
  await expect(dialog).toBeVisible();
  await reviewShot(page, shot);
  await page.getByTestId("guided-code-close").click();
  await guided.getByTestId("guided-apply").click();
  await expect(guided.getByTestId("guided-applied")).toBeVisible();
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
  // wait's answer instead. Re-pressing keeps walking like a player would.
  let held = false;
  try {
    await expect
      .poll(
        async () => {
          const hook = await textHook(page);
          lastHook = hook;
          if (hook.modal === null) {
            ackedModal = null;
          } else {
            const instance = `${hook.modal}:${hook.rows.join("\n")}`;
            if (instance !== ackedModal) {
              ackedModal = instance;
              await page.keyboard.press("Enter");
            }
          }
          if (held) await page.keyboard.up(key);
          await page.keyboard.down(key);
          held = true;
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

test("the first guided game: starter → studios → five actions → test → keep → play both ways @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const projectId = await createStarter(page, "Guided grove");

  // Back home, the new card's Edit opens Logic Studio with the panel mounted.
  await page.goto("/");
  const studio = await openLogicStudio(page, "Guided grove");
  const guided = page.getByTestId("guided-actions");
  await expect(guided).toBeVisible();
  await reviewShot(page, "guided-normal");

  const explorer = page.getByTestId("logic-explorer");

  // PIC 1 changes in the real Picture Studio, kept into the same draft.
  await explorer.getByTestId("logic-doc-picture:1").click();
  await page.getByTestId("logic-resource-edit").click();
  const roomStudio = page.getByTestId("room-studio");
  await expect(roomStudio).toBeVisible();
  await roomStudio.locator("[data-row]").first().click();
  await roomStudio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(roomStudio.getByTestId("studio-draft-status")).toHaveText("1 change");
  await roomStudio.getByTestId("studio-keep").click();
  await expect(roomStudio.getByTestId("studio-draft-status")).toHaveText("Kept");
  await roomStudio.getByTestId("studio-close").click();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");

  // VIEW 1 recolours in Sprite Studio the same way.
  await explorer.getByTestId("logic-doc-view:1").click();
  await page.getByTestId("logic-resource-edit").click();
  const sprite = page.getByTestId("sprite-studio");
  await expect(sprite).toBeVisible();
  await sprite.locator('[data-loop="0"][data-cel="0"]').click();
  await sprite.getByTestId("sprite-stage").focus();
  await page.keyboard.press("c");
  const recolor = sprite.getByTestId("sprite-recolor");
  await expect(recolor).toBeVisible();
  await page.keyboard.press("Space");
  await recolor.getByRole("radio", { name: "To colour 2, green" }).click();
  await recolor.getByTestId("sprite-recolor-apply").click();
  await expect(sprite.getByTestId("studio-draft-status")).toHaveText("1 change");
  await sprite.getByTestId("studio-keep").click();
  await expect(sprite.getByTestId("studio-draft-status")).toHaveText("Kept");
  await sprite.getByTestId("studio-close").click();

  // Place hero: move ego's spawn left so the right-hand doorway is clear.
  await guided.getByTestId("guided-place-hero").click();
  await guided.getByTestId("guided-hero-view").selectOption("1");
  await guided.getByTestId("guided-hero-x").fill("40");
  await guided.getByTestId("guided-hero-y").fill("140");
  await guided.getByTestId("guided-prepare").click();
  await previewAndApply(page, "guided-source-hero");
  await guided.getByTestId("guided-open-logic:1").click();
  await expect(page.getByTestId("logic-editor").locator(".view-lines")).toContainText(
    "position(o0, 40, 140)",
  );

  // Add room: one title, the hero starts there too. Ordinary LOGIC/PIC appear.
  await guided.getByTestId("guided-add-room").click();
  await guided.getByTestId("guided-add-room-title").fill("Moonlit grove");
  await guided.getByTestId("guided-add-room-hero-toggle").click();
  await guided.getByTestId("guided-add-room-view").selectOption("1");
  await guided.getByTestId("guided-add-room-x").fill("80");
  await guided.getByTestId("guided-add-room-y").fill("120");
  await guided.getByTestId("guided-prepare").click();
  await previewAndApply(page, "guided-source-add-room");
  await guided.getByTestId("guided-open-logic:2").click();
  await expect(page.getByTestId("logic-editor").locator(".view-lines")).toContainText(
    "Moonlit grove",
  );
  await expect(explorer.getByTestId("logic-doc-picture:2")).toBeVisible();

  // The honest refusal: 'look' already has a handler in room 1 and is not
  // replaced. The form seeded room 2 from the open document, so pick room 1.
  await guided.getByTestId("guided-respond-to-command").click();
  await guided.getByTestId("guided-respond-room").selectOption("1");
  await guided.getByTestId("guided-respond-command").fill("look");
  await guided.getByTestId("guided-respond-response").fill("A second answer.");
  await guided.getByTestId("guided-prepare").click();
  await expect(guided.getByTestId("guided-refusal")).toContainText("already answers");
  await expect(guided.getByTestId("guided-refusal-go")).toBeVisible();
  await reviewShot(page, "guided-refusal");

  // Respond, keyboard only: fill both fields, Enter prepares; the review reads well.
  await guided.getByTestId("guided-respond-command").fill("sing");
  await guided.getByTestId("guided-respond-response").fill("The clearing hums back.");
  await reviewShot(page, "guided-keyboard-flow");
  await guided.getByTestId("guided-respond-command").focus();
  await page.keyboard.press("Enter");
  await previewAndApply(page, "guided-source-respond");
  await guided.getByTestId("guided-dismiss").click();

  // Connect door: a two-way doorway room 1 ⇄ room 2 with real @rule source.
  await guided.getByTestId("guided-connect-door").click();
  await guided.getByTestId("guided-door-from").selectOption("1");
  await guided.getByTestId("guided-door-to").selectOption("2");
  await guided.getByTestId("guided-door-x1").fill("110");
  await guided.getByTestId("guided-door-y1").fill("130");
  await guided.getByTestId("guided-door-x2").fill("140");
  await guided.getByTestId("guided-door-y2").fill("155");
  await guided.getByTestId("guided-door-return").click();
  await guided.getByTestId("guided-door-rx1").fill("30");
  await guided.getByTestId("guided-door-ry1").fill("105");
  await guided.getByTestId("guided-door-rx2").fill("55");
  await guided.getByTestId("guided-door-ry2").fill("135");
  await guided.getByTestId("guided-prepare").click();
  await previewAndApply(page, "guided-source-door");
  await guided.getByTestId("guided-dismiss").click();

  // Play sound: the chime cue threads through the 'sing' handler, its finish
  // flag printing the completion line — proof enough the cue really played.
  await guided.getByTestId("guided-play-sound").click();
  await guided.getByTestId("guided-cue-room").selectOption("1");
  await guided.getByTestId("guided-cue-sound").selectOption("1");
  await guided.getByTestId("guided-cue-command").fill("sing");
  await guided.getByTestId("guided-cue-message").fill("The last note fades.");
  await guided.getByTestId("guided-prepare").click();
  await previewAndApply(page, "guided-source-cue");
  await guided.getByTestId("guided-undo").click();
  await expect(guided.getByTestId("guided-applied-label")).toContainText("undone");
  await guided.getByTestId("guided-redo").click();
  await guided.getByTestId("guided-dismiss").click();

  // Test ≠ Keep: the frozen complete draft runs in the private worker; the
  // draft still reports its unkept changes afterwards.
  await page.getByTestId("logic-test").click();
  const dock = page.getByTestId("debug-test-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped", { timeout: 30_000 });
  await dock.getByTestId("debug-step-cycle").click();
  await expect(page.getByTestId("debug-game")).toHaveAttribute("data-has-frame", "true", {
    timeout: 20_000,
  });
  await dock.getByTestId("debug-end").click();
  await dock.getByTestId("debug-close").click();
  await expect(page.getByTestId("logic-studio-status")).not.toContainText("No changes");

  // Keep builds the candidate, reviews it, lands it.
  await page.getByTestId("logic-review-build").click();
  const review = page.getByTestId("logic-review-dialog");
  await expect(review).toBeVisible();
  await review.getByTestId("logic-keep-confirm").click();
  await expect(page.getByTestId("logic-saved-note")).toContainText("Saved to the library");
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");

  // Play for real: cross the door both directions, type the command, hear it.
  await page.getByTestId("logic-close").click();
  await expect(studio).toHaveCount(0);
  const card = savedGameCard(page, "Guided grove");
  await card.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const input = page.getByTestId("input-line");
  await expect(input).toBeEnabled();
  await input.fill("sing");
  await input.press("Enter");
  // The reply and the cue's completion note are modal print windows: each
  // pauses the interpreter until acknowledged, so Enter reads them through.
  await expect
    .poll(async () => (await screenText(page)).replace(/#/g, " ").replace(/\s+/g, " "))
    .toContain("The clearing hums back.");
  await input.press("Enter");
  await expect
    .poll(async () => (await screenText(page)).replace(/#/g, " ").replace(/\s+/g, " "), {
      timeout: 30_000,
    })
    .toContain("The last note fades.");
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
  expect(files.getResource("view", 1)).toBeDefined();
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
  await page.goto("/");
  await openLogicStudio(page, "Custom grove");
  const guided = page.getByTestId("guided-actions");
  await expect(guided).toBeVisible();

  // Edit the actual shown source: the entry block gains a variable-computed
  // position.v — real custom code, not recognizable ego setup anymore.
  const editor = page.getByTestId("logic-editor");
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
  await editor.locator(".view-lines").getByText("player.control()").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("position.v(o0, v200, v201);");
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");

  // Place hero cannot rewrite it: the refusal names Custom code and the exact
  // line, and 'Go to the code' jumps into that real document.
  await guided.getByTestId("guided-place-hero").click();
  await guided.getByTestId("guided-hero-x").fill("60");
  await guided.getByTestId("guided-hero-y").fill("140");
  await guided.getByTestId("guided-prepare").click();
  const refusal = guided.getByTestId("guided-refusal");
  await expect(guided.getByTestId("guided-refusal-code")).toHaveText("custom-code");
  await expect(refusal).toContainText("custom code");
  await reviewShot(page, "guided-custom-code");
  // Navigate away first so the refusal's link proves it re-opens the document.
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-words").click();
  await guided.getByTestId("guided-refusal-go").click();
  await expect(editor.locator(".view-lines")).toContainText("sunny clearing");
  await expect(page.getByTestId("logic-tab-logic:1")).toHaveClass(/logic-studio__tab--active/);

  // Guidance still applies beside the custom block — the custom line survives.
  await guided.getByTestId("guided-respond-to-command").click();
  await guided.getByTestId("guided-respond-command").fill("hum");
  await guided.getByTestId("guided-respond-response").fill("A low hum answers.");
  await guided.getByTestId("guided-prepare").click();
  await previewAndApply(page, "guided-source-beside-custom");

  // The draft carries both edits: the new said() and the untouched custom line.
  await guided.getByTestId("guided-open-logic:1").click();
  await editor.locator(".view-lines").click();
  await page.keyboard.press("ControlOrMeta+F");
  await page.keyboard.type("position.v(o0, v200, v201);");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  const cursor = await page.evaluate(() =>
    (
      window as { __AGI_LOGIC__?: { cursor(): { line: number } | undefined } }
    ).__AGI_LOGIC__?.cursor(),
  );
  expect(cursor?.line).toBeGreaterThan(1);

  // Nothing was kept: the stored copy is untouched while the draft holds both.
  const kept = await storedDocument(page, projectId, "logic:1");
  expect(kept).not.toContain('said("hum")');
  expect(kept).not.toContain("position.v(o0, v200, v201);");
});

test("half-edited JSON stays editable: pickers keep working, corrected docs prepare again @webkit-desktop", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await isolateStorage(page);
  await createStarter(page, "Half grove");
  await page.goto("/");
  await openLogicStudio(page, "Half grove");
  const guided = page.getByTestId("guided-actions");
  const editor = page.getByTestId("logic-editor");
  const explorer = page.getByTestId("logic-explorer");

  // Mid-edit JSON in the real editor: 'rooms' is null while the author retypes
  // the world map, and a binding entry is null while its fields are written.
  // Each document swap waits for its own text so the replacement lands in the
  // right model — not in whichever model the editor still shows. Typed text
  // can pick up auto-paired quote/brace twins behind the caret, so each write
  // forward-deletes them until the buffer reads exactly the intended JSON.
  const viewLines = editor.locator(".view-lines");
  const typeDocument = async (text: string): Promise<string> => {
    await viewLines.click();
    await page.keyboard.press("ControlOrMeta+A");
    const previous = ((await viewLines.textContent()) ?? "").trim();
    await page.keyboard.type(text);
    for (let i = 0; i < 8; i++) {
      if (((await viewLines.textContent()) ?? "").trim() === text) break;
      await page.keyboard.press("Delete");
    }
    await expect(viewLines).toHaveText(text);
    return previous;
  };

  await explorer.getByTestId("logic-doc-world").click();
  await expect(viewLines).toContainText('"rooms"');
  const worldOriginal = await typeDocument('{"rooms":null}');
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");
  await explorer.getByTestId("logic-doc-bindings").click();
  await expect(viewLines).toContainText('"ego_view"');
  const bindingsOriginal = await typeDocument('{"hero":null}');
  await expect(page.getByTestId("logic-studio-status")).toContainText("2 changes");

  // The mounted panel still renders and its pickers keep listing real rooms
  // and views: malformed JSON is a document problem, not a panel crash. The
  // room's world title and the view's binding name honestly drop off while
  // their entries are half-written — plain labels, nothing invented.
  await guided.getByTestId("guided-place-hero").click();
  await expect(guided.getByTestId("guided-hero-room").locator("option")).toHaveText(["Room 1"]);
  await expect(guided.getByTestId("guided-hero-view").locator("option")).toHaveText([
    "Keep the current view",
    "VIEW 1",
  ]);
  await reviewShot(page, "guided-preview-correction");

  // Correcting both documents with the studio's own Undo returns to a clean
  // draft — typing records several stops, so undo until each buffer is its
  // original text again — and the same action prepares its preview anew.
  const restoreDocument = async (marker: string, original: string): Promise<void> => {
    await expect(viewLines).toContainText(marker);
    for (let i = 0; i < 16 && ((await viewLines.textContent()) ?? "").trim() !== original; i++) {
      await page.getByTestId("logic-undo").click();
    }
    await expect(viewLines).toHaveText(original);
  };
  await explorer.getByTestId("logic-doc-world").click();
  await restoreDocument('"rooms":null', worldOriginal);
  await explorer.getByTestId("logic-doc-bindings").click();
  await restoreDocument('"hero":null', bindingsOriginal);
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  await guided.getByTestId("guided-hero-x").fill("60");
  await guided.getByTestId("guided-hero-y").fill("140");
  await guided.getByTestId("guided-prepare").click();
  await expect(guided.getByTestId("guided-preview")).toBeVisible();
  await guided.getByTestId("guided-cancel").click();

  expect(pageErrors).toEqual([]);
});
