import { expect, test, reviewShot } from "./test.ts";
import { observe } from "./engineProbe.ts";
import {
  blockProviders,
  continueRun,
  dismissModal,
  egoPosition,
  expectNoModal,
  focusScreen,
  openLogicOne,
  openStudio,
  pauseToStop,
  prepareIsolatedPage,
  seedLocalProject,
  startDebugRun,
  waitForFrame,
} from "./logicDebugShared.ts";

/**
 * The test run's runtime input: raw keys echo into the engine's own input
 * row, completed lines parse through the real parser, arrow keys walk ego,
 * and the preview chrome reports the engine's waits — none of it simulated
 * and none of it reaching the parked live game.
 */

test("parser input, directions and the engine's own input row reach the test run", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Input lab");
  await page.reload();
  await openStudio(page, "Input lab");
  await openLogicOne(page);
  const dock = await startDebugRun(page);
  await continueRun(page);
  await waitForFrame(page);

  // The engine reports its input row is enabled — the command box appears.
  const command = page.getByTestId("debug-command-input");
  await expect(command).toBeVisible();

  // Raw keys type into the engine's own row: the inputEdit mirror the worker
  // publishes is the engine's echo, not a DOM edit box.
  const screen = await focusScreen(page);
  await page.keyboard.type("look", { delay: 40 });
  await expect(page.getByTestId("debug-input-edit")).toContainText("look", {
    timeout: 10_000,
  });
  await page.keyboard.press("Enter");
  // Enter submits; the engine's own row clears once the line is consumed —
  // the mirror only renders while the row has text.
  await expect(page.getByTestId("debug-input-edit")).toBeHidden({
    timeout: 10_000,
  });
  // The parse matched `said("look")` and opened the m1 message window — the
  // modal kind rides the presented frame, so the run parks honestly.
  await expect(screen).toHaveAttribute("data-modal", "print", { timeout: 15_000 });

  // The parser consumed it. Stop and read the worker's published report.
  await pauseToStop(page);
  const parser = page.getByTestId("debug-inspector").locator("details", {
    hasText: "Parser and objects",
  });
  await parser.locator("summary").click();
  await expect(page.getByTestId("debug-parser")).toContainText('input: "look"', {
    timeout: 15_000,
  });
  await expect(page.getByTestId("debug-parser")).toContainText("words: look");

  // Directions move ego through the real input surface — ArrowDown walks
  // south once the held print window is dismissed; sixty browser frames is
  // long enough for several interpreter cycles of walking before the release
  // keyup and the pause.
  const before = await egoPosition(page);
  await continueRun(page);
  await screen.click();
  await dismissModal(page);
  await page.keyboard.down("ArrowDown");
  await observe(page, 60);
  await page.keyboard.up("ArrowDown");
  await pauseToStop(page);
  const moved = await egoPosition(page);
  expect(moved.y).toBeGreaterThan(before.y);

  // A completed line through the command box submits as one parser line.
  await continueRun(page);
  await command.fill("help");
  await command.press("Enter");
  // said("help") opens its message window — proof the line reached the parser.
  await expect(screen).toHaveAttribute("data-modal", "print", { timeout: 15_000 });
  await pauseToStop(page);
  await expect(page.getByTestId("debug-parser")).toContainText('input: "help"', {
    timeout: 15_000,
  });
  await expect(page.getByTestId("debug-parser")).toContainText("words: help");

  // The ESC menu key reaches the engine — its modal surface rides the frame.
  await continueRun(page);
  await screen.click();
  await dismissModal(page);
  await page.keyboard.press("Escape");
  await expect(screen).toHaveAttribute("data-modal", "menu", { timeout: 15_000 });
  await reviewShot(page, "debug-input-menu");
  await page.keyboard.press("Escape");
  await expectNoModal(page);

  await dock.getByTestId("debug-end").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Ended");
  expect(providers.count()).toBe(0);
  expect(errors).toEqual([]);
});

test("the dock stays usable at a narrow width and from the keyboard @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 520 });
  await prepareIsolatedPage(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Narrow desk");
  await page.reload();
  await openStudio(page, "Narrow desk");
  await openLogicOne(page);
  const dock = await startDebugRun(page);
  await reviewShot(page, "debug-narrow-entry");

  // Keyboard-only: F5 continues the held run out of its entry stop.
  await dock.press("F5");
  await expect(dock.getByTestId("debug-phase")).not.toContainText("Stopped");

  // The strip still exposes the execution controls at 720px.
  await expect(dock.getByTestId("debug-pause")).toBeVisible();
  await expect(dock.getByTestId("debug-step-over")).toBeVisible();
  await expect(dock.getByTestId("debug-end")).toBeVisible();
  await dock.getByTestId("debug-pause").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped");
  await reviewShot(page, "debug-narrow-stopped");

  // F10 steps one statement from the keyboard.
  await dock.press("F10");
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped");
  await reviewShot(page, "debug-narrow-stepped");

  await dock.getByTestId("debug-end").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Ended");
  expect(errors).toEqual([]);
});
