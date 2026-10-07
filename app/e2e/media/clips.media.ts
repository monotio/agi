import { expect, test } from "../test.ts";
import type { Locator, Page } from "@playwright/test";
import {
  configureAi,
  enterCreateMode,
  enterPlayMode,
  isolateStorage,
  probe,
  screenText,
  settled,
  textHook,
  waitForRoom,
} from "../engineProbe.ts";
import { record } from "./record.ts";
import { openRoomGenerationGame, walkInto } from "./roomGeneration.ts";

/**
 * Short clips for the README and the media gallery, encoded to GIF by
 * scripts/capture-media.ts. Same rules as the stills: the bundled tutorial,
 * Starter and original resources, the stub provider or a recorded reply.
 */

// Clips show the app's real motion.
test.use({ reducedMotion: "no-preference" });

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.addInitScript(() => localStorage.setItem("monotio_agi.originalAspect", "on"));
});

async function rest(page: Page, ms: number): Promise<void> {
  // Clips need real pauses between actions so a viewer can follow them.
  await page.evaluate((ms) => new Promise((resolve) => setTimeout(resolve, ms)), ms);
}

async function glide(page: Page, target: Locator, x: number, y: number): Promise<void> {
  const box = (await target.boundingBox())!;
  await page.mouse.move(
    box.x + ((x + 0.5) * box.width) / 160,
    box.y + ((y + 0.5) * box.height) / 168,
    {
      steps: 14,
    },
  );
}

async function starter(page: Page): Promise<void> {
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("My adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await settled(page);
}

async function tutorial(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await settled(page);
}

/** Hold one arrow key's walk for `ms`, then stop the hero. */
async function walk(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.press(key);
  await rest(page, ms);
  await page.keyboard.press(key);
}

test("clip-room-generation", async ({ page }) => {
  const room = await openRoomGenerationGame(page);
  await rest(page, 600);
  await record(page, "clip-room-generation", page.locator(".screen:visible"), async () => {
    await rest(page, 700);
    await walkInto(page, 140);
    await expect(page.getByTestId("room-generation")).toBeVisible();
    await rest(page, 2600);
    room.release();
    await expect(page.getByTestId("room-generation")).toBeHidden({ timeout: 30_000 });
    await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(2);
    await rest(page, 3200);
  });
});

test("clip-picture-line", async ({ page }) => {
  await starter(page);
  await page.getByTestId("part-room:1:picture:1").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  // Focus gives the PICTURE editor the workspace while the game keeps running.
  await page.getByTestId("workspace-focus").click();
  const pane = studio.locator(".studio-pane").last();
  await expect(pane).toBeVisible();
  await pane.evaluate(() => document.fonts.ready);
  await page.mouse.move(1439, 899);
  await rest(page, 500);
  await record(page, "clip-picture-line", page.getByTestId("workspace-editor"), async () => {
    await rest(page, 600);
    await studio.locator('button[data-tool="line"]').click();
    await rest(page, 400);
    await studio.locator('.workspace-palette__choices button[data-colour="15"]').click();
    await rest(page, 400);
    const points = [
      [22, 150],
      [48, 128],
      [80, 122],
      [112, 128],
      [138, 150],
    ] as const;
    for (const [x, y] of points) {
      await glide(page, pane, x, y);
      await rest(page, 250);
      await page.mouse.down();
      await page.mouse.up();
      await rest(page, 350);
    }
    await glide(page, pane, 150, 160);
    await rest(page, 500);
    await page
      .getByTestId("workspace-context")
      .getByTestId("studio-path")
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await page.mouse.move(1439, 899, { steps: 10 });
    await rest(page, 2200);
  });
});

test("clip-create-play", async ({ page }) => {
  await tutorial(page);
  await page.keyboard.press("Enter");
  await rest(page, 400);
  await record(page, "clip-create-play", null, async () => {
    await walk(page, "ArrowRight", 1400);
    await rest(page, 700);
    const before = await probe(page);
    await enterCreateMode(page);
    await rest(page, 900);
    await page.getByTestId("part-room:1:picture:1").click();
    await expect(page.getByTestId("room-studio")).toBeVisible();
    await rest(page, 1600);
    await enterPlayMode(page);
    await expect.poll(async () => (await probe(page)).cycle).toBeGreaterThan(before.cycle);
    await rest(page, 900);
    await walk(page, "ArrowDown", 700);
    await rest(page, 1400);
  });
});

test("clip-crt-walk", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("monotio_agi.crt", "on"));
  await tutorial(page);
  await page.keyboard.press("Enter");
  await rest(page, 400);
  await record(page, "clip-crt-walk", page.locator(".game-surface:visible"), async () => {
    await rest(page, 500);
    await walk(page, "ArrowRight", 1700);
    await walk(page, "ArrowUp", 900);
    await walk(page, "ArrowLeft", 1200);
    await rest(page, 900);
  });
});

test("clip-launch-restart", async ({ page }) => {
  await starter(page);
  const action = page.getByTestId("workspace-update");
  await expect(action).toHaveAccessibleName("Restart Meadow");
  const game = page.locator(".game-surface:visible");
  await game.click();
  await rest(page, 500);
  // The top bar, the game and its bar: where the restart happens.
  const stage = (await page.getByTestId("parts-list").boundingBox())!;
  const bar = (await page.getByTestId("workspace-game-bar").boundingBox())!;
  const left = stage.x + stage.width;
  const crop = { x: left, y: 0, width: 1440 - left, height: bar.y + bar.height };
  await record(page, "clip-launch-restart", crop, async () => {
    for (let round = 0; round < 2; round++) {
      await rest(page, 700);
      await page.keyboard.type("die", { delay: 150 });
      await page.keyboard.press("Enter");
      await expect.poll(() => screenText(page)).toContain("lava");
      await rest(page, 1600);
      const box = (await action.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
      await rest(page, 300);
      await action.click();
      await expect.poll(() => screenText(page)).not.toContain("lava");
      await game.click();
    }
    await page.mouse.move(1439, 899, { steps: 10 });
    await rest(page, 1200);
  });
});
