import { expect, test } from "@playwright/test";
import { fixtureSkip, KNOWN_GAME_HASH } from "../../test/fixtures.ts";
import { loadGame } from "../../test/game-fixture.ts";
import { cacheGame, enterCreateMode } from "./engineProbe.ts";
import { testProjectId } from "../test/identity.ts";

interface ScanProbe {
  tasks: { start: number; duration: number }[];
  events: { phase: string; at: number; elapsed: number }[];
  frames: number;
}

test.use({ headless: true, viewport: { width: 1440, height: 900 } });
for (const activity of ["map", "Create"] as const) {
  test(
    `PQ1 ${activity} resolves room paths in a worker without a scan long task`,
    { tag: "@perf" },
    async ({ page }) => {
      const missing = fixtureSkip(KNOWN_GAME_HASH.PQ1);
      test.skip(Boolean(missing), missing || "");
      await page.addInitScript(() => {
        const probe: ScanProbe = { tasks: [], events: [], frames: 0 };
        (window as unknown as { __ROOM_SCAN__: ScanProbe }).__ROOM_SCAN__ = probe;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            probe.tasks.push({ start: entry.startTime, duration: entry.duration });
        }).observe({ type: "longtask", buffered: true });
        const NativeWorker = Worker;
        window.Worker = new Proxy(NativeWorker, {
          construct(Target, args: ConstructorParameters<typeof Worker>) {
            const worker = new Target(...args);
            if (!String(args[0]).includes("roomAnalysis.worker")) return worker;
            let since = 0;
            const post = worker.postMessage.bind(worker);
            worker.postMessage = (message: unknown) => {
              since = performance.now();
              probe.events.push({ phase: "post", at: since, elapsed: 0 });
              post(message);
            };
            worker.addEventListener("message", (event: MessageEvent<{ phase: string }>) => {
              probe.events.push({
                phase: event.data.phase,
                at: performance.now(),
                elapsed: performance.now() - since,
              });
            });
            return worker;
          },
        });
        const tick = (): void => {
          probe.frames++;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const { files } = loadGame(KNOWN_GAME_HASH.PQ1, { interpreterFiles: true });
      await page.goto("/");
      await cacheGame(page, {
        projectId: testProjectId(`pq1-scan-${activity}`),
        title: "Police Quest",
        imported: true,
        files: Object.fromEntries(files),
        words: [],
      });
      await page.reload();
      await page.getByTestId("btn-resume-cached").click();
      await expect(page.getByTestId("input-line")).toBeVisible();
      expect(
        await page.evaluate(
          () => (window as unknown as { __ROOM_SCAN__: ScanProbe }).__ROOM_SCAN__.events,
        ),
      ).toEqual([]);
      const firstFrame = await page.evaluate(
        () => (window as unknown as { __ROOM_SCAN__: ScanProbe }).__ROOM_SCAN__.frames,
      );
      if (activity === "map") {
        await page.getByTestId("btn-world-map").click();
        await expect(page.getByTestId("world-map")).toBeVisible();
        await page.getByTestId("btn-world-plan").click();
      } else await enterCreateMode(page);
      const surface = page.getByTestId(activity === "map" ? "world-map" : "parts-list");
      await expect(surface).toBeVisible();
      await expect(surface).toHaveAttribute("data-analysis", "resolved");
      const probe = await page.evaluate(async () => {
        for (let n = 0; n < 2; n++) await new Promise(requestAnimationFrame);
        return (window as unknown as { __ROOM_SCAN__: ScanProbe }).__ROOM_SCAN__;
      });
      expect(probe.events.map((event) => event.phase)).toEqual(["post", "literal", "resolved"]);
      // These are the tasks containing scan dispatch or a worker reply, including
      // the resulting reactive flush. Other editor startup tasks are independent.
      const scanTasks = probe.tasks.filter((task) =>
        probe.events.some(
          (event) => event.at >= task.start && event.at < task.start + task.duration,
        ),
      );
      expect(scanTasks, "main-thread scan dispatch/reply tasks over 50 ms").toEqual([]);
      expect(probe.frames - firstFrame).toBeGreaterThan(1);
      console.log(
        `[room-scan] ${activity} literal=${probe.events[1]!.elapsed.toFixed(1)}ms resolved=${probe.events[2]!.elapsed.toFixed(1)}ms scanLongTasks=${scanTasks.length}`,
      );
      if (activity === "map") {
        await expect(page.getByTestId("map-room-119")).toBeVisible();
      } else {
        await expect(page.getByTestId("part-room:119")).toBeVisible();
      }
      for (const [width, height] of [
        [1063, 815],
        [1440, 900],
        [390, 844],
      ] as const) {
        await page.setViewportSize({ width, height });
        if (width === 390 && activity === "Create") {
          await page.getByTestId("btn-world-map").click();
          await expect(page.getByTestId("world-map")).toBeVisible();
        } else await expect(surface).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`pq1-${activity}-${width}.png`) });
      }
    },
  );
}
