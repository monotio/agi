import { expect, test, type Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import {
  cacheGame,
  isolateStorage,
  observe,
  openGameOptions,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";

test.use({ headless: process.platform !== "darwin" });

/**
 * The history transport's proof fixture: an authored two-room game that
 * draws a picture in each room (so every visited position is a resumable
 * boundary) and crosses between them on flag writes — f6 into room 2,
 * f201 back to room 1.
 */
function tapeGame() {
  const pic = (n: number) =>
    Uint8Array.of(0xf0, 1, 0xf6, 10, 10, 100, 10, 100, 40, 10, 40, 10, 10, 0xf1, n, 0xf3, 0xff);
  const game = createContainer();
  game.putResource("picture", 1, pic(1));
  game.putResource("picture", 2, pic(2));
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
  game.putResource(
    "logic",
    2,
    assembleLogic(
      "if(!isset(f5)){set(f5);load.pic(v0);draw.pic(v0);show.pic();}if(isset(f201)){reset(f201);new.room(1);}return;",
      { dictionary: new Map() },
    ).payload,
  );
  return game;
}

async function bootTapeGame(page: Page): Promise<void> {
  const game = tapeGame();
  await page.goto("/");
  await cacheGame(page, {
    projectId: "history-transport-fixture",
    title: "Tape fixture",
    provider: "stub",
    model: "stub",
    imported: false,
    roomGeneration: true,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
}

/** The inspector's flag write — the same drive the world-map spec uses. */
async function writeFlag(page: Page, flag: number): Promise<void> {
  await page.getByTestId("power-up").click();
  await page.getByTestId("inspect-toggle").click();
  await page.keyboard.press("Escape");
  await page.getByTestId("dbg-tab-state").click();
  await page.getByTestId("dbg-flags").locator("button").nth(flag).click();
  // The flag button keeps focus; a later Space would re-click it instead of
  // toggling tape playback.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

interface ViewState {
  active: boolean;
  loading: boolean;
  seeking: boolean;
  playing: boolean;
  segment: number;
  tick: number;
  totalTicks: number;
  room: number;
  canResume: boolean;
  retained: boolean;
  diverged: { tick: number; detail: string } | null;
}

async function viewState(page: Page): Promise<ViewState | null> {
  return page.evaluate(() => (window.__AGI_STATE__?.historyView ?? null) as ViewState | null);
}

/** Open the transport through the same menu item a player uses. */
async function openLookBack(page: Page): Promise<void> {
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-look-back").click();
  await expect(page.getByTestId("history-transport")).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await viewState(page))?.active).toBe(true);
}

test("look back pauses live, scrubs and watches the tape, and Escape returns to live", async ({
  page,
}) => {
  await isolateStorage(page);
  await bootTapeGame(page);

  // A second room on the tape: f6 fires logic 1's literal new.room(2).
  await writeFlag(page, 6);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await waitForCycles(page, 3);

  await openLookBack(page);
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  await expect(page.getByTestId("history-pos")).toContainText("Room 2");
  await expect(page.locator(".history-marker").first()).toBeVisible();

  // Scrub back: a click near the timeline's start lands near the boot.
  const before = (await viewState(page))!;
  const timeline = page.getByTestId("history-timeline");
  const box = (await timeline.boundingBox())!;
  await timeline.click({ position: { x: box.width * 0.05, y: box.height / 2 } });
  await expect
    .poll(async () => (await viewState(page))!.tick)
    .toBeLessThan(Math.max(1, before.tick / 2));
  const rewound = (await viewState(page))!;
  expect(rewound.room, "the early tape sits before room 2").toBeLessThanOrEqual(1);

  // Watch: play advances the tape on its own clock; Space pauses it.
  await page.keyboard.press(" ");
  await expect.poll(async () => (await viewState(page))!.tick).toBeGreaterThan(rewound.tick);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await viewState(page))?.playing).toBe(false);

  // The parked live session never moved while the tape played.
  const liveCycles = (await textHook(page)).cycle;
  await observe(page, 30);
  expect((await textHook(page)).cycle, "the live engine stays parked").toBe(liveCycles);

  // Escape returns to live; the parked session resumes where it was.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("history-transport")).toBeHidden();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  expect((await textHook(page)).room, "live play resumes where it was parked").toBe(2);
  await waitForCycles(page, 2);
});

test("Resume here continues from the viewed moment; Back to before restores the original", async ({
  page,
}) => {
  await isolateStorage(page);
  await bootTapeGame(page);
  await writeFlag(page, 6);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await waitForCycles(page, 3);

  await openLookBack(page);
  // Scrub to the tape's start: room 1 before the transition.
  const timeline = page.getByTestId("history-timeline");
  const box = (await timeline.boundingBox())!;
  await timeline.click({ position: { x: box.width * 0.03, y: box.height / 2 } });
  await expect.poll(async () => (await viewState(page))?.room, { timeout: 20_000 }).toBe(1);

  const resume = page.getByTestId("btn-resume-here");
  await expect(resume).toBeEnabled({ timeout: 20_000 });
  await resume.click();

  // The transport releases its pause; live play is the viewed moment now.
  await expect(page.getByTestId("history-transport")).toBeHidden({ timeout: 20_000 });
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);

  // The departing session was kept: reopen the tape and take it back.
  await openLookBack(page);
  const back = page.getByTestId("btn-back-to-before");
  await expect(back).toBeVisible();
  await back.click();
  await expect(page.getByTestId("history-transport")).toBeHidden({ timeout: 20_000 });
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
});

test("a diverged tape labels the position unverified and keeps Resume here off", async ({
  page,
}) => {
  await isolateStorage(page);
  await bootTapeGame(page);
  await writeFlag(page, 6);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await waitForCycles(page, 3);

  // Open and close the transport once: the pause seals the recorded tail and
  // the open's drain commits it before the corruption lands.
  await openLookBack(page);
  await page.getByTestId("btn-back-to-live").click();
  await expect(page.getByTestId("history-transport")).toBeHidden();

  // Corrupt the stored tape: flip every sync mark's expected digest in the
  // first segment, so any replay across it fails the marks it crosses.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("monotio-agi-projects", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    interface StoredTape {
      recording: { segments: { sync: { digest: string; tick: number }[] }[] };
    }
    const record = await new Promise<StoredTape>((resolve, reject) => {
      const req = db
        .transaction("projects", "readonly")
        .objectStore("projects")
        .get("history/history-transport-fixture");
      req.onsuccess = () => resolve(req.result as StoredTape);
      req.onerror = () => reject(req.error);
    });
    for (const mark of record.recording.segments[0]!.sync)
      mark.digest = (mark.digest[0] === "0" ? "1" : "0") + mark.digest.slice(1);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      tx.objectStore("projects").put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });

  // The live worker replays its in-memory tape; reload so the stored —
  // corrupted — recording is the one under view.
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBeGreaterThanOrEqual(1);
  await openLookBack(page);

  // Step into the corrupted first segment: the drive replays across the
  // flipped marks and the verification must fail at the first one it meets.
  await page.getByTestId("history-seg-prev").click();
  await expect
    .poll(async () => (await viewState(page))?.diverged !== null, { timeout: 20_000 })
    .toBe(true);

  // The position is labeled unverified and Resume here stays off.
  await expect(page.getByTestId("history-diverged")).toContainText("Unverified");
  await expect(page.getByTestId("btn-resume-here")).toBeDisabled();
});

test("a tape the app cannot read reports the failure and leaves live play alone", async ({
  page,
}) => {
  await isolateStorage(page);
  await bootTapeGame(page);
  await writeFlag(page, 6);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await waitForCycles(page, 2);

  // Seal and commit the tail so a record exists to reject.
  await openLookBack(page);
  await page.getByTestId("btn-back-to-live").click();
  await expect(page.getByTestId("history-transport")).toBeHidden();

  // A record version this app does not know must be refused, not replayed.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("monotio-agi-projects", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const record = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = db
        .transaction("projects", "readonly")
        .objectStore("projects")
        .get("history/history-transport-fixture");
      req.onsuccess = () => resolve(req.result as Record<string, unknown>);
      req.onerror = () => reject(req.error);
    });
    record["version"] = 99;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      tx.objectStore("projects").put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });

  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBeGreaterThanOrEqual(1);

  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-look-back").click();
  await expect(page.getByTestId("history-error")).toContainText("not supported");
  expect((await viewState(page))?.active).toBe(false);

  // Nothing was parked: the live engine kept running.
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await waitForCycles(page, 2);
});

test("a map visit jumps straight to its moment on the tape", async ({ page }) => {
  await isolateStorage(page);
  await bootTapeGame(page);
  await writeFlag(page, 6);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await waitForCycles(page, 3);

  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-world-map").click();
  await expect(page.getByTestId("world-map")).toBeVisible();
  await page.getByTestId("map-room-1").click();
  const jump = page.locator("[data-testid^='map-visit-jump-']").first();
  await expect(jump).toBeVisible();
  await jump.click();

  // The map hands over to the transport, parked at the visit's recorded tick.
  await expect(page.getByTestId("world-map")).toBeHidden();
  await expect(page.getByTestId("history-transport")).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await viewState(page))?.active).toBe(true);
  await expect.poll(async () => (await viewState(page))!.room, { timeout: 20_000 }).toBe(1);
});
