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
 * The map as a plan surface under one-flow genesis: the agent records the
 * world through update_world and builds the opening room in the same turn,
 * the map shows the plan on the running game and stays editable, and a
 * planned room builds just-in-time — by walking into it or from "Build this
 * room". No fixture needed — every byte here is generated.
 */

test.use({ headless: process.platform !== "darwin" });

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
});

/** Create an adventure through the same controls a player uses. */
async function createAdventure(page: Page): Promise<void> {
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await openCreateAdventure(page);
  await page.getByTestId("template-custom").click();
  await page.getByTestId("custom-adventure-input").fill("A small stub adventure.");
  await page.getByTestId("boot-game").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await textHook(page)).room, { timeout: 20_000 }).toBe(1);
}

async function openMap(page: Page): Promise<void> {
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
}

test("a fresh create yields a playable room 1 and the planned map in one turn", async ({
  page,
}) => {
  await createAdventure(page);

  // One flow, one turn: the agent log records a single Genesis request —
  // the world plan and the opening room landed together.
  const panel = page.getByTestId("agent-panel");
  await expect(panel).toContainText("Starting Genesis", { timeout: 30_000 });
  await expect(panel).toContainText("planned a three-room world", { timeout: 30_000 });
  const genesisRuns = await panel.locator(".agent-detail", { hasText: "Starting Genesis" }).count();
  expect(genesisRuns).toBe(1);

  // The map shows the plan over the running game: room 1 is authored and
  // visited, rooms 2 and 3 are planned nodes the player can already edit.
  await openMap(page);
  await expect(page.getByTestId("map-room-1")).toBeVisible();
  await expect(page.getByTestId("map-room-2")).toContainText("The Hall");
  await expect(page.getByTestId("map-room-3")).toContainText("The Vault");
  await page.getByTestId("map-room-2").click();
  await expect(page.getByTestId("map-detail")).toContainText("planned");
  await page.screenshot({ path: "test-results/plan-map-created.png" });
});

test("editing a planned node and walking into it builds the edited version", async ({ page }) => {
  await createAdventure(page);

  // Rename the planned east neighbor and give it a brief — the edits commit
  // against the live world while the game is paused under the map.
  await openMap(page);
  await page.getByTestId("map-room-2").click();
  const title = page.getByTestId("plan-room-title");
  await expect(title).toHaveValue("The Hall");
  await title.fill("The Gallery");
  await title.press("Tab");
  const brief = page.getByTestId("plan-room-brief");
  await brief.fill("A long gallery of portraits.");
  await brief.press("Tab");
  await expect(page.getByTestId("map-room-2")).toContainText("The Gallery");
  await page.getByTestId("map-close").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);

  // Walk east into the unbuilt room: the just-in-time room turn authors it.
  const input = page.getByTestId("input-line");
  await input.focus();
  if ((await textHook(page)).modal !== null) {
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  }
  await input.fill("east");
  await input.press("Enter");
  await expect(page.getByTestId("agent-panel")).toContainText("authored room 2", {
    timeout: 30_000,
  });
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(2);

  // World state kept the edits: the built node's plan entry still reads The
  // Gallery and its planned exits are the ones the player saw on the map.
  await openMap(page);
  await page.getByTestId("map-room-2").click();
  await expect(page.getByTestId("plan-room-title")).toHaveValue("The Gallery");
  await expect(page.getByTestId("plan-room-brief")).toHaveValue("A long gallery of portraits.");
  await expect(page.getByTestId("map-detail")).toContainText("west");
  await expect(page.getByTestId("map-detail")).toContainText("north");
});

test("the plan surface stays usable on a phone and under reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createAdventure(page);
  await openMap(page);

  // The room list leads on a small screen; the plan editor is reachable.
  await expect(page.getByTestId("map-room-list")).toBeVisible();
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
  await page.screenshot({ path: "test-results/plan-map-phone.png" });
});

test("a running authored game extends from a planned map node", async ({ page }) => {
  // The direct create path plans in the same turn it builds, so the live
  // session's world holds rooms the stub has not authored yet.
  await page.goto("/");
  await openDeveloperActivity(page);
  await page.getByTestId("boot-agent").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-panel")).toContainText("assembled room 1", {
    timeout: 30_000,
  });
  await expect.poll(async () => (await textHook(page)).room, { timeout: 20_000 }).toBe(1);

  await openMap(page);

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
