import type { Locator, Page } from "@playwright/test";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { createPictureSurface } from "../../src/types.ts";
import { testProjectId } from "../test/identity.ts";
import {
  cacheGame,
  enterCreateMode,
  openWorkspacePicture,
  textHook,
  waitForCycles,
  workspaceUpdated,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

/**
 * Several Room Studio items as one, end to end on the real app: a stored
 * project whose PIC 5 has no source, as an imported game's pictures have
 * none, so Studio splits it into inferred elements. The bush is two of them:
 * its outline (el-1) and, seeded after the trunk, its fill (el-1-2). Every
 * expected plane is decoded here from bytes read out of the page or storage
 * and compared with a hand-shifted SOURCE.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const PROJECT = testProjectId("studio-group");
/** The bush outline, a trunk, the bush's fill (seeded after the trunk) and a red stripe. */
const bush = (dx: number, dy: number, trunk: [number, number] = [0, 0]): string =>
  [
    "vis 2",
    `line ${[
      [20, 40],
      [50, 40],
      [56, 50],
      [50, 60],
      [20, 60],
      [14, 50],
      [20, 40],
    ]
      .map(([x, y]) => `${x! + dx},${y! + dy}`)
      .join(" ")}`,
    "vis 6",
    `line ${110 + trunk[0]},${110 + trunk[1]} ${110 + trunk[0]},${140 + trunk[1]}`,
    "vis 10",
    `fill ${35 + dx},${50 + dy}`,
    "vis 4",
    "line 80,20 90,20",
    "end",
  ].join("\n");
const PIC_5 = compilePictureSource(bush(0, 0)).bytes;

function groupGame() {
  const game = createContainer();
  const dictionary = new Map<string, number>();
  const logic = (source: string) => assembleLogic(source, { dictionary }).payload;
  game.putFile("WORDS.TOK", buildWordsTok([{ word: "look", id: 1 }]));
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

async function resumeInRoom(page: Page): Promise<void> {
  const resume = page.getByTestId("btn-resume-cached");
  await expect
    .poll(async () => (await resume.isVisible()) || (await textHook(page)).room === 1)
    .toBe(true);
  if (await resume.isVisible()) await resume.click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await waitForCycles(page, 2);
}

async function bootGame(page: Page): Promise<void> {
  await page.goto("/");
  await cacheGame(page, {
    projectId: PROJECT,
    title: "Studio group fixture",
    provider: "stub",
    model: "stub",
    imported: false,
    roomGeneration: true,
    authoringState: {
      authoring: {
        version: 1,
        bindings: {},
        world: {
          rooms: { "1": { title: "Garden", description: "A bush.", exits: {} } },
          facts: {},
          quests: {},
        },
      },
      // No picture source: Studio rebuilds PIC 5 from its bytes, as for an import.
      sources: { logics: [], pictures: [] },
    },
    files: Object.fromEntries(groupGame().files),
    words: [["look", 1]],
  });
  await page.reload();
  await resumeInRoom(page);
}

async function openStudio(page: Page): Promise<Locator> {
  await enterCreateMode(page);
  await openWorkspacePicture(page, 1);
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

const draftBytes = async (page: Page): Promise<Uint8Array> =>
  Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));

async function storedPicture(page: Page): Promise<Uint8Array> {
  const files = await page.evaluate(async (id) => {
    const path = "/src/project/gameStorage.ts";
    const { loadAuthoredGame } = await import(path);
    const game = await loadAuthoredGame(id);
    return Object.entries(game.files as Record<string, Uint8Array>).map(
      ([name, bytes]) => [name, [...bytes]] as const,
    );
  }, PROJECT);
  return openContainer(
    new Map(files.map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
  ).getResource("picture", 5)!;
}

function planes(bytes: Uint8Array) {
  const surface = createPictureSurface();
  renderPicture(bytes, surface);
  return surface;
}

/** The screen point at the centre of logical cell x,y of the (last) pane. */
async function cell(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.locator(".studio-pane").last().boundingBox())!;
  const zoom = box.height / 168;
  return [box.x + (x + 0.5) * 2 * zoom, box.y + (y + 0.5) * zoom];
}

const rows = (studio: Locator) =>
  studio
    .locator('[role="treeitem"][data-row]')
    .evaluateAll((list) => list.map((row) => row.getAttribute("data-row")));
const selectedRows = (studio: Locator) =>
  studio
    .locator('[role="treeitem"][aria-selected="true"]')
    .evaluateAll((list) => list.map((row) => row.getAttribute("data-row")));

test("an outline and its fill, selected together, move as one and keep exactly those pixels", async ({
  page,
}) => {
  await bootGame(page);
  const studio = await openStudio(page);
  const canvas = studio.getByRole("group", { name: /^Canvas/ });
  const bar = studio.getByTestId("studio-options-bar");
  expect(await rows(studio)).toEqual(["el-1", "el-2", "el-1-2", "el-3"]);

  // The outline alone, 8 px right: its fill, drawn after the trunk, pours into
  // its new inside. The edit lands and says so; one undo takes it all back.
  const original = await draftBytes(page);
  await studio.locator('[data-row="el-1"]').click();
  await expect(bar.getByTestId("selection-name")).toHaveText("Element 1");
  await canvas.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator(".workspace-status").getByTestId("studio-notice")).toHaveText(
    /^Element 1 part 2 flows differently: [\d,]+ cells changed\. (⌘|Ctrl\+)Z undoes it\.$/,
  );
  await workspaceUpdated(page);
  await page.keyboard.press("ControlOrMeta+z");
  await workspaceUpdated(page);
  await expect.poll(() => draftBytes(page)).toEqual(original);

  // Shift+click on the fill adds its item (the bush's fill, seeded after the trunk).
  await page.keyboard.down("Shift");
  await page.mouse.click(...(await cell(page, 35, 50)));
  await page.keyboard.up("Shift");
  await expect(bar.getByTestId("selection-name")).toHaveText("2 items");
  expect(await selectedRows(studio)).toEqual(["el-1", "el-1-2"]);
  await expect(studio.getByTestId("selection-name")).toHaveText("2 items");

  // Right 4 and up 2 from the keyboard: every press moves both, one step each.
  await canvas.focus();
  for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowUp", "ArrowUp"])
    await page.keyboard.press(key);
  await workspaceUpdated(page);
  await expect(page.locator(".workspace-status").getByTestId("studio-notice")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("group-move-selection.png") });

  await workspaceUpdated(page);
  const kept = await storedPicture(page);
  expect(kept).toEqual(await draftBytes(page));
  // Hand-shifted: the outline and the seed 4 right and 2 up; the trunk and stripe stay.
  const expected = planes(compilePictureSource(bush(4, -2)).bytes);
  const after = planes(kept);
  expect(after.visual).toEqual(expected.visual);
  expect(after.priority).toEqual(expected.priority);
  // The fill stayed inside its outline: the corner is still white, the moved inside green.
  expect(after.visual[0]).toBe(15);
  expect(after.visual[48 * 160 + 39]).toBe(10);
});

test("from the keyboard alone: step to an item, grow the run with Shift+Alt+arrows, nudge it", async ({
  page,
}) => {
  await bootGame(page);
  const studio = await openStudio(page);
  const canvas = studio.getByRole("group", { name: /^Canvas/ });
  await canvas.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(studio.locator('[data-role="announce"]')).toHaveText("Element 1, art, 2 steps");
  await page.keyboard.press("Shift+Alt+ArrowDown");
  await page.keyboard.press("Shift+Alt+ArrowDown");
  await expect(studio.locator('[data-role="announce"]')).toHaveText("3 items, art, 6 steps");
  expect(await selectedRows(studio)).toEqual(["el-1", "el-2", "el-1-2"]);
  // Shift+Alt+Up takes the last one away again, and Down brings it back.
  await page.keyboard.press("Shift+Alt+ArrowUp");
  expect(await selectedRows(studio)).toEqual(["el-1", "el-2"]);
  await page.keyboard.press("Shift+Alt+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("ArrowDown");
  await workspaceUpdated(page);
  const moved = planes(await draftBytes(page));
  const expected = planes(compilePictureSource(bush(8, 1, [8, 1])).bytes);
  expect(moved.visual).toEqual(expected.visual);
  // The approved Update game storyboard gives both nudges one History step.
  await page.getByTestId("workspace-undo").click();
  await workspaceUpdated(page);
  await expect.poll(() => draftBytes(page)).toEqual(PIC_5);
});

test("Shift+drag draws a marquee that selects the items wholly inside it", async ({ page }) => {
  await bootGame(page);
  const studio = await openStudio(page);
  await page.keyboard.down("Shift");
  await page.mouse.move(...(await cell(page, 8, 34)));
  await page.mouse.down();
  await page.mouse.move(...(await cell(page, 62, 66)), { steps: 5 });
  await expect(studio.locator('[data-role="marquee"]')).toHaveCount(1);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(studio.locator('[data-role="marquee"]')).toHaveCount(0);
  // The outline and its fill lie inside; the trunk and the stripe do not.
  expect(await selectedRows(studio)).toEqual(["el-1", "el-1-2"]);
  await expect(studio.getByTestId("selection-name")).toHaveText("2 items");
});

test("Group names the bush, keeps the bytes, stays one item after a reload, and Ungroup gives the parts back", async ({
  page,
}) => {
  await bootGame(page);
  let studio = await openStudio(page);
  await studio.locator('[data-row="el-1"]').click();
  await studio.locator('[data-row="el-1-2"]').click({ modifiers: ["Shift"] });
  await studio.getByTestId("selection-combine").click();
  const dialog = page.getByTestId("combine-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("combine-name")).toHaveValue("Group");
  // The trunk is drawn between the outline and its fill: only neighbours can be one item.
  await expect(page.getByTestId("combine-gap")).toHaveText(
    "“Element 2” is drawn between them. Only neighbours in the draw order can be grouped.",
  );
  await expect(page.getByTestId("combine-make")).toBeDisabled();
  await page.getByTestId("combine-include").click();
  await expect(page.getByTestId("combine-gap")).toHaveCount(0);
  await page.getByTestId("combine-name").fill("Bush");
  await page.screenshot({ path: test.info().outputPath("group-move-group.png") });
  await page.getByTestId("combine-make").click();
  await expect(dialog).toBeHidden();

  expect(await rows(studio)).toEqual(["bush", "el-3"]);
  await expect(studio.locator('[data-row="bush"]')).toContainText("Bush");
  await expect(studio.locator('[data-row="bush"]')).toHaveAttribute("aria-selected", "true");
  await workspaceUpdated(page);
  expect(await draftBytes(page)).toEqual(PIC_5);
  expect(await page.evaluate(() => window.__AGI_STUDIO__!.source())).toContain(
    '# @item bush "Bush" art',
  );
  await workspaceUpdated(page);
  expect(await storedPicture(page)).toEqual(PIC_5);

  await page.reload();
  await resumeInRoom(page);
  studio = await openStudio(page);
  expect(await rows(studio)).toEqual(["bush", "el-3"]);
  // The picture's own source: nothing says Rebuilt.
  await expect(page.locator(".workspace-status").getByTestId("studio-source-kind")).toHaveCount(0);
  expect(await draftBytes(page)).toEqual(PIC_5);

  // Ungroup, in the bar for a group: the parts come back as they were, selected, same bytes.
  await studio.locator('[data-row="bush"]').click();
  await studio.getByTestId("selection-ungroup").click();
  expect(await rows(studio)).toEqual(["el-1", "el-2", "el-1-2", "el-3"]);
  expect(await selectedRows(studio)).toEqual(["el-1", "el-2", "el-1-2"]);
  expect(await draftBytes(page)).toEqual(PIC_5);
  await workspaceUpdated(page);
  // ⌘G (Ctrl+G) groups them again, through the dialog, and ⇧⌘G ungroups.
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ControlOrMeta+g");
  await expect(page.getByTestId("combine-name")).toHaveValue("Group");
  // The name field has focus, so Enter groups.
  await expect(page.getByTestId("combine-name")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("combine-dialog")).toBeHidden();
  await expect.poll(() => rows(studio)).toEqual(["group", "el-3"]);
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ControlOrMeta+Shift+g");
  await expect.poll(() => rows(studio)).toEqual(["el-1", "el-2", "el-1-2", "el-3"]);
  expect(await draftBytes(page)).toEqual(PIC_5);
});
