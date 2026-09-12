import { expect, test, type Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { cacheGame, openGameOptions, textHook, waitForCycles } from "./engineProbe.ts";

test.use({ headless: process.platform !== "darwin" });

/**
 * The world map reads three sources: the journal (observed), the authoring
 * world (planned) and the logic scan (static). This fixture gives one room
 * all three kinds of evidence at once: room 2 is planned ("east"), named in
 * logic 1's literal new.room, and visited through the f6 flag write.
 */
function mapGame() {
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xf0, 3, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic("if(!isset(f200)){set(f200);accept.input();new.room(1);}call.v(v0);return;", {
      dictionary: new Map(),
    }).payload,
  );
  game.putResource(
    "logic",
    1,
    assembleLogic(
      "if(!isset(f5)){set(f5);load.pic(v0);draw.pic(v0);show.pic();}if(isset(f6)){new.room(2);}return;",
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("logic", 2, assembleLogic("return;", { dictionary: new Map() }).payload);
  // Room 9 exists in logic but nobody routes to it; its own exit is computed.
  game.putResource(
    "logic",
    9,
    assembleLogic("new.room.v(v60);return;", { dictionary: new Map() }).payload,
  );
  return game;
}

const MAP_GAME = {
  projectId: "world-map-fixture",
  title: "Map fixture",
  provider: "stub",
  model: "stub",
  // Not "imported": only an app-authored record gets the stub provider config
  // back on resume, which is what restores the authoring session (and with it
  // the planned world.rooms) without a real provider key.
  imported: false,
  roomGeneration: true,
  authoringState: {
    authoring: {
      version: 1,
      bindings: {},
      world: {
        rooms: {
          "1": {
            title: "Lobby",
            description: "The entry hall.",
            exits: { ladder: 4, east: 2 },
          },
          "4": { title: "Attic", description: "Dusty storage.", exits: {} },
        },
        facts: {},
        quests: {},
      },
      sources: { logics: [[0, "return;"]] },
    },
  },
};

async function bootMapGame(page: Page): Promise<void> {
  const game = mapGame();
  await page.goto("/");
  await cacheGame(page, {
    ...MAP_GAME,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
}

test("world map lists observed, planned and logic-named rooms; closing preserves play", async ({
  page,
}) => {
  await bootMapGame(page);

  // Partial input must survive the round trip through the map.
  const input = page.getByTestId("input-line");
  await input.fill("lo");

  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  const mapDialog = page.getByTestId("world-map");
  await expect(mapDialog).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);

  // Observed (room 1), logic-only (room 9), planned-only (room 4).
  await expect(page.getByTestId("map-room-1")).toContainText("visited");
  await expect(page.getByTestId("map-room-9")).toContainText("logic");
  await expect(page.getByTestId("map-room-9")).toContainText("computed exit");
  await expect(page.getByTestId("map-room-4")).toContainText("planned");
  await expect(page.getByTestId("map-room-4")).toContainText("Attic");

  // Keyboard: the room list answers ArrowUp/ArrowDown with roving selection.
  await page.getByTestId("map-room-list").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("map-detail")).toBeVisible();
  const detail = page.getByTestId("map-detail");
  await expect(detail).toContainText(/Room \d/);

  // Select the planned room: never visited, but the plan names it.
  await page.getByTestId("map-room-4").click();
  await expect(detail).toContainText("Room 4");
  await expect(detail).toContainText("Attic");
  await expect(detail).toContainText("Not visited");
  await expect(detail).toContainText("planned");
  await page.screenshot({ path: "test-results/world-map-desktop.png" });

  // Escape closes only the map; the game resumes where it was.
  await page.keyboard.press("Escape");
  await expect(mapDialog).not.toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await expect(input).toHaveValue("lo");
  const before = await textHook(page);
  await waitForCycles(page, 2);
  expect((await textHook(page)).cycle).toBeGreaterThan(before.cycle);
});

test("phone layout puts the room list first and the graph one tap away", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await bootMapGame(page);
  await openGameOptions(page, "game-actions-menu");
  const openedAt = Date.now();
  await page.getByTestId("btn-world-map").click();
  const mapDialog = page.getByTestId("world-map");
  await expect(mapDialog).toBeVisible();
  const openMs = Date.now() - openedAt;
  await expect(page.getByTestId("map-room-list")).toBeVisible();
  // The graph folds closed on small screens; the list stays usable.
  const pane = page.getByTestId("map-graph-pane");
  if (!(await pane.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await pane.locator("summary").click();
  }
  await expect(page.getByTestId("map-graph")).toBeVisible();
  await page.getByTestId("map-room-4").click();
  await expect(page.getByTestId("map-detail")).toContainText("Attic");
  await page.screenshot({ path: "test-results/world-map-phone.png" });
  test.info().annotations.push({ type: "world-map open (ms)", description: String(openMs) });
});

test("the map records a live transition and matches it against plan and logic", async ({
  page,
}) => {
  await bootMapGame(page);
  // Visit room 2 through the inspector's flag write: logic 1's literal
  // new.room(2) fires, so the journal edge joins the planned and static ones.
  await page.getByTestId("power-up").click();
  await page.getByTestId("inspect-toggle").click();
  await page.keyboard.press("Escape");
  await page.getByTestId("dbg-tab-state").click();
  await page.getByTestId("dbg-flags").locator("button").nth(6).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(2);

  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await expect(page.getByTestId("map-room-2")).toContainText("visited");
  await page.getByTestId("map-room-2").click();
  const detail = page.getByTestId("map-detail");
  await expect(detail).toContainText("Visited 1×");
  // Three provenances on one pair stay distinct: walked, planned (east), logic.
  await expect(detail).toContainText(/Walked|walked/);
  await expect(detail).toContainText("via east");
  await expect(detail).toContainText("you are here");
});
