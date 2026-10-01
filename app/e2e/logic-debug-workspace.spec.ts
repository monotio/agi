import { expect, test, reviewShot } from "./test.ts";
import { isolateStorage, observe, savedGameCard, textHook } from "./engineProbe.ts";
import { openStudio, seedLocalProject } from "./logicDebugShared.ts";

/**
 * The Logic Studio test workspace: a real compiled draft in an isolated
 * worker, debugger stops mapped back to authored source, a private GPU
 * preview and private audio — none of it touching the kept game or needing
 * an AI provider.
 */

test("a stored starter draft tests, stops on an authored line, inspects, edits stale, retests and keeps @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Debug me");
  await page.reload();
  await openStudio(page, "Debug me");

  const explorer = page.getByTestId("logic-explorer");
  const editor = page.getByTestId("logic-editor");
  await explorer.getByTestId("logic-doc-logic:1").click();
  await expect(editor.locator(".view-lines")).toContainText("sunny clearing");

  // Test builds the complete draft and parks on the engine's first tick.
  await page.getByTestId("logic-test").click();
  const dock = page.getByTestId("debug-test-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped", {
    timeout: 30_000,
  });
  // The entry stop is an idle park between cycles: honest, no invented line.
  await expect(page.getByTestId("debug-no-source")).toBeVisible();
  await expect(dock.getByTestId("debug-stale")).toBeHidden();
  await reviewShot(page, "debug-workspace-entry");

  // The private preview is a real canvas — its own stage, not the live game.
  await expect(page.getByTestId("debug-game-screen")).toBeVisible();

  // F9 on the `said("look")` statement toggles a real source breakpoint. Monaco
  // renders only visible lines, so walk the caret to line 24 deterministically.
  // Focus the editor's own input: a content click does not reliably focus
  // Monaco across engines, and the focusable node differs — EditContext in
  // Chromium, a plain textarea where EditContext is unavailable.
  await editor.locator("textarea.inputarea, .native-edit-context").first().focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  for (let i = 0; i < 23; i++) await page.keyboard.press("ArrowDown");
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __AGI_LOGIC__?: { cursor(): { line: number; column: number } | undefined };
            }
          ).__AGI_LOGIC__?.cursor()?.line,
      ),
    )
    .toBe(24);
  await page.keyboard.press("F9");
  const breakpoints = page.getByTestId("debug-breakpoints");
  await expect(breakpoints.locator("[data-testid^='debug-bp-status-']")).toHaveCount(1);
  await expect(breakpoints.locator("[data-testid^='debug-bp-status-']")).toContainText("bound");

  // Continue to the breakpoint: the stop names the authored line and the
  // editor reveals it with the execution decoration.
  await dock.getByTestId("debug-continue").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped");
  await expect(page.getByTestId("debug-goto-source")).toContainText("logic:1:24");
  await expect(editor.locator(".debug-line-stop")).toBeVisible();
  await reviewShot(page, "debug-workspace-stopped");

  // Real runtime values: the starter entered room 1 (v0), ego is placed.
  const values = page.getByTestId("debug-values");
  await expect(values).toContainText("room 1");
  await expect(values).toContainText("v0=1");

  // Evaluation is side-effect-free against the held stop.
  await page.getByTestId("debug-eval-input").fill("v0");
  await page.getByTestId("debug-eval-apply").click();
  await expect(page.getByTestId("debug-evaluate")).toContainText("v0 = 1");

  // Stepping stays inside the frozen run and refreshes the held stop. One
  // cycle step lets the engine present a real composed frame to the preview.
  await dock.getByTestId("debug-step-over").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped");
  await dock.getByTestId("debug-step-cycle").click();
  await expect(page.getByTestId("debug-game")).toHaveAttribute("data-has-frame", "true", {
    timeout: 20_000,
  });
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>("[data-testid='debug-canvas']")!;
          const px = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let i = 0; i < px.length; i += 4)
            if (px[i]! || px[i + 1]! || px[i + 2]!) return true;
          return false;
        }),
      { timeout: 20_000 },
    )
    .toBe(true);

  // Editing the draft must not touch the pinned run: the stale chip and the
  // running-source diff tell the truth. The edit goes at the top so it stays
  // inside the diff editor's rendered viewport.
  await editor.locator("textarea.inputarea, .native-edit-context").first().focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await page.keyboard.type("// drafted while the test stays pinned\n");
  await expect(dock.getByTestId("debug-stale")).toContainText("Draft changed");
  await dock.getByTestId("debug-diff-toggle").click();
  await expect(page.getByTestId("debug-diff-view")).toBeVisible();
  await expect(page.getByTestId("debug-diff-view").locator(".modified .view-lines")).toContainText(
    "drafted while the test stays pinned",
  );
  await reviewShot(page, "debug-workspace-stale-diff");

  // An explicit Test runs the latest draft — the stale marker clears and the
  // comment is now part of the frozen source.
  await dock.getByTestId("debug-restart").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped", {
    timeout: 30_000,
  });
  await expect(dock.getByTestId("debug-stale")).toBeHidden();

  // End the run; the dock stays usable and the worker is gone.
  await dock.getByTestId("debug-end").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Ended");
  await dock.getByTestId("debug-close").click();
  await expect(dock).toBeHidden();

  // The draft edit is still an unkept change; Keep it and it persists.
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");
  await page.getByTestId("logic-review-build").click();
  const review = page.getByTestId("logic-review-dialog");
  await expect(review).toBeVisible();
  await review.getByTestId("logic-keep-confirm").click();
  await expect(page.getByTestId("logic-saved-note")).toContainText("Saved to the library");
  const stored = await page.evaluate(async (id) => {
    const storage = await import("/src/project/gameStorage.ts");
    const { inspectEditableProject } = await import("/src/project/projectWorkspaceSource.ts");
    const data = await storage.loadAuthoredGame(id as never);
    const document = data ? inspectEditableProject(data).documents["logic:1"] : null;
    return typeof document === "string" ? document : null;
  }, projectId);
  expect(stored).toContain("drafted while the test stays pinned");
  expect(providerCalls).toBe(0);
  expect(errors).toEqual([]);
});

test("the test run keeps the live game parked and ends cleanly on close", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Play then test", "blank");
  await page.reload();

  // A real live game runs behind the editor.
  await savedGameCard(page, "Play then test")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(0);

  // The shell bridge opens the workspace over the running game, parked.
  await page.evaluate(
    (id) =>
      (
        window as {
          __AGI_LOGIC__?: { open(projectId: string): void };
        }
      ).__AGI_LOGIC__?.open(id),
    projectId,
  );
  await expect(page.getByTestId("logic-studio")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);

  // Start the isolated test: the live game stays parked, the test stops.
  await page.getByTestId("logic-test").click();
  const dock = page.getByTestId("debug-test-dock");
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped", {
    timeout: 30_000,
  });
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);

  // The test's keyboard surface is scoped to the dock; the parked live game
  // never advances. F5 continues the test out of its entry stop.
  const parkedCycle = (await textHook(page)).cycle;
  await dock.press("F5");
  await expect(dock.getByTestId("debug-phase")).not.toContainText("Stopped");
  await observe(page, 30);
  expect((await textHook(page)).cycle).toBe(parkedCycle);
  expect((await textHook(page)).paused).toBe(true);

  // Pause the test again — a real stop with a fresh stop identity.
  await dock.getByTestId("debug-pause").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped");
  await expect(page.getByTestId("debug-stop-section")).toContainText("#2");
  expect((await textHook(page)).paused).toBe(true);

  // End it: only the test's lease and worker go away.
  await dock.getByTestId("debug-end").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Ended");
  await dock.getByTestId("debug-close").click();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);

  // Closing the studio releases every hold; the same live game resumes. No
  // draft edits happened, so the leave guard does not appear.
  await page.getByTestId("logic-close").click();
  await expect(page.getByTestId("logic-studio")).toBeHidden();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(parkedCycle);
});
