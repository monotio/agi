import { expect, test } from "../test.ts";
import type { Locator, Page } from "@playwright/test";
import { testProjectId } from "../../test/identity.ts";
import { parseGameHash } from "../../src/shell/shellRoute.ts";
import { BRIDGE_SOURCE, DOT_EGO, ROBOT_VIEW } from "../../../test/studioAssistFixtures.ts";
import { createContainer } from "../../../src/container/container.ts";
import { assembleLogic } from "../../../src/logic/assembler.ts";
import { compilePictureSource } from "../../../src/picture/source.ts";
import {
  cacheGame,
  clickTimelineMark,
  configureAi,
  enterCreateMode,
  isolateStorage,
  settled,
  textHook,
  waitForCycles,
  waitForRoom,
  openWorldRoom,
} from "../engineProbe.ts";

/**
 * The README and docs/media screenshots, driven through the real app in test
 * mode (playwright.media.config.ts; run with `npm run media:capture`). Each
 * shot is a fresh context on the bundled Adventure Department tutorial or an
 * original test fixture, with the stub provider for AI state. The fixture
 * server's installed-game list is answered empty, so no local game library
 * reaches a picture. Shots wait on published state, never on a clock.
 *
 * Nothing is restyled for the camera. A live session's history transport
 * places its marks by how many ticks the session has run, which the wall
 * clock decides, and the engine's clock runs in its worker, beyond the reach
 * of Playwright's page.clock. So the Play shot starts from a finished tape:
 * the tutorial's recorded walkthrough, sought to a checkpoint while paused,
 * then Take control (takeControlAt). Create mode needs the tutorial's own
 * project, which a walkthrough session is not, so its transport keeps one
 * live mark: the start of the session, a few pixels into the lane.
 */

/** Where the PNGs go: the capture script's staging folder, else the test's output. */
const OUT = process.env["AGI_MEDIA_OUT"];

/**
 * Save `name`.png at CSS pixel size: the page renders at device scale 2 and
 * the screenshot is downsampled from it. `clip` crops to a region in CSS px.
 */
async function shot(
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  // Nothing hovers: the pointer rests in the status bar's corner.
  await page.mouse.move(1439, 899);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.screenshot({
    path: OUT ? `${OUT}/${name}.png` : test.info().outputPath(`${name}.png`),
    scale: "css",
    animations: "disabled",
    caret: "hide",
    ...(clip ? { clip } : {}),
  });
}

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
  // Only the catalog and the stored fixtures: no games from a local games/ folder.
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  // The shipped display: square-pixel test mode off, 4:3 like a monitor of the day.
  await page.addInitScript(() => localStorage.setItem("monotio_agi.originalAspect", "on"));
});

async function playTutorial(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await settled(page);
}

/**
 * The tutorial from its recorded walkthrough: paused, sought to checkpoint
 * `index`, taken over and resumed. The new session's transport has no marks
 * yet and fills once its first batch lands, the same on every run.
 */
async function takeControlAt(
  page: Page,
  index: number,
  { resume = true }: { resume?: boolean } = {},
): Promise<void> {
  await page.goto("/#watch/adventure-department");
  await expect(page.getByTestId("walkthrough-bar")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("btn-walkthrough-pause").click();
  await expect
    .poll(() => page.evaluate(() => window.__AGI_STATE__?.walkthrough.status))
    .toBe("paused");
  await clickTimelineMark(page, page.getByTestId(`walkthrough-marker-${index}`));
  await expect
    .poll(() => page.evaluate(() => window.__AGI_STATE__?.walkthrough.checkpointIndex))
    .toBe(index);
  await settled(page);
  await page.getByTestId("btn-walkthrough-take-control").click();
  await expect(page.getByTestId("walkthrough-bar")).toBeHidden();
  // A paused walkthrough hands over a paused game; Resume plays on from here.
  if (resume) await page.getByTestId("btn-transport-resume").click();
  await expect(page.locator(".play-strip .transport-progress-fill")).toHaveAttribute(
    "style",
    /width: 100%/,
  );
  await expect(page.locator(".play-strip .transport-marker")).toHaveCount(0);
  await settled(page);
}

async function openRoomStudio(page: Page, room: number): Promise<Locator> {
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, room);
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

/** The screen point at the centre of logical cell x,y of the picture pane. */
async function cell(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.locator(".studio-pane").last().boundingBox())!;
  const zoom = box.height / 168;
  return [box.x + (x + 0.5) * 2 * zoom, box.y + (y + 0.5) * zoom];
}

/** Studio's stage and side panel, without the scene list and the scrubber. */
const STAGE = { x: 348, y: 104, width: 1092, height: 690 };

test("home", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("catalog-play-adventure-department")).toBeVisible();
  // Every card's thumbnail has drawn.
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() => page.evaluate(() => [...document.images].every((image) => image.complete)))
    .toBe(true);
  await shot(page, "home");
});

test("tutorial-gallery", async ({ page }) => {
  // The moment the walkthrough has just painted the mural and dismissed its
  // message: the status line reads "Mural fixed!".
  await takeControlAt(page, 1);
  expect((await textHook(page)).rows[0]).toContain("Score: 10 of 30");
  await shot(page, "tutorial-gallery");
});

test("create-mode", async ({ page }) => {
  await playTutorial(page);
  // Pause from the play bar at a fixed cycle: the timeline's length, and so
  // where its boot mark sits, is then the same on every capture.
  await expect
    .poll(async () => (await textHook(page)).cycle, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(80);
  await page.getByTestId("btn-transport-pause").click();
  await expect(page.getByTestId("btn-transport-resume")).toBeVisible();
  await configureAi(page, { provider: "stub" });
  await enterCreateMode(page);
  // All three rooms in the World panel's graph.
  await page.getByTestId("world-panel").getByText("Fit", { exact: true }).click();
  await page.getByTestId("power-up").click();
  const input = page.getByTestId("agent-bubble-input");
  await expect(input).toBeEnabled();
  await input.fill("Hang a fourth painting beside the east door.");
  await settled(page);
  await shot(page, "create-mode");
});

test("room-studio", async ({ page }) => {
  await playTutorial(page);
  const studio = await openRoomStudio(page, 1);
  await studio.locator('[data-row="rope"]').click();
  await expect(studio.getByTestId("item-editor")).toBeVisible();
  await shot(page, "room-studio");
});

test("room-studio-walk", async ({ page }) => {
  await playTutorial(page);
  const studio = await openRoomStudio(page, 2);
  await page.keyboard.press("3");
  await expect(studio.locator('[data-role="walkable-tint"]')).toBeVisible();
  await page.keyboard.press("t");
  // From the west door, where the player comes in from the gallery, to the console.
  await studio.locator('[data-role="door"][data-destination="1"] polygon').click();
  await expect(studio.locator('[data-role="walk-start"]')).toBeVisible();
  await page.mouse.click(...(await cell(page, 104, 150)));
  await expect(studio.getByTestId("walk-result-title")).toHaveText("Reached", { timeout: 30_000 });
  await shot(page, "room-studio-walk", STAGE);
});

const ASSIST_PROJECT = testProjectId("studio-assist");
const ASSIST_ROOM = [
  "if (isset(f5)) {",
  "  load.pic(v0); draw.pic(v0); discard.pic(v0); show.pic();",
  "  load.view(1);",
  "  load.view(0); animate.obj(o0); set.view(o0, 0); position(o0, 40, 100); draw(o0);",
  "}",
  "return;",
  "",
].join("\n");

/** The Studio assist spec's river crossing: picture 1 is the bridge fixture. */
async function bootAssistGame(page: Page): Promise<void> {
  const game = createContainer();
  const logic = (source: string) => assembleLogic(source, { dictionary: new Map() }).payload;
  game.putResource(
    "logic",
    0,
    logic("if (!isset(f200)) { set(f200); accept.input(); new.room(1); } call.v(v0); return;"),
  );
  game.putResource("logic", 1, logic(ASSIST_ROOM));
  game.putResource("picture", 1, compilePictureSource(BRIDGE_SOURCE).bytes);
  game.putResource("view", 0, DOT_EGO);
  game.putResource("view", 1, ROBOT_VIEW);
  await page.goto("/");
  await cacheGame(page, {
    projectId: ASSIST_PROJECT,
    title: "River crossing",
    provider: "stub",
    model: "stub",
    imported: false,
    roomGeneration: false,
    authoringState: {
      authoring: {
        version: 1,
        bindings: {},
        world: {
          rooms: { "1": { title: "River", description: "A bridge.", exits: {} } },
          facts: {},
          quests: {},
        },
      },
      sources: { logics: [[1, ASSIST_ROOM]], pictures: [[1, BRIDGE_SOURCE]] },
    },
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  if (!parseGameHash(new URL(page.url()).hash)) await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
}

test("studio-ask", async ({ page }) => {
  await bootAssistGame(page);
  await configureAi(page, { provider: "stub" });
  const studio = await openRoomStudio(page, 1);
  await studio.getByRole("radio", { name: /Walk/ }).click();
  await studio.locator('[data-row="bridge"]').click();
  await expect(studio.getByTestId("assist-chip").first()).toHaveText("Bridge");
  const input = studio.getByTestId("assist-input");
  await input.fill("Make this bridge walkable without changing the art");
  await input.press("Enter");
  await expect(studio.getByTestId("assist-candidate")).toBeVisible();
  await expect(studio.getByTestId("assist-summary")).toHaveText(
    "Opened the barrier under the bridge without touching its art.",
  );
  await expect(studio.locator('[data-role="changed"]').first()).toBeVisible();
  await shot(page, "studio-ask", STAGE);
});

test("sprite-studio", async ({ page }) => {
  await playTutorial(page);
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 2);
  await panel.getByTestId("world-open-sprite-2").click();
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  // The wave: cel 2 raises the arm.
  await studio.locator('[data-loop="0"][data-cel="2"]').click();
  await expect(studio.getByTestId("sprite-cel-summary")).toHaveText("Cel 2 · Loop 0");
  await shot(page, "sprite-studio");
});
