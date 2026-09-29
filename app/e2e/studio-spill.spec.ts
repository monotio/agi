import { expect, test, reviewShot } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { ISLAND_MOVE, ISLAND_SOURCE } from "../../test/studioAssistFixtures.ts";
import { testProjectId } from "../test/identity.ts";
import { parseGameHash } from "../src/shell/shellRoute.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { createPictureSurface } from "../../src/types.ts";
import {
  cacheGame,
  enterCreateMode,
  textHook,
  waitForCycles,
  openWorldRoom,
} from "./engineProbe.ts";

/**
 * Side effects on the real app: an island outline drawn BEFORE the grass
 * fill that pours around it. Moving the island re-pours the grass; the move
 * lands as one undo step and the status line names the grass, for the
 * creator's own drag and for an Ask proposal (the stub's "move" scenario),
 * whose Before/After view outlines the grass's changed cells in their own
 * colour. Every expected plane is decoded here from bytes read out of the
 * page and compared with a hand-shifted source.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const PROJECT = testProjectId("studio-spill");
const ROOM = "if (isset(f5)) { load.pic(v0); draw.pic(v0); discard.pic(v0); show.pic(); } return;";
const LOGIC_0 = "if (!isset(f200)) { set(f200); accept.input(); new.room(1); } call.v(v0); return;";
const PIC_1 = compilePictureSource(ISLAND_SOURCE).bytes;
/** The island moved 8 right, as a drag or the stub's proposal moves it. */
const MOVED = ISLAND_SOURCE.replace("rect 20,40 40,60", "rect 28,40 48,60");
const NOTE = new RegExp(
  `^Grass flows differently: ${ISLAND_MOVE.cells} cells changed\\. (⌘|Ctrl\\+)Z undoes it\\.$`,
);

async function bootIslandGame(page: Page): Promise<void> {
  const game = createContainer();
  const logic = (source: string) => assembleLogic(source, { dictionary: new Map() }).payload;
  game.putResource("logic", 0, logic(LOGIC_0));
  game.putResource("logic", 1, logic(ROOM));
  game.putResource("picture", 1, PIC_1);
  await page.goto("/");
  await cacheGame(page, {
    projectId: PROJECT,
    title: "Island",
    provider: "stub",
    model: "stub",
    imported: false,
    roomGeneration: false,
    authoringState: {
      authoring: {
        version: 1,
        bindings: {},
        world: {
          rooms: { "1": { title: "Meadow", description: "An island in the grass.", exits: {} } },
          facts: {},
          quests: {},
        },
      },
      sources: { logics: [[1, ROOM]], pictures: [[1, ISLAND_SOURCE]] },
    },
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  if (!parseGameHash(new URL(page.url()).hash)) await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
  await enterCreateMode(page);
}

async function openStudio(page: Page): Promise<Locator> {
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 1);
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

const draftBytes = async (page: Page): Promise<Uint8Array> =>
  Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));

function planes(bytes: Uint8Array) {
  const surface = createPictureSurface();
  renderPicture(bytes, surface, { profile: DEFAULT_V2_PROFILE });
  return { visual: surface.visual, priority: surface.priority };
}

/** The screen point at the centre of logical cell x,y of the (last) pane. */
async function cell(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.locator(".studio-pane").last().boundingBox())!;
  const zoom = box.height / 168;
  return [box.x + (x + 0.5) * 2 * zoom, box.y + (y + 0.5) * zoom];
}

test("dragging an outline another item's fill pours around lands, names the fill, and undoes exactly", async ({
  page,
}) => {
  await bootIslandGame(page);
  const studio = await openStudio(page);
  const status = studio.getByTestId("studio-draft-status");
  const original = await draftBytes(page);
  expect(original).toEqual(PIC_1);

  await studio.locator('[data-row="island"]').click();
  await expect(studio.getByTestId("selection-name")).toHaveText("Island");
  // Drag the island's left edge 8 cells right.
  await page.mouse.move(...(await cell(page, 20, 50)));
  await page.mouse.down();
  for (const x of [22, 25, 28]) await page.mouse.move(...(await cell(page, x, 50)));
  await page.mouse.up();

  await expect(status).toHaveText("1 change");
  const notice = studio.getByTestId("studio-notice");
  await expect(notice).toHaveText(NOTE);
  const moved = planes(await draftBytes(page));
  const expected = planes(compilePictureSource(MOVED).bytes);
  expect(moved.visual).toEqual(expected.visual);
  expect(moved.priority).toEqual(expected.priority);
  // The grass poured into the inside the island left, and out of its new one.
  expect(moved.visual[50 * 160 + 24]).toBe(10);
  expect(moved.visual[50 * 160 + 44]).toBe(15);
  await reviewShot(page, "spill-status-note");

  await studio.locator(".studio__stage").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(status).toHaveText("No changes");
  await expect(notice).toHaveCount(0);
  expect(await draftBytes(page)).toEqual(original);
});

test("Ask: a proposal that re-pours another item's fill outlines it and names it; Accept and Undo", async ({
  page,
}) => {
  await bootIslandGame(page);
  const studio = await openStudio(page);
  const original = await draftBytes(page);
  await studio.locator('[data-row="island"]').click();
  await studio.getByTestId("assist-connect").click();
  const dialog = page.getByTestId("ai-settings-dialog");
  await dialog.getByTestId("provider-select").selectOption("stub");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  await expect(studio.getByTestId("assist-chip").first()).toHaveText("Island");

  const input = studio.getByTestId("assist-input");
  await input.fill("Move the island to the right");
  await input.press("Enter");
  await expect(studio.getByTestId("assist-candidate")).toBeVisible();
  await expect(studio.getByTestId("assist-summary")).toHaveText("Moved the island 8 pixels right.");
  // The island's own cells, then the grass's: each counted once.
  await expect(studio.getByTestId("assist-changes")).toHaveText("Island: 108 art cells change");
  await expect(studio.getByTestId("assist-also")).toHaveText(
    `Also changes: Grass, ${ISLAND_MOVE.cells} cells.`,
  );
  // The grass's changed cells, outside the selection, in their own colour and key.
  const compare = studio.getByTestId("studio-options-bar").getByTestId("assist-compare");
  await expect(compare.getByTestId("assist-compare-spilled")).toHaveText("other items");
  await expect(studio.locator('[data-role="spilled"]').first()).toBeVisible();
  await expect(studio.locator('[data-role="changed"]').first()).toBeVisible();
  await reviewShot(page, "spill-ask-proposal");
  // Nothing is applied until Accept.
  expect(await draftBytes(page)).toEqual(original);

  await studio.getByTestId("assist-accept").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  await expect(studio.getByTestId("studio-notice")).toHaveText(NOTE);
  expect(planes(await draftBytes(page)).visual).toEqual(
    planes(compilePictureSource(MOVED).bytes).visual,
  );
  await expect(studio.locator('[data-role="spilled"]')).toHaveCount(0);

  await studio.locator(".studio__stage").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("No changes");
  expect(await draftBytes(page)).toEqual(original);
});
