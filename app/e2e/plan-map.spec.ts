import { expect, test, type Page } from "@playwright/test";
import {
  configureAi,
  isolateStorage,
  openCreateAdventure,
  openDeveloperActivity,
  openGameOptions,
  textHook,
} from "./engineProbe.ts";

/**
 * The map as a plan surface: the stub agent designs a world, the player
 * reviews and edits it on the map, and only an explicit "Build as shown"
 * authors real bytecode. No fixture needed — every byte here is generated.
 */

test.use({ headless: process.platform !== "darwin" });

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
});

/** Reach the plan-review map through the same controls a player uses. */
async function openPlanReview(page: Page): Promise<void> {
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await openCreateAdventure(page);
  await page.getByTestId("template-custom").click();
  await page
    .getByTestId("custom-adventure-input")
    .fill("A small stub adventure for the plan flow.");
  await page.getByTestId("plan-game").click();
  await expect(page.getByTestId("map-review")).toBeVisible({ timeout: 30_000 });
}

test("plan → review → edit → revise → keep → resume → build", async ({ page }) => {
  await openPlanReview(page);

  // The stub's three-room plan fills the map before anything is built.
  await expect(page.getByTestId("map-room-1")).toContainText("planned");
  await expect(page.getByTestId("map-room-3")).toBeVisible();

  // Rename the opening room — the edit lands in the draft, not in resources.
  await page.getByTestId("map-room-1").click();
  const title = page.getByTestId("plan-room-title");
  await expect(title).toHaveValue("The Clearing");
  await title.fill("The Meadow");
  await title.press("Tab");
  await expect(page.getByTestId("map-room-1")).toContainText("The Meadow");

  // A revision turn grows the plan: the stub adds an annex room.
  await page.getByTestId("map-revise-input").fill("add a tower room");
  await page.getByTestId("map-revise-input").press("Enter");
  await expect(page.getByTestId("map-room-4")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "test-results/plan-review-map.png" });

  // Keep the draft: the map closes, nothing boots, the plan survives a reload.
  await page.getByTestId("map-keep-plan").click();
  await expect(page.getByTestId("map-review")).toBeHidden();
  await expect(page.getByTestId("pending-plan")).toBeVisible();
  await page.reload();
  await openCreateAdventure(page);
  await expect(page.getByTestId("pending-plan")).toBeVisible();

  // Resume: the map reopens over the kept draft, edits intact.
  await page.getByTestId("resume-plan").click();
  await expect(page.getByTestId("map-review")).toBeVisible();
  await page.getByTestId("map-room-1").click();
  await expect(page.getByTestId("plan-room-title")).toHaveValue("The Meadow");

  // Approve: the build turn authors the opening room and boots the game.
  await page.getByTestId("map-build-plan").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await textHook(page)).room, { timeout: 20_000 }).toBe(1);
  await expect(page.getByTestId("pending-plan")).toBeHidden();
});

test("the plan surface stays usable on a phone and under reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPlanReview(page);

  // The room list leads on a small screen; the plan-review bar stays visible.
  await expect(page.getByTestId("map-room-list")).toBeVisible();
  await expect(page.getByTestId("map-review")).toBeVisible();
  await page.getByTestId("map-room-2").click();
  await expect(page.getByTestId("plan-room-title")).toHaveValue("The Hall");

  // Nothing animates under reduced motion.
  const animating = await page
    .getByTestId("world-map")
    .evaluate((el) =>
      Array.from(el.querySelectorAll("*")).some(
        (n) => getComputedStyle(n).animationName !== "none",
      ),
    );
  expect(animating).toBe(false);
  await page.screenshot({ path: "test-results/plan-review-phone.png" });
});

test("a pending plan can be discarded without building", async ({ page }) => {
  await openPlanReview(page);
  await page.getByTestId("map-keep-plan").click();
  await expect(page.getByTestId("pending-plan")).toBeVisible();

  await page.getByTestId("discard-plan").click();
  await expect(page.getByTestId("pending-plan")).toBeHidden();

  // Nothing lingers: a reload shows no resume offer.
  await page.reload();
  await openCreateAdventure(page);
  await expect(page.getByTestId("pending-plan")).toBeHidden();
});

test("a running authored game extends from a planned map node", async ({ page }) => {
  // The direct create path still plans first, so the live session's world
  // holds rooms the stub has not built yet.
  await page.goto("/");
  await openDeveloperActivity(page);
  await page.getByTestId("boot-agent").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-panel")).toContainText("assembled room 1", {
    timeout: 30_000,
  });
  await expect.poll(async () => (await textHook(page)).room, { timeout: 20_000 }).toBe(1);

  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);

  // Room 2 is in the plan but not yet authored: it offers "Build this room".
  await page.getByTestId("map-room-2").click();
  const detail = page.getByTestId("map-detail");
  await expect(detail).toContainText("planned");
  await page.getByTestId("map-build-room").click();
  await expect(page.getByTestId("agent-panel")).toContainText("authored room 2", {
    timeout: 30_000,
  });
  // The map stayed open on the paused game and the node is now authored.
  await expect(page.getByTestId("world-map")).toBeVisible();
  await expect(page.getByTestId("map-room-2")).toContainText("logic");

  // Closing the map resumes play; walking east enters the authored room —
  // it exists, so no second authoring turn fires.
  await page.getByTestId("map-close").click();
  await expect(page.getByTestId("world-map")).toBeHidden();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  const input = page.getByTestId("input-line");
  await input.focus();
  if ((await textHook(page)).modal !== null) {
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  }
  await input.fill("east");
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).room, { timeout: 20_000 }).toBe(2);
});
