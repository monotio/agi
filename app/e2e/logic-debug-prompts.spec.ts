import { expect, test, reviewShot } from "./test.ts";
import type { Page } from "@playwright/test";
import { observe } from "./engineProbe.ts";
import {
  blockProviders,
  continueRun,
  dismissModal,
  egoPosition,
  expectNoModal,
  focusEditor,
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
 * Host interaction through the real test run: get.string and get.num prompts
 * surface the engine's resolved message text, the save selector's private
 * ephemeral slots round-trip interpreter state, an answer queued on a held
 * stop applies on resume, and the death box restarts the interpreter in place.
 */

// Added to the draft before the first Test — the frozen build owns them.
// "examine"/"hint" share verb groups with the built-in look/help blocks, so
// each prompt is followed by the engine's own print window once it resumes.
const PROMPT_LINES = [
  '#message 5 "What is your name?"',
  '#message 6 "How many years?"',
  'if (said("examine")) { get.string(s5, m5, 22, 0, 30); }',
  'if (said("hint")) { get.num(6, v60); }',
  "",
];

async function addPromptCommands(page: Page): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  // insertText is a direct content insertion — Monaco's pair-completion
  // never fires on it, so braces and quotes land verbatim.
  await page.keyboard.insertText(PROMPT_LINES.join("\n"));
}

/** Drive the engine's save/restore selector keys through the preview. */
async function pickerKey(page: Page, key: string): Promise<void> {
  await page.getByTestId("debug-waiting-key").waitFor({ timeout: 15_000 });
  // Selector keys go to the engine through the focused screen — a just-closed
  // DOM prompt can leave focus on a detached button, so refocus every time.
  await focusScreen(page);
  await page.keyboard.press(key);
}

test("string and number prompts carry the engine's real message text @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Prompt lab");
  await page.reload();
  await openStudio(page, "Prompt lab");
  await openLogicOne(page);
  await addPromptCommands(page);
  const dock = await startDebugRun(page);
  await continueRun(page);

  // get.string: the prompt dialog shows the resolved message text.
  await page.getByTestId("debug-command-input").fill("examine");
  await page.getByTestId("debug-command-input").press("Enter");
  const prompt = page.getByTestId("debug-prompt");
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await expect(prompt).toContainText("What is your name?");
  await reviewShot(page, "debug-prompt-string");
  await page.getByTestId("debug-prompt-input").fill("Arthur");
  await page.getByTestId("debug-prompt-submit").click();
  await expect(prompt).toBeHidden();

  // The answer stored into the engine — the inspector reads s40.
  await pauseToStop(page);
  await expect(page.getByTestId("debug-values")).toContainText('s5 = "Arthur"', {
    timeout: 15_000,
  });

  // get.num: the numeric prompt accepts "42" and stores its byte in v60.
  // The same-group print window from "examine" is still parked — dismiss it.
  await continueRun(page);
  await focusScreen(page);
  await dismissModal(page);
  await page.getByTestId("debug-command-input").fill("hint");
  await page.getByTestId("debug-command-input").press("Enter");
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await expect(prompt).toContainText("How many years?");
  await page.getByTestId("debug-prompt-input").fill("42");
  await page.getByTestId("debug-prompt-submit").click();
  await pauseToStop(page);
  await expect(page.getByTestId("debug-values")).toContainText("v60=42");

  // An answer queued while the stop is held applies only on resume. The
  // help print window parked after "hint" gets dismissed first.
  await continueRun(page);
  await focusScreen(page);
  await dismissModal(page);
  await page.getByTestId("debug-command-input").fill("examine");
  await page.getByTestId("debug-command-input").press("Enter");
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  // The modal prompt blocks pointer access to Pause — the dock's F5 is the
  // honest keyboard route, bubbling up from the dialog to the dock section.
  await page.keyboard.press("F5");
  await expect(dock.getByTestId("debug-phase")).toContainText("Stopped");
  await page.getByTestId("debug-prompt-input").fill("Queued");
  await page.getByTestId("debug-prompt-submit").click();
  await expect(dock.getByTestId("debug-answers")).toContainText("1 answer queued");
  await expect(page.getByTestId("debug-answers-ready")).toContainText("queued");
  await continueRun(page);
  await pauseToStop(page);
  await expect(page.getByTestId("debug-values")).toContainText('s5 = "Queued"');

  await dock.getByTestId("debug-end").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Ended");
  expect(providers.count()).toBe(0);
  expect(errors).toEqual([]);
});

test("save and restore round-trip interpreter state through private test slots", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Save lab");
  await page.reload();
  await openStudio(page, "Save lab");
  await openLogicOne(page);
  const dock = await startDebugRun(page);
  await continueRun(page);
  await waitForFrame(page);
  const screen = await focusScreen(page);

  // Walk ego south, hold the position, then open the engine's save selector.
  await page.keyboard.down("ArrowDown");
  await observe(page, 50);
  await page.keyboard.up("ArrowDown");
  await pauseToStop(page);
  const savedPos = await egoPosition(page);
  await continueRun(page);
  await screen.click();

  // F5 → selector draws on the engine surface → Enter picks slot 1 → the
  // describe prompt is the DOM dialog → Enter confirms → the write lands.
  await page.keyboard.press("F5");
  await pickerKey(page, "Enter");
  const prompt = page.getByTestId("debug-prompt");
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("debug-prompt-input").fill("debug save");
  await page.getByTestId("debug-prompt-submit").click();
  await pickerKey(page, "Enter");
  await expect(dock.getByTestId("debug-saves")).toContainText("1 save in test", {
    timeout: 15_000,
  });

  // Move again, then F7 → the selector lists the private slot → Enter
  // restores the saved image: ego is back at the saved position.
  await page.keyboard.down("ArrowDown");
  await observe(page, 50);
  await page.keyboard.up("ArrowDown");
  await pauseToStop(page);
  const movedPos = await egoPosition(page);
  expect(movedPos.y).toBeGreaterThan(savedPos.y);
  await continueRun(page);
  await screen.click();
  await page.keyboard.press("F7");
  await pickerKey(page, "Enter");
  await pauseToStop(page);
  const restored = await egoPosition(page);
  expect(restored).toEqual(savedPos);

  // The slots are the test run's own: durable storage never got an entry.
  const durableSaves = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => /saves?\./i.test(key)),
  );
  expect(durableSaves).toEqual([]);

  await dock.getByTestId("debug-end").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Ended");
  expect(providers.count()).toBe(0);
  expect(errors).toEqual([]);
});

test("the death box is engine-drawn and restart mints a fresh epoch", async ({ page }) => {
  await prepareIsolatedPage(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Death lab");
  await page.reload();
  await openStudio(page, "Death lab");
  await openLogicOne(page);
  const dock = await startDebugRun(page);
  await continueRun(page);
  await waitForFrame(page);
  const screen = await focusScreen(page);
  // "die" runs the template's death logic: an engine-drawn box on the text
  // surface — a pixel change inside the composited frame, never DOM text.
  const shot = () => page.getByTestId("debug-game-screen").screenshot();
  const before = await shot();
  await page.getByTestId("debug-command-input").fill("die");
  await page.getByTestId("debug-command-input").press("Enter");
  // print(m3) opens a key-waiting window in front of the death box — dismiss
  // it with exactly one Enter: a second press would land in the box's v19
  // poll and select Restore instead.
  await expect(screen).toHaveAttribute("data-modal", "print", { timeout: 15_000 });
  await focusScreen(page);
  await page.keyboard.press("Enter");
  await expectNoModal(page);
  await expect
    .poll(async () => Buffer.compare(before, await shot()), { timeout: 15_000 })
    .not.toBe(0);
  await reviewShot(page, "debug-death-box");
  const deathFrame = await shot();
  const epochBefore = Number(await dock.getAttribute("data-epoch"));

  // The box's key menu: "2" selects Restart — restart.game() reboots the
  // engine in place with a fresh debug epoch: the death box disappears,
  // the room re-runs its entry block, and a held stop shows the reset state.
  await page.keyboard.press("2");
  await expect
    .poll(async () => Buffer.compare(deathFrame, await shot()), { timeout: 30_000 })
    .not.toBe(0);
  await pauseToStop(page);
  expect(Number(await dock.getAttribute("data-epoch"))).toBeGreaterThan(epochBefore);
  await expect(page.getByTestId("debug-values")).toContainText("dead f202 = false");
  await expect(page.getByTestId("debug-values")).toContainText("room 1");
  expect(errors).toEqual([]);

  await dock.getByTestId("debug-end").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Ended");
});
