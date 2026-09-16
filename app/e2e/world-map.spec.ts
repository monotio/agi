import { expect, test, type Page } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "../../test/fixtures.ts";
import {
  cacheGame,
  observe,
  openCardMenu,
  openGameOptions,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";

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
      "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}if(isset(f6)){new.room(2);}return;",
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
  projectId: testProjectId("world-map-fixture"),
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

  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await page.getByTestId("btn-world-plan").click();
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
  await openGameOptions(page, "help-menu");
  const openedAt = Date.now();
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await page.getByTestId("btn-world-plan").click();
  const mapDialog = page.getByTestId("world-map");
  await expect(mapDialog).toBeVisible();
  const openMs = Date.now() - openedAt;
  await expect(page.getByTestId("map-room-list")).toBeVisible();
  // The graph folds closed on small screens; the list stays usable.
  const pane = page.getByTestId("map-graph-pane");
  if (await pane.evaluate((el) => el.classList.contains("closed"))) {
    await page.getByTestId("map-graph-fold").click();
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
  // Read the live marker before the transition: reopening must update a
  // previously evaluated current-room subscription, not retain its first room.
  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("map-room-1")).toHaveClass(/current/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("world-map")).not.toBeVisible();
  // Visit room 2 through the inspector's flag write: logic 1's literal
  // new.room(2) fires, so the journal edge joins the planned and static ones.
  await page.getByTestId("power-up").click();
  await page.getByTestId("inspect-toggle").click();
  await page.keyboard.press("Escape");
  await page.getByTestId("dbg-tab-state").click();
  await page.getByTestId("dbg-flags").locator("button").nth(6).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(2);

  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await page.getByTestId("btn-world-plan").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await expect(page.getByTestId("map-room-2")).toContainText("visited");
  await expect(page.getByTestId("map-room-2")).toHaveClass(/current/);
  await expect(page.getByTestId("map-node-2")).toBeInViewport();
  await page.screenshot({ path: "test-results/world-map-transition.png" });
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

  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await page.getByTestId("btn-world-plan").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  // The scroll canvas opens on the live room, not the world's empty corner.
  await expect(page.getByTestId("map-node-83")).toBeInViewport();

  // Nothing walked yet: only the boot room is observed; every other row is a
  // logic-named candidate, never a claimed route.
  const items = page.locator(".map-list-item");
  await expect.poll(() => items.count(), { timeout: 15_000 }).toBeGreaterThan(10);
  const unvisited = items.filter({ hasNotText: "visited" });
  await expect(unvisited.first()).toContainText("logic");

  // KQ1's courtyard logic encodes the geography: room 2 lies off room 1's
  // left edge (v2==4), room 8 off its right (v2==2), room 16 off its top
  // (v2==1) — the static edges carry those sides and the layout must honor
  // them before any visit.
  const pos = async (room: number) => {
    const t = await page.getByTestId(`map-node-${room}`).getAttribute("transform");
    const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(t ?? "");
    if (!m) throw new Error(`node ${room} has no position`);
    return { x: Number(m[1]), y: Number(m[2]) };
  };
  const [p1, p2, p8, p16] = await Promise.all([pos(1), pos(2), pos(8), pos(16)]);
  expect(p2.x, "room 2 left of room 1").toBeLessThan(p1.x);
  expect(p8.x, "room 8 right of room 1").toBeGreaterThan(p1.x);
  expect(p16.y, "room 16 above room 1").toBeLessThan(p1.y);

  // Edge groups carry native tooltips on a wide invisible hit-path — a
  // labeled static edge spells out which side its logic exits on.
  expect(
    await page
      .locator(".edge-static > title")
      .filter({ hasText: "logic exits off the left edge" })
      .count(),
  ).toBeGreaterThan(0);

  // No two labels share a spot: opposite-direction siblings fan to opposite
  // sides (a reversed edge's perpendicular must not collapse onto its twin),
  // a duplicated fact renders once, and coincident midpoints get a per-pair
  // jitter. On this fixture the result is exact — every label sits alone.
  const labelPos = await page
    .locator(".edge-label")
    .evaluateAll((els) => els.map((e) => `${e.getAttribute("x")},${e.getAttribute("y")}`));
  expect(new Set(labelPos).size).toBe(labelPos.length);
  await page.screenshot({ path: "test-results/world-map-imported.png" });
});

test("opening the map during a walkthrough stops the replay ticks", async ({ page }) => {
  test.skip(Boolean(kq1Missing), kq1Missing || "");
  await page.goto("/");
  await openCardMenu(page, "game-actions-kq1");
  await page.getByTestId("run-walkthrough").click();
  await expect(page.getByTestId("walkthrough-transport")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  await openGameOptions(page, "help-menu");
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

  await openGameOptions(page, "help-menu");
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

  await openGameOptions(page, "help-menu");
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

  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await page.getByTestId("btn-world-plan").click();
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
  projectId: testProjectId("world-map-dense"),
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

  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await page.getByTestId("btn-world-plan").click();
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
    projectId: testProjectId("world-map-empty"),
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

  await openGameOptions(page, "help-menu");
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
  await openGameOptions(page, "help-menu");
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

test("the graph pans in both axes, zooms, and the detail pane dismisses", async ({ page }) => {
  // The 18-room dense plan spreads wide enough to scroll on both axes.
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

  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await page.getByTestId("btn-world-plan").click();
  const scroll = page.getByTestId("map-graph-scroll");
  await expect(scroll).toBeVisible();

  // Zooming in makes the world larger than the pane in both axes.
  const svg = page.getByTestId("map-graph");
  const width0 = Number(await svg.getAttribute("width"));
  await page.getByTestId("map-zoom-in").click();
  await page.getByTestId("map-zoom-in").click();
  await expect.poll(async () => Number(await svg.getAttribute("width"))).toBeGreaterThan(width0);
  const range = await scroll.evaluate((el) => ({
    x: el.scrollWidth - el.clientWidth,
    y: el.scrollHeight - el.clientHeight,
  }));
  expect(range.x, "horizontal scroll range").toBeGreaterThan(0);
  expect(range.y, "vertical scroll range").toBeGreaterThan(0);

  // A background drag pans the view on both axes. The press starts on the
  // world's top-left margin — guaranteed empty at any zoom — and moves
  // toward the corner so the scroll offset grows.
  const box = (await scroll.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 5, box.y + 5, { steps: 4 });
  await page.mouse.up();
  const after = await scroll.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
  expect(after.x).toBeGreaterThan(0);
  expect(after.y).toBeGreaterThan(0);

  // A pan released outside the window must not stay latched: the browser may
  // never deliver the captured pointerup, so a pointermove arriving with no
  // buttons held must end the pan. Simulate exactly that (a real mouse.up
  // would reach the captured element and mask the defect).
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 100, { steps: 2 });
  await expect(scroll).toHaveClass(/panning/);
  await page.evaluate(() => {
    document
      .querySelector("[data-testid=map-graph]")!
      .dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, buttons: 0, clientX: 500, clientY: 500 }),
      );
  });
  await expect(scroll).not.toHaveClass(/panning/);
  await page.mouse.up();

  // Fit returns the whole graph to the pane: both scroll ranges collapse
  // (≤2px slack for integer rounding of the svg size).
  await page.getByTestId("map-zoom-fit").click();
  await expect
    .poll(async () =>
      scroll.evaluate((el) =>
        Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight),
      ),
    )
    .toBeLessThanOrEqual(2);

  // The detail pane dismisses via its close button and via a background click.
  // Picking a room from the list centres the graph on its node.
  await page.getByTestId("map-room-4").click();
  await expect(page.getByTestId("map-detail")).toBeVisible();
  // List selection scrolls the node into view (centred when the scroll range
  // allows it — a node at the world edge clamps to the nearest reach).
  await expect
    .poll(async () => {
      const nb = await page.getByTestId("map-node-4").boundingBox();
      const sb = await scroll.boundingBox();
      if (!nb || !sb) return false;
      return (
        nb.x + nb.width > sb.x &&
        nb.x < sb.x + sb.width &&
        nb.y + nb.height > sb.y &&
        nb.y < sb.y + sb.height
      );
    })
    .toBe(true);

  // Selecting a node is not a layout move; a real drag is.
  const sidecarLayout = () =>
    page.evaluate(
      () =>
        (JSON.parse(localStorage.getItem("monotio_agi.map.world-map-dense") ?? "{}").layout ??
          {}) as Record<string, unknown>,
    );
  const node = page.getByTestId("map-node-4");
  const nb = (await node.boundingBox())!;
  await page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2);
  expect(await sidecarLayout()).not.toHaveProperty("4");
  // The click opened the detail pane, which reshaped the viewport — re-measure.
  await node.scrollIntoViewIfNeeded();
  const nb2 = (await node.boundingBox())!;
  await page.mouse.move(nb2.x + nb2.width / 2, nb2.y + nb2.height / 2);
  await page.mouse.down();
  await page.mouse.move(nb2.x + nb2.width / 2 + 60, nb2.y + nb2.height / 2 + 30, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Object.keys(await sidecarLayout())).toContain("4");

  await page.getByTestId("map-detail-close").click();
  await expect(page.getByTestId("map-detail")).not.toBeVisible();

  // A click on empty graph space (no drag) deselects. Centering scrolled the
  // view; reset to the top-left world margin, which is guaranteed empty.
  await scroll.evaluate((el) => {
    el.scrollLeft = 0;
    el.scrollTop = 0;
  });
  await page.mouse.move(box.x + 3, box.y + 3);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByTestId("map-detail")).not.toBeVisible();
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
    projectId: testProjectId("world-map-perf"),
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
    await openGameOptions(page, "help-menu");
    await page.getByTestId("btn-world-map").click();
    await expect(page.getByTestId("world-map")).toBeVisible();
    await page.getByTestId("btn-world-plan").click();
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

test("a pictured map past the old static cache stays responsive", async ({ page }) => {
  // 140 rooms each drawing their own picture — past the old 128-entry static
  // cache, where read-time renders thrashed the version counter and the map
  // did not display within five seconds.
  const ROOMS = 140;
  const game = createContainer();
  const pic = Uint8Array.of(0xf0, 3, 0xf8, 0, 0, 0xff);
  game.putResource(
    "logic",
    0,
    assembleLogic("if(!isset(f200)){set(f200);accept.input();new.room(1);}return;", {
      dictionary: new Map(),
    }).payload,
  );
  for (let i = 1; i <= ROOMS; i++) {
    game.putResource("picture", i, pic);
    game.putResource(
      "logic",
      i,
      // v0 is selfRoom: room i draws picture i. The literal new.room behind a
      // never-set flag gives the scan a static edge without the room bouncing.
      assembleLogic(
        `load.pic(v0);draw.pic(v0);if(isset(f199)){new.room(${(i % ROOMS) + 1});}return;`,
        { dictionary: new Map() },
      ).payload,
    );
  }
  await page.goto("/");
  await cacheGame(page, {
    projectId: testProjectId("world-map-pictured"),
    title: "Pictured map fixture",
    provider: "stub",
    model: "stub",
    imported: true,
    roomGeneration: false,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);

  const timed = async (fn: () => Promise<unknown>): Promise<number> => {
    const t0 = Date.now();
    await fn();
    return Date.now() - t0;
  };
  const thumbs = page.locator(".map-node .node-thumb");
  const openMap = async () => {
    await openGameOptions(page, "help-menu");
    await page.getByTestId("btn-world-map").click();
    await expect(page.getByTestId("world-map")).toBeVisible();
    await page.getByTestId("btn-world-plan").click();
    await expect(page.getByTestId("world-map")).toBeVisible();
    await expect(thumbs).toHaveCount(ROOMS, { timeout: 5000 });
  };

  const coldMs = await timed(openMap);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("world-map")).not.toBeVisible();
  const warmMs = await timed(openMap);
  const selectMs = await timed(async () => {
    await page.getByTestId("map-room-70").click();
    await expect(page.getByTestId("map-detail")).toContainText("Room 70");
  });

  const info = test.info();
  for (const [name, ms] of [
    ["cold open", coldMs],
    ["warm open", warmMs],
    ["select feedback", selectMs],
  ] as const) {
    info.annotations.push({
      type: `map ${name} (ms, ${ROOMS} pictured rooms, chromium)`,
      description: `${ms}`,
    });
  }
  expect(warmMs).toBeLessThan(2000);
  expect(selectMs).toBeLessThan(1000);
  await page.screenshot({ path: "test-results/world-map-pictured-140.png" });
});
