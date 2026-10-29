import { countWork } from "./workCounts.ts";
import { recordPerformance } from "./performanceTrend.ts";
import { DEADLINES } from "./deadlines.ts";
import { expect, test } from "./test.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import {
  isolateStorage,
  waitForRoom,
  openWorkspacePicture,
  openWorkspaceView,
  workspaceSaved,
  workspaceUpdated,
} from "./engineProbe.ts";

/** Real interactions keep their state assertions; elapsed samples are retained as trends. */
test.use({ viewport: { width: 1440, height: 900 } });
// Serial: one interaction at a time makes the trend samples easier to compare.
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

const nextFrame = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

async function playTutorial(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.addInitScript(() => localStorage.setItem("monotio_agi.crtAmount", "1"));
  await installProbe(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
}

async function historyCommits(page: Page): Promise<number> {
  const count = await page.evaluate(
    () =>
      (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
        .getSession()
        .capture().history.commits.length,
  );
  return count;
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
    const preparation = await countWork(
      page,
      /\/src\/library\/gamePreview\.ts(?:\?|$)/,
      'async function previewGame(game, profile, source = "zip") {',
      "boot-preparation",
    );
    await playTutorial(page);
    await expect
      .poll(
        () =>
          page.evaluate(() => (window as unknown as { __PERF__: PerfProbe }).__PERF__.firstFrameAt),
        { timeout: DEADLINES.project },
      )
      .not.toBeNull();
    const probe = await page.evaluate(
      () => (window as unknown as { __PERF__: PerfProbe }).__PERF__,
    );
    const sample = summarize(probe, 0, probe.firstFrameAt!);
    await recordPerformance("boot", {
      firstFrameAt: probe.firstFrameAt!,
      longTaskCount: sample.longTaskCount,
      longTaskTotal: sample.longTaskTotal,
      eventMax: sample.eventMax,
    });
    expect(probe.firstFrameAt).not.toBeNull();
    expect(await preparation(), "one preparation of the selected cold boot").toBe(1);
  },
);

test(
  "dragging an item in the tutorial's PICTURE editor keeps frames and input responsive",
  PERF,
  async ({ page }) => {
    await playTutorial(page);
    const studio = await openWorkspacePicture(page, 1);
    await studio.getByRole("searchbox", { name: "Filter items" }).fill("Marble bust");
    await studio.locator('[role="treeitem"][data-row]').first().click();
    await page.getByTestId("workspace-focus").click();
    await expect(page.getByTestId("workspace-focus")).toHaveAttribute("aria-pressed", "true");
    // The bust is painted over the finished room, so it moves without changing
    // another item's art: from its chest (sceneArt.ts) 30 px across the floor.
    const pane = page.locator(".studio-pane").last();
    // Focus refits the stage: the pane still moves and resizes while the new
    // size reaches the zoom. Measure only once the box holds still across a frame.
    let box = (await pane.boundingBox())!;
    await expect(async () => {
      await nextFrame(page);
      const next = (await pane.boundingBox())!;
      const prev = box;
      box = next;
      expect(next).toEqual(prev);
    }).toPass({ timeout: DEADLINES.editor });
    const zoom = box.height / 168;
    const cell = (x: number, y: number): [number, number] => [
      box.x + (x + 0.5) * 2 * zoom,
      box.y + (y + 0.5) * zoom,
    ];
    const commits = await historyCommits(page);
    await startWindow(page);
    await dragPerFrame(page, cell(8, 112), cell(38, 108), 60);
    const sample = await endWindow(page);
    await recordPerformance("studio-drag", sample);
    await workspaceSaved(page);
    // The approved Update game storyboard keeps a drag out of History until Update.
    expect(await historyCommits(page)).toBe(commits);
    await workspaceUpdated(page);
    expect(await historyCommits(page)).toBe(commits + 1);
    expect(sample.frames).toBeGreaterThanOrEqual(60);
  },
);

test("pencil strokes in VIEW editor keep frames responsive", PERF, async ({ page }) => {
  await playTutorial(page);
  const studio = await openWorkspaceView(page, 0, false);
  await studio.locator('.view-workspace-palette [data-colour="4"]').click();
  await studio.locator('[data-loop="0"][data-cel="0"]').click();
  const canvas = studio.getByTestId("view-canvas");
  const width = Number(await canvas.getAttribute("data-width"));
  const height = Number(await canvas.getAttribute("data-height"));
  const commits = await historyCommits(page);
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
  for (const [from, to] of strokes) {
    const box = (await canvas.boundingBox())!;
    const zoom = Number(await canvas.getAttribute("data-zoom"));
    const cell = (x: number, y: number): [number, number] => [
      box.x + (x + 0.5) * 2 * zoom,
      box.y + (y + 0.5) * zoom,
    ];
    await dragPerFrame(page, cell(...from), cell(...to), 20);
  }
  const sample = await endWindow(page);
  await recordPerformance("view-pencil", sample);
  // Each stroke is one undo step.
  await workspaceSaved(page);
  expect(await historyCommits(page)).toBe(commits);
  await workspaceUpdated(page);
  expect(await historyCommits(page)).toBe(commits + 1);
  expect(sample.frames).toBeGreaterThanOrEqual(80);
});

for (const arrangement of ["Stacked", "Side by side"] as const) {
  test(
    `workspace ${arrangement} splitter keeps frames responsive during a LOGIC resize`,
    PERF,
    async ({ page }) => {
      await playTutorial(page);
      await openWorkspacePicture(page, 1);
      await page.getByTestId("part-room:1:logic").click();
      await expect(
        page.getByTestId("workspace-logic-editor").locator(".monaco-editor"),
      ).toBeVisible({ timeout: DEADLINES.editor });
      const stacked = arrangement === "Stacked";
      const layout = page.getByTestId("workspace-layout");
      await expect(layout).toBeVisible();
      if (!stacked) await layout.click();
      await expect(layout).toHaveAttribute("aria-pressed", stacked ? "false" : "true");
      const splitter = page.getByRole("separator", {
        name: stacked ? "Editor height" : "Editor width",
      });
      await expect(splitter).toBeVisible();
      const initial = (await splitter.getAttribute("aria-valuenow"))!;
      const box = (await splitter.boundingBox())!;
      const start: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
      const end: [number, number] = stacked
        ? [start[0], start[1] + 160]
        : [start[0] + 160, start[1]];
      await startWindow(page);
      await dragPerFrame(page, start, end, 60);
      const sample = await endWindow(page);
      await expect(splitter).not.toHaveAttribute("aria-valuenow", initial);
      await recordPerformance(`workspace-splitter-${stacked ? "stacked" : "side"}`, sample);
      expect(sample.frames).toBeGreaterThanOrEqual(30);
    },
  );
}
