import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { testProjectId } from "../test/identity.ts";
import {
  cacheGame,
  isolateStorage,
  openGameOptions,
  textHook,
  waitForAutosaveAfter,
  waitForCycles,
  waitForRoom,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

/**
 * The 1.1 shell: a loaded game is shown in Play or Create, the URL names the
 * mode, Back and Forward move between them, and the stage gives the game the
 * largest whole multiple of its 320×200 frame that fills most of the space,
 * or else the largest fit (viewportLayout.ts).
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function bootTutorial(page: Parameters<typeof textHook>[0]): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
}

const surfaceBox = async (page: Parameters<typeof textHook>[0]) =>
  (await page.locator(".game-surface:visible").boundingBox())!;

test("Play fits the game to a whole multiple of the frame and the Ask drawer resizes it", async ({
  page,
}) => {
  await bootTutorial(page);
  // 900 rows less the 52 px bar and the 48 px strip leave exactly 800: 4×.
  expect(await surfaceBox(page)).toMatchObject({ width: 1280, height: 800 });
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("toggle-original-aspect").click();
  // 4:3 needs 240 rows per step: 800 rows hold 3× (960×720).
  await expect.poll(async () => (await surfaceBox(page)).width).toBe(960);
  expect((await surfaceBox(page)).height).toBe(720);
  await page.getByTestId("toggle-original-aspect").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-menu")).toBeFocused();

  // Ask is a non-modal drawer: the game stays visible beside it at 3×, and
  // Play offers no Remix.
  const ask = page.getByTestId("menu-assistant");
  await ask.click();
  const drawer = page.getByTestId("agent-bubble");
  await expect(drawer).toBeVisible();
  await expect(ask).toHaveAttribute("aria-expanded", "true");
  await expect(drawer.getByTestId("agent-mode-remix")).toHaveCount(0);
  await expect(drawer.getByTestId("btn-record-test")).toHaveCount(0);
  // The strip's Ask button steps away while the drawer is open; the drawer
  // itself says how to get back.
  await expect(drawer.getByTestId("agent-bubble-esc")).toHaveText("Esc");
  await expect(drawer.getByTestId("agent-bubble-close")).toBeVisible();
  await expect.poll(async () => (await surfaceBox(page)).width).toBe(960);
  const game = await surfaceBox(page);
  const side = (await drawer.boundingBox())!;
  expect(game.x + game.width).toBeLessThanOrEqual(side.x);
  await drawer.getByTestId("agent-bubble-close").click();
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId("input-line")).toBeFocused();
  await expect.poll(async () => (await surfaceBox(page)).width).toBe(1280);
});

/** Pairs of top-bar controls whose boxes overlap, and how wide the bar is laid out. */
async function topBar(page: Parameters<typeof textHook>[0]) {
  return page.getByRole("navigation", { name: "App options" }).evaluate((nav) => {
    const boxes = [...nav.querySelectorAll("button, h1, [data-testid='play-room']")]
      .map((element) => ({
        name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
        box: element.getBoundingClientRect(),
      }))
      .filter(({ box }) => box.width > 0);
    const overlaps: string[] = [];
    for (const [i, a] of boxes.entries())
      for (const b of boxes.slice(i + 1))
        if (
          a.box.left < b.box.right &&
          b.box.left < a.box.right &&
          a.box.top < b.box.bottom &&
          b.box.top < a.box.bottom
        )
          overlaps.push(`${a.name} × ${b.name}`);
    return { overlaps, width: nav.getBoundingClientRect().width, controls: boxes.length };
  });
}

test("Play shows the game and its bar only; Developer activity opens from Settings → Advanced", async ({
  page,
}) => {
  await bootTutorial(page);
  // The tutorial registers no menu, so the key help does not offer Esc for one.
  await expect(page.locator("#game-input-help")).toContainText("Arrows or numpad walk");
  await expect(page.locator("#game-input-help")).not.toContainText("game menu");
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() => page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight))
      .toBeLessThanOrEqual(0);
  }
  await expect(page.getByTestId("developer-activity-summary")).toHaveCount(0);
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("settings-advanced").click();
  await page.getByTestId("settings-developer-activity").click();
  const sheet = page.getByTestId("developer-activity-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Developer activity" })).toBeVisible();
  await expect(sheet.getByTestId("agent-panel")).toBeVisible();
  await expect(sheet.getByTestId("gpu-backend")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("settings-menu")).toBeFocused();
});

test("short windows fit the whole game under the bar and the top bar never overlaps", async ({
  page,
}) => {
  await bootTutorial(page);
  // 800×600 leaves 800×465 under the bar and the two-row strip: 465 rows fit
  // 744 wide, which 2× (640) would fill only (640/744)² = 74% of, so the
  // screen takes the whole fit; below 2× it fits the stage fluidly at its
  // exact aspect (844×390), so the game and its input line stay in view with
  // nothing scrolled under the bar.
  for (const [width, height, screenWidth] of [
    [800, 600, 744],
    [844, 390, null],
  ] as const) {
    await page.setViewportSize({ width, height });
    if (screenWidth)
      await expect.poll(async () => (await surfaceBox(page)).width).toBe(screenWidth);
    else await expect.poll(async () => (await surfaceBox(page)).width).toBeLessThan(640);
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const body = document.querySelector(".shell-body")!;
      return {
        bar: rect(".play-bar").bottom,
        strip: rect(".play-strip"),
        shell: rect(".shell").bottom,
        scrollY: window.scrollY,
        bodyOverflow: body.scrollHeight - body.clientHeight,
      };
    });
    const screen = await surfaceBox(page);
    expect(screen.width / screen.height).toBeCloseTo(1.6, 3);
    expect(screen.y).toBeGreaterThanOrEqual(layout.bar);
    expect(screen.y + screen.height).toBeLessThanOrEqual(layout.strip.top);
    expect(layout.strip.bottom).toBeLessThanOrEqual(height);
    expect(layout.shell).toBeLessThanOrEqual(height);
    expect(layout.scrollY).toBe(0);
    expect(layout.bodyOverflow).toBe(0);
    const bar = await topBar(page);
    expect(bar.overlaps).toEqual([]);
    expect(bar.controls).toBeGreaterThanOrEqual(6);
    expect(bar.width).toBeGreaterThan(width - 40);
  }
  // Touch layouts keep the landscape rules: the pad beside the screen, which
  // is sized from the stable viewport so the page does not scroll.
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("toggle-touch-controls").click();
  await page.keyboard.press("Escape");
  const pad = page.getByTestId("touch-controls");
  await expect(pad).toBeVisible();
  // The stage row: 390 - 52 bar - 6 top padding - 8 row gap - 48 strip = 276
  // rows, narrower than its column, so the width is 276 × 1.6 = 441.6.
  await expect.poll(async () => (await surfaceBox(page)).width).toBeCloseTo(441.6, 1);
  const screen = await surfaceBox(page);
  const padBox = (await pad.boundingBox())!;
  expect(padBox.width).toBe(220);
  expect(padBox.x).toBeGreaterThanOrEqual(screen.x + screen.width);
  expect(padBox.x + padBox.width).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBe(390);
  expect((await topBar(page)).overlaps).toEqual([]);
});

test("a game started from the keyboard takes the keyboard", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  const play = page.getByTestId("hero-primary");
  await expect(play).toBeEnabled();
  await play.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.getByTestId("input-line")).toBeFocused();
});

test("reduced motion: the shell neither animates nor scrolls smoothly", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, { __scrollBehaviors: calls });
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
      calls.push(typeof arg === "object" ? (arg.behavior ?? "auto") : "auto");
      scroll.call(this, arg);
    };
  });
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("create-adventure-toggle").click();
  await expect(page.getByTestId("create-adventure-disclosure")).toHaveAttribute("open");
  const behaviors = () =>
    page.evaluate(() => (window as unknown as { __scrollBehaviors: string[] }).__scrollBehaviors);
  await expect.poll(async () => (await behaviors()).length).toBeGreaterThan(0);
  expect(await behaviors()).not.toContain("smooth");
  await page.keyboard.press("Escape");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  // Scoped component animations too: the key hint's settle, the resume caption.
  const animated = await page
    .locator(".app-container")
    .evaluate((root) =>
      [...root.querySelectorAll("*")]
        .filter((element) => getComputedStyle(element).animationName !== "none")
        .map((element) => element.className.toString()),
    );
  expect(animated).toEqual([]);
});

test("Create is a route: Back and Forward switch modes and a reload keeps Create", async ({
  page,
}) => {
  await bootTutorial(page);
  const play = page.getByRole("radio", { name: "Play", exact: true });
  const create = page.getByRole("radio", { name: "Create", exact: true });
  await expect(page).toHaveURL(/#play\/[^/]+$/);
  const target = new URL(page.url()).hash.slice("#play/".length);

  await create.click();
  await expect(page).toHaveURL(new RegExp(`#create/${target}$`));
  await expect(page.getByTestId("parts-list")).toBeVisible();
  // The catalog tutorial is read-only: the first edit forks a remix.
  await expect(page.getByTestId("workspace-agent")).toBeVisible();
  await expect(page.getByTestId("menu-assistant")).toHaveCount(0);
  // The same live stage sits in the centre: the game keeps running.
  const cycle = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#play/${target}$`));
  await expect(play).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("parts-list")).toHaveCount(0);
  await expect(page.getByTestId("input-line")).toBeFocused();
  await page.goForward();
  await expect(create).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("parts-list")).toBeVisible();

  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await page.reload();
  await waitForRoom(page, 1, { coldBoot: true });
  await expect(page).toHaveURL(new RegExp(`#create/${target}$`));
  await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("keys typed on the shell chrome never reach the game's parser", async ({ page }) => {
  await bootTutorial(page);
  const input = page.getByTestId("input-line");
  await page.getByRole("radio", { name: "Play", exact: true }).focus();
  await page.keyboard.type("look");
  await expect(input).toHaveValue("");
  expect((await textHook(page)).rows.join(" ")).not.toContain("look");
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await page.getByTestId("part-room:1").focus();
  await page.keyboard.type("look");
  await expect(input).toHaveValue("");
  // Back in Play, the keyboard belongs to the game again.
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect(input).toBeFocused();
  await page.keyboard.type("look");
  await expect(input).toHaveValue("look");
});

test("a cold deep link boots the stored game it names, or says it is not in this browser", async ({
  page,
}) => {
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic("if(!isset(f200)){set(f200);accept.input();new.room(1);}return;", {
      dictionary: new Map(),
    }).payload,
  );
  game.putResource(
    "logic",
    1,
    assembleLogic("if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}return;", {
      dictionary: new Map(),
    }).payload,
  );
  const projectId = testProjectId("deep-link-fixture");
  await isolateStorage(page);
  await page.goto("/");
  // Stored in this browser, never played: there is no autosave to resume.
  await cacheGame(page, {
    projectId,
    title: "Deep link fixture",
    provider: "stub",
    model: "stub",
    imported: false,
    roomGeneration: true,
    files: Object.fromEntries(game.files),
    words: [],
  });

  // Cold loads, as a link opened in a new tab: nothing of the page survives.
  await page.goto("about:blank");
  await page.goto(`/#create/${projectId}`);
  await waitForRoom(page, 1, { coldBoot: true });
  await expect(page).toHaveURL(new RegExp(`#create/${projectId}$`));
  await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // A link to a game this browser does not hold lands on Home and says so.
  await page.goto("about:blank");
  await page.goto("/#play/not-in-this-browser");
  const note = page.getByTestId("route-note");
  await expect(note).toHaveText("That game isn't in this browser.");
  await expect(page.getByTestId("hero-primary")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
});

/**
 * Pairs of the play strip's visible pieces that print over each other: the
 * hint's text lines (a line that wraps or overflows included) against every
 * transport control, and the Ask button.
 */
async function stripOverlaps(page: Parameters<typeof textHook>[0]): Promise<string[]> {
  return page.locator(".play-strip:visible").evaluate((strip) => {
    const text = [...strip.querySelectorAll(".play-hints .input-help, .play-hints .caption")]
      .flatMap((hint) => {
        const range = document.createRange();
        range.selectNodeContents(hint);
        return [...range.getClientRects()];
      })
      .filter((box) => box.width > 0 && box.height > 0);
    const controls = [
      ...strip.querySelectorAll<HTMLElement>(
        ".transport button, .transport [role='slider'], .ask-button",
      ),
    ]
      .map((element) => ({
        name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
        box: element.getBoundingClientRect(),
      }))
      .filter(({ box }) => box.width > 0);
    const overlaps: string[] = [];
    for (const line of text)
      for (const { name, box } of controls)
        if (
          line.left < box.right &&
          box.left < line.right &&
          line.top < box.bottom &&
          box.top < line.bottom
        )
          overlaps.push(`hint × ${name}`);
    const right = strip.getBoundingClientRect().right;
    for (const line of text) if (line.right > right + 0.5) overlaps.push("hint past the strip");
    return [...new Set(overlaps)];
  });
}

test("the strip's key hint never prints over the transport, and Create's stage fills its column", async ({
  page,
}) => {
  await bootTutorial(page);
  for (const mode of ["Play", "Create"] as const) {
    const radio = page.getByRole("radio", { name: mode, exact: true });
    if ((await radio.getAttribute("aria-checked")) !== "true") await radio.click();
    for (const [width, height] of [
      [1024, 600],
      [1100, 700],
      [1180, 560],
      [1280, 720],
      [1366, 768],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      if (mode === "Play") {
        await expect
          .poll(() => stripOverlaps(page), { message: `${mode} at ${width}×${height}` })
          .toEqual([]);
        await expect(page.locator("#game-input-help:visible")).toHaveCount(1);
      } else {
        await expect(page.locator(".play-strip")).toBeHidden();
        await expect(page.locator(".game-surface:visible")).toBeInViewport();
      }
    }
  }
  // At 1440×900, the 252 px parts list leaves an 1188 px game column.
  // The screen fills that column at its 320×200 aspect.
  await expect.poll(async () => (await surfaceBox(page)).width).toBe(1188);
  expect((await surfaceBox(page)).height).toBe(742.5);
});
