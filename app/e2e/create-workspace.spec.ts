import { expect, test } from "./test.ts";
import type { Page } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import {
  cacheGame,
  enterCreateMode,
  isolateStorage,
  openWorldRoom,
  textHook,
  waitForAutosaveAfter,
  waitForCycles,
  waitForRoom,
} from "./engineProbe.ts";

/**
 * The Create workspace: the World panel docked beside the live game, Room
 * Studio's seam in the centre, and the docks' folds and keys. The fixture
 * never lets a room number stand in for its picture: rooms 1 and 2 share
 * PIC 5, room 3 picks its picture at runtime, room 4 draws PIC 7, and the
 * plan names an unbuilt room 6. Room 2's logic names rooms 3 and 4, which
 * is what puts them on the map (a resource alone is not room evidence).
 */
test.use({ viewport: { width: 1440, height: 900 } });

const PIC_5 = [0xf0, 1, 0xf8, 0, 0, 0xff];

function workspaceGame() {
  const game = createContainer();
  const dictionary = new Map<string, number>();
  const logic = (source: string) => assembleLogic(source, { dictionary }).payload;
  game.putResource("picture", 5, Uint8Array.from(PIC_5));
  game.putResource("picture", 7, Uint8Array.of(0xf0, 2, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    0,
    logic("if(!isset(f200)){set(f200);accept.input();new.room(1);}call.v(v0);return;"),
  );
  const draw = (pick: string) =>
    `if(isset(f5)){${pick}load.pic(v30);draw.pic(v30);discard.pic(v30);show.pic();}`;
  game.putResource(
    "logic",
    1,
    logic(`${draw("assignn(v30,5);")}if(isset(f6)){new.room(2);}return;`),
  );
  game.putResource(
    "logic",
    2,
    logic(
      `${draw("assignn(v30,5);")}if(isset(f7)){new.room(3);}if(isset(f8)){new.room(4);}return;`,
    ),
  );
  game.putResource("logic", 3, logic(`${draw("random(1,9,v30);")}return;`));
  game.putResource("logic", 4, logic(`${draw("assignn(v30,7);")}return;`));
  return game;
}

async function bootWorkspaceGame(page: Page): Promise<void> {
  await page.goto("/");
  await cacheGame(page, {
    projectId: testProjectId("create-workspace"),
    title: "Workspace fixture",
    provider: "stub",
    model: "stub",
    imported: false,
    roomGeneration: true,
    authoringState: {
      authoring: {
        version: 1,
        bindings: {},
        world: {
          rooms: {
            "1": { title: "Castle Gate", description: "The way in.", exits: { north: 2 } },
            "2": { title: "Great Hall", description: "Banners.", exits: { down: 6 } },
            "6": { title: "Crypt", description: "Not dug yet.", exits: {} },
          },
          facts: {},
          quests: {},
        },
        sources: { logics: [[0, "return;"]] },
      },
    },
    files: Object.fromEntries(workspaceGame().files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
}

test("the World panel maps rooms to the pictures their logic draws", async ({ page }) => {
  await bootWorkspaceGame(page);
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await expect(panel).toBeVisible();
  // The docked map is a creator view of the running game: it never pauses.
  const cycle = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
  // Graph nodes carry real thumbnails, not placeholders.
  await expect(panel.locator(".map-node .node-thumb").first()).toBeVisible();

  // Entering Create opens the card of the room the game is in.
  const detail = panel.getByTestId("map-detail");
  await expect(detail).toContainText("Castle Gate");
  await expect(panel.getByTestId("map-room-list")).toBeHidden();
  await expect(panel.getByTestId("world-room-pictures")).toContainText(
    "PIC 5 · shared with room 2",
  );
  // No placeholder: Play here lives in Room Studio (its canvas menu), where the spot is chosen.
  await expect(panel.getByTestId("world-play-here")).toHaveCount(0);
  await expect(panel.locator("[title='Coming in a later update']")).toHaveCount(0);

  // All rooms lists each room with the picture its logic draws.
  await panel.getByTestId("world-all-rooms").click();
  await expect(panel.getByTestId("map-room-pic-1")).toBeVisible();
  await expect(panel.getByTestId("map-room-pic-1")).toHaveText("PIC 5 · shared");
  await expect(panel.getByTestId("map-room-pic-2")).toHaveText("PIC 5 · shared");
  await expect(panel.getByTestId("map-room-pic-3")).toHaveText("runtime");
  await expect(panel.getByTestId("map-room-pic-4")).toHaveText("PIC 7");
  await expect(panel.getByTestId("map-room-pic-6")).toHaveText("plan");
  await expect(panel.getByTestId("map-room-1")).toContainText("visited");
  await expect(panel.getByTestId("map-room-6")).toContainText("planned · not built");

  await openWorldRoom(panel, 3);
  await expect(panel.getByTestId("world-room-pictures")).toContainText("picture chosen at runtime");
  await expect(panel.getByTestId("world-open-studio")).toBeDisabled();
  await expect(panel.getByTestId("world-studio-blocked")).toContainText("chosen at runtime");
  await openWorldRoom(panel, 6);
  await expect(panel.getByTestId("world-open-studio")).toBeDisabled();
  await expect(panel.getByTestId("world-studio-blocked")).toContainText("not built yet");

  // The map button in Create shows this panel; the window is Play's.
  await page.getByTestId("dock-tab-world").focus();
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toHaveCount(0);
  await expect(panel).toBeVisible();
});

test("Expand opens the world plan over the panel; zoomed out, exit words keep to the room in view", async ({
  page,
}) => {
  await bootWorkspaceGame(page);
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await expect(panel.getByTestId("map-detail")).toContainText("Castle Gate");

  // At 100% every exit word shows; zoomed out (51%) only the selected
  // room's: Castle Gate's "north", not the Great Hall's "down".
  const words = () =>
    panel.locator(".edge-label").evaluateAll((els) => els.map((e) => e.textContent?.trim()).sort());
  await panel.getByTestId("map-zoom-level").click();
  await expect.poll(words).toEqual(["down", "north"]);
  for (let i = 0; i < 3; i++) await panel.getByTestId("map-zoom-out").click();
  await expect(panel.getByTestId("map-zoom-level")).toHaveText("51%");
  await expect.poll(words).toEqual(["north"]);

  const expand = panel.getByRole("button", { name: "Expand", exact: true });
  await expect(expand).toHaveAttribute("title", "Expand");
  await expand.click();
  const map = page.getByTestId("world-map");
  await expect(map).toBeVisible();
  // The create experience with the plan editable, on the same selection.
  await expect(map.getByRole("heading", { name: "Map" })).toBeVisible();
  await expect(map.getByTestId("btn-world-plan")).toHaveText("Plan");
  await expect(map.getByTestId("btn-world-plan")).toHaveAttribute("aria-checked", "true");
  await expect(map.getByTestId("map-detail")).toContainText("Castle Gate");
  await map.getByTestId("world-all-rooms").click();
  await expect(map.getByTestId("map-add-room")).toBeVisible();
  // The window may switch to the discovered map; the panel keeps its plan view.
  await map.getByTestId("btn-world-discovered").click();
  await expect(map.getByTestId("btn-world-discovered")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(map).toHaveCount(0);
  await expect(expand).toBeFocused();
  await expect(panel.locator(".map-legend")).toContainText("planned");
});

test("the World panel opens on the player's room, follows them, and drills in and out", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  const walk = async (direction: string, room: number) => {
    await page.getByTestId("input-line").fill(direction);
    await page.getByTestId("input-line").press("Enter");
    await waitForRoom(page, room);
  };
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  const list = panel.getByTestId("map-room-list");
  const heading = panel.getByTestId("map-detail").getByRole("heading", { level: 3 });
  const row = (room: number) => panel.getByTestId(`map-room-${room}`).getByRole("button");

  // Entering Create shows the card of the room the player stands in.
  await expect(heading).toHaveText("Room 1");
  await expect(list).toBeHidden();
  // Walking on moves the card along.
  await walk("east", 2);
  await expect(heading).toHaveText("Room 2");

  // All rooms returns to the list, the room just shown in view and focused.
  await panel.getByRole("button", { name: "All rooms" }).click();
  await expect(list).toBeVisible();
  await expect(panel.getByTestId("map-detail")).toHaveCount(0);
  await expect(row(2)).toBeFocused();
  await expect(row(2)).toBeInViewport();

  // Picking another room stops following: its card stays while the player walks.
  await row(3).click();
  await expect(heading).toHaveText("Room 3");
  await expect(heading).toBeFocused();
  await walk("west", 1);
  await expect(heading).toHaveText("Room 3");
  // A graph node switches the card straight to its room.
  await panel.getByTestId("map-node-2").click();
  await expect(heading).toHaveText("Room 2");

  // Esc inside the card returns to the list.
  await heading.focus();
  await page.keyboard.press("Escape");
  await expect(list).toBeVisible();
  await expect(row(2)).toBeFocused();
  expect((await textHook(page)).room, "Esc stays with the panel").toBe(1);

  // Picking the room marked "you are here" follows the player again.
  await row(1).click();
  await expect(heading).toHaveText("Room 1");
  await walk("east", 2);
  await expect(heading).toHaveText("Room 2");
});

test("Open in Studio shows its picture in the centre and closing resumes the game", async ({
  page,
}) => {
  await bootWorkspaceGame(page);
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 2);
  await panel.getByTestId("world-open-studio").click();

  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByTestId("studio-picture")).toHaveText("PIC 5");
  await expect(studio.getByTestId("studio-size")).toContainText(
    `${PIC_5.length.toLocaleString("en-US")} bytes`,
  );
  await expect(studio).toContainText("Great Hall");
  // The live stage waits hidden (never remounted) while Studio has the centre.
  await expect(page.locator(".game-surface:visible")).toHaveCount(0);
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  const held = (await textHook(page)).cycle;
  await page.waitForTimeout(300);
  expect((await textHook(page)).cycle).toBe(held);
  // Keys typed over Studio never reach the paused game.
  await page.keyboard.type("look");
  await expect(page.getByTestId("input-line")).toHaveValue("");

  await studio.getByTestId("studio-close").click();
  await expect(studio).toHaveCount(0);
  await expect(page.getByTestId("input-line")).toBeFocused();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(held);
});

test("Room Studio takes the whole workspace and closing restores the docks as they were", async ({
  page,
}) => {
  await bootWorkspaceGame(page);
  await enterCreateMode(page);
  const left = page.getByTestId("create-dock-left");
  const right = page.getByTestId("create-dock-right");
  const panel = page.getByTestId("world-panel");
  await page.getByTestId("dock-tab-activity").click();
  await openWorldRoom(panel, 2);
  await panel.getByTestId("world-open-studio").click();

  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  // The docks wait hidden while Studio has the workspace.
  await expect(left).toBeHidden();
  await expect(right).toBeHidden();
  const zoomPercent = async () =>
    Number(
      /(\d+)%/.exec((await page.getByRole("group", { name: "Zoom" }).textContent()) ?? "")?.[1],
    );
  const scrubber = page.getByRole("slider", { name: "Draw order", exact: true });
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect.poll(async () => (await studio.boundingBox())?.width).toBe(width);
    expect((await scrubber.boundingBox())!.width).toBeGreaterThanOrEqual(300);
    await expect.poll(zoomPercent).toBeGreaterThanOrEqual(200);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Studio's own back control is the way back to Create: the docks return
  // with the tab and the room they showed.
  await studio.getByTestId("studio-back").click();
  await expect(studio).toHaveCount(0);
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  await expect(page.getByTestId("dock-tab-activity")).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByTestId("map-detail")).toContainText("Great Hall");
  await expect(page.getByTestId("input-line")).toBeFocused();
});

test("phone layouts offer Room Studio disabled, with a note saying why", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("monotio_agi.touchControls", "on"));
  await bootWorkspaceGame(page);
  await enterCreateMode(page);
  const open = page.getByTestId("world-open-studio");
  const note = page.getByTestId("world-studio-small");
  // Portrait: the World tab of the one bottom sheet.
  await page.getByTestId("dock-tab-world").click();
  await expect(page.getByTestId("world-panel")).toBeVisible();
  await expect(open).toBeDisabled();
  await expect(note).toBeVisible();
  await expect(note).toHaveText("Room Studio needs a larger screen");
  await expect(open).toHaveAttribute("aria-describedby", "world-studio-small");
  await expect(page.locator("[title='Room Studio needs a larger screen']")).toHaveCount(1);
  // Short landscape keeps it disabled; the same window without the touch
  // layout offers it again.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(open).toBeDisabled();
  await expect(note).toBeVisible();
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("toggle-touch-controls").click();
  await page.keyboard.press("Escape");
  await expect(open).toBeEnabled();
  await expect(note).toHaveCount(0);
  await context.close();
});

test("a folded dock stays folded across a reload and brackets fold only outside text", async ({
  page,
}) => {
  await bootWorkspaceGame(page);
  await enterCreateMode(page);
  const left = page.getByTestId("create-dock-left");
  await page.getByTestId("dock-fold-left").click();
  await expect(left).toHaveClass(/create-dock--rail/);
  await expect(page.getByTestId("world-panel")).toHaveCount(0);

  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await page.reload();
  await waitForRoom(page, 1, { coldBoot: true });
  await expect(page).toHaveURL(/#create\//);
  await expect(page.getByTestId("create-dock-left")).toHaveClass(/create-dock--rail/);

  // In the game's own input line `[` and `]` are text, as in Play: they
  // reach the parser and fold nothing.
  const input = page.getByTestId("input-line");
  await input.focus();
  await page.keyboard.type("a[b]");
  await expect(input).toHaveValue("a[b]");
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("a[b]");
  await expect(page.getByTestId("create-dock-left")).toHaveClass(/create-dock--rail/);
  await expect(page.getByTestId("create-dock-right")).not.toHaveClass(/create-dock--rail/);

  // Anywhere else they fold the docks, and never reach the parser.
  await page.getByTestId("dock-fold-right").focus();
  await page.keyboard.press("[");
  await expect(page.getByTestId("create-dock-left")).not.toHaveClass(/create-dock--rail/);
  await expect(page.getByTestId("world-panel")).toBeVisible();
  await page.keyboard.press("]");
  await expect(page.getByTestId("create-dock-right")).toHaveClass(/create-dock--rail/);
  await page.keyboard.press("]");
  await expect(page.getByTestId("create-dock-right")).not.toHaveClass(/create-dock--rail/);
  await expect(input).toHaveValue("a[b]");

  // Tabs are a tablist: arrow keys move the selection.
  await page.getByTestId("dock-tab-assistant").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("dock-tab-inspect")).toBeFocused();
  await expect(page.getByTestId("dock-tab-inspect")).toHaveAttribute("aria-selected", "true");
  // The Inspect tab is the inspector: its controls dock, nothing floats.
  await expect(page.getByTestId("inspect-panel")).toBeVisible();
  await expect(page.getByTestId("debug-dock")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("dock-tab-activity")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("agent-panel")).toBeVisible();
  await expect(page.getByTestId("agent-panel")).toHaveCount(1);
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
]) {
  test(`the assistant's header keeps Back to game inside the dock at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await bootWorkspaceGame(page);
    await enterCreateMode(page);
    await page.getByTestId("power-up").click();
    // The right dock: its tabs (create-dock-right) above the assistant it hosts.
    const dock = page.getByRole("complementary", { name: "Assistant panels" });
    const close = page.getByTestId("agent-bubble-close");
    await expect(close).toBeInViewport({ ratio: 1 });
    const [inner, outer] = [(await close.boundingBox())!, (await dock.boundingBox())!];
    expect(inner.x).toBeGreaterThanOrEqual(outer.x);
    expect(inner.y).toBeGreaterThanOrEqual(outer.y);
    expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
    expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
  });
}
