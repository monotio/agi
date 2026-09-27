import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import { parseGameHash } from "../src/shell/shellRoute.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { buildView } from "../../src/view/view.ts";
import {
  cacheGame,
  enterCreateMode,
  isolateStorage,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";

/**
 * Room Studio's Walk view on the real app. In the tutorial: test walks the
 * game runs for real (the lab's west door to the lever plate reaches it; the
 * gallery doorway into the velvet rope is blocked by it), Play here, native
 * doors that stay read-only, and a test walk from the keyboard alone. In a
 * created game: a door box bound to its doorway art moves with the art in
 * one Keep and changes room when walked into; an edge exit retargeted and
 * kept sends the player to the new room.
 */
test.use({ viewport: { width: 1440, height: 900 } });

/** Screenshots go here when set (the rc.4 review set), else to the test's output. */
const SHOTS = process.env["AGI_WALK_SHOTS"];
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: SHOTS ? `${SHOTS}/${name}.png` : test.info().outputPath(`${name}.png`),
  });

async function playTutorial(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
}

async function openRoomStudio(page: Page, room: number): Promise<Locator> {
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId(`map-room-${room}`).click();
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

/** The screen point at the centre of logical cell x,y of the (last) pane. */
async function cell(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.locator(".studio-pane").last().boundingBox())!;
  const zoom = box.height / 168;
  return [box.x + (x + 0.5) * 2 * zoom, box.y + (y + 0.5) * zoom];
}

async function clickCell(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.click(...(await cell(page, x, y)));
}

/** Where the live game stands: its room and ego's baseline. */
async function egoAt(page: Page): Promise<number[]> {
  const hook = await textHook(page);
  return [hook.room, hook.egoX, hook.egoY];
}

/** Press `key` `times` times. */
async function press(page: Page, key: string, times: number): Promise<void> {
  for (let k = 0; k < times; k++) await page.keyboard.press(key);
}

/** Move the keyboard cursor by dx,dy cells: Shift+arrows for 8, arrows for the rest. */
async function moveCursor(page: Page, dx: number, dy: number): Promise<void> {
  for (const [delta, minus, plus] of [
    [dx, "ArrowLeft", "ArrowRight"],
    [dy, "ArrowUp", "ArrowDown"],
  ] as const) {
    const key = delta < 0 ? minus : plus;
    await press(page, `Shift+${key}`, Math.floor(Math.abs(delta) / 8));
    await press(page, key, Math.abs(delta) % 8);
  }
}

test("a test walk in the lab reaches the lever plate; the gallery's rope blocks one; Play here @webkit-desktop", async ({
  page,
}) => {
  await playTutorial(page);
  const studio = await openRoomStudio(page, 2);
  await page.keyboard.press("3");
  await expect(studio.locator('[data-role="walkable-tint"]')).toBeVisible();
  await expect(studio.getByTestId("walk-panel")).toContainText("estimate");
  await shot(page, "walk-tint");

  await page.keyboard.press("t");
  // The west door's arrow: the walk starts where the player comes in from the gallery.
  await studio.locator('[data-role="door"][data-destination="1"] polygon').click();
  await expect(studio.locator('[data-role="walk-start"]')).toBeVisible();
  await clickCell(page, 30, 140);
  await expect(studio.getByTestId("walk-result-title")).toHaveText("Reached", {
    timeout: 30_000,
  });
  await expect(studio.getByTestId("walk-result-end")).toHaveText("30,140");
  await shot(page, "walk-reached");

  // The gallery: from its doorway straight at the mural, into the velvet rope.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(studio).toBeHidden();
  const gallery = await openRoomStudio(page, 1);
  await page.keyboard.press("3");
  await page.keyboard.press("t");
  await clickCell(page, 18, 151);
  await clickCell(page, 78, 116);
  await expect(gallery.getByTestId("walk-result-title")).toHaveText("Blocked at Rope barrier", {
    timeout: 30_000,
  });
  await expect(gallery.getByTestId("walk-result")).toHaveAttribute("data-outcome", "blocked");
  const end = gallery.locator('[data-role="walk-end"]');
  const endX = Number(await end.getAttribute("data-x"));
  const endY = Number(await end.getAttribute("data-y"));
  expect(endY).toBeGreaterThan(121);
  await shot(page, "walk-blocked");

  // Play here from where the walk stopped: Studio closes and the live game
  // stands ego on that spot, in Play.
  await gallery.getByTestId("walk-play-here").click();
  await expect(gallery).toBeHidden();
  await expect(page).toHaveURL(/#play\//);
  await expect.poll(() => egoAt(page)).toEqual([1, endX, endY]);
});

test("Play here from the canvas menu; the lab's native doors are read-only", async ({ page }) => {
  await playTutorial(page);
  const studio = await openRoomStudio(page, 2);
  await page.keyboard.press("3");

  // The lab's exits are written in its own logic: listed, labelled, read-only.
  await studio.getByTestId("walk-door").filter({ hasText: "west edge" }).click();
  const editor = studio.getByTestId("door-editor");
  await expect(editor.getByTestId("door-native")).toContainText("→ Picture Gallery");
  await expect(editor.getByTestId("door-destination")).toHaveCount(0);
  await expect(editor.getByTestId("door-way-back")).toContainText("Way back: yes, via");
  await expect(editor.getByTestId("door-way-back")).toContainText("the east edge");
  await shot(page, "door-two-sided");
  await editor.getByTestId("door-edit-text").click();
  const text = page.getByTestId("logic-text");
  await expect(text).toBeVisible();
  await expect(text).toContainText("new.room(1)");
  await page.keyboard.press("Escape");
  await expect(text).toBeHidden();

  // Right-click a floor spot: Play here puts ego there in the live lab.
  const [x, y] = await cell(page, 70, 150);
  await page.mouse.click(x, y, { button: "right" });
  const menu = page.getByTestId("canvas-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Play here" }).click();
  await expect(studio).toBeHidden();
  await expect.poll(() => egoAt(page)).toEqual([2, 70, 150]);
});

test("a test walk from the keyboard alone", async ({ page }) => {
  await playTutorial(page);
  const studio = await openRoomStudio(page, 2);
  // The pointer rests off the canvas, so the keyboard cursor starts at the centre (80,84).
  await page.mouse.move(0, 0);
  await page.keyboard.press("3");
  await page.keyboard.press("t");
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await moveCursor(page, 18 - 80, 151 - 84);
  await expect(studio.locator('[data-role="key-cursor"]')).toHaveAttribute("data-x", "18");
  await page.keyboard.press("Space");
  await expect(studio.locator('[data-role="walk-start"]')).toBeVisible();
  await moveCursor(page, 30 - 18, 140 - 151);
  await expect(studio.locator('[data-role="walk-estimate"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(studio.getByTestId("walk-result-title")).toHaveText("Reached", {
    timeout: 30_000,
  });
  await expect(studio.getByTestId("walk-result-end")).toHaveText("30,140");
  // Keys never reached the game: it still stands in the gallery.
  expect((await textHook(page)).room).toBe(1);
});

// ---- A created game: doors that follow the art ----------------------------

const PROJECT = testProjectId("studio-walk");
const PIC_1 = [
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
  '# @item doorway "Doorway" art',
  "vis 4",
  "rect 120,100 135,130",
  "# @end",
  '# @item wall-line "Wall line" walk',
  "pri 0",
  "line 0,111 159,111",
  "# @end",
  "end",
].join("\n");
const PLAIN = (colour: number) => [`vis ${colour}`, "fill 80,80", "end"].join("\n");
/**
 * Every room draws its own picture and stands a 3x6 ego at 40,140; standing
 * on the plate in the bottom left corner sets f40 (plate_pressed).
 */
const ROOM = [
  "if (isset(f5)) {",
  "  load.pic(v0); draw.pic(v0); discard.pic(v0); show.pic();",
  "  load.view(0); animate.obj(o0); set.view(o0, 0); position(o0, 40, 140); draw(o0);",
  "}",
  "if (posn(o0, 0, 160, 20, 167)) { set(f40); }",
  "return;",
  "",
].join("\n");
const LOGIC_0 = "if (!isset(f200)) { set(f200); accept.input(); new.room(1); } call.v(v0); return;";

function createdGame() {
  const game = createContainer();
  const logic = (source: string) => assembleLogic(source, { dictionary: new Map() }).payload;
  game.putResource("logic", 0, logic(LOGIC_0));
  for (const room of [1, 2, 3]) game.putResource("logic", room, logic(ROOM));
  game.putResource("picture", 1, compilePictureSource(PIC_1).bytes);
  game.putResource("picture", 2, compilePictureSource(PLAIN(2)).bytes);
  game.putResource("picture", 3, compilePictureSource(PLAIN(5)).bytes);
  game.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 3, height: 6, pixels: new Array(18).fill(15) }] }] }),
  );
  return game;
}

async function bootCreatedGame(page: Page): Promise<void> {
  await page.goto("/");
  await cacheGame(page, {
    projectId: PROJECT,
    title: "Door hall",
    provider: "stub",
    model: "stub",
    imported: false,
    roomGeneration: true,
    authoringState: {
      authoring: {
        version: 1,
        bindings: { plate_pressed: { kind: "flag", num: 40 } },
        world: {
          rooms: {
            "1": { title: "Door hall", description: "A doorway.", exits: {} },
            "2": { title: "Green room", description: "Beyond the door.", exits: {} },
            "3": { title: "Cellar", description: "Below.", exits: {} },
          },
          facts: {},
          quests: {},
        },
      },
      sources: {
        logics: [
          [1, ROOM],
          [2, ROOM],
          [3, ROOM],
        ],
        pictures: [[1, PIC_1]],
      },
    },
    files: Object.fromEntries(createdGame().files),
    words: [],
  });
  await page.reload();
  if (!parseGameHash(new URL(page.url()).hash)) await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
}

/** The stored project's logic source for `room`. */
const storedLogic = (page: Page, room: number): Promise<string | undefined> =>
  page.evaluate(
    async ([id, num]) => {
      const path = "/src/gameStorage.ts";
      const { loadAuthoredGame } = await import(path);
      const game = await loadAuthoredGame(id);
      const logics = (game.authoringState?.sources?.logics ?? []) as [number, string][];
      return logics.find(([n]) => n === num)?.[1];
    },
    [PROJECT, room] as const,
  );

/** Play here at x,y from the canvas menu, then walk with an arrow key in the live game. */
async function walkFrom(
  page: Page,
  studio: Locator,
  at: [number, number],
  key: string,
): Promise<void> {
  const [x, y] = await cell(page, ...at);
  await page.mouse.click(x, y, { button: "right" });
  await page.getByTestId("canvas-menu").getByRole("menuitem", { name: "Play here" }).click();
  await expect(studio).toBeHidden();
  await expect.poll(() => egoAt(page)).toEqual([1, ...at]);
  await page.keyboard.press(key);
}

test("a door box bound to the doorway moves with it in one Keep; an edge exit retargets", async ({
  page,
}) => {
  await bootCreatedGame(page);
  const studio = await openRoomStudio(page, 1);
  const editor = studio.getByTestId("door-editor");
  await page.keyboard.press("3");

  // Draw a door box in front of the doorway: it leads to the first other room.
  await page.keyboard.press("d");
  await page.mouse.move(...(await cell(page, 122, 124)));
  await page.mouse.down();
  await page.mouse.move(...(await cell(page, 128, 127)));
  await page.mouse.move(...(await cell(page, 133, 130)));
  await page.mouse.up();
  await expect(editor.getByTestId("door-destination")).toHaveValue("2");
  await expect(editor.getByTestId("door-box-x1")).toHaveValue("122");
  await expect(studio.locator('[data-role="door"] text').first()).toHaveText("→ Green room");

  // Drag its link handle onto the doorway art: the box follows it.
  await page.keyboard.press("v");
  const handle = (await studio.locator('[data-role="door-link-handle"]').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(...(await cell(page, 128, 106)));
  await page.mouse.move(...(await cell(page, 135, 110)));
  await page.mouse.up();
  await expect(editor.getByTestId("door-follows")).toHaveValue("doorway");
  await expect(editor.getByTestId("door-way-back")).toHaveText("One-way");

  // Move the doorway 20 px west by pointer: the door box moves with it as it drags.
  await studio.getByTestId("studio-unlock").click();
  await studio.locator('[data-row="doorway"]').click();
  const [sx, sy] = await cell(page, 120, 110);
  const perCell = ((await page.locator(".studio-pane").last().boundingBox())!.height / 168) * 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let k = 1; k <= 5; k++) await page.mouse.move(sx - 4 * k * perCell, sy);
  const doorBox = studio.locator('[data-role="door"] rect').first();
  await expect(doorBox).toHaveAttribute("x", "102");
  await shot(page, "door-follows-drag");
  await page.mouse.up();
  await doorBox.click();
  await expect(editor.getByTestId("door-box-x1")).toHaveValue("102");
  await shot(page, "door-selected");

  // One Keep writes the picture and the moved door together.
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  await expect.poll(() => storedLogic(page, 1)).toContain("posn(o0, 102, 124, 113, 130)");
  expect(await storedLogic(page, 1)).toContain(
    '// @rule door-1 "Door to room 2" exit item=doorway',
  );

  // Playing: walking up into the moved box changes room.
  await walkFrom(page, studio, [105, 140], "ArrowUp");
  await expect.poll(async () => (await textHook(page)).room, { timeout: 10_000 }).toBe(2);

  // An edge exit: add one by the south edge and Keep, then retarget it to the cellar and Keep.
  await openRoomStudio(page, 1);
  await page.keyboard.press("3");
  await page.keyboard.press("e");
  await clickCell(page, 60, 165);
  await expect(editor.getByTestId("door-destination")).toHaveValue("2");
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  await editor.getByTestId("door-destination").selectOption("3");
  await expect(studio.locator('[data-role="door"][data-destination="3"]')).toHaveCount(1);
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  await expect.poll(() => storedLogic(page, 1)).toContain("new.room(3)");

  // Walking off the south edge lands in the cellar.
  await walkFrom(page, studio, [60, 160], "ArrowDown");
  await expect.poll(async () => (await textHook(page)).room, { timeout: 10_000 }).toBe(3);
});

test("a test walk uses the live game's flags: a flag-gated door opens once the game sets it", async ({
  page,
}) => {
  await bootCreatedGame(page);
  let studio = await openRoomStudio(page, 1);
  const editor = studio.getByTestId("door-editor");
  await page.keyboard.press("3");

  // A door box in front of the wall line, open only while plate_pressed is set.
  await page.keyboard.press("d");
  await page.mouse.move(...(await cell(page, 100, 112)));
  await page.mouse.down();
  await page.mouse.move(...(await cell(page, 110, 116)));
  await page.mouse.move(...(await cell(page, 115, 118)));
  await page.mouse.up();
  await editor.getByTestId("door-flag").selectOption("plate_pressed");
  await expect(editor.getByTestId("door-flag")).toHaveValue("plate_pressed");

  // The live game has not pressed the plate: the walk passes the shut door into the wall.
  await expect(studio.getByTestId("walk-live-state")).toBeChecked();
  await page.keyboard.press("t");
  await clickCell(page, 108, 150);
  await clickCell(page, 108, 100);
  await expect(studio.getByTestId("walk-result-title")).toHaveText("Blocked at Wall line", {
    timeout: 30_000,
  });
  await expect(studio.getByTestId("walk-result-state")).toHaveText(
    "Tested with your game as it is now",
  );
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");

  // Play from the plate: the live game sets plate_pressed (f40).
  const [px, py] = await cell(page, 10, 165);
  await page.mouse.click(px, py, { button: "right" });
  await page.getByTestId("canvas-menu").getByRole("menuitem", { name: "Play here" }).click();
  await expect(studio).toBeHidden();
  await expect.poll(() => egoAt(page)).toEqual([1, 10, 165]);
  await waitForCycles(page, 3);

  // The same walk now goes through the door, with the game as it is now.
  studio = await openRoomStudio(page, 1);
  await page.keyboard.press("3");
  await page.keyboard.press("t");
  await clickCell(page, 108, 150);
  await clickCell(page, 108, 100);
  await expect(studio.getByTestId("walk-result-title")).toHaveText("Went to room 2 (Green room)", {
    timeout: 30_000,
  });
  await expect(studio.getByTestId("walk-result-state")).toHaveText(
    "Tested with your game as it is now",
  );
  await shot(page, "walk-live-state");

  // From a fresh start the flag is clear again and the door stays shut.
  await studio.getByTestId("walk-live-state").uncheck();
  await studio.getByTestId("walk-again").click();
  await expect(studio.getByTestId("walk-result-state")).toHaveText("Tested from a fresh start", {
    timeout: 30_000,
  });
  await expect(studio.getByTestId("walk-result-title")).toHaveText("Blocked at Wall line");

  // With a start set, a click on the door box makes it the goal: the walk
  // runs into the box and through the (now open) door.
  await studio.getByTestId("walk-live-state").check();
  await clickCell(page, 108, 150);
  await expect(studio.getByTestId("walk-result")).toHaveCount(0);
  await clickCell(page, 108, 115);
  await expect(studio.getByTestId("walk-result-title")).toHaveText("Went to room 2 (Green room)", {
    timeout: 30_000,
  });
});
