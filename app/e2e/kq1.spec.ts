import { openGameOptions } from "./engineProbe.ts";
import { fixtureSkip } from "../../test/fixtures.ts";
import { readFile } from "node:fs/promises";
import { readGameZip } from "../src/gameZip.ts";
import { openContainer } from "../../src/container/container.ts";
import { disassembleLogic } from "../../src/logic/disassembler.ts";
import { expect, test, type Page } from "@playwright/test";
import {
  canvasColors,
  canvasHash,
  configureAi,
  isolateStorage,
  openCreateAdventure,
  openSavedGameDetails,
  openLibraryDownload,
  observe,
  probe,
  screenText,
  settled,
  storedAutosave,
  textHook,
  waitForAutosaveAfter,
  waitForCycles,
} from "./engineProbe.ts";

/**
 * Proof runs against the REAL app in REAL Chrome (per the project method:
 * interface changes are proven by scripted browser runs, not unit tests).
 *
 * The authentic KQ1 fixture is local-only (gitignored Sierra data). When it
 * is absent — CI, fresh clones — every test here skips.
 *
 * Every wait in this file is a poll on state the app publishes (the text
 * hook's rows / modal / textMode / profile / paused, its cycle counter, the
 * presented-frame counter, locator visibility, canvas pixels). There are no
 * wall-clock sleeps: see e2e/engineProbe.ts.
 */
const missingFixture = fixtureSkip("kq1", ["AGIDATA.OVL"]);
test.skip(Boolean(missingFixture), missingFixture || "");
if (missingFixture) console.warn(`[fixture skipped] ${missingFixture}`);

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
});

async function expectModal(page: Page, kind: string | null, timeout = 10_000): Promise<void> {
  await expect.poll(async () => (await textHook(page)).modal, { timeout }).toBe(kind);
}

async function clickGameKey(page: Page, key: number): Promise<void> {
  const controls = page.getByTestId("game-controls");
  await controls.locator("summary").click();
  await controls.locator(`button[data-key="${key}"]`).click();
}

/** Boot KQ1 and wait for the title screen (room 83) to be up and drawn. */
async function bootKq1(page: Page): Promise<void> {
  await page.getByTestId("boot-kq1").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("title-prompt-hint")).toBeVisible({ timeout: 15_000 });
}

/**
 * Click through the title screen and wait for room 1. The courtyard is the
 * first room with a status line, so `Score:` on row 0 is the arrival signal.
 */
async function advanceToCourtyard(page: Page): Promise<void> {
  await expect(page.getByTestId("title-prompt-hint")).toBeVisible({ timeout: 15_000 });
  await page.locator(".screen").click();
  await expect
    .poll(async () => (await textHook(page)).rows[0] ?? "", { timeout: 20_000 })
    .toContain("Score:");
  await expect(page.getByTestId("title-prompt-hint")).toBeHidden();
}

test("boots authentic KQ1 to the title screen and advances to courtyard", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);

  // The title screen (Room 83) uses the authentic vector renderer with Roberta Williams credits
  await expect.poll(() => canvasColors(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(8);
  await page.screenshot({ path: "test-results/kq1-title-screen.png" });

  // Advance past title screen to room 1 (courtyard): status line on row 0.
  await advanceToCourtyard(page);
  await expect.poll(async () => (await textHook(page)).rows[0]).toContain("Score:");
  await expect.poll(() => canvasColors(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(8);
  await page.screenshot({ path: "test-results/kq1-courtyard.png" });
});

test("KQ1 boots on the interpreter profile detected from its own AGIDATA.OVL", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("boot-kq1").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  // games/kq1/AGIDATA.OVL carries "Adventure Game Interpreter\n      Version 2.917";
  // the loader ships that file to the worker, which detects the 2.917 profile
  // (actions 0x00..0xad, exactly-four-loop direction selection) instead of the
  // 2.936 fallback. Verified by hand against the fixture bytes.
  await expect.poll(async () => (await textHook(page)).profile, { timeout: 15_000 }).toBe("2.917");
});

test("a printable key wakes a graphics-mode have.key wait on the title screen", async ({
  page,
}) => {
  await page.goto("/");
  // Room 83 is a GRAPHICS-mode wait screen (picture + display()ed prompt, not
  // text mode); its have.key() loop parks the worker on the host's waitKey.
  await bootKq1(page);
  expect((await textHook(page)).textMode).toBe(false);

  // A letter, not Enter or Space, and typed with the input line unfocused.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("x");

  // The wait resolved and the game advanced to the courtyard status line.
  await expect
    .poll(async () => (await textHook(page)).rows[0] ?? "", { timeout: 20_000 })
    .toContain("Score:");
  await expect(page.getByTestId("title-prompt-hint")).toBeHidden();
});

test("intro credits in room 83 land on the engine's text rows below the picture", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("boot-kq1").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  // Room 83 configures display base 0: the copyright line and the key prompt
  // are display()ed on rows 22 and 24 (hand-checked in logic 83), each once.
  // Row 24 is the last of them to be written, so it is the arrival signal.
  await expect
    .poll(async () => (await textHook(page)).rows[24] ?? "", { timeout: 15_000 })
    .toContain("Press any key");

  const { rows, textMode } = await textHook(page);
  expect(textMode).toBe(false);
  expect(rows[22]).toMatch(/copyright/i);
  expect(rows[24]).toContain("Press any key");
  expect(rows.filter((r) => r.includes("Press any key")).length).toBe(1);
  expect(rows.filter((r) => /copyright/i.test(r)).length).toBe(1);
});

test("ego walks with the arrow keys", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);

  const before = await canvasHash(page);
  await page.locator("canvas.game-surface:visible").click(); // focus for key events
  await page.keyboard.down("ArrowLeft");
  await expect.poll(() => canvasHash(page), { timeout: 15_000 }).not.toBe(before);
  await page.keyboard.up("ArrowLeft");
  await page.keyboard.press("ArrowLeft"); // AGI: press the direction again to stop.
});

test("parser: typing 'look' produces a game response", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);

  await page.getByTestId("input-line").fill("look");
  await page.getByTestId("input-line").press("Enter");
  await expectModal(page, "print");
  // The window is bordered with the engine's box glyphs ('#' in the hook)
  // and carries text between its side borders.
  const { rows } = await textHook(page);
  const windowRows = rows.filter((r) => /#[^#]*[a-z][^#]*#/i.test(r));
  expect(windowRows.length).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/kq1-print-window.png" });
});

test("print modal pauses the world until dismissed (classic AGI)", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);

  await page.getByTestId("input-line").fill("look");
  await page.getByTestId("input-line").press("Enter");
  await expectModal(page, "print");

  // The world freezes: identical frames while the window is open. `settled`
  // waits out the window's own draw before the comparison starts, and the
  // observation window is browser frames, not a wall-clock guess.
  const frozen = (await settled(page)).hash;
  await observe(page);
  expect(await canvasHash(page)).toBe(frozen);

  // Enter dismisses; the world resumes and ego can move again.
  await page.keyboard.press("Enter");
  await expectModal(page, null);
  await page.keyboard.down("ArrowRight");
  await expect.poll(() => canvasHash(page), { timeout: 15_000 }).not.toBe(frozen);
  await page.keyboard.up("ArrowRight");
  await page.keyboard.press("ArrowRight"); // AGI: press the direction again to stop.
});

test("Tab key opens authentic inventory modal", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);

  // Press Tab to open inventory
  await page.keyboard.press("Tab");
  await expectModal(page, "inventory", 5_000);
  expect(await screenText(page)).toContain("You are carrying:");
  await page.screenshot({ path: "test-results/kq1-inventory.png" });

  // Dismiss with Escape
  await page.keyboard.press("Escape");
  await expectModal(page, null);
});

test("discovered game shortcuts trigger inventory and debug mode", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);

  // Click the discovered Tab shortcut; clicking the screen acknowledges it.
  await clickGameKey(page, 9);
  await expectModal(page, "inventory", 5_000);
  await page.locator(".screen").click();
  await expectModal(page, null);

  // Click the discovered Alt+D shortcut
  await clickGameKey(page, 8192);
  await expectModal(page, "print", 5_000);
  expect(await screenText(page)).toContain("VERSION");
  await page.keyboard.press("Enter");
  await expectModal(page, null);
});

test("F1 help screen displays in text mode and is dismissed on key or click", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);

  // Use the game-registered F1 shortcut
  await clickGameKey(page, 15104);
  await expect.poll(async () => (await textHook(page)).textMode, { timeout: 5_000 }).toBe(true);
  await expect(page.getByTestId("text-mode-hint")).toBeVisible();

  // Verify help text contains "Help"
  expect(await screenText(page)).toContain("Help");
  await page.screenshot({ path: "test-results/kq1-text-screen.png" });

  // Dismiss help screen via screen click or key
  await page.locator(".screen").click();
  await expect.poll(async () => (await textHook(page)).textMode, { timeout: 5_000 }).toBe(false);
  await expect(page.getByTestId("text-mode-hint")).toBeHidden();
});

test("Escape opens the authentic menu bar; arrows navigate; Escape closes it", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);

  await page.keyboard.press("Escape");
  await expectModal(page, "menu", 5_000);
  const { rows } = await textHook(page);
  // KQ1 logic 0 builds headings Info, File, Game, Action, Special, Speed.
  expect(rows[0]).toContain("Info");
  expect(rows[0]).toContain("File");
  expect(rows[0]).toContain("Speed");
  expect(rows[2]).toContain("About KQ");
  await page.screenshot({ path: "test-results/kq1-menu-bar.png" });

  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).rows[2]).toContain("Save Game");
  await page.keyboard.press("Escape");
  await expectModal(page, null);
  await expect.poll(async () => (await textHook(page)).rows[0]).toContain("Score:");
});

test("typed input echoes on the engine's input row with the cursor marker", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);

  await page.getByTestId("input-line").fill("open door");
  await expect.poll(async () => (await textHook(page)).rows[22]).toContain("_open door");
  await page.getByTestId("input-line").press("Enter");
  await expect.poll(async () => (await textHook(page)).rows[22]).not.toContain("open door");
});

test("saving with F5 writes a real save-file image and F7 restores it without looping", async ({
  page,
}) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);

  // Save game (F5): select a slot, name it and confirm the engine's dialog.
  await clickGameKey(page, 16128);
  await expectModal(page, "save");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  await page.getByTestId("input-line").fill("Courtyard");
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(page)).toContain("Save in slot 1?");
  await expect.poll(() => screenText(page)).toContain("Courtyard");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("monotio_agi.saves.kq1") !== null), {
      timeout: 15_000,
    })
    .toBe(true);

  // The stored value is the authentic save envelope, not a JSON snapshot:
  // base64 of a 31-byte description header followed by the 2.917 profile's
  // five u16le length-prefixed blocks, the first of which is 0x05e1 bytes.
  const envelope = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("monotio_agi.saves.kq1") ?? "{}").slots["1"];
    if (!stored) return null;
    const binary = atob(stored);
    return { length: binary.length, block1: binary.charCodeAt(31) | (binary.charCodeAt(32) << 8) };
  });
  expect(envelope).not.toBeNull();
  expect(envelope!.block1).toBe(0x05e1);
  expect(envelope!.length).toBeGreaterThan(31 + 2 + 0x05e1);

  // Restore game (F7)
  await clickGameKey(page, 16640);
  await expectModal(page, "restore");
  await expect.poll(() => screenText(page)).toContain("Courtyard");
  await page.keyboard.press("Enter");

  // Telemetry checks
  await expect(page.locator(".agent-panel")).toContainText(
    "Restoring saved game from local storage...",
  );

  // Verify only 1 restore request was sent (infinite loop bug fixed): the
  // count must reach one and then STAY at one across an observation window.
  const restoreRequests = async (): Promise<number> =>
    page.evaluate(
      () =>
        ((window as any).__AGI_TRACE__ || []).filter(
          (e: any) => e.kind === "request" && e.detail.startsWith("restore"),
        ).length,
    );
  await expect.poll(restoreRequests, { timeout: 15_000 }).toBe(1);
  await observe(page);
  expect(await restoreRequests()).toBe(1);

  // Verify game is alive and responsive after restore
  await page.keyboard.press("Tab");
  await expectModal(page, "inventory", 5_000);
  await page.keyboard.press("Escape");
  await expectModal(page, null);
});

/**
 * Autosave and resume: nobody loses
 * progress to a browser reload. The worker snapshots the running game every
 * five seconds through the host-initiated save path — the same envelope
 * save.game writes, taken without the game's own save action — and the next
 * page load boots that game and replays the image before its first cycle.
 *
 * The reload is issued only after the HOST has stored a snapshot taken later
 * than the walk, which the text hook publishes; nothing here waits on a clock.
 *
 * The Vite HMR half of the same mechanism (flush on `vite:beforeFullReload`,
 * in-memory handover through `import.meta.hot.dispose`) is NOT covered here:
 * proving it means editing files under app/src while the dev server watches
 * them, which is exactly what invalidates a suite run (AGENTS.md). It has a
 * manual proof run instead — `node app/e2e/manual/hmr-resume.mjs`, whose
 * header documents the procedure and what it asserts.
 */

/** Walk ego left for a while, then let him come to rest. */
async function walkAndRest(page: Page): Promise<void> {
  await page.locator("canvas.game-surface:visible").click();
  await page.keyboard.down("ArrowLeft");
  await waitForCycles(page, 12);
  await page.keyboard.up("ArrowLeft");
  await page.keyboard.press("ArrowLeft"); // AGI: press the direction again to stop.
  // Ego stops on the next input phase; give the world a few cycles to settle
  // so the position sampled below is the position the autosave will hold.
  await waitForCycles(page, 6);
}

test("an autosave resumes the courtyard across a browser reload", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);
  await walkAndRest(page);

  // Wait for a snapshot taken AFTER the walk, then read where it left ego.
  const walked = await textHook(page);
  await waitForAutosaveAfter(page, walked.cycle);
  const before = await textHook(page);
  expect(before.room).toBe(1);

  // What is stored is the authentic envelope, not a JSON snapshot: the same
  // 31-byte header plus five length-prefixed blocks F5 writes, with 0x05e1
  // for block 1 on the 2.917 profile (hand-checked in games-persistence).
  const stored = await storedAutosave(page, "kq1");
  expect(stored).not.toBeNull();
  expect(stored!.room).toBe(1);
  expect(stored!.imageLength).toBeGreaterThan(31 + 2 + 0x05e1);
  // The player's own F5 slot was never touched behind their back.
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.save"))).toBeNull();

  await page.reload();

  // No picker, no title screen: the same game comes back by itself.
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("resume-caption")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".setup-panel")).toBeHidden();
  await expect
    .poll(async () => (await textHook(page)).rows[0] ?? "", { timeout: 20_000 })
    .toContain("Score:");
  await expect(page.getByTestId("title-prompt-hint")).toBeHidden();

  const after = await textHook(page);
  expect(after.room).toBe(1);
  // Ego is standing where he was. A couple of pixels of slack: the restored
  // game keeps cycling while the assertion is read, and KQ1's ego has a
  // step size of one or two per cycle.
  expect(Math.abs(after.egoX - before.egoX)).toBeLessThanOrEqual(4);
  expect(Math.abs(after.egoY - before.egoY)).toBeLessThanOrEqual(4);
  await page.screenshot({ path: "test-results/kq1-resumed.png" });

  // ...and the resumed game is a live game, not a restored still frame.
  await waitForCycles(page, 10);
  await page.keyboard.press("Tab");
  await expectModal(page, "inventory", 5_000);
  await page.keyboard.press("Escape");
  await expectModal(page, null);
});

test("Start over discards the autosave and boots the game from the top", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);
  await walkAndRest(page);

  const walked = await textHook(page);
  await waitForAutosaveAfter(page, walked.cycle);
  await page.reload();
  await expect(page.getByTestId("resume-caption")).toBeVisible({ timeout: 20_000 });

  // Start over throws the snapshot away and boots KQ1 from its title screen.
  await openGameOptions(page, "sound-display-menu");
  await page.getByTestId("btn-start-over").click();
  await expect(page.getByTestId("title-prompt-hint")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("resume-caption")).toBeHidden();
  expect(await storedAutosave(page, "kq1")).toBeNull();
});

test("returning to the menu preserves the installed game autosave", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);
  const walked = await textHook(page);
  await waitForAutosaveAfter(page, walked.cycle);
  expect(await storedAutosave(page, "kq1")).not.toBeNull();

  await page.getByTestId("btn-eject").click();
  await expect(page.locator(".setup-panel")).toBeVisible();
  expect((await storedAutosave(page, "kq1"))?.room).toBe(1);
  await page
    .getByTestId("local-game-card-kq1")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.locator(".screen")).toBeVisible();
});

test("a corrupt autosave is discarded and the game boots normally", async ({ page }) => {
  await page.goto("/");
  await bootKq1(page);
  await advanceToCourtyard(page);
  const walked = await textHook(page);
  await waitForAutosaveAfter(page, walked.cycle);

  // Truncate the stored envelope past repair: the decode has to throw.
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("monotio_agi.autosave.kq1")!);
    raw.image = raw.image.slice(0, 40);
    localStorage.setItem("monotio_agi.autosave.kq1", JSON.stringify(raw));
  });

  await page.reload();
  // A normal boot, not a broken screen: KQ1 comes up on its title screen and
  // the failure is a log line, not an error panel.
  await expect(page.getByTestId("title-prompt-hint")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("error-panel")).toHaveCount(0);
  await expect(page.getByTestId("resume-caption")).toBeHidden();
  await expect(page.getByTestId("agent-panel")).toContainText("Autosave discarded");
});

test("game frame is hidden until game is running, clicking screen advances title screen, and menu button ejects", async ({
  page,
}) => {
  await page.goto("/");

  // 1. Initially (idle), the screen container must be hidden
  await expect(page.locator(".screen")).toBeHidden();
  await expect(page.locator(".setup-panel")).toBeVisible();

  // 2. Creating without a configured key opens shared AI settings and preserves the draft.
  await openCreateAdventure(page);
  await page.getByTestId("cartridge-knights-trial").click();
  const draft = await page.getByTestId("custom-cartridge-input").inputValue();
  await page.getByTestId("connect-create-ai").click();
  await expect(page.getByTestId("ai-settings-dialog")).toBeVisible();
  await expect(page.getByTestId("custom-cartridge-input")).toHaveValue(draft);
  await page.getByTestId("ai-settings-cancel").click();
  await expect(page.locator(".screen")).toBeHidden();

  // 3. Boot KQ1: screen becomes visible
  await page.getByTestId("boot-kq1").click();
  await expect(page.locator(".screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".setup-panel")).toBeHidden();

  // 4. In Room 83 title screen, title prompt hint is visible
  await expect(page.getByTestId("title-prompt-hint")).toBeVisible({ timeout: 15_000 });

  // 5. Clicking screen advances to courtyard (Room 1)
  await advanceToCourtyard(page);
  await expect.poll(() => canvasColors(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(8);
  await expect(page.getByTestId("title-prompt-hint")).toBeHidden();

  // 6. Clicking Menu button returns to setup panel and hides screen
  await page.getByTestId("btn-eject").click();
  await expect(page.locator(".setup-panel")).toBeVisible();
  await expect(page.locator(".screen")).toBeHidden();
});

/** The first submitted Ask gets real fixture context without changing the game. */
test("KQ1 orientation accompanies the first question, Escape resumes", async ({ page }) => {
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await bootKq1(page);
  await advanceToCourtyard(page);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(0);

  await page.getByTestId("power-up").click();
  await expect(page.getByTestId("agent-bubble")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);

  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await expect(page.getByTestId("agent-panel")).not.toContainText("[Orientation]");
  await page.getByTestId("agent-mode-ask").click();
  await page.getByTestId("agent-bubble-input").fill("Where am I?");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  // The submitted context names the game and the profile the engine detected.
  await expect(page.getByTestId("agent-panel")).toContainText("[Orientation] kq1", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("agent-bubble-room")).toContainText("room 1");
  await page.screenshot({ path: "test-results/kq1-power-up-bubble.png" });
  await expect(page.getByTestId("agent-panel")).toContainText("profile 2.917");

  // ...and its prompt really is the live container read back as source.
  const prompt = await page.evaluate(() => {
    const trace = ((window as any).__AGI_TRACE__ ?? []) as { detail: string; data?: any }[];
    const entry = trace.find((e) => e.detail.startsWith("[Orientation]"));
    return String(entry?.data?.prompt ?? "");
  });
  expect(prompt).toContain("ORIENTATION: You have joined a game already in progress");
  expect(prompt).toContain("Game: kq1");
  expect(prompt).toContain("--- Resources ---");
  expect(prompt).toMatch(/logic: \d+ present/);
  expect(prompt).toContain("--- Dictionary ---");

  // The world really is frozen: the interpreter's cycle counter stops dead
  // and KQ1's animating courtyard stops changing with it.
  const parked = await settled(page);
  expect(parked.cycle).toBeGreaterThan(0);
  await observe(page);
  const stillParked = await probe(page);
  expect(stillParked.cycle).toBe(parked.cycle);
  expect(stillParked.hash).toBe(parked.hash);

  // Escape closes the bubble without patching anything and the world runs on.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-bubble")).toBeHidden();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await expect
    .poll(async () => (await textHook(page)).cycle, { timeout: 15_000 })
    .toBeGreaterThan(parked.cycle);

  // Ego still walks: the arrow keys move him and the frame changes again.
  const before = await canvasHash(page);
  await page.locator("canvas.game-surface:visible").click();
  await page.keyboard.down("ArrowLeft");
  await expect.poll(() => canvasHash(page), { timeout: 15_000 }).not.toBe(before);
  await page.keyboard.up("ArrowLeft");
  await page.keyboard.press("ArrowLeft"); // AGI: press the direction again to stop.
  await page.screenshot({ path: "test-results/kq1-power-up-resumed.png" });
});

test("a locally loaded patched game can be downloaded and imported", async ({ page }) => {
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await bootKq1(page);
  await advanceToCourtyard(page);

  // Patch a real local game through the UI, then verify the downloaded bytes.
  await page.getByTestId("power-up").click();
  await expect(page.getByTestId("agent-bubble")).toBeVisible();
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await page.getByTestId("agent-bubble-input").fill("put up a sign by the road");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-bubble")).toBeHidden();
  await openGameOptions(page, "save-share-menu");
  await expect(page.getByTestId("btn-export-live-zip")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await openGameOptions(page, "save-share-menu");
  await page.getByTestId("btn-export-live-zip").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^agi-remix-[a-f0-9-]+-game\.zip$/);
  expect(await download.failure()).toBeNull();
  const imported = await readGameZip(await readFile((await download.path())!));
  const container = openContainer(new Map(Object.entries(imported.files)));
  expect(disassembleLogic(container.getResource("logic", 1)!)).toContain("weathered sign");
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.authored.kq1"))).toBeNull();
  await page.getByTestId("btn-eject").click();

  // The remix is a saved cartridge of its own; it must not overwrite the
  // installed game's storage identity.
  const stored = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.includes("kq1")),
  );
  expect(stored).toEqual([]);
  const savedCard = page
    .getByTestId("saved-game-gallery")
    .locator("[data-testid^='saved-game-card-']");
  await expect(savedCard).toHaveCount(1);
  await openSavedGameDetails(savedCard);
  await openLibraryDownload(page, savedCard);
  await expect(page.getByTestId("btn-export-agi-zip")).toBeVisible();
});
