import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { enterCreateMode, isolateStorage, waitForRoom } from "./engineProbe.ts";

/**
 * Interaction budgets on the real app, measured in the page with the
 * Performance APIs: `longtask` and `event` entries from PerformanceObserver,
 * and requestAnimationFrame deltas for frame intervals. They guard against a
 * change that makes Studio drags, pencil strokes or a game's boot visibly
 * janky, not against small drifts.
 *
 * Budgets are about three times the worst of seven runs on a development
 * Mac, alone and under the full suite's parallel load (numbers beside each
 * budget), so CI's slower two-worker headless runners still pass. Raise one
 * only on purpose, with the measurement and the reason in the commit. Tagged
 * @perf: the main suite leaves them out, and `npm --prefix app run e2e:perf`
 * runs them alone on one worker, so no other test loads the machine they
 * measure (CI runs them after the first Chromium shard).
 */
test.use({ viewport: { width: 1440, height: 900 } });
// One test at a time in this file, so the specs do not load each other.
test.describe.configure({ mode: "serial" });
const PERF = { tag: "@perf" };

type PerfSample = {
  /** Frames recorded, and the p95 and largest interval between them (ms). */
  readonly frames: number;
  readonly frameP95: number;
  readonly frameMax: number;
  /** Largest `event` entry duration: an INP-like worst input delay to paint (ms). */
  readonly eventMax: number;
  readonly longTaskCount: number;
  readonly longTaskTotal: number;
};

interface PerfProbe {
  longTasks: { start: number; duration: number }[];
  events: { name: string; start: number; duration: number }[];
  frames: number[];
  recording: boolean;
  since: number;
  firstFrameAt: number | null;
}

/** Observers installed before any app script, so boot's long tasks are seen. */
async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: PerfProbe = {
      longTasks: [],
      events: [],
      frames: [],
      recording: false,
      since: 0,
      firstFrameAt: null,
    };
    (window as unknown as { __PERF__: PerfProbe }).__PERF__ = probe;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        probe.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });
    // 16 ms is the smallest threshold the Event Timing API reports.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        probe.events.push({ name: entry.name, start: entry.startTime, duration: entry.duration });
    }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
    const watchFirstFrame = (): void => {
      const hook = (window as unknown as { __AGI_TEXT__?: { frame: number } }).__AGI_TEXT__;
      if ((hook?.frame ?? 0) > 0) probe.firstFrameAt = performance.now();
      else requestAnimationFrame(watchFirstFrame);
    };
    requestAnimationFrame(watchFirstFrame);
  });
}

/** Start recording frame intervals; long tasks and events count from here. */
async function startWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (window as unknown as { __PERF__: PerfProbe }).__PERF__;
    probe.frames = [];
    probe.recording = true;
    probe.since = performance.now();
    const tick = (time: number): void => {
      if (!probe.recording) return;
      probe.frames.push(time);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Stop recording, after two more frames so the last events are reported. */
async function endWindow(page: Page): Promise<PerfSample> {
  const probe = await page.evaluate(async () => {
    const probe = (window as unknown as { __PERF__: PerfProbe }).__PERF__;
    for (let k = 0; k < 2; k++) await new Promise((resolve) => requestAnimationFrame(resolve));
    probe.recording = false;
    return probe;
  });
  return summarize(probe, probe.since, Infinity);
}

function summarize(probe: PerfProbe, from: number, to: number): PerfSample {
  const intervals = probe.frames
    .slice(1)
    .map((time, k) => time - probe.frames[k]!)
    .sort((a, b) => a - b);
  const within = <T extends { start: number }>(entries: T[]) =>
    entries.filter((entry) => entry.start >= from && entry.start < to);
  const longTasks = within(probe.longTasks);
  return {
    frames: probe.frames.length,
    frameP95: intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))] ?? 0,
    frameMax: intervals.at(-1) ?? 0,
    eventMax: Math.max(0, ...within(probe.events).map((entry) => entry.duration)),
    longTaskCount: longTasks.length,
    longTaskTotal: longTasks.reduce((sum, task) => sum + task.duration, 0),
  };
}

/** Print the measurement, so a run's numbers can be compared with the budgets. */
function report(name: string, sample: Readonly<Record<string, number>>): void {
  const rounded = Object.entries(sample).map(([key, value]) => `${key}=${Math.round(value)}`);
  console.log(`[perf] ${name} ${rounded.join(" ")}`);
}

const nextFrame = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

async function playTutorial(page: Page): Promise<void> {
  await isolateStorage(page);
  await installProbe(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
}

/** Press at `from`, move one step per animation frame to `to`, release. */
async function dragPerFrame(
  page: Page,
  from: readonly [number, number],
  to: readonly [number, number],
  frames: number,
): Promise<void> {
  await page.mouse.move(...from);
  await page.mouse.down();
  for (let k = 1; k <= frames; k++) {
    await page.mouse.move(
      from[0] + ((to[0] - from[0]) * k) / frames,
      from[1] + ((to[1] - from[1]) * k) / frames,
    );
    await nextFrame(page);
  }
  await page.mouse.up();
}

test(
  "a cold boot of the catalog tutorial reaches its first frame without long jank",
  PERF,
  async ({ page }) => {
    await playTutorial(page);
    const probe = await page.evaluate(async () => {
      const probe = (window as unknown as { __PERF__: PerfProbe }).__PERF__;
      while (probe.firstFrameAt === null)
        await new Promise((resolve) => requestAnimationFrame(resolve));
      return probe;
    });
    const sample = summarize(probe, 0, probe.firstFrameAt!);
    report("boot", {
      firstFrameAt: probe.firstFrameAt!,
      longTaskCount: sample.longTaskCount,
      longTaskTotal: sample.longTaskTotal,
      eventMax: sample.eventMax,
    });
    // Measured 149–377 ms in 1–2 long tasks (first frame at 1.0–2.3 s).
    expect(sample.longTaskTotal, "long-task time before the first frame (ms)").toBeLessThan(1200);
    expect(sample.longTaskCount, "long tasks before the first frame").toBeLessThanOrEqual(6);
  },
);

test(
  "dragging an item in the tutorial's Room Studio keeps frames and input responsive",
  PERF,
  async ({ page }) => {
    await playTutorial(page);
    await enterCreateMode(page);
    const panel = page.getByTestId("world-panel");
    await panel.getByTestId("map-room-1").click();
    await panel.getByTestId("world-open-studio").click();
    const studio = page.getByTestId("room-studio");
    await expect(studio).toBeVisible();
    await studio.getByRole("searchbox", { name: "Filter items" }).fill("Marble bust");
    await studio.locator('[role="treeitem"][data-row]').first().click();
    // The bust is painted over the finished room, so it moves without changing
    // another item's art: from its chest (sceneArt.ts) 30 px across the floor.
    const pane = page.locator(".studio-pane").last();
    const box = (await pane.boundingBox())!;
    const zoom = box.height / 168;
    const cell = (x: number, y: number): [number, number] => [
      box.x + (x + 0.5) * 2 * zoom,
      box.y + (y + 0.5) * zoom,
    ];
    await startWindow(page);
    await dragPerFrame(page, cell(8, 112), cell(38, 108), 60);
    const sample = await endWindow(page);
    report("studio-drag", sample);
    await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
    expect(sample.frames).toBeGreaterThanOrEqual(60);
    // Measured: p95 16.8 ms (every frame on time), slowest event 16–32 ms.
    expect(sample.frameP95, "p95 frame interval while dragging (ms)").toBeLessThan(50);
    expect(sample.eventMax, "slowest input event while dragging (ms)").toBeLessThan(100);
  },
);

async function openApprentice(page: Page): Promise<Locator> {
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await panel.getByTestId("world-open-sprite-0").click();
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  return studio;
}

test("pencil strokes in Sprite Studio keep frames responsive", PERF, async ({ page }) => {
  await playTutorial(page);
  const studio = await openApprentice(page);
  await studio.locator('[data-colour="4"]').click();
  await studio.locator('[data-loop="0"][data-cel="0"]').click();
  const canvas = studio.getByTestId("sprite-canvas");
  const box = (await canvas.boundingBox())!;
  const width = Number(await canvas.getAttribute("data-width"));
  const height = Number(await canvas.getAttribute("data-height"));
  const zoom = Number(await canvas.getAttribute("data-zoom"));
  const cell = (x: number, y: number): [number, number] => [
    box.x + (x + 0.5) * 2 * zoom,
    box.y + (y + 0.5) * zoom,
  ];
  await startWindow(page);
  // Four strokes across the cel: two rows, a column, a diagonal.
  const strokes: [[number, number], [number, number]][] = [
    [
      [0, 2],
      [width - 1, 2],
    ],
    [
      [0, height - 3],
      [width - 1, height - 3],
    ],
    [
      [1, 0],
      [1, height - 1],
    ],
    [
      [0, 0],
      [width - 1, height - 1],
    ],
  ];
  for (const [from, to] of strokes) await dragPerFrame(page, cell(...from), cell(...to), 20);
  const sample = await endWindow(page);
  report("sprite-pencil", sample);
  // Each stroke is one undo step.
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("4 changes");
  expect(sample.frames).toBeGreaterThanOrEqual(80);
  // Measured: p95 16.7 ms (every frame on time), slowest event 24 ms.
  expect(sample.frameP95, "p95 frame interval while drawing (ms)").toBeLessThan(50);
  expect(sample.eventMax, "slowest input event while drawing (ms)").toBeLessThan(75);
});
