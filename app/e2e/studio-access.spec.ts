import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { createPictureSurface } from "../../src/types.ts";
import { cacheGame, textHook, waitForCycles } from "./engineProbe.ts";

/**
 * Room Studio without a pointer and on screens that change under it: the
 * keyboard cursor draws and keeps, a layout too small for Studio covers it
 * with a notice instead of closing it, and while it is open the page holds
 * still with Tab kept to Studio and the bar above it. Room 1 draws PIC 5;
 * expected planes are decoded here from bytes read out of storage.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const PROJECT = testProjectId("studio-access");
/** 12 drawing commands: wall 0–2, floor 3–5, bench 6–7, occluder 8–11; then `end`. */
const SOURCE = [
  '# @item wall "Wall" art',
  "vis 7",
  "rect 0,0 159,111",
  "fill 80,40",
  "# @end",
  '# @item floor "Floor" art',
  "vis 8",
  "rect 0,112 159,167",
  "fill 80,140",
  "# @end",
  '# @item bench "Bench" art',
  "vis 6",
  "rect 44,92 116,104",
  "# @end",
  '# @item occluder "Bench occluder part 12" depth',
  "vis off",
  "pri 10",
  "polygon 40,90 119,90 126,98 119,105 40,105",
  "fill 80,97",
  "# @end",
  "end",
].join("\n");
const PIC_5 = compilePictureSource(SOURCE).bytes;

function accessGame() {
  const game = createContainer();
  const dictionary = new Map<string, number>();
  const logic = (source: string) => assembleLogic(source, { dictionary }).payload;
  game.putResource("picture", 5, PIC_5);
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
  return game;
}

async function bootGame(page: Page): Promise<void> {
  await page.goto("/");
  await cacheGame(page, {
    projectId: PROJECT,
    title: "Studio access fixture",
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
    files: Object.fromEntries(accessGame().files),
    words: [],
  });
  await page.reload();
  const resume = page.getByTestId("btn-resume-cached");
  await expect
    .poll(async () => (await resume.isVisible()) || (await textHook(page)).room === 1)
    .toBe(true);
  if (await resume.isVisible()) await resume.press("Enter");
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
}

/** Create, room 1, Open in Studio: all from the keyboard. */
async function openStudio(page: Page): Promise<Locator> {
  const create = page.getByRole("radio", { name: "Create", exact: true });
  if ((await create.getAttribute("aria-checked")) !== "true") {
    await create.focus();
    await page.keyboard.press("Space");
  }
  await expect(page).toHaveURL(/#create\//);
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").getByRole("button").press("Enter");
  const open = panel.getByTestId("world-open-studio");
  await expect(open).toBeEnabled();
  await open.press("Enter");
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

const draftBytes = async (page: Page): Promise<Uint8Array> =>
  Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));

function planes(bytes: Uint8Array) {
  const surface = createPictureSurface();
  renderPicture(bytes, surface);
  return surface;
}
const at = (x: number, y: number) => y * 160 + x;

async function storedPicture(page: Page): Promise<Uint8Array> {
  const files = await page.evaluate(async (id) => {
    const path = "/src/gameStorage.ts";
    const { loadAuthoredGame } = await import(path);
    const game = await loadAuthoredGame(id);
    return Object.entries(game.files as Record<string, Uint8Array>).map(
      ([name, bytes]) => [name, [...bytes]] as const,
    );
  }, PROJECT);
  const container = openContainer(
    new Map(files.map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
  );
  return container.getResource("picture", 5)!;
}

/** Press `key` `times` times. */
async function repeat(page: Page, key: string, times: number): Promise<void> {
  for (let k = 0; k < times; k++) await page.keyboard.press(key);
}

/** A one-step Depth edit with the Select tool: the occluder one row down. */
async function nudgeOccluder(page: Page, studio: Locator): Promise<void> {
  await page.keyboard.press("2");
  await studio.locator('[data-row="occluder"]').click();
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
}

test("keyboard only: a rect in the Art lens and a barrier line in the Walk lens, then Keep", async ({
  page,
}) => {
  await bootGame(page);
  await page.evaluate(() => {
    const counts = { pointer: 0 };
    (window as unknown as { __POINTER__: typeof counts }).__POINTER__ = counts;
    for (const type of ["pointerdown", "mousedown", "pointermove", "mousemove"])
      window.addEventListener(type, () => counts.pointer++, { capture: true });
  });
  const studio = await openStudio(page);
  const status = studio.getByTestId("studio-draft-status");
  const canvas = studio.getByRole("group", { name: /^Canvas/ });
  const crosshair = studio.locator('[data-role="key-cursor"]').last();
  const announce = studio.locator('[data-role="announce"]');

  // Art lens, the rect tool, Filled: the keys are listed under the tool.
  await page.keyboard.press("r");
  await studio.getByTestId("studio-tool-filled").press("Space");
  await expect(studio.getByTestId("studio-tool-filled")).toBeChecked();
  await expect(studio.getByTestId("studio-tool-keys")).toContainText(
    "Space or Enter starts, arrows size it, again finishes",
  );
  await canvas.focus();
  await expect(canvas).toHaveAttribute("aria-label", /arrow keys move the drawing cursor/i);
  // The cursor starts at the centre, 80,84: to 20,120.
  await repeat(page, "Shift+ArrowLeft", 7);
  await repeat(page, "ArrowLeft", 4);
  await repeat(page, "Shift+ArrowDown", 4);
  await repeat(page, "ArrowDown", 4);
  await expect(crosshair).toHaveAttribute("data-x", "20");
  await expect(crosshair).toHaveAttribute("data-y", "120");
  await expect(announce).toHaveText("x 20 y 120");
  await page.keyboard.press("Space");
  await repeat(page, "Shift+ArrowRight", 2);
  await repeat(page, "ArrowRight", 4);
  await repeat(page, "Shift+ArrowDown", 2);
  await repeat(page, "ArrowDown", 4);
  await expect(announce).toHaveText("x 40 y 140");
  await expect(studio.locator('[data-role="tool-overlay"] rect.tool-overlay__line')).toHaveCount(
    await page.locator(".studio-pane").count(),
  );
  await page.keyboard.press("Space");
  await expect(status).toHaveText("1 change");
  await expect(studio.locator('[data-row="rect-1"]')).toHaveAttribute("aria-selected", "true");

  // Walk lens, the line tool: a barrier from 20,150 to 100,150.
  await page.keyboard.press("3");
  await page.keyboard.press("l");
  await expect(studio.getByTestId("studio-value-priority")).toHaveAttribute("data-value", "0");
  await expect(canvas).toBeFocused();
  // From 40,140 to 20,150, then 80 to the right: Enter there adds the
  // second point, Enter again on it finishes.
  await repeat(page, "Shift+ArrowLeft", 2);
  await repeat(page, "ArrowLeft", 4);
  await repeat(page, "ArrowDown", 10);
  await page.keyboard.press("Space");
  await repeat(page, "Shift+ArrowRight", 10);
  await expect(announce).toHaveText("x 100 y 150");
  await page.keyboard.press("Enter");
  await expect(studio.getByTestId("studio-tool-options")).toContainText("Backspace");
  await expect(status).toHaveText("1 change");
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("2 changes");
  await expect(studio.locator('[data-row="barrier-line-1"]')).toContainText("Barrier line 1");

  await studio.getByTestId("studio-keep").press("Enter");
  await expect(status).toHaveText("Kept");
  const kept = planes(await storedPicture(page));
  const before = planes(PIC_5);
  for (let y = 120; y <= 140; y++)
    for (let x = 20; x <= 40; x++) expect(kept.visual[at(x, y)]).toBe(0);
  expect(kept.visual[at(41, 130)]).toBe(before.visual[at(41, 130)]);
  for (let x = 20; x <= 100; x++) expect(kept.priority[at(x, 150)]).toBe(0);
  expect(kept.priority[at(19, 150)]).toBe(before.priority[at(19, 150)]);
  expect(kept.priority[at(60, 151)]).toBe(before.priority[at(60, 151)]);
  expect(
    await page.evaluate(
      () => (window as unknown as { __POINTER__: { pointer: number } }).__POINTER__.pointer,
    ),
  ).toBe(0);
});

test("a phone-width window covers Studio with a notice and keeps the draft; Keep there leaves", async ({
  page,
}) => {
  await bootGame(page);
  let studio = await openStudio(page);
  const notice = page.getByTestId("studio-small-screen");
  // Nothing unkept: a phone-width window simply returns to the game.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(studio).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  studio = await openStudio(page);

  await nudgeOccluder(page, studio);
  const edited = await draftBytes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Room Studio needs a larger screen");
  await expect(notice).toContainText(
    "Your unkept changes are safe — widen the window or rotate back to continue.",
  );
  await expect(notice).toContainText("1 unkept change");
  await expect(studio).toHaveCount(1);
  // Esc dismisses nothing and closes nothing.
  await page.keyboard.press("Escape");
  await expect(notice).toBeVisible();
  await expect(page.getByTestId("studio-dialog-keep")).toBeHidden();

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(notice).toBeHidden();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  expect(await draftBytes(page)).toEqual(edited);
  // The history came through too: undo and redo the nudge.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("No changes");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");

  await page.setViewportSize({ width: 390, height: 844 });
  await notice.getByTestId("studio-small-keep").click();
  await expect(studio).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  expect(await storedPicture(page)).toEqual(edited);
});

test("rotating a touch screen to its short landscape or portrait layout keeps the draft; Discard there leaves", async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 1180, height: 820 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("monotio_agi.touchControls", "on"));
  await bootGame(page);
  const studio = await openStudio(page);
  const notice = page.getByTestId("studio-small-screen");
  await nudgeOccluder(page, studio);
  const edited = await draftBytes(page);

  for (const [width, height] of [
    [820, 1180],
    [844, 390],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(notice).toBeVisible();
    await expect(studio).toHaveCount(1);
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(notice).toBeHidden();
    await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
    expect(await draftBytes(page)).toEqual(edited);
  }

  await page.setViewportSize({ width: 844, height: 390 });
  await notice.getByTestId("studio-small-discard").click();
  await expect(studio).toHaveCount(0);
  expect(await storedPicture(page)).toEqual(PIC_5);
  await context.close();
});

test("while Studio is open the page holds still and Tab stays in Studio and the bar above it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await bootGame(page);
  const activity = page.getByTestId("developer-activity-summary");
  await expect(activity).toBeAttached();
  const studio = await openStudio(page);
  await expect(activity).toBeHidden();
  const scroll = () =>
    page.evaluate(() => {
      window.scrollTo(0, 500);
      const root = document.documentElement;
      return { y: window.scrollY, extra: root.scrollHeight - root.clientHeight };
    });
  expect(await scroll()).toEqual({ y: 0, extra: 0 });

  const outside: string[] = [];
  for (let k = 0; k < 80; k++) {
    await page.keyboard.press("Tab");
    const where = await page.evaluate(() => {
      const focused = document.activeElement;
      if (!focused || focused === document.body) return "body";
      if (focused.closest('[data-testid="room-studio"], .play-bar')) return null;
      return focused.outerHTML.slice(0, 80);
    });
    if (where !== null && where !== "body") outside.push(where);
  }
  expect(outside).toEqual([]);

  // The full label is the row's tooltip; the filter shows a focus ring.
  await expect(studio.locator('[data-row="occluder"] .scene-list__label')).toHaveAttribute(
    "title",
    "Bench occluder part 12",
  );
  await expect(studio.locator('[data-row="occluder"] .scene-list__tail')).toHaveText(" 12");
  await studio.getByRole("searchbox", { name: "Filter items" }).focus();
  await expect(studio.locator(".scene-list__filter")).toHaveCSS("outline-style", "solid");
  await expect(studio.locator(".scene-list__filter")).toHaveCSS("outline-width", "3px");

  await studio.getByTestId("studio-close").click();
  await expect(studio).toHaveCount(0);
  await expect(activity).toBeVisible();
});
