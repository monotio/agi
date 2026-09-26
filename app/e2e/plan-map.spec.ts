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
  await openGameOptions(page, "help-menu");
  // The plan surface is the creator entry — "World map" is the player's
  // discovered-rooms view and shows no plan.
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await page.getByTestId("btn-world-plan").click();
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

test("Attach reference art opens the upload over the open world plan", async ({ page }) => {
  await createAdventure(page);
  await openMap(page);
  await page.getByTestId("map-room-1").click();

  // The map is a native modal on the top layer; a plain positioned overlay
  // would land behind it. The upload must be a top-layer dialog itself.
  await page.getByTestId("map-attach-reference").click();
  const upload = page.getByTestId("reference-upload");
  await expect(upload).toBeVisible();
  await expect(page.getByTestId("world-map")).toBeVisible();
  expect(await upload.evaluate((element) => element.matches(":modal"))).toBe(true);
  // Its first control holds focus while the map stays open beneath.
  const uploadClose = upload.getByRole("button", { name: "Close", exact: true });
  await expect(uploadClose).toBeFocused();

  await uploadClose.click();
  await expect(upload).toBeHidden();
  await expect(page.getByTestId("world-map")).toBeVisible();
});

test("the player's world map shows walked rooms only — no plan, no controls", async ({ page }) => {
  await createAdventure(page);
  await expect(page.getByTestId("agent-panel")).toContainText("planned a three-room world", {
    timeout: 30_000,
  });

  // The player entry is the discovered view: room 1 was walked; rooms 2 and
  // 3 exist only in the creator's plan and must not appear — nor may any
  // plan affordance.
  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-world-map").click();
  const map = page.getByTestId("world-map");
  await expect(map).toBeVisible();
  // The plan entry is the in-dialog switch — the player menu carries no
  // creator surface.
  await expect(page.getByTestId("btn-world-plan")).toBeVisible();
  await expect(map).toContainText("World map");
  await expect(page.getByTestId("map-room-1")).toBeVisible();
  await expect(page.getByTestId("map-room-2")).toHaveCount(0);
  await expect(page.getByTestId("map-room-3")).toHaveCount(0);
  await expect(map).not.toContainText("planned");
  await expect(map).not.toContainText("named in logic");
  await expect(page.getByTestId("map-add-room")).toHaveCount(0);
  // Even the visited room's detail carries no plan editor.
  await page.getByTestId("map-room-1").click();
  await expect(page.getByTestId("plan-room-title")).toHaveCount(0);
  await page.screenshot({ path: "test-results/world-map-player.png" });
  await page.getByTestId("map-close").click();

  // The creator entry on the same session shows the full plan.
  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await page.getByTestId("btn-world-plan").click();
  await expect(map).toBeVisible();
  await expect(map).toContainText("World plan");
  await expect(page.getByTestId("map-room-2")).toContainText("The Hall");
  await expect(page.getByTestId("map-room-3")).toContainText("The Vault");
  await expect(page.getByTestId("map-add-room")).toBeVisible();
  await page.screenshot({ path: "test-results/world-map-creator.png" });
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

test("a refused plan write flags unsaved, retains the edit, and Retry lands it", async ({
  page,
}) => {
  // Refuse project-store writes while armed — the flag is a page global, so
  // arming and disarming it needs no app hooks.
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      const w = window as Window & { __agiFailSaves?: boolean };
      if (w.__agiFailSaves && this.name === "projects")
        throw new DOMException("quota", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await createAdventure(page);
  await openMap(page);
  await page.getByTestId("map-room-2").click();
  const title = page.getByTestId("plan-room-title");
  await expect(title).toHaveValue("The Hall");

  // Storage refuses the write: the edit stays in memory, flagged visibly.
  await page.evaluate(() => {
    (window as Window & { __agiFailSaves?: boolean }).__agiFailSaves = true;
  });
  await title.fill("The Gallery");
  await title.press("Tab");
  const flag = page.getByTestId("map-plan-unsaved");
  await expect(flag).toContainText("could not be saved");
  await expect(title).toHaveValue("The Gallery");

  // Close and reopen: the in-memory edit and its flag are still there.
  await page.getByTestId("map-close").click();
  await expect(page.getByTestId("world-map")).toBeHidden();
  await openMap(page);
  await page.getByTestId("map-room-2").click();
  await expect(page.getByTestId("plan-room-title")).toHaveValue("The Gallery");
  await expect(flag).toBeVisible();

  // Retry with healthy storage writes the exact in-memory revision.
  await page.evaluate(() => {
    (window as Window & { __agiFailSaves?: boolean }).__agiFailSaves = false;
  });
  await page.getByTestId("map-plan-retry").click();
  await expect(flag).toBeHidden();
  const stored = await page.evaluate(async () => {
    const { listCachedGames, loadAuthoredGame } = await import("/src/gameStorage.ts");
    const id = listCachedGames()[0]!.projectId;
    const data = await loadAuthoredGame(id);
    const authoring = data?.authoringState?.["authoring"] as
      { world?: { rooms?: Record<string, { title?: string }> } } | undefined;
    return authoring?.world?.rooms?.["2"]?.title ?? null;
  });
  expect(stored).toBe("The Gallery");

  // Across a reload the durable revision is what the session reopens with.
  await page.getByTestId("map-close").click();
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 30_000 });
  await openMap(page);
  await page.getByTestId("map-room-2").click();
  await expect(page.getByTestId("plan-room-title")).toHaveValue("The Gallery");
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

test("a planned exit the source room lacks becomes a real route when built", async ({ page }) => {
  // Room 2's plan edge names north→3; room 2's authored logic has no north
  // route. Building room 3 from the map must rewrite room 2 in the same turn.
  await page.goto("/");
  await openDeveloperActivity(page);
  await page.getByTestId("boot-agent").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-panel")).toContainText("assembled room 1", {
    timeout: 30_000,
  });
  await expect.poll(async () => (await textHook(page)).room, { timeout: 20_000 }).toBe(1);

  const input = page.getByTestId("input-line");
  const say = async (text: string) => {
    await input.focus();
    if ((await textHook(page)).modal !== null) {
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await textHook(page)).modal).toBe(null);
    }
    await input.fill(text);
    await input.press("Enter");
  };

  // Walk east: room 2 authors just-in-time.
  await say("east");
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(2);

  // North is plan intent only — the compiled logic has no such route.
  await say("north");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);

  // Building the planned node rewrites room 2's logic in the same commit.
  await openMap(page);
  await page.getByTestId("map-room-3").click();
  await expect(page.getByTestId("map-detail")).toContainText("planned");
  await page.getByTestId("map-build-room").click();
  await expect(page.getByTestId("agent-panel")).toContainText("authored room 3", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("agent-panel")).toContainText("'north' now reaches room 3", {
    timeout: 15_000,
  });
  await page.getByTestId("map-close").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);

  // Ordinary input now crosses it — no teleport, no host-side rule.
  await say("north");
  await expect.poll(async () => (await textHook(page)).room, { timeout: 20_000 }).toBe(3);

  // The return route the stub authored still works.
  await say("west");
  await expect.poll(async () => (await textHook(page)).room, { timeout: 20_000 }).toBe(2);
});
