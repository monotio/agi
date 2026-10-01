import type { Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { testProjectId } from "../test/identity.ts";
import {
  cacheGame,
  closeWorkspaceEditor,
  enterCreateMode,
  enterPlayMode,
  openWorkspacePicture,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

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

test("the parts list maps rooms to their drawn pictures", async ({ page }) => {
  await bootWorkspaceGame(page);
  await enterCreateMode(page);
  const parts = page.getByTestId("parts-list");
  await expect(parts).toBeVisible();
  const cycle = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
  await expect(parts.getByTestId("part-room:1")).toContainText("Castle Gate");
  await expect(parts.getByTestId("part-room:2")).toContainText("Great Hall");
  for (const room of [1, 2]) {
    await expect(parts.getByTestId(`part-room:${room}:picture:5`)).toHaveText("PICTURE 5");
  }
  await expect(parts.getByTestId("part-room:1").locator("img")).toBeVisible();
  await expect(parts.getByTestId("part-room:4:picture:7")).toHaveText("PICTURE 7");
  await expect(parts.locator('[data-testid^="part-room:3:picture:"]')).toHaveCount(0);
  await expect(parts.getByTestId("part-room:6")).toHaveCount(0);
  await expect(parts.getByTestId("part-room:1").locator(".live-dot")).toBeVisible();
});

test("the World map keeps exit words on the selected room when zoomed out", async ({ page }) => {
  await bootWorkspaceGame(page);
  await enterCreateMode(page);
  await enterPlayMode(page);
  await page.getByTestId("btn-world-map").click();
  const map = page.getByTestId("world-map");
  await expect(map).toBeVisible();
  await map.getByTestId("btn-world-plan").click();
  await map.getByTestId("map-node-1").click();
  await expect(map.getByTestId("map-detail")).toContainText("Castle Gate");
  const words = () =>
    map.locator(".edge-label").evaluateAll((els) => els.map((e) => e.textContent?.trim()).sort());
  await map.getByTestId("map-zoom-level").click();
  await expect.poll(words).toEqual(["down", "north"]);
  for (let i = 0; i < 3; i++) await map.getByTestId("map-zoom-out").click();
  await expect(map.getByTestId("map-zoom-level")).toHaveText("51%");
  await expect.poll(words).toEqual(["north"]);
  if (await map.getByTestId("world-all-rooms").isVisible())
    await map.getByTestId("world-all-rooms").click();
  await expect(map.getByTestId("map-add-room")).toBeVisible();
  await map.getByTestId("btn-world-discovered").click();
  await expect(map.getByTestId("btn-world-discovered")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(map).toBeHidden();
});

test("PICTURE editing leaves the same game running and isolates keyboard input", async ({
  page,
}) => {
  await bootWorkspaceGame(page);
  const studio = await openWorkspacePicture(page, 2);
  expect(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()])).toEqual(PIC_5);
  await expect(page.locator(".game-surface:visible")).toHaveCount(1);
  const cycle = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
  await page.keyboard.type("look");
  await expect(page.getByTestId("input-line")).toHaveValue("");
  await closeWorkspaceEditor(page);
  await expect(studio).toBeHidden();
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
});
