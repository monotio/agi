import { expect, type Locator, type Page } from "@playwright/test";
import type { CachedGameData } from "../src/project/gameTypes.ts";

/** Reject the draft's actual background transaction, leaving its recovery journal available. */
export async function refuseDraftWrites(page: Page, message: string): Promise<void> {
  await page.evaluate((message) => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (
        this.name === "projects" &&
        String((args[0] as { projectId?: string }).projectId).startsWith("part-drafts/")
      )
        throw new Error(message);
      return put.apply(this, args);
    };
  }, message);
}

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

/** Mirror of window.__AGI_TEXT__ (see app/src/engine/useEngine.ts, TextHook). */
export interface TextHook {
  rows: string[];
  modal: string | null;
  textMode: boolean;
  /** Interpreter profile the engine detected from the shipped AGIDATA.OVL. */
  profile: string | null;
  /** Detection kind of the interpreter profile: "binary", "catalog", or "default". */
  profileKind: string | null;
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
  profileKind: null,
  paused: false,
  cycle: 0,
  frame: 0,
  autosave: -1,
  room: 0,
  egoX: 0,
  egoY: 0,
};

export async function textHook(page: Page): Promise<TextHook> {
  return page.evaluate((empty) => ({ ...empty, ...(window.__AGI_TEXT__ ?? {}) }), EMPTY_HOOK);
}

/** The async play surface has mounted and owns the player's keyboard. */
export async function waitForGameInput(page: Page): Promise<void> {
  const command = page.getByRole("textbox", { name: "Game command", exact: true });
  await expect(command).toBeVisible();
  await expect(command).toBeEnabled();
  await expect(command).toBeFocused();
  await expect.poll(async () => page.evaluate(() => window.__AGI_STATE__?.inputReady)).toBe(true);
}

/** Keyboard ownership and host activity alongside the worker heartbeat. */
export async function gameInputProbe(page: Page) {
  return page.evaluate(() => {
    const state = window.__AGI_STATE__;
    const active = document.activeElement;
    return {
      engine: window.__AGI_TEXT__,
      focused: active
        ? { tag: active.tagName, label: active.getAttribute("aria-label"), id: active.id }
        : null,
      phase: state?.phase,
      inputReady: state?.inputReady,
      inputEnabled: state?.inputEnabled,
      waitingForKey: state?.waitingForKey,
      prompt: state?.prompt,
      paused: state?.paused,
      hostRequests: state?.agentLog.filter(
        (entry) => entry.kind === "request" || entry.kind === "response",
      ),
      agentTask: state?.agentTask,
    };
  });
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
    const hook = window.__AGI_TEXT__;
    return {
      frame: hook?.frame ?? 0,
      cycle: hook?.cycle ?? 0,
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
 * A cold Vite dev server transforms and serves the boot's whole module graph
 * on first request, so the first game boot of a run — and any fresh page load
 * or deep link — can sit far past the settled-state poll before room 1 shows.
 */
const COLD_BOOT_BUDGET_MS = 30_000;

/**
 * Wait until the engine reports `room`. `coldBoot` spends the cold-boot
 * budget on a wait that covers a fresh boot; a warm room change keeps the
 * default poll budget.
 */
export async function waitForRoom(
  page: Page,
  room: number,
  options?: { coldBoot?: boolean },
): Promise<void> {
  await expect
    .poll(
      async () => (await textHook(page)).room,
      options?.coldBoot === true ? { timeout: COLD_BOOT_BUDGET_MS } : {},
    )
    .toBe(room);
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

/** The autosave record the host stored for `gameKey`, straight out of localStorage. */
/** The live storage address bound to a saved body or a served fixture. */
export async function progressStorageKey(page: Page, gameKey: string): Promise<string> {
  return page.evaluate(async (key) => {
    const bindingPath = "/src/project/progressBinding.ts";
    const { bindSavedProgressTarget } = await import(/* @vite-ignore */ bindingPath);
    const saved = await bindSavedProgressTarget(key);
    if (saved) return saved.locator;
    const discoveryPath = "/src/library/gameDiscovery.ts";
    const metadataPath = "/src/project/gameMetadata.ts";
    const targetPath = "/src/project/progressTarget.ts";
    const { fetchFixtureFiles } = await import(/* @vite-ignore */ discoveryPath);
    const { gameRevision } = await import(/* @vite-ignore */ metadataPath);
    const { installedProgressLocator } = await import(/* @vite-ignore */ targetPath);
    return installedProgressLocator(key, await gameRevision(await fetchFixtureFiles(key)))!;
  }, gameKey);
}

export async function storedAutosave(
  page: Page,
  gameKey: string,
): Promise<{ room: number; cycle: number; imageLength: number } | null> {
  const locator = await progressStorageKey(page, gameKey);
  return page.evaluate((key) => {
    const raw = localStorage.getItem(`monotio_agi.autosave.${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      room: Number(parsed.room),
      cycle: Number(parsed.cycle),
      imageLength: atob(String(parsed.image)).length,
    };
  }, locator);
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
 * save image would let F7 restore someone else's game, a cached game
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
  // A stored game's card carries its project id; the tutorial's stored copy is
  // the tutorial's own card, so it is found here too.
  return page
    .getByTestId("saved-game-gallery")
    .locator("[data-project-id]")
    .filter({ has: page.getByTestId("saved-game-title").filter({ hasText: titlePattern }) });
}

/** Open a saved game's Details dialog from its ⋯ menu; returns the open dialog. */
export async function openSavedGameDetails(card: Locator): Promise<Locator> {
  const page = card.page();
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("game-details-item")
    .click();
  const dialog = page.locator("dialog[data-testid^='game-details-']");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Open the new game page on its AI starting point. */
export async function openCreateAdventure(page: Page): Promise<void> {
  const details = page.getByTestId("create-adventure-disclosure");
  if ((await details.getAttribute("open")) === null)
    await page.getByTestId("create-adventure-toggle").click();
  await page.getByTestId("local-create-kind-ai").click();
}

/**
 * Open Developer activity, which no screen keeps on the page: Settings →
 * Advanced opens it — as a dialog, or as Create's Activity tab on a desktop.
 * A panel already showing stays as it is.
 */
export async function openDeveloperActivity(page: Page): Promise<void> {
  const panel = page.getByTestId("agent-panel");
  if (await panel.isVisible()) return;
  await openGameOptions(page, "settings-menu");
  const advanced = page.getByTestId("settings-advanced");
  if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
  await page.getByTestId("settings-developer-activity").click();
  await expect(panel).toBeVisible();
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
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click({ trial: true, timeout: 5000 });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(page.getByRole("menu", { name: "Game actions", exact: true })).toBeVisible();
}

/**
 * Open a game card's action menu. Cards can sit deep in the library: the
 * trigger's scroll-into-view plus scroll-anchored layout shifts can still be
 * settling as the menu opens. Check its actionability before opening it so
 * movement during the scroll cannot close the menu mid-click.
 */
export async function openCardMenu(page: Page, testId: string): Promise<void> {
  const trigger = page.getByTestId(testId);
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click({ trial: true, timeout: 5000 });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
}

/**
 * The Home shelf shows one card per game: an installed development copy of
 * the tutorial folds into the tutorial's card, and its boot control (with the
 * usual data-hash, data-alias and boot-* hooks) is an item in that card's ⋯
 * menu. Open the menu before looking for the control; other games keep theirs
 * on their own cards.
 */
export async function revealFoldedBoot(page: Page, alias: string): Promise<void> {
  if (alias === "adventure-department")
    await openCardMenu(page, "game-actions-adventure-department");
}

/**
 * Click a transport timeline marker. Markers are visual-only (dense checkpoint
 * clusters overlap beyond DOM hit-testing), so the pointer clicks the marker's
 * position on the timeline and the transport resolves the nearest mark — the
 * same path a user's click takes.
 */
export async function clickTimelineMark(page: Page, marker: Locator): Promise<void> {
  const box = await marker.boundingBox();
  if (!box) throw new Error("Timeline marker is not visible");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Open a top-bar surface through its trigger without closing it on repeat calls.
 * `help-menu` holds the Help guide, Game controls and the walkthrough;
 * `settings-menu` opens the settings sheet: sound, display, input and AI
 * settings, this game's edit, download and export actions, and Start over.
 */
export async function openGameOptions(
  page: Page,
  menu: "help-menu" | "settings-menu",
): Promise<void> {
  const trigger = page.getByTestId(menu);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
}

/** Open the Game controls dialog through the Help menu. */
export async function openGameControls(page: Page): Promise<void> {
  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-game-controls").click();
  await expect(page.getByTestId("game-controls")).toBeVisible();
}

/** Open the world map from the top bar; pass "create" to land on the plan view. */
export async function openWorldMap(
  page: Page,
  experience: "play" | "create" = "play",
): Promise<void> {
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  if (experience === "create") await page.getByTestId("btn-world-plan").click();
}

/**
 * Turn the inspector on through Settings > Advanced (Play mode keeps the
 * whole stage for the game) and close the sheet again.
 */
export async function openInspector(page: Page): Promise<void> {
  await enterPlayMode(page);
  await openGameOptions(page, "settings-menu");
  const advanced = page.getByTestId("settings-advanced");
  if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
  const inspect = page.getByTestId("settings-inspect");
  if ((await inspect.getAttribute("aria-checked")) !== "true") await inspect.click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("debug-dock")).toBeVisible();
}

/**
 * Show the running game in Create mode, where the assistant's Ask and Remix
 * surface (the `power-up` entry) lives. Play mode offers the Ask drawer only.
 */
/**
 * Show one room's card in Create's World panel as a user does: back to All
 * rooms when another card shows (entering Create shows the player's room),
 * then the room's row.
 */
export async function openWorldRoom(panel: Locator, room: number): Promise<void> {
  const back = panel.getByTestId("world-all-rooms");
  await expect(async () => {
    if (await back.isVisible()) await back.click();
    await panel.getByTestId(`map-room-${room}`).click({ timeout: 2_000 });
  }).toPass();
  await expect(panel.getByTestId("map-detail")).toHaveAttribute("data-room", String(room));
}

/** Open a room's real PICTURE through the workspace parts list. */
export async function openWorkspacePicture(
  page: Page,
  room: number,
  showGame = true,
): Promise<Locator> {
  await enterCreateMode(page);
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
  await page.locator(`[data-testid^="part-room:${room}:picture:"]`).first().click();
  if (showGame && (await show.isVisible())) await show.click();
  if (
    !showGame &&
    (await page.getByTestId("workspace-focus").getAttribute("aria-pressed")) === "false"
  )
    await page.getByTestId("workspace-focus").click();
  const studio = page.getByTestId("room-studio").filter({ visible: true });
  await expect(studio).toBeVisible();
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  return studio;
}

/** Open a VIEW beside MAIN through the workspace parts list. */
export async function openWorkspaceView(
  page: Page,
  view: number,
  showGame = true,
): Promise<Locator> {
  await enterCreateMode(page);
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
  await page.getByTestId(`part-view:${view}`).click();
  if (showGame && (await show.isVisible())) await show.click();
  if (
    !showGame &&
    (await page.getByTestId("workspace-focus").getAttribute("aria-pressed")) === "false"
  )
    await page.getByTestId("workspace-focus").click();
  const studio = page.getByTestId("sprite-studio").filter({ visible: true });
  await expect(studio).toBeVisible();
  await studio.getByTestId("sprite-stage").focus();
  return studio;
}

/** Close the selected editor tab while keeping MAIN running. */
export async function closeWorkspaceEditor(page: Page): Promise<void> {
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
  const tab = page.getByRole("tab", { selected: true });
  await tab
    .locator("..")
    .getByRole("button", { name: /^Close / })
    .click();
}

/** Observe durable editor drafts and accepted project writes. */
export async function workspaceSaved(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const probe = window as unknown as {
            __AGI_PROJECT__: {
              getSession(): { saveStatus(): { state: string; message: string } } | undefined;
            };
          };
          const status = probe.__AGI_PROJECT__.getSession()?.saveStatus();
          return status?.state === "failed" || status?.state === "conflict"
            ? status.message
            : status?.state;
        }),
      { intervals: [100] },
    )
    .toBe("saved");
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  await page.evaluate(async () => {
    const probe = window as unknown as {
      __AGI_PROJECT__: { getSession(): { flush(): Promise<void> } };
    };
    await probe.__AGI_PROJECT__.getSession().flush();
  });
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
}

/** The approved storyboard replaces gesture publication with an explicit Update game. */
export async function workspaceUpdated(page: Page, keyboard = false): Promise<void> {
  await workspaceSaved(page);
  const update = page.getByTestId("workspace-update");
  if ((await update.isVisible()) && (await update.isEnabled())) {
    const previousFocus = await page.evaluateHandle(() => document.activeElement);
    await expect(update).toBeVisible();
    if (keyboard) await page.keyboard.press("ControlOrMeta+Enter");
    else await update.click();
    await expect(page.getByTestId("workspace-updated")).toBeVisible();
    await workspaceSaved(page);
    await previousFocus.evaluate((element) => {
      if (element instanceof HTMLElement && element.isConnected) element.focus();
    });
    await previousFocus.dispose();
  }
}

export async function enterCreateMode(page: Page): Promise<void> {
  const create = page.getByRole("radio", { name: "Create", exact: true });
  if ((await create.getAttribute("aria-checked")) !== "true") await create.click();
  await expect(create).toHaveAttribute("aria-checked", "true");
  await expect(page).toHaveURL(/#create\//);
}

/** Open the Create assistant through its registered workspace command. */
export async function openWorkspaceAgent(page: Page): Promise<void> {
  await enterCreateMode(page);
  const panel = page.getByTestId("workspace-agent-panel").or(page.getByTestId("agent-bubble"));
  if (await panel.isVisible()) return;
  await page.getByTestId("workspace-agent").click();
  await expect(panel).toBeVisible();
}

/** Developer activity remains published while its dialog is closed. */
export async function agentActivity(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __AGI_STATE__: { agentLog: { kind: string; detail: string }[] };
      }
    ).__AGI_STATE__;
    return state.agentLog.map((entry) => `[${entry.kind}] ${entry.detail}`).join("\n");
  });
}

/** Return to the full game before opening player tools. */
export async function enterPlayMode(page: Page): Promise<void> {
  const play = page.getByRole("radio", { name: "Play", exact: true });
  if ((await play.getAttribute("aria-checked")) !== "true") await play.click();
  await expect(play).toHaveAttribute("aria-checked", "true");
  await expect(page).toHaveURL(/#play\//);
}

/** Seed through the production persistence boundary, so fixtures use the release contract. */
export async function cacheGame(
  page: Page,
  game: Omit<CachedGameData, "authoredAt">,
): Promise<void> {
  const { files, ...metadata } = game;
  const saved = await page.evaluate(
    async ({ metadata, files }) => {
      const path = "/src/project/gameStorage.ts";
      const { saveAuthoredGame } = await import(path);
      return saveAuthoredGame(metadata.projectId, {
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
  // The save pulled the storage modules in through a dynamic import. A reload
  // that cancels those requests mid-flight can make WebKit fail the next
  // page's module loads outright, so callers reload only once they settle.
  await page.waitForLoadState("networkidle");
}

/** Visibility selection and measurement share one DOM read across the GPU handoff. */
export async function surfaceBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.locator(".game-surface").evaluateAll((surfaces) => {
    const boxes = surfaces
      .map((surface) => surface.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    if (boxes.length !== 1)
      throw new Error(`Expected one visible game surface; found ${boxes.length}.`);
    const { x, y, width, height } = boxes[0]!;
    return { x, y, width, height };
  });
}

/** Situation hints live in the key help bubble, opened without moving game focus. */
export async function gameHint(page: Page, id: string): Promise<Locator> {
  const status = page.getByTestId("game-keys");
  await expect(status).toBeVisible();
  await status.hover();
  await expect(page.getByTestId("game-key-help")).toBeVisible();
  return page.getByTestId(id);
}
