import { expect, type Locator, type Page } from "@playwright/test";
import type { CachedCartridgeData } from "../src/cartridgeTypes.ts";

export interface AiConfiguration {
  provider: "anthropic" | "openai" | "stub";
  key?: string;
  model?: string;
  budget?: number;
}

/**
 * Shared observation helpers for the e2e proof runs.
 *
 * These specs must never wait on wall-clock sleeps: a fixed `waitForTimeout`
 * is a guess about how fast the machine is, and under load the guess is wrong
 * in the direction that fails the test. Everything here waits on state the app
 * actually publishes — the engine's text hook (rows / modal / textMode /
 * profile / paused), its interpreter cycle counter, the presented-frame
 * counter, and the pixels on the probe canvas.
 */

/** Mirror of window.__AGI_TEXT__ (see app/src/useEngine.ts, TextHook). */
export interface TextHook {
  rows: string[];
  modal: string | null;
  textMode: boolean;
  /** Interpreter profile the engine detected from the shipped AGIDATA.OVL. */
  profile: string | null;
  /** The interpreter is parked between cycles (power-up freeze). */
  paused: boolean;
  /** Interpreter cycles completed; stops advancing while the world is frozen. */
  cycle: number;
  /** Frames presented on the probe canvas; ticks only after pixels are drawn. */
  frame: number;
  /** Interpreter cycle of the newest autosave the HOST stored; -1 for none. */
  autosave: number;
  /** Current room and ego's position, from the worker's cycle heartbeat. */
  room: number;
  egoX: number;
  egoY: number;
}

const EMPTY_HOOK: TextHook = {
  rows: [],
  modal: null,
  textMode: false,
  profile: null,
  paused: false,
  cycle: 0,
  frame: 0,
  autosave: -1,
  room: 0,
  egoX: 0,
  egoY: 0,
};

export async function textHook(page: Page): Promise<TextHook> {
  return page.evaluate(
    (empty) => ({ ...empty, ...((window as any).__AGI_TEXT__ ?? {}) }),
    EMPTY_HOOK,
  );
}

export async function screenText(page: Page): Promise<string> {
  return (await textHook(page)).rows.join("\n");
}

/** One page turn: the canvas hash together with the counters that explain it. */
export interface Probe {
  frame: number;
  cycle: number;
  /** Hash of the whole composed 320x200 frame. */
  hash: number;
  /** Hash of the picture band only (rows 8..175): text rows excluded. */
  picHash: number;
  /** Distinct colours in the whole composed frame. */
  colors: number;
}

/**
 * Read the pixels and the counters in a single evaluate, so a hash can never
 * be attributed to a frame that had not been drawn when it was sampled.
 */
export async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']")!;
    const ctx = c.getContext("2d")!;
    const all = ctx.getImageData(0, 0, 320, 200).data;
    const band = ctx.getImageData(0, 8, 320, 168).data;
    const hashOf = (d: Uint8ClampedArray): number => {
      let h = 0;
      for (let i = 0; i < d.length; i += 16) {
        h = (h * 31 + d[i]! * 65536 + d[i + 1]! * 256 + d[i + 2]!) | 0;
      }
      return h;
    };
    const colors = new Set<string>();
    for (let i = 0; i < all.length; i += 4) colors.add(`${all[i]},${all[i + 1]},${all[i + 2]}`);
    const hook = (window as any).__AGI_TEXT__ ?? {};
    return {
      frame: Number(hook.frame ?? 0),
      cycle: Number(hook.cycle ?? 0),
      hash: hashOf(all),
      picHash: hashOf(band),
      colors: colors.size,
    };
  });
}

export async function canvasHash(page: Page): Promise<number> {
  return (await probe(page)).hash;
}

export async function canvasPicHash(page: Page): Promise<number> {
  return (await probe(page)).picHash;
}

export async function canvasColors(page: Page): Promise<number> {
  return (await probe(page)).colors;
}

/** Wait until the app has presented `n` further frames on the probe canvas. */
export async function waitForFrames(page: Page, n: number, timeout = 15_000): Promise<void> {
  const from = (await probe(page)).frame;
  await expect
    .poll(async () => (await probe(page)).frame, { timeout })
    .toBeGreaterThanOrEqual(from + n);
}

/** Wait until the interpreter has completed `n` further cycles. */
export async function waitForCycles(page: Page, n: number, timeout = 15_000): Promise<void> {
  const from = (await textHook(page)).cycle;
  await expect
    .poll(async () => (await textHook(page)).cycle, { timeout })
    .toBeGreaterThanOrEqual(from + n);
}

/**
 * The frame once the picture has stopped changing: boot and room re-entry
 * draw over several cycles, so a hash sampled at a fixed delay can catch the
 * screen mid-draw and make an "unchanged" comparison order-dependent. Settled
 * means both hashes held still across four consecutive samples (~0.4s of
 * screen time), which is longer than any gap inside a room's draw.
 */
export async function settled(page: Page, timeout = 20_000): Promise<Probe> {
  let last: Probe | null = null;
  let runs = 0;
  await expect
    .poll(
      async () => {
        const now = await probe(page);
        const same = last !== null && last.hash === now.hash && last.picHash === now.picHash;
        runs = same ? runs + 1 : 0;
        last = now;
        return runs;
      },
      { timeout, intervals: [100] },
    )
    .toBeGreaterThanOrEqual(4);
  return last!;
}

/**
 * Wait until the host has STORED an autosave taken after `cycle`.
 *
 * This is the only safe point to reload in a proof run: the worker takes a
 * snapshot on its own cadence, so a reload issued before one has been written
 * would be asserting against whatever the previous snapshot happened to hold.
 * Returns the cycle the stored image was taken at.
 */
export async function waitForAutosaveAfter(
  page: Page,
  cycle: number,
  timeout = 30_000,
): Promise<number> {
  await expect
    .poll(async () => (await textHook(page)).autosave, { timeout })
    .toBeGreaterThan(cycle);
  return (await textHook(page)).autosave;
}

/** The autosave record the host stored for `slug`, straight out of localStorage. */
export async function storedAutosave(
  page: Page,
  slug: string,
): Promise<{ room: number; cycle: number; imageLength: number } | null> {
  return page.evaluate((s) => {
    const raw = localStorage.getItem(`monotio_agi.autosave.${s}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      room: Number(parsed.room),
      cycle: Number(parsed.cycle),
      imageLength: atob(String(parsed.image)).length,
    };
  }, slug);
}

/**
 * An observation window for NEGATIVE assertions ("nothing changed while the
 * world was frozen"). It is measured in the browser's own animation frames
 * rather than in milliseconds: there is nothing to wait FOR when the claim is
 * that no state advances, and a window that stretches under load only makes
 * such an assertion stronger, never flakier.
 */
export async function observe(page: Page, ticks = 45): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let seen = 0;
        const step = (): void => {
          if (++seen >= n) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    ticks,
  );
}

/**
 * Per-test isolation. Playwright gives every test a fresh context, but the
 * dev server is shared and every one of these keys is read back on boot: a
 * save image would let F7 restore someone else's game, a cached cartridge
 * would skip authoring, and a stored transcript would change the agent's
 * first turn. Cleared before any app script runs on the page.
 */
export async function isolateStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      // Once per test, not once per navigation. An init script runs again on
      // every load, and a test that RELOADS the page on purpose (the autosave
      // resume proof) would otherwise wipe the state it is reloading to read.
      // The marker itself is what survives the reload, so the check has to be
      // in localStorage rather than in a page variable.
      if (localStorage.getItem("monotio_agi.e2e.isolated") === "1") return;
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("monotio_agi.e2e.isolated", "1");
    } catch {
      /* a context that blocks storage is already isolated */
    }
  });
}

/** Find one saved-game card by the title visible to the player. */
export function savedGameCard(page: Page, title: string | RegExp): Locator {
  const titlePattern =
    typeof title === "string"
      ? new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)
      : title;
  return page
    .getByTestId("saved-game-gallery")
    .locator("[data-testid^='saved-game-card-']")
    .filter({ has: page.getByTestId("saved-game-title").filter({ hasText: titlePattern }) });
}

/** Open a saved game's native Details disclosure without toggling it closed. */
export async function openSavedGameDetails(card: Locator): Promise<void> {
  const details = card.locator("details[data-testid^='game-details-']");
  if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
}

/** Open the native Create an adventure disclosure without toggling it closed. */
export async function openCreateAdventure(page: Page): Promise<void> {
  const details = page.getByTestId("create-adventure-disclosure");
  if ((await details.getAttribute("open")) === null)
    await page.getByTestId("create-adventure-toggle").click();
}

/** Open the test/developer activity disclosure without toggling it closed. */
export async function openDeveloperActivity(page: Page): Promise<void> {
  const details = page.getByTestId("agent-panel");
  if ((await details.getAttribute("open")) === null)
    await page.getByTestId("developer-activity-summary").click();
}

/** Configure the app-wide AI connection through the same dialog a player uses. */
export async function configureAi(page: Page, configuration: AiConfiguration): Promise<void> {
  await openAiSettings(page);
  const dialog = page.getByTestId("ai-settings-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("provider-select").selectOption(configuration.provider);
  if (configuration.model !== undefined)
    await dialog.getByTestId("model-select").selectOption(configuration.model);
  if (configuration.key !== undefined)
    await dialog.getByTestId("api-key-input").fill(configuration.key);
  if (configuration.budget !== undefined)
    await dialog.getByTestId("task-budget").fill(String(configuration.budget));
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
}

/** Open the single shared connection dialog through Settings. */
export async function openAiSettings(page: Page): Promise<void> {
  const settings = page.getByTestId("settings-menu");
  if ((await settings.getAttribute("aria-expanded")) !== "true") await settings.click();
  await page.getByTestId("open-ai-settings").click();
  await expect(page.getByTestId("ai-settings-dialog")).toBeVisible();
}

/** Saved-game actions live in a popup outside the card's clipping boundary. */
export async function openLibraryActions(page: Page, card: Locator): Promise<void> {
  const trigger = card.getByRole("button", { name: "Game actions", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(page.getByRole("menu", { name: "Game actions", exact: true })).toBeVisible();
}

export async function openLibraryDownload(page: Page, card: Locator): Promise<void> {
  const trigger = card.getByRole("button", { name: "Download", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(page.getByRole("menu", { name: "Download", exact: true })).toBeVisible();
}

/** Open a top-bar disclosure through its visible control without closing it on repeat calls. */
export async function openGameOptions(
  page: Page,
  menu: "save-share-menu" | "sound-display-menu",
): Promise<void> {
  const trigger = page.getByTestId(
    menu === "save-share-menu" ? "download-game-menu" : "settings-menu",
  );
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
}

/** Seed through the production persistence boundary, so fixtures use the release contract. */
export async function cacheGame(
  page: Page,
  game: Omit<CachedCartridgeData, "authoredAt">,
): Promise<void> {
  const { files, ...metadata } = game;
  const saved = await page.evaluate(
    async ({ metadata, files }) => {
      const path = "/src/cartridgeStorage.ts";
      const { saveAuthoredCartridge } = await import(path);
      return saveAuthoredCartridge(metadata.slug, {
        ...metadata,
        files: Object.fromEntries(
          Object.entries(files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
        ),
      });
    },
    {
      metadata,
      files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, [...bytes]])),
    },
  );
  expect(saved).toBe(true);
}
