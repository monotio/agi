import { expect, test, type Page } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import {
  cacheGame,
  isolateStorage,
  observe,
  openWorldMap,
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
    projectId: testProjectId("history-transport-fixture"),
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
  parked: boolean;
  seeking: boolean;
  playing: boolean;
  watching: boolean;
  segment: number;
  tick: number;
  room: number;
  canResume: boolean;
  branches: number;
  pendingSwaps: number;
  diverged: { tick: number; detail: string } | null;
}

async function viewState(page: Page): Promise<ViewState | null> {
  return page.evaluate(() => (window.__AGI_STATE__?.historyView ?? null) as ViewState | null);
}

/**
 * A timeline click during live play: the transport pauses first, then opens
 * the tape and lands at the clicked position — the agreed entry gesture.
 */
async function scrubToTape(page: Page, fraction: number): Promise<void> {
  const timeline = page.getByTestId("history-timeline");
  // The axis is inert until the first live batch lands — the live position
  // reads 100% only once the recording has an extent.
  await expect(timeline).toHaveAttribute("aria-valuenow", "100", { timeout: 20_000 });
  const box = (await timeline.boundingBox())!;
  await timeline.click({ position: { x: box.width * fraction, y: box.height / 2 } });
  await expect.poll(async () => (await viewState(page))?.active, { timeout: 20_000 }).toBe(true);
  const selected = (await timeline.boundingBox())!;
  expect(selected.x, "seeking directly from LIVE keeps the timeline origin").toBe(box.x);
  expect(selected.width, "seeking directly from LIVE keeps the timeline width").toBe(box.width);
}

test("the transport rides live play from boot; the timeline enters the tape and LIVE returns paused", async ({
  page,
}) => {
  await isolateStorage(page);
  await bootTapeGame(page);

  // Always visible from the first cycle — no menu item, no record toggle.
  await expect(page.getByTestId("history-transport")).toBeVisible();
  const live = page.getByTestId("history-live");
  await expect(live).toBeVisible();
  await expect(live).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: test.info().outputPath("transport-live.png") });

  // Pause works before any recorded batch is even needed.
  const pause = page.getByTestId("btn-transport-pause");
  await pause.click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  await expect.poll(async () => (await viewState(page))?.parked).toBe(true);
  await page.getByTestId("btn-transport-resume").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);

  // A second room on the tape: f6 fires logic 1's literal new.room(2).
  await writeFlag(page, 6);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await waitForCycles(page, 3);

  // Clicking near the tape's start pauses live, then lands near the boot.
  await scrubToTape(page, 0.05);
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  await expect(page.getByTestId("history-pos")).toContainText("Room");
  await expect(page.locator(".history-marker").first()).toBeVisible();
  await expect
    .poll(async () => (await viewState(page))!.room, { timeout: 20_000 })
    .toBeLessThanOrEqual(1);
  await expect(live).toHaveAttribute("aria-pressed", "false");

  // Watch is the secondary action: the tape advances on its own clock and
  // Space pauses it, while the primary button still means Resume from here.
  const watchedFrom = (await viewState(page))!.tick;
  await page.getByTestId("btn-history-watch").click();
  await expect.poll(async () => (await viewState(page))!.tick).toBeGreaterThan(watchedFrom);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await viewState(page))?.playing).toBe(false);
  await expect(page.getByTestId("btn-history-resume")).toContainText("Resume from here");

  // The parked live session never moved while the tape played.
  const liveCycles = (await textHook(page)).cycle;
  await observe(page, 30);
  expect((await textHook(page)).cycle, "the live engine stays parked").toBe(liveCycles);

  // LIVE restores the parked surface — still paused under the transport's
  // hold until Resume continues exactly where Pause left it.
  await live.click();
  await expect.poll(async () => (await viewState(page))?.active).toBe(false);
  await expect.poll(async () => (await viewState(page))?.parked).toBe(true);
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  expect((await textHook(page)).room, "the parked live session, not a replay tick").toBe(2);
  await page.getByTestId("btn-transport-resume").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);

  // Scrub in again; Escape leaves the tape and resumes live in one step.
  await scrubToTape(page, 0.05);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await viewState(page))?.active).toBe(false);
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  expect((await textHook(page)).room, "live play resumes where it was parked").toBe(2);
  await waitForCycles(page, 2);
});

test("Resume from here continues from the viewed moment; Undo rewind restores the kept session", async ({
  page,
}) => {
  await isolateStorage(page);
  await bootTapeGame(page);
  await writeFlag(page, 6);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await waitForCycles(page, 3);

  // Scrub into room 1 before the transition — past the tape's opening tick,
  // which precedes the first drawn frame and is legitimately unrestorable.
  await scrubToTape(page, 0.2);
  await expect.poll(async () => (await viewState(page))?.room, { timeout: 20_000 }).toBe(1);

  const resume = page.getByTestId("btn-history-resume");
  await expect(resume).toBeEnabled({ timeout: 20_000 });
  await resume.click();

  // The swap adopts the viewed moment; live play continues there with no
  // Keep/Replace question.
  await expect.poll(async () => (await viewState(page))?.active).toBe(false);
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);

  // The departing session was kept as a recovery branch — Undo rewind is
  // the secondary path straight from live play.
  const undo = page.getByTestId("btn-undo-rewind");
  await expect(undo).toBeVisible();
  await undo.click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  // The resumed room-1 session is itself kept now — the branch list holds it.
  await expect(undo).toBeVisible();
});

test("a diverged tape labels the position unrestorable and keeps Resume from here off", async ({
  page,
}) => {
  await isolateStorage(page);
  await bootTapeGame(page);
  await writeFlag(page, 6);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await waitForCycles(page, 3);

  // Open and close the tape once: the open's drain commits the recorded tail
  // before the corruption lands.
  await scrubToTape(page, 0.5);
  await page.getByTestId("history-live").click();
  await expect.poll(async () => (await viewState(page))?.active).toBe(false);
  await page.getByTestId("btn-transport-resume").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);

  // Corrupt the stored tape: flip every sync mark's expected digest in the
  // first segment's batch records, so any replay across one fails. A seek
  // replays only from the nearest anchor at-or-before its target — marks
  // behind that anchor never verify — so the target is chosen from the
  // tape itself: a corrupted mark with no anchor sharing its neighborhood.
  // The tape is append-oriented — each batch is its own record under
  // `history/<key>/s/<segment>/<batch>`.
  const corruptedTick = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("monotio-agi-projects", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    interface StoredBatch {
      projectId: string;
      segment: string;
      batch: number;
      sync: { digest: string; tick: number }[];
      anchor?: { tick: number };
    }
    const manifest = await new Promise<{ segments: { id: string }[] }>((resolve, reject) => {
      const req = db
        .transaction("projects", "readonly")
        .objectStore("projects")
        .get("history/history-transport-fixture");
      req.onsuccess = () => resolve(req.result as { segments: { id: string }[] });
      req.onerror = () => reject(req.error);
    });
    const firstSegment = manifest.segments[0]!.id;
    const keys = (await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = db.transaction("projects", "readonly").objectStore("projects").getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })) as string[];
    const targets = keys.filter(
      (key) =>
        typeof key === "string" &&
        key.startsWith(`history/history-transport-fixture/s/${firstSegment}/`),
    );
    const markTicks: number[] = [];
    const anchorTicks: number[] = [];
    const tx = db.transaction("projects", "readwrite");
    const store = tx.objectStore("projects");
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const key of targets) {
        const req = store.get(key);
        req.onsuccess = () => {
          const batch = req.result as StoredBatch | undefined;
          if (batch === undefined) return;
          for (const mark of batch.sync) {
            markTicks.push(mark.tick);
            mark.digest = (mark.digest[0] === "0" ? "1" : "0") + mark.digest.slice(1);
          }
          if (batch.anchor) anchorTicks.push(batch.anchor.tick);
          store.put(batch);
        };
      }
    });
    // A seek target a few ticks past this mark replays across it: no anchor
    // sits in the window the click could land in. Pick the earliest such
    // mark — the live tail only grows after it.
    for (const tick of markTicks.sort((a, b) => a - b)) {
      if (anchorTicks.every((a) => a < tick - 3 || a > tick + 6)) return tick;
    }
    return markTicks[markTicks.length - 1] ?? 0;
  });

  // The live worker replays its in-memory tape; reload so the stored —
  // corrupted — recording is the one under view.
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBeGreaterThanOrEqual(1);

  // Click the fraction that lands a few ticks past the chosen mark: the
  // current total extent comes from the manifest's segment lanes.
  const fraction = await page.evaluate(async (tick) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("monotio-agi-projects", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const manifest = await new Promise<{ segments: { extent?: number }[] }>((resolve, reject) => {
      const req = db
        .transaction("projects", "readonly")
        .objectStore("projects")
        .get("history/history-transport-fixture");
      req.onsuccess = () => resolve(req.result as { segments: { extent?: number }[] });
      req.onerror = () => reject(req.error);
    });
    const total = manifest.segments.reduce((sum, s) => sum + (s.extent ?? 0), 0);
    return Math.min(0.95, (tick + 3) / Math.max(total, 1));
  }, corruptedTick);
  await scrubToTape(page, fraction);
  await expect
    .poll(async () => (await viewState(page))?.diverged !== null, { timeout: 20_000 })
    .toBe(true);

  // The position is labeled unrestorable and Resume from here stays off.
  await expect(page.getByTestId("history-diverged")).toContainText("can't be restored");
  await expect(page.getByTestId("btn-history-resume")).toBeDisabled();

  // LIVE still recovers the verified current game.
  await page.getByTestId("history-live").click();
  await page.getByTestId("btn-transport-resume").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
});

test("a tape the app cannot read reports the failure and resumes the verified live game", async ({
  page,
}) => {
  await isolateStorage(page);
  await bootTapeGame(page);
  await writeFlag(page, 6);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await waitForCycles(page, 2);

  // Seal and commit the tail so a record exists to reject.
  await scrubToTape(page, 0.5);
  await page.getByTestId("history-live").click();
  await page.getByTestId("btn-transport-resume").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);

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

  // A timeline click still pauses first even on an empty axis — the stored
  // tape exists but cannot be read, and the failed open leaves the live
  // session parked at LIVE with the refusal on the bar.
  const timeline = page.getByTestId("history-timeline");
  const box = (await timeline.boundingBox())!;
  await timeline.click({ position: { x: box.width * 0.4, y: box.height / 2 } });
  await expect(page.getByTestId("history-error")).toContainText("not supported", {
    timeout: 20_000,
  });
  await expect.poll(async () => (await viewState(page))?.active).toBe(false);
  await expect.poll(async () => (await viewState(page))?.parked).toBe(true);

  // Resume returns to the verified live game — no recovery vote was asked.
  await page.getByTestId("btn-transport-resume").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await waitForCycles(page, 2);
});

test("a map visit jumps straight to its moment on the tape", async ({ page }) => {
  await isolateStorage(page);
  await bootTapeGame(page);
  await writeFlag(page, 6);
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await waitForCycles(page, 3);

  await openWorldMap(page);
  await page.getByTestId("map-room-1").click();
  const jump = page.locator("[data-testid^='map-visit-jump-']").first();
  await expect(jump).toBeVisible();
  await jump.click();

  // The map hands over to the transport, parked at the visit's recorded tick.
  await expect(page.getByTestId("world-map")).toBeHidden();
  await expect.poll(async () => (await viewState(page))?.active).toBe(true);
  await expect.poll(async () => (await viewState(page))!.room, { timeout: 20_000 }).toBe(1);
});

test.describe("phone transport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("seeking, Watch and Undo keep a usable timeline and every control on screen", async ({
    page,
  }) => {
    await isolateStorage(page);
    await bootTapeGame(page);
    await waitForCycles(page, 6);
    // Flush a recorded extent, then return to running LIVE before the gesture.
    await page.getByTestId("btn-transport-pause").tap();
    await page.getByTestId("btn-transport-resume").tap();
    await expect.poll(async () => (await textHook(page)).paused).toBe(false);
    await scrubToTape(page, 0.5);
    await expect(page.getByTestId("btn-history-resume")).toBeEnabled();

    const assertGeometry = async () => {
      const timeline = (await page.getByTestId("history-timeline").boundingBox())!;
      expect(
        timeline.width,
        "the timeline remains useful after its label changes",
      ).toBeGreaterThanOrEqual(96);
      expect(timeline.height, "touch scrub target").toBeGreaterThanOrEqual(44);
      const controls = await page
        .getByTestId("history-transport")
        .locator(":scope > div > button, .transport-speed-group > button")
        .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()));
      expect(controls.length).toBeGreaterThanOrEqual(2);
      for (const box of controls) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    };
    await assertGeometry();
    await page.screenshot({ path: test.info().outputPath("phone-history-seek.png") });
    await page.getByTestId("btn-history-watch").tap();
    await assertGeometry();
    await page.screenshot({ path: test.info().outputPath("phone-history-watch.png") });
    await page.getByTestId("btn-history-resume").tap();
    await expect(page.getByTestId("btn-undo-rewind")).toBeVisible();
    await assertGeometry();
    await page.getByTestId("btn-undo-rewind").tap();
    await expect.poll(async () => (await textHook(page)).paused).toBe(false);
    await assertGeometry();
    await page.screenshot({ path: test.info().outputPath("phone-history-undo.png") });
  });
});
