import { expect, test, type Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "../../test/fixtures.ts";
import { cacheGame, observe, openGameOptions, textHook, waitForCycles } from "./engineProbe.ts";

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

const kq1Missing = fixtureSkip(KNOWN_GAME_HASH.KQ1, ["AGIDATA.OVL"]);

test("an imported game shows its static graph before any visit", async ({ page }) => {
  test.skip(Boolean(kq1Missing), kq1Missing || "");
  await page.goto("/");
  await page
    .locator(`[data-hash="${KNOWN_GAME_HASH.KQ1}"], [data-alias="kq1"], [data-testid="boot-kq1"]`)
    .first()
    .click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });

  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();

  // Nothing walked yet: only the boot room is observed; every other row is a
  // logic-named candidate, never a claimed route.
  const items = page.locator(".map-list-item");
  await expect.poll(() => items.count(), { timeout: 15_000 }).toBeGreaterThan(10);
  const unvisited = items.filter({ hasNotText: "visited" });
  await expect(unvisited.first()).toContainText("logic");
  await page.screenshot({ path: "test-results/world-map-imported.png" });
});

test("opening the map during a walkthrough stops the replay ticks", async ({ page }) => {
  test.skip(Boolean(kq1Missing), kq1Missing || "");
  await page.goto("/");
  await page.getByTestId("game-actions-kq1").click();
  await page.getByTestId("run-walkthrough").click();
  await expect(page.getByTestId("walkthrough-transport")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__AGI_STATE__?.walkthrough.status))
    .toBe("paused");

  // The claim is that replay stops, not that a label says so: hold a real
  // frame window and the virtual tick must not move.
  const frozen = await page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0);
  await observe(page, 60);
  expect(await page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0)).toBe(frozen);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("world-map")).not.toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0), {
      timeout: 15_000,
    })
    .toBeGreaterThan(frozen);
});

test("Watch from here seeks the walkthrough to the room's checkpoint", async ({ page }) => {
  test.skip(Boolean(kq1Missing), kq1Missing || "");
  await page.goto("/");
  await page
    .locator(`[data-hash="${KNOWN_GAME_HASH.KQ1}"], [data-alias="kq1"], [data-testid="boot-kq1"]`)
    .first()
    .click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });

  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();

  // The boot room is observed and the kq1 walkthrough names it ("Title"), so
  // the action resolves against this exact game edition.
  await page.getByTestId("map-room-83").click();
  const watch = page.getByRole("button", { name: /Watch from here/ });
  await expect(watch).toBeVisible({ timeout: 15_000 });
  await watch.click();

  await expect(page.getByTestId("world-map")).not.toBeVisible();
  await expect(page.getByTestId("walkthrough-transport")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => window.__AGI_STATE__?.walkthrough.status))
    .toBe("playing");
});

test("closing the map restores only the pause it owns", async ({ page }) => {
  await bootMapGame(page);
  // Remix (the power-up bubble) holds a pause the map must not release.
  await page.getByTestId("power-up").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);

  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);

  // Escape closes the topmost shell overlay — the map — not the bubble.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("world-map")).not.toBeVisible();
  await expect(page.getByTestId("agent-bubble")).toBeVisible();
  await observe(page, 30);
  expect((await textHook(page)).paused).toBe(true);

  // The bubble's own close is what resumes the game.
  await page.getByTestId("agent-bubble-close").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
});

test("opening and using the map makes no provider request", async ({ page }) => {
  const providerCalls: string[] = [];
  await page.route(/\/api\//, (route) => {
    providerCalls.push(route.request().url());
    return route.abort();
  });
  await bootMapGame(page);
  const traceCount = () =>
    page.evaluate(
      () =>
        (window.__AGI_TRACE__ ?? []).filter(
          (e) => e.kind === "request" || e.kind === "response" || e.kind === "telemetry",
        ).length,
    );
  const before = await traceCount();

  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  const mapDialog = page.getByTestId("world-map");
  await expect(mapDialog).toBeVisible();

  // Use the map: select a room, edit a note, drag a node, reset layout.
  await page.getByTestId("map-room-4").click();
  await expect(page.getByTestId("map-detail")).toContainText("Attic");
  const note = page.getByTestId("map-note");
  if (await note.count()) await note.fill("check the ladder");
  const node = page.getByTestId("map-node-4");
  if (await node.count()) {
    const box = await node.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 10, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + 60, box.y + 40, { steps: 4 });
      await page.mouse.up();
    }
  }
  await page.keyboard.press("Escape");
  await expect(mapDialog).not.toBeVisible();

  expect(providerCalls, "no /api/ request may leave the map").toEqual([]);
  expect(await traceCount()).toBe(before);
});

/** A planned world with a long title and a denser exit web. */
const DENSE_GAME = {
  ...MAP_GAME,
  projectId: "world-map-dense",
  title: "Dense map fixture",
  authoringState: {
    authoring: {
      version: 1,
      bindings: {},
      world: {
        rooms: Object.fromEntries(
          Array.from({ length: 18 }, (_, i) => [
            String(i + 1),
            {
              title:
                i === 3
                  ? "The remarkably long corridor between the northern gallery and the stair"
                  : `Room ${i + 1}`,
              description: "",
              exits:
                i === 0
                  ? { east: 2, north: 5 }
                  : {
                      back: 1,
                      ...(i % 3 === 0 ? { down: ((i + 4) % 18) + 1 } : {}),
                      ...(i % 2 === 0 ? { side: ((i + 7) % 18) + 1 } : {}),
                    },
            },
          ]),
        ),
        facts: {},
        quests: {},
      },
      sources: { logics: [[0, "return;"]] },
    },
  },
};

test("long labels and a dense planned graph stay navigable", async ({ page }) => {
  const game = mapGame();
  await page.goto("/");
  await cacheGame(page, {
    ...DENSE_GAME,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);

  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await expect(page.getByTestId("map-room-4")).toContainText("northern gallery");
  await page.getByTestId("map-room-4").click();
  await expect(page.getByTestId("map-detail")).toContainText("northern gallery");
  await page.screenshot({ path: "test-results/world-map-dense.png" });
});

test("an unexplored game lists only the observed room", async ({ page }) => {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic("if(!isset(f200)){set(f200);accept.input();}return;", {
      dictionary: new Map(),
    }).payload,
  );
  await page.goto("/");
  await cacheGame(page, {
    projectId: "world-map-empty",
    title: "Empty map fixture",
    provider: "stub",
    model: "stub",
    imported: true,
    roomGeneration: false,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(0);

  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  const items = page.locator(".map-list-item");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("visited");
  await page.screenshot({ path: "test-results/world-map-empty.png" });
});

test("reduced motion renders the same map without animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await bootMapGame(page);
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await expect(page.getByTestId("map-room-1")).toContainText("visited");
  // The marker is a static ▶, not a pulse: nothing animates under reduced motion.
  const animating = await page
    .getByTestId("world-map")
    .evaluate((el) =>
      Array.from(el.querySelectorAll("*")).some(
        (n) => getComputedStyle(n).animationName !== "none",
      ),
    );
  expect(animating).toBe(false);
  await page.screenshot({ path: "test-results/world-map-reduced-motion.png" });
});

test("cold open, warm open and select stay fast on the largest synthetic map", async ({ page }) => {
  // 255 logic resources, each naming one literal room target — the largest
  // static graph the resource space supports.
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic("if(!isset(f200)){set(f200);accept.input();}return;", {
      dictionary: new Map(),
    }).payload,
  );
  for (let i = 1; i <= 255; i++) {
    game.putResource(
      "logic",
      i,
      assembleLogic(`if(isset(f200)){new.room(${(i * 7) % 256});}return;`, {
        dictionary: new Map(),
      }).payload,
    );
  }
  await page.goto("/");
  await cacheGame(page, {
    projectId: "world-map-perf",
    title: "Map perf fixture",
    provider: "stub",
    model: "stub",
    imported: true,
    roomGeneration: false,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(0);

  const timed = async (fn: () => Promise<unknown>): Promise<number> => {
    const t0 = Date.now();
    await fn();
    return Date.now() - t0;
  };
  const openMap = async () => {
    await openGameOptions(page, "game-actions-menu");
    await page.getByTestId("btn-world-map").click();
    await expect(page.getByTestId("world-map")).toBeVisible();
    await expect(page.locator(".map-list-item").nth(200)).toBeVisible();
  };

  const coldMs = await timed(openMap);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("world-map")).not.toBeVisible();
  const warmMs = await timed(openMap);
  const selectMs = await timed(async () => {
    await page.getByTestId("map-room-140").click();
    await expect(page.getByTestId("map-detail")).toContainText("Room 140");
  });

  const info = test.info();
  for (const [name, ms] of [
    ["cold open", coldMs],
    ["warm open", warmMs],
    ["select feedback", selectMs],
  ] as const) {
    info.annotations.push({ type: `map ${name} (ms, 256 rooms, chromium)`, description: `${ms}` });
  }
  // Provisional targets: warm open < 200 ms, feedback < 100 ms. The hard bound
  // is a smoke ceiling so the run reports the measured value, not a guess.
  expect(warmMs).toBeLessThan(2000);
  expect(selectMs).toBeLessThan(1000);
  await page.screenshot({ path: "test-results/world-map-dense-256.png" });
});
