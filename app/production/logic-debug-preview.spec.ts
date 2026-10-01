import { expect, test } from "@playwright/test";
import { isolateStorage } from "../e2e/engineProbe.ts";
import {
  blockProviders,
  continueRun,
  createProjectViaUi,
  dismissModal,
  focusEditor,
  focusScreen,
  litPixelsInShot,
  openLogicOne,
  openStudio,
  pauseToStop,
  startDebugRun,
} from "../e2e/logicDebugShared.ts";

/**
 * The Logic Studio debugger against the BUILT app: the static bundle, the
 * real production engine worker chunk, and the production preview path —
 * `MODE=production`, so the 2D probe canvas is only a fallback and the GPU
 * stage (WebGPU or WebGL2) is the compositor when the browser has one.
 * Pixels are read out of real PNG screenshots: a GPU canvas cannot be
 * probed by getImageData, so the backend identity is reported by
 * `data-backend` and the rendered bytes are proven by decoded screenshot
 * pixels — never asserted "webgpu" when the machine only gave a context.
 */

test("the production build runs a real debugger session on the real worker", async ({ page }) => {
  await isolateStorage(page);
  const providers = blockProviders(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const workerRequests: string[] = [];
  page.on("request", (request) => {
    if (/\.js/.test(new URL(request.url()).pathname) && /worker|engine/.test(request.url()))
      workerRequests.push(new URL(request.url()).pathname);
  });
  await page.goto("/");

  // Seed through the visible create form — production has no /src modules.
  await createProjectViaUi(page, "Production debug");
  await openStudio(page, "Production debug");
  await openLogicOne(page);

  // Test boots the real production worker; the entry stop is the engine's
  // own idle park — the run is held before any gameplay cycle.
  const dock = await startDebugRun(page);
  await expect(page.getByTestId("debug-no-source")).toBeVisible();
  expect(workerRequests.length, "a worker chunk was fetched").toBeGreaterThan(0);

  // The preview presents a real frame: decoded screenshot pixels are lit,
  // and the backend identity is whatever the machine actually gave.
  await expect(page.getByTestId("debug-game")).toHaveAttribute("data-has-frame", "true", {
    timeout: 30_000,
  });
  const backend = await page.getByTestId("debug-game").getAttribute("data-backend");
  expect(["webgpu", "webgl2", "2d"]).toContain(backend);
  const lit = await litPixelsInShot(page, "debug-game-screen");
  expect(lit, "the composed frame is not black").toBeGreaterThan(0);
  // Engine text is bytes inside the frame: the screen element contains only
  // canvases — there is no DOM text node for game text at all.
  const domText = await page
    .getByTestId("debug-game-screen")
    .evaluate((el) => el.textContent?.trim() ?? "");
  expect(domText).toBe("");

  // Continue → the run plays; pause → a real input stop with worker state.
  // said("look") opens print(m1), a key-wait window that parks the
  // interpreter — close it before pausing so cycles stay live.
  await continueRun(page);
  const screen = await focusScreen(page);
  await page.keyboard.type("look", { delay: 30 });
  await page.keyboard.press("Enter");
  await expect(screen).toHaveAttribute("data-modal", "print", { timeout: 15_000 });
  await dismissModal(page);
  await pauseToStop(page);
  const parser = page.getByTestId("debug-inspector").locator("details", {
    hasText: "Parser and objects",
  });
  await parser.locator("summary").click();
  await expect(page.getByTestId("debug-parser")).toContainText('input: "look"', {
    timeout: 15_000,
  });
  await expect(page.getByTestId("debug-values")).toContainText("v0=1");

  // A source breakpoint through the editor: caret to the said("look") line
  // — no dev bridge, so the published bound row proves the line landed.
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  for (let i = 0; i < 23; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("F9");
  const breakpoints = page
    .getByTestId("debug-inspector")
    .locator("details", { hasText: "Breakpoints" });
  await breakpoints.locator("summary").click();
  await expect(breakpoints.getByTestId("debug-bp-status-logic:1:24")).toContainText("bound");
  // said() is evaluated every cycle, so the bound statement stops again
  // within a cycle — the Running transition is too brief to observe. The
  // fresh stop's reason and source row are the honest signals instead.
  await dock.getByTestId("debug-continue").click();
  await expect(page.getByTestId("debug-stop-reasons")).toContainText("breakpoint", {
    timeout: 20_000,
  });
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped");
  await expect(page.getByTestId("debug-goto-source")).toContainText("logic:1:24");

  // A draft edit marks the frozen build stale; Retest freezes the new draft.
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await page.keyboard.insertText("// production draft change\n");
  await expect(dock.getByTestId("debug-stale")).toContainText("Draft changed");
  await dock.getByTestId("debug-restart").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped", {
    timeout: 30_000,
  });
  await expect(dock.getByTestId("debug-stale")).toBeHidden();

  // Same-build restart admits a fresh run on the pinned image: the worker
  // epoch restarts at 1 on a new worker, so the workspace's monotonic run
  // counter is the honest replacement signal; End tears the run down.
  const runBefore = Number(await dock.getAttribute("data-run"));
  await dock.getByTestId("debug-replay").click();
  await expect
    .poll(async () => Number(await dock.getAttribute("data-run")), {
      timeout: 30_000,
    })
    .toBeGreaterThan(runBefore);
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped", {
    timeout: 30_000,
  });
  await dock.getByTestId("debug-end").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Ended");
  await dock.getByTestId("debug-close").click();
  await expect(dock).toBeHidden();

  expect(providers.count()).toBe(0);
  expect(errors).toEqual([]);
  expect(backend).not.toBeNull();
  test.info().annotations.push({
    type: "backend",
    description: `preview backend: ${backend}`,
  });
});
