import { expect, test, type Page } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import {
  cacheGame,
  isolateStorage,
  openWorldMap,
  textHook,
  waitForAutosaveAfter,
  waitForCycles,
  openInspector,
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
      "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}if(isset(f6)){new.room(2);}return;",
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource(
    "logic",
    2,
    assembleLogic(
      "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}if(isset(f201)){reset(f201);new.room(1);}return;",
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

/**
 * The inspector's flag write — the same drive the world-map spec uses. The
 * inspector opens from Settings > Advanced, so the game stays in Play mode.
 */
async function writeFlag(page: Page, flag: number): Promise<void> {
  await openInspector(page);
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
  const liveCycles = (await textHook(page)).cycle;
  const watchedFrom = (await viewState(page))!.tick;
  await page.getByTestId("btn-history-watch").click();
  await expect.poll(async () => (await viewState(page))!.tick).toBeGreaterThan(watchedFrom);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await viewState(page))?.playing).toBe(false);
  await expect(page.getByTestId("btn-history-resume")).toContainText("Resume from here");

  // The parked live session never moved while the tape played.
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
  // Record a periodic sync after the room-entry anchor (the cadence is 20 cycles).
  await waitForCycles(page, 25);
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);

  // Open and close the tape once: the open's drain commits the recorded tail
  // before the corruption lands. Keep LIVE paused so later anchors cannot
  // invalidate the deliberately corrupted replay interval.
  await scrubToTape(page, 0.5);
  await page.getByTestId("history-live").click();
  await expect.poll(async () => (await viewState(page))?.active).toBe(false);
  // Corrupt the stored tape: flip every sync mark's expected digest in the
  // first segment's batch records, so any replay across one fails.
  // The tape is append-oriented — each batch is its own record under
  // `history/<key>/s/<segment>/<batch>`.
  const corrupted = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("monotio-agi-projects", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    interface StoredBatch {
      sync: { digest: string }[];
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
    let flipped = 0;
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
            mark.digest = (mark.digest[0] === "0" ? "1" : "0") + mark.digest.slice(1);
            flipped++;
          }
          store.put(batch);
        };
      }
    });
    return flipped;
  });
  expect(corrupted, "the recorded tape holds sync marks to corrupt").toBeGreaterThan(0);

  // The live worker replays its in-memory tape; reload so the stored —
  // corrupted — recording is the one under view.
  await expect(page).toHaveURL(/#play\/history-transport-fixture$/);
  await page.reload();
  await expect.poll(async () => (await textHook(page)).room).toBeGreaterThanOrEqual(1);
  await page.getByTestId("btn-transport-pause").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__AGI_STATE__?.historyPending)).toBe(0);

  // Choose the click from the stored tape's own anatomy — read after the
  // reload's pause has drained, so the resumed session's new segment is part
  // of the axis. A seek replays only from the nearest anchor at-or-before
  // its target — marks behind that anchor never verify — so the landing
  // sits a few ticks past a corrupted sync mark and short of the next
  // anchor. The timeline also resolves a click within 1.5% of a room notch
  // to that notch, and every notch sits on an anchor's tick: a landing
  // inside the snap radius restarts replay AT that anchor, past the
  // corruption, and the divergence never surfaces. The total extent and the
  // notches come from the manifest's segment lanes.
  const aimed = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("monotio-agi-projects", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    interface StoredBatch {
      sync: { tick: number }[];
      anchors?: { tick: number }[];
    }
    interface Manifest {
      segments: { id: string; extent?: number; marks?: { tick: number }[] }[];
    }
    const readManifest = () =>
      new Promise<Manifest>((resolve, reject) => {
        const req = db
          .transaction("projects", "readonly")
          .objectStore("projects")
          .get("history/history-transport-fixture");
        req.onsuccess = () => resolve(req.result as Manifest);
        req.onerror = () => reject(req.error);
      });
    // The click maps against the committed axis, and a batch still queued
    // in the worker (the in-flight credit is bounded) lands after the
    // pending drain — moving the landing under the pointer. Read until the
    // manifest's shape holds still instead of trusting a single snapshot.
    let manifest = await readManifest();
    for (let i = 0; i < 40; i++) {
      const shape = manifest.segments.map((seg) => seg.extent ?? 0).join(",");
      await new Promise((r) => setTimeout(r, 150));
      const again = await readManifest();
      if (again.segments.map((seg) => seg.extent ?? 0).join(",") === shape) break;
      manifest = again;
    }
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
    const batches = await new Promise<StoredBatch[]>((resolve, reject) => {
      const tx = db.transaction("projects", "readonly");
      const store = tx.objectStore("projects");
      const out: StoredBatch[] = [];
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      for (const key of targets) {
        const req = store.get(key);
        req.onsuccess = () => {
          if (req.result !== undefined) out.push(req.result as StoredBatch);
        };
      }
    });
    const corruptedTicks = batches
      .flatMap((batch) => batch.sync.map((mark) => mark.tick))
      .sort((a, b) => a - b);
    const anchorTicks = batches
      .flatMap((batch) => (batch.anchors ?? []).map((anchor) => anchor.tick))
      .sort((a, b) => a - b);
    const extents = manifest.segments.map((seg) => seg.extent ?? 0);
    const total = Math.max(
      extents.reduce((sum, extent) => sum + extent, 0),
      1,
    );
    const extent0 = extents[0] ?? 0;
    // The timeline notches a click could snap to, in flattened axis ticks.
    const notches: number[] = [];
    let prefix = 0;
    manifest.segments.forEach((seg, i) => {
      for (const mark of seg.marks ?? []) notches.push(prefix + mark.tick);
      prefix += extents[i]!;
    });
    // Snap radius in ticks, plus slack for a lane committing between this
    // read and the click (the axis only grows while live play is paused).
    const snapGuard = Math.ceil(total * 0.015) + 5;
    const drift = 5;
    for (const tick of corruptedTicks) {
      const nextAnchor = anchorTicks.find((anchor) => anchor > tick) ?? Number.POSITIVE_INFINITY;
      for (
        let landing = tick + 3;
        landing + drift < nextAnchor && landing + drift <= extent0;
        landing++
      ) {
        if (notches.some((notch) => Math.abs(notch - landing) < snapGuard + drift)) continue;
        if (landing / total > 0.9) break;
        return { fraction: landing / total, landing };
      }
    }
    throw new Error("The fixture recorded no corrupted mark with a snap-safe landing.");
  });
  await scrubToTape(page, aimed.fraction);
  // The seek settles inside the corrupted segment — either parked on the
  // aimed tick or halted early at the corrupted mark. A click deflected to
  // a notch lands on the notch's own tick and fails this fast, rather than
  // consuming the divergence timeout below.
  await expect
    .poll(
      async () => {
        const v = await viewState(page);
        return v?.segment === 0 && !v.seeking ? v.tick : null;
      },
      { timeout: 20_000 },
    )
    .not.toBeNull();
  const landed = (await viewState(page))!;
  expect(
    landed.diverged !== null || Math.abs(landed.tick - aimed.landing) <= 6,
    "the click landed on the aimed tick — not snapped to a notch",
  ).toBe(true);
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
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);

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

  await expect(page).toHaveURL(/#play\/history-transport-fixture$/);
  await page.reload();
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
