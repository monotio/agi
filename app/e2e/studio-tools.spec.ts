import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { createPictureSurface } from "../../src/types.ts";
import { buildView } from "../../src/view/view.ts";
import { CHARACTER_VIEWS } from "../../games/adventure-department/characterViews.ts";
import { cacheGame, enterCreateMode, textHook, waitForCycles } from "./engineProbe.ts";

/**
 * Room Studio's tool rail, end to end on the real app: a stored project
 * whose room 1 draws PIC 5, with one character VIEW for the actor probe.
 * Expected planes are decoded here with the engine's renderer from bytes
 * read out of the page and storage; cells are hand-placed in SOURCE.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const PROJECT = testProjectId("studio-tools");
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
  '# @item occluder "Bench occluder" depth',
  "vis off",
  "pri 10",
  "polygon 40,90 119,90 126,98 119,105 40,105",
  "fill 80,97",
  "# @end",
  "end",
].join("\n");
const PIC_5 = compilePictureSource(SOURCE).bytes;

function toolsGame() {
  const game = createContainer();
  const dictionary = new Map<string, number>();
  const logic = (source: string) => assembleLogic(source, { dictionary }).payload;
  game.putFile("WORDS.TOK", buildWordsTok([{ word: "look", id: 1 }]));
  game.putResource("picture", 5, PIC_5);
  game.putResource("view", 0, buildView(CHARACTER_VIEWS[0]!));
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

async function openStudio(page: Page): Promise<Locator> {
  await page.goto("/");
  await cacheGame(page, {
    projectId: PROJECT,
    title: "Studio tools fixture",
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
    files: Object.fromEntries(toolsGame().files),
    words: [["look", 1]],
  });
  await page.reload();
  const resume = page.getByTestId("btn-resume-cached");
  await expect
    .poll(async () => (await resume.isVisible()) || (await textHook(page)).room === 1)
    .toBe(true);
  if (await resume.isVisible()) await resume.click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await panel.getByTestId("world-open-studio").click();
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

/** The screen point at the centre of logical cell x,y of the (last) pane. */
async function cell(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.locator(".studio-pane").last().boundingBox())!;
  const zoom = box.height / 168;
  return [box.x + (x + 0.5) * 2 * zoom, box.y + (y + 0.5) * zoom];
}

async function dragCells(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...(await cell(page, ...from)));
  await page.mouse.down();
  await page.mouse.move(...(await cell(page, ...to)), { steps: 6 });
  await page.mouse.up();
}

async function clickCell(page: Page, x: number, y: number) {
  await page.mouse.click(...(await cell(page, x, y)));
}

async function pickColour(studio: Locator, value: number) {
  const values = studio.getByTestId("studio-current-values");
  await values.getByTestId("studio-value-visual").click();
  await values.locator(`[role="radio"][data-value="${value}"]`).click();
  await expect(values.getByTestId("studio-value-visual")).toHaveAttribute(
    "data-value",
    String(value),
  );
}

const order = (studio: Locator) =>
  studio
    .locator('[role="treeitem"][data-row]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row")));

test("a filled rect drawn in the Art lens keeps as those pixels and leaves priority alone", async ({
  page,
}) => {
  const studio = await openStudio(page);
  await page.keyboard.press("r");
  await expect(studio.locator('button[data-tool="rect"]')).toHaveAttribute("aria-pressed", "true");
  await expect(studio.getByTestId("studio-insert-at")).toHaveText(
    "New shapes are drawn last, after step 12.",
  );
  await studio.getByTestId("studio-tool-filled").check();
  await pickColour(studio, 4);
  await dragCells(page, [20, 120], [40, 140]);
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  await expect(studio.locator('[data-row="rect-1"]')).toHaveAttribute("aria-selected", "true");
  expect(await order(studio)).toEqual(["wall", "floor", "bench", "occluder", "rect-1"]);

  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  const kept = await storedPicture(page);
  expect(kept).toEqual(await draftBytes(page));
  const before = planes(PIC_5);
  const after = planes(kept);
  expect(after.priority).toEqual(before.priority);
  for (let y = 120; y <= 140; y++)
    for (let x = 20; x <= 40; x++) expect(after.visual[at(x, y)]).toBe(4);

  // The live room re-enters on the kept picture: its visual pixels in the
  // rect's box are the kept bytes' rendering.
  await studio.getByTestId("studio-close").click();
  await expect(studio).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const frame = window.__AGI_FRAME__?.();
        if (!frame) return null;
        const box: number[] = [];
        for (let y = 118; y <= 142; y++)
          for (let x = 18; x <= 42; x++) box.push(frame.visual[y * 160 + x]!);
        return box;
      }),
    )
    .toEqual(
      Array.from(
        { length: 25 * 25 },
        (_, k) => after.visual[at(18 + (k % 25), 118 + ((k / 25) | 0))],
      ),
    );
});

test("a barrier line clicked out in the Walk lens writes priority 0 and not one art byte", async ({
  page,
}) => {
  const studio = await openStudio(page);
  await page.keyboard.press("3");
  await page.keyboard.press("l");
  await expect(studio.getByTestId("studio-value-priority")).toHaveAttribute("data-value", "0");
  await clickCell(page, 20, 150);
  await clickCell(page, 100, 150);
  await page.keyboard.press("Enter");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  const row = studio.locator('[data-row="barrier-line-1"]');
  await expect(row).toContainText("Barrier line 1");
  await expect(row).toContainText("barrier");
  const before = planes(PIC_5);
  const after = planes(await draftBytes(page));
  expect(after.visual).toEqual(before.visual);
  for (let x = 20; x <= 100; x++) expect(after.priority[at(x, 150)]).toBe(0);
  expect(after.priority[at(19, 150)]).toBe(before.priority[at(19, 150)]);
  expect(after.priority[at(60, 151)]).toBe(before.priority[at(60, 151)]);
});

test("the fill tool on a seed that is not white explains the AGI rule and inserts nothing", async ({
  page,
}) => {
  const studio = await openStudio(page);
  await page.keyboard.press("f");
  await clickCell(page, 80, 40);
  await expect(studio.getByTestId("studio-fill-why")).toHaveText(
    "Nothing to fill: at this point in the draw order 80,40 holds colour 7 (drawn by line 4), and a colour fill floods only white (15) cells, 4-connected.",
  );
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("No changes");
  expect(await draftBytes(page)).toEqual(PIC_5);
});

test("an insert at a mid playhead lands at that draw-order position under later commands", async ({
  page,
}) => {
  const studio = await openStudio(page);
  // Six commands drawn: the wall and the floor, not yet the bench.
  await page.keyboard.press("Home");
  for (let k = 0; k < 6; k++) await page.keyboard.press(".");
  await page.keyboard.press("r");
  await expect(studio.getByTestId("studio-insert-at")).toContainText(
    "New shapes are drawn after step 6 of 12",
  );
  await studio.getByTestId("studio-tool-filled").check();
  await pickColour(studio, 1);
  await dragCells(page, [50, 88], [70, 100]);
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  expect(await order(studio)).toEqual(["wall", "floor", "rect-1", "bench", "occluder"]);
  const drawn = planes(await draftBytes(page));
  // The bench outline, drawn later, is still on top of the new rect.
  expect(drawn.visual[at(60, 92)]).toBe(6);
  expect(drawn.visual[at(60, 95)]).toBe(1);
  // The playhead stays after the new item; the way back to the end is one click.
  // vis, pri off and 13 rows: 15 commands after the first 6.
  await expect(studio.getByTestId("studio-insert-at")).toContainText(
    "New shapes are drawn after step 21 of 27",
  );
  await studio.getByTestId("studio-playhead-end").click();
  await expect(studio.getByTestId("studio-insert-at")).toHaveText(
    "New shapes are drawn last, after step 27.",
  );
});

test("G stands the ghost actor on the draft; dragged behind the occluder it reads Behind", async ({
  page,
}) => {
  const studio = await openStudio(page);
  await page.keyboard.press("g");
  const ghost = studio.getByTestId("ghost-probe");
  await expect(ghost).toBeVisible();
  await expect(studio.getByTestId("studio-probe-toggle")).toHaveAttribute("aria-pressed", "true");
  // From its start (baseline 120, band 11: in front) up to baseline 97 (band 9).
  const handle = studio.getByTestId("ghost-probe-handle");
  const box = (await handle.boundingBox())!;
  const zoom = (await page.locator(".studio-pane").first().boundingBox())!.height / 168;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 23 * zoom, { steps: 8 });
  await page.mouse.up();
  await expect(ghost).toHaveAttribute("data-verdict", "behind");
  await expect(studio.locator('[data-role="ghost-verdict"]')).toContainText(
    "Behind Bench occluder",
  );
  await expect(studio.locator('[data-role="ghost-band"]')).toContainText("y 97 → band 9");
  // Dragging the ghost edited nothing.
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("No changes");
  await page.keyboard.press("g");
  await expect(ghost).toHaveCount(0);
});

/** A one-step Depth edit: the occluder one row down. */
async function nudgeOccluder(page: Page, studio: Locator) {
  await page.keyboard.press("2");
  await studio.locator('[data-row="occluder"]').click();
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
}

test("switching to Play with unkept changes asks: Cancel stays, Discard leaves", async ({
  page,
}) => {
  const studio = await openStudio(page);
  await nudgeOccluder(page, studio);
  const play = page.getByRole("radio", { name: "Play", exact: true });
  const create = page.getByRole("radio", { name: "Create", exact: true });
  await play.click();
  await expect(page.getByTestId("studio-dialog-keep")).toBeVisible();
  await page.getByTestId("studio-dialog-cancel").click();
  await expect(page.getByTestId("studio-dialog-keep")).toBeHidden();
  await expect(studio).toBeVisible();
  await expect(create).toHaveAttribute("aria-checked", "true");
  await expect(page).toHaveURL(/#create\//);
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");

  await play.click();
  await page.getByTestId("studio-dialog-discard").click();
  await expect(studio).toHaveCount(0);
  await expect(play).toHaveAttribute("aria-checked", "true");
  await expect(page).toHaveURL(/#play\//);
  expect(await storedPicture(page)).toEqual(PIC_5);
});

test("Back to Play asks too, and Exit with unkept changes can Keep them first", async ({
  page,
}) => {
  const studio = await openStudio(page);
  await nudgeOccluder(page, studio);
  // Browser Back from #create to #play: the question, and Cancel keeps Create.
  await page.goBack();
  await expect(page.getByTestId("studio-dialog-keep")).toBeVisible();
  await page.getByTestId("studio-dialog-cancel").click();
  await expect(studio).toBeVisible();
  await expect(page).toHaveURL(/#create\//);

  const edited = await draftBytes(page);
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("studio-dialog-keep")).toBeVisible();
  await page.getByTestId("studio-dialog-keep").click();
  await expect(studio).toHaveCount(0);
  await expect(page.getByTestId("btn-exit")).toHaveCount(0);
  expect(await storedPicture(page)).toEqual(edited);
});

test("the page asks before unloading only while changes are unkept", async ({ page }) => {
  const studio = await openStudio(page);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await nudgeOccluder(page, studio);
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => dialogs).toEqual(["beforeunload"]);
});

test("undo after Keep reverts the kept edit as an unkept change", async ({ page }) => {
  const studio = await openStudio(page);
  const status = studio.getByTestId("studio-draft-status");
  await nudgeOccluder(page, studio);
  const edited = await draftBytes(page);
  await studio.getByTestId("studio-keep").click();
  await expect(status).toHaveText("Kept");
  expect(await storedPicture(page)).toEqual(edited);
  await expect(studio.getByTestId("studio-undo")).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(status).toHaveText("1 change");
  expect(await draftBytes(page)).toEqual(PIC_5);
  await studio.getByTestId("studio-keep").click();
  await expect(status).toHaveText("Kept");
  expect(await storedPicture(page)).toEqual(PIC_5);
  // Redo walks forward again past both Keeps.
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(status).toHaveText("1 change");
  expect(await draftBytes(page)).toEqual(edited);
});
