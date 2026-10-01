import { expect, test } from "./test.ts";
import {
  blockProviders,
  caretToLine,
  continueRun,
  focusEditor,
  focusScreen,
  openLogicOne,
  openStudio,
  pauseToStop,
  prepareIsolatedPage,
  seedLocalProject,
  startDebugRun,
} from "./logicDebugShared.ts";

/**
 * The inspector's form round-trips against the real worker: breakpoint
 * conditions and hit policies gate real stops, a logpoint writes to the
 * run's log without stopping, a watchpoint breaks on an actual flag change,
 * and set-values writes into the held run — every row reflecting the
 * worker's published status, never a local guess.
 */

const BP_ID = "logic:1:24";

test("conditions, hit policies, logpoints, watches and set-values round-trip", async ({ page }) => {
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Forms lab");
  await page.reload();
  await openStudio(page, "Forms lab");
  const editor = await openLogicOne(page);
  const dock = await startDebugRun(page);

  const breakpoints = page.getByTestId("debug-inspector").locator("details", {
    hasText: "Breakpoints",
  });
  await breakpoints.locator("summary").click();

  // F9 on the `said("look")` line toggles the real breakpoint.
  await caretToLine(page, 24);
  await page.keyboard.press("F9");
  const bpStatus = breakpoints.getByTestId(`debug-bp-status-${BP_ID}`);
  await expect(bpStatus).toContainText("bound");

  // Edit it: a condition that is true in room 1 plus hit >= 3 — the first
  // two encounters pass through, the third stops.
  await breakpoints.getByTestId(`debug-bp-edit-${BP_ID}`).click();
  await breakpoints.getByTestId(`debug-bp-condition-${BP_ID}`).fill("v0 == 1");
  await breakpoints.getByTestId(`debug-bp-hitkind-${BP_ID}`).selectOption("atLeast");
  await breakpoints.getByTestId(`debug-bp-hitcount-${BP_ID}`).fill("3");
  await breakpoints.getByTestId(`debug-bp-apply-${BP_ID}`).click();
  await expect(bpStatus).toContainText("bound");

  await continueRun(page);
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("debug-stop-reasons")).toContainText(
    "breakpoint logic:1:24 (hit 3)",
  );
  await expect(page.getByTestId("debug-goto-source")).toContainText("logic:1:24");

  // A false condition refuses to stop: re-edit, gate on a never-true clause.
  await breakpoints.getByTestId(`debug-bp-edit-${BP_ID}`).click();
  await breakpoints.getByTestId(`debug-bp-condition-${BP_ID}`).fill("v0 == 99");
  await breakpoints.getByTestId(`debug-bp-hitkind-${BP_ID}`).selectOption("");
  await breakpoints.getByTestId(`debug-bp-hitcount-${BP_ID}`).fill("");
  await breakpoints.getByTestId(`debug-bp-apply-${BP_ID}`).click();
  await continueRun(page);
  await expect(dock.getByTestId("debug-phase")).not.toContainText("Stopped");
  await pauseToStop(page);
  await expect(page.getByTestId("debug-stop-reasons")).not.toContainText("breakpoint");

  // A logpoint on the next statement logs without stopping.
  await caretToLine(page, 25);
  await page.keyboard.press("F9");
  const logId = "logic:1:25";
  await breakpoints.getByTestId(`debug-bp-edit-${logId}`).click();
  await breakpoints.getByTestId(`debug-bp-log-${logId}`).fill("tick room={v0}");
  await breakpoints.getByTestId(`debug-bp-apply-${logId}`).click();
  await expect(breakpoints.getByTestId(`debug-bp-status-${logId}`)).toContainText("bound");
  await continueRun(page);
  // The Log section opens itself once entries exist.
  const logBody = page.getByTestId("debug-log");
  await expect(logBody.locator("..")).toHaveAttribute("open", "", { timeout: 15_000 });
  await expect(logBody).toContainText("tick room=1", {
    timeout: 15_000,
  });
  // Logpoints observe; they never stop the run.
  await expect(dock.getByTestId("debug-phase")).not.toContainText("Stopped");

  // A watchpoint on f4 stops when the flag actually changes. Submitting a
  // parser line flips the said-matched flag inside the engine.
  const watches = page.getByTestId("debug-inspector").locator("details", {
    hasText: "Watches",
  });
  await watches.locator("summary").click();
  await page.getByTestId("debug-watch-target").fill("f4");
  await page.getByTestId("debug-watch-add").click();
  const watchRow = watches.getByTestId("debug-watch-watch:1");
  await expect(watchRow).toContainText("f4");
  await expect(watchRow).toContainText("0 changes");
  await page.getByTestId("debug-command-input").fill("look");
  await page.getByTestId("debug-command-input").press("Enter");
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("debug-stop-reasons")).toContainText("watchpoint");
  await expect(watchRow).toContainText(/[1-9]\d* change/);
  await watches.getByTestId("debug-watch-remove-watch:1").click();
  await expect(watchRow).toHaveCount(0);

  // Set-values writes into the held run and marks it modified.
  await page.getByTestId("debug-set-target").fill("v60");
  await page.getByTestId("debug-set-value").fill("5");
  await page.getByTestId("debug-set-apply").click();
  await expect(page.getByTestId("debug-modified")).toBeVisible();
  await expect(dock.getByTestId("debug-modified-chip")).toBeVisible();
  await expect(page.getByTestId("debug-values")).toContainText("v60=5");

  // Source navigation reveals the held stop's authored line in the editor.
  await page.getByTestId("debug-goto-source").click();
  await expect(editor.locator(".debug-line-stop")).toBeVisible();

  // Run-to-cursor binds against the frozen map and stops on the target line.
  // The stop navigation may have switched the editor to logic:0 — re-open
  // the room logic so the cursor lands on the right document.
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
  await expect(page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1")).toHaveClass(
    /logic-explorer__item--active/,
  );
  await caretToLine(page, 29);
  await dock.getByTestId("debug-run-cursor").click();
  // The pending `print(m1)` opens a modal message window before the cycle
  // reaches line 29: while the run parks on that window no boundaries flow,
  // so keep pressing Enter until it is dismissed and the run-to stop lands.
  const reasons = page.getByTestId("debug-stop-reasons");
  await focusScreen(page);
  await expect(async () => {
    await page.keyboard.press("Enter");
    await expect(reasons).toContainText("run to cursor", { timeout: 500 });
  }).toPass({ timeout: 20_000 });
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped");
  await expect(page.getByTestId("debug-goto-source")).toContainText("logic:1:29");

  await dock.getByTestId("debug-end").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Ended");
  expect(providers.count()).toBe(0);
  expect(errors).toEqual([]);
});

test("run-to-cursor refuses when the draft moved past the frozen build", async ({ page }) => {
  await prepareIsolatedPage(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Stale lab");
  await page.reload();
  await openStudio(page, "Stale lab");
  await openLogicOne(page);
  const dock = await startDebugRun(page);

  // Edit the draft — the frozen run stays pinned and run-to-cursor refuses.
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await page.keyboard.insertText("// moved on\n");
  await expect(dock.getByTestId("debug-stale")).toContainText("Draft changed");
  await dock.getByTestId("debug-run-cursor").click();
  await expect(page.getByTestId("debug-runto-verdict")).toContainText("moved", {
    timeout: 10_000,
  });

  await dock.getByTestId("debug-end").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Ended");
  expect(errors).toEqual([]);
});
