import { expect, reviewShot, test } from "./test.ts";
import {
  blockProviders,
  focusEditor,
  focusScreen,
  openLogicOne,
  openStudio,
  prepareIsolatedPage,
  seedLocalProject,
  waitForFrame,
} from "./logicDebugShared.ts";

/**
 * The play lane's same-Engine live update, driven through the real app and
 * the real engine worker: an ordinary no-key Play session edits a compiled
 * LOGIC source and the new bytes take over the running preview without a
 * new worker, a new run or a lost step of gameplay state. An invalid draft
 * keeps the older build running under its honest label.
 *
 * This is the narrow Code-mount proof: worker and run identity come from
 * the dock's own published attributes, the updated effect is read back
 * through the run's held stop. The full four-family navigation proof stays
 * with the frame-integration owner.
 */
test("a completed LOGIC edit live-patches the running preview @webkit-desktop", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  const title = "Live update preview";
  await seedLocalProject(page, title);
  await page.reload();
  await openStudio(page, title);

  // Ordinary playtesting: the dock's Play boots the draft immediately on the
  // explicit play-preview lane — no entry stop, nothing armed.
  const dock = page.getByTestId("debug-test-dock");
  await page.getByTestId("logic-test").click();
  await expect(dock).toBeVisible();
  await dock.getByTestId("debug-end").click();
  await dock.getByTestId("debug-play").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Running", {
    timeout: 30_000,
  });
  await expect(dock.getByTestId("debug-kind")).toContainText("Play");
  await waitForFrame(page);
  const runSeq = await dock.getAttribute("data-run");
  const bootEpoch = await dock.getAttribute("data-epoch");

  // Walk: hold an arrow on the focused screen — ego leaves its boot
  // position and the cycle count climbs.
  await focusScreen(page);
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(700);
  await page.keyboard.up("ArrowRight");

  // Pause into a held stop and read the progressed state back.
  await dock.getByTestId("debug-pause").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped", {
    timeout: 15_000,
  });
  const evalInput = dock.getByTestId("debug-eval-input");
  const evalApply = dock.getByTestId("debug-eval-apply");
  const evaluate = async (expression: string): Promise<string> => {
    await evalInput.fill(expression);
    await evalApply.click();
    // Newest evaluation prepends: the first row names this expression once
    // the worker's reply lands.
    const row = dock.getByTestId("debug-evaluate").locator("p.debug-inspector__row").first();
    await expect(row).toContainText(expression, { timeout: 15_000 });
    return (await row.textContent()) ?? "";
  };
  const walked = await evaluate("object[0].x");
  expect(walked).not.toContain("= 80"); // boot x was 80 — the walk moved ego
  const xMatch = /= (\d+)/.exec(walked);
  expect(xMatch, walked).toBeTruthy();
  const egoX = Number(xMatch![1]);
  expect(egoX).toBeGreaterThan(80);
  expect(await evaluate("room")).toContain("= 1");
  const cyclesBefore = Number(/= (\d+)/.exec(await evaluate("cycle"))![1]);
  expect(cyclesBefore).toBeGreaterThan(0);
  expect(await evaluate("v42")).toContain("= 0");
  await dock.getByTestId("debug-continue").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Running");

  // The completed edit: a new line before return in logic 1 — typed verbatim
  // into the real editor, so the draft tick and the debounce run for real.
  await openLogicOne(page);
  await focusEditor(page);
  // Control+End lands past the trailing newline; the statement must go
  // before `return;`, on the line above it.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home");
  await page.keyboard.insertText("increment(v42);\n");
  await expect(dock.getByTestId("debug-stale")).toBeVisible();

  // The candidate proposes, commits at a quiet boundary and the pin flips —
  // the same runSeq and lane the whole way. The commit mints a fresh
  // debugger epoch, so data-epoch must move while data-run holds.
  await expect(dock.getByTestId("debug-stale")).toBeHidden({ timeout: 15_000 });
  await expect(dock.getByTestId("debug-update")).toBeHidden();
  await expect(dock.getByTestId("debug-phase")).toContainText("Running");
  expect(await dock.getAttribute("data-run")).toBe(runSeq);
  await expect(dock.getByTestId("debug-kind")).toContainText("Play");
  await expect.poll(() => dock.getAttribute("data-epoch"), { timeout: 10_000 }).not.toBe(bootEpoch);

  // The new bytes run on this engine and its state survived: v42 climbs,
  // ego's walked-in x and the cycle count held. The pause can land before
  // the first post-commit cycle finishes, so read v42 across held stops.
  let v42 = 0;
  let cyclesAfter = 0;
  for (let attempt = 0; attempt < 6 && v42 === 0; attempt++) {
    await page.waitForTimeout(600);
    await dock.getByTestId("debug-pause").click();
    await expect(dock.getByTestId("debug-phase")).toContainText("Stopped", {
      timeout: 15_000,
    });
    cyclesAfter = Number(/= (\d+)/.exec(await evaluate("cycle"))![1]);
    v42 = Number(/= (\d+)/.exec(await evaluate("v42"))![1]);
    if (v42 === 0) {
      await dock.getByTestId("debug-continue").click();
      await expect(dock.getByTestId("debug-phase")).toContainText("Running");
    }
  }
  expect(cyclesAfter).toBeGreaterThan(cyclesBefore);
  expect(v42).toBeGreaterThan(0);
  expect(await evaluate("object[0].x")).toContain(`= ${egoX}`);
  await dock.getByTestId("debug-continue").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Running");

  // A draft that cannot build keeps the committed build running — labelled,
  // never idled, same run.
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+KeyA" : "Control+KeyA");
  await page.keyboard.insertText("this is not logic\n");
  await expect(dock.getByTestId("debug-error")).toBeVisible({ timeout: 15_000 });
  await expect(dock.getByTestId("debug-older-build")).toContainText("Older build");
  await expect(dock.getByTestId("debug-phase")).toContainText("Running");
  expect(await dock.getAttribute("data-run")).toBe(runSeq);

  // The next valid draft resumes live updates on the same run. Brace-free
  // text: the editor auto-closes `{` inside an atomic insert and leaves a
  // stray `}` behind, which is a typing artifact, not a draft defect.
  const previousEpoch = await dock.getAttribute("data-epoch");
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+KeyA" : "Control+KeyA");
  await page.keyboard.insertText("assignn(v43, 5);\nreturn;\n");
  await expect
    .poll(() => dock.getAttribute("data-epoch"), { timeout: 15_000 })
    .not.toBe(previousEpoch);
  await expect(dock.getByTestId("debug-error")).toBeHidden();
  await expect(dock.getByTestId("debug-stale")).toBeHidden({ timeout: 15_000 });
  await expect(dock.getByTestId("debug-phase")).toContainText("Running");
  expect(await dock.getAttribute("data-run")).toBe(runSeq);
  await expect(page.getByTestId("logic-problems").locator(".logic-studio__problem")).toHaveCount(0);
  await page.waitForTimeout(600);
  await dock.getByTestId("debug-pause").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped");
  expect(await evaluate("v43")).toContain("= 5");
  await dock.getByTestId("debug-continue").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Running");
  await reviewShot(page, "logic-preview-update-1280");
  expect(pageErrors).toEqual([]);
  expect(providers.count()).toBe(0);
});
