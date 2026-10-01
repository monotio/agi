import { expect, test, reviewShot } from "./test.ts";
import {
  continueRun,
  focusEditor,
  openLogicOne,
  openStudio,
  pauseToStop,
  prepareIsolatedPage,
  seedLocalProject,
  startDebugRun,
} from "./logicDebugShared.ts";

// The laptop design corrections: an opened comparison must actually be seen,
// analysis findings fold without losing their severity, and the held stop
// leads with guidance instead of raw protocol detail.

test.use({ viewport: { width: 1280, height: 720 } });

test("opening the running-source comparison reveals and focuses it @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Clarity lab");
  await page.reload();
  await openStudio(page, "Clarity lab");
  const editor = await openLogicOne(page);
  const dock = await startDebugRun(page);

  // A real draft edit first: the comparison opens against a moved-on draft.
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await page.keyboard.type("// drafted beside the frozen run\n");
  await expect(dock.getByTestId("debug-stale")).toContainText("Draft changed");

  const toggle = dock.getByTestId("debug-diff-toggle");
  await toggle.click();
  const diff = page.getByTestId("debug-diff-view");
  await expect(diff).toBeVisible();

  // The dock's scroll region must actually show the comparison — mounted but
  // parked below the fold is not open for a laptop user.
  const visibleHeight = await diff.evaluate((element) => {
    const scroller = element.closest(".debug-dock__scroll");
    if (!scroller) return 0;
    const s = scroller.getBoundingClientRect();
    const r = element.getBoundingClientRect();
    return Math.max(0, Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top));
  });
  expect(visibleHeight, "the comparison must be scrolled into view").toBeGreaterThanOrEqual(80);

  // Focus lands on the comparison's heading, and the toggle advertises state.
  await expect(diff.locator(".debug-diff__heading")).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await reviewShot(page, "debug-clarity-diff-reveal");

  // Closing hands focus back to the toggle and unmounts the comparison.
  await toggle.click();
  await expect(diff).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // The editor still holds its laptop share after the round trip.
  const editorHeight = await editor.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(0, rect.top));
  });
  expect(editorHeight).toBeGreaterThanOrEqual(160);
  expect(errors).toEqual([]);
});

test("analysis notes fold into a disclosure while build errors stay loud @webkit-desktop", async ({
  page,
}) => {
  // Two full flows (run, fold, then a real failing build) — allow headroom
  // when the desktop WebKit project runs multiple workers at once.
  test.slow();
  await prepareIsolatedPage(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Notes lab");
  await page.reload();
  await openStudio(page, "Notes lab");
  await openLogicOne(page);
  const dock = await startDebugRun(page);

  // The untouched starter template resolves several dynamic opcode targets at
  // runtime — the build keeps them as non-blocking analysis notes, folded.
  const notes = dock.getByTestId("debug-notes");
  const summary = notes.locator("summary");
  await expect(summary).toHaveText(/^\d+ analysis notes?$/);
  const noteCount = Number(/(\d+)/.exec((await summary.innerText()).trim())?.[1]);
  expect(noteCount).toBeGreaterThan(0);
  expect(await notes.getAttribute("open")).toBeNull();
  // No error list — nothing is blocking this build.
  await expect(dock.getByTestId("debug-diagnostics")).toBeHidden();
  await reviewShot(page, "debug-clarity-notes-folded");

  // Keyboard users expand the group the same way pointer users do.
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(notes).toHaveJSProperty("open", true);
  const items = notes.locator("li");
  await expect(items).toHaveCount(noteCount);
  // Severity and content survive the fold — these are warnings, not errors.
  await expect(items.first()).toContainText("warning");
  await expect(notes).toContainText("unresolved");
  await reviewShot(page, "debug-clarity-notes-open");

  // A genuine build error is never folded away: it stops the test and stays
  // prominent beside the alert.
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type("\ncall(99);\n");
  await dock.getByTestId("debug-restart").click();
  await expect(dock.getByTestId("debug-error")).toContainText("block");
  const errorList = dock.getByTestId("debug-diagnostics");
  await expect(errorList).toBeVisible();
  await expect(errorList).toContainText("LOGIC 99");
  await reviewShot(page, "debug-clarity-build-error");
  expect(errors).toEqual([]);
});

test("the held stop leads with guidance and folds its run details @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Guidance lab");
  await page.reload();
  await openStudio(page, "Guidance lab");
  await openLogicOne(page);
  await startDebugRun(page);

  const section = page.getByTestId("debug-stop-section");
  // The entry hold is provable: stopOnEntry is always set, so stop #1 with no
  // trigger reason is the hold before the first game cycle.
  await expect(section.getByTestId("debug-stop-headline")).toContainText("first game cycle");
  const details = section.getByTestId("debug-stop-details");
  expect(await details.getAttribute("open")).toBeNull();
  await reviewShot(page, "debug-clarity-stop-headline");

  // Identity stays available inside the disclosure: serial, cause, build,
  // epoch and profile.
  await details.locator("summary").click();
  await expect(details).toContainText("stop #1");
  await expect(details).toContainText("epoch 1");
  await expect(details).toContainText("build ");
  await reviewShot(page, "debug-clarity-stop-details");

  // A mid-run pause reports the generic stopped state — no invented
  // "before your code starts" claim.
  await continueRun(page);
  await pauseToStop(page);
  await expect(section.getByTestId("debug-stop-headline")).toContainText("Test paused");
  await expect(section.getByTestId("debug-stop-headline")).toContainText("Continue");
  await expect(details).toContainText("stop #2");
  expect(errors).toEqual([]);
});
