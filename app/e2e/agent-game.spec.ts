import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  canvasPicHash,
  openAiSettings,
  isolateStorage,
  observe,
  openCreateAdventure,
  openDeveloperActivity,
  openGameOptions,
  probe,
  settled,
  savedGameCard,
  storedAutosave,
  textHook,
  waitForAutosaveAfter,
} from "./engineProbe.ts";

/**
 * Proof of the standard-bytecode authoring loop: the stub agent (deterministic, no keys)
 * authors real bytecode rooms through the real toolchain while you play.
 * No fixture needed — every byte here is generated.
 *
 * Every wait here is a poll on published state (text hook rows / modal /
 * paused, the interpreter's cycle counter, the presented-frame counter,
 * locators, canvas pixels). No wall-clock sleeps: see e2e/engineProbe.ts.
 */

test.beforeEach(async ({ page }) => {
  // Every test authors its world from scratch: no cached game, no
  // transcript and no save may carry in from a previous test or run.
  await isolateStorage(page);
});

/** Interpreter cycle count; the worker heartbeats it four times a second. */
async function cycleOf(page: Page): Promise<number> {
  return (await textHook(page)).cycle;
}

async function bootAgentGame(page: Page): Promise<void> {
  await page.goto("/");
  await openDeveloperActivity(page);
  await page.getByTestId("boot-agent").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  // Authoring finishes before room 1 can be entered, and room 1 has to be
  // drawn before any pixel assertion means anything.
  await expect(page.getByTestId("agent-panel")).toContainText("assembled room 1", {
    timeout: 30_000,
  });
  await expect.poll(async () => (await probe(page)).frame, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => cycleOf(page), { timeout: 20_000 }).toBeGreaterThan(0);
}

/**
 * Wait for an engine print window and return its text with the box border
 * glyphs stripped and the wrapped lines re-joined.
 */
async function printWindowText(page: Page): Promise<string> {
  await expect.poll(async () => (await textHook(page)).modal, { timeout: 10_000 }).toBe("print");
  return (await textHook(page)).rows.join(" ").replace(/#/g, " ").replace(/\s+/g, " ");
}

/** Close any open engine window first (Enter would only dismiss it), then submit. */
async function typeCommand(page: Page, text: string): Promise<void> {
  const openMenu = page.locator(".game-nav details[open] summary");
  if (await openMenu.count()) await openMenu.press("Escape");
  const input = page.getByTestId("input-line");
  await input.focus();
  if ((await textHook(page)).modal !== null) {
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).modal, { timeout: 5_000 }).toBe(null);
  }
  await input.fill(text);
  await input.press("Enter");
}

test("agent game boots into generated room 1", async ({ page }) => {
  await bootAgentGame(page);
  // Room 1 rendered: sky + ground + priority line (at least 3 colors).
  const colors = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']")!;
    const d = c.getContext("2d")!.getImageData(0, 8, 320, 168).data;
    const set = new Set<string>();
    for (let i = 0; i < d.length; i += 4) set.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return set.size;
  });
  expect(colors).toBeGreaterThanOrEqual(3);
  // The debug screen shows the agent assembling room 1.
  await expect(page.getByTestId("agent-panel")).toContainText("assembled room 1");
});

test("returning to the menu preserves the saved room and offers continue", async ({ page }) => {
  await bootAgentGame(page);
  await typeCommand(page, "east");
  expect(await printWindowText(page)).toContain("generated room 2");
  await page.keyboard.press("Enter");
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await page.getByTestId("btn-eject").click();
  expect((await storedAutosave(page, "custom"))?.room).toBe(2);
  await savedGameCard(page, "custom").getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
});

test("in-game ZIP exports the live game after a patch and reload", async ({ page }) => {
  await bootAgentGame(page);
  await typeCommand(page, "east");
  expect(await printWindowText(page)).toContain("generated room 2");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  await page.getByTestId("power-up").click();
  await expect(page.getByTestId("agent-bubble-room")).toContainText("room 2");
  await page.getByTestId("agent-bubble-input").fill("put up a sign by the road");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-bubble")).toBeHidden();
  // A patch re-enters the room and prints two messages. Acknowledge each
  // once, then wait for a stored checkpoint before testing reload.
  expect(await printWindowText(page)).toContain("generated room 2");
  await page.keyboard.press("Enter");
  await expect.poll(() => printWindowText(page)).toContain("weathered sign");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  const downloadPromise = page.waitForEvent("download");
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-export-live-zip").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("agi-custom-game.zip");
  const bytes = await readFile((await download.path())!);
  const files: Record<string, Buffer> = {};
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength + bytes.readUInt16LE(offset + 28);
    files[bytes.toString("utf8", offset + 30, offset + 30 + nameLength)] = bytes.subarray(
      start,
      start + size,
    );
    offset = start + size;
  }
  const cachedFiles = await page.evaluate(async () => {
    const modulePath = "/src/gameStorage.ts";
    const { loadAuthoredGame } = await import(modulePath);
    const cached = await loadAuthoredGame("custom");
    return Object.fromEntries(
      Object.entries(cached.files as Record<string, Uint8Array>).map(([name, bytes]) => [
        name,
        Array.from(bytes),
      ]),
    );
  });
  for (const [name, bytes] of Object.entries(cachedFiles)) {
    expect(files[name]).toEqual(Buffer.from(bytes));
  }
  expect(files["WORDS.TOK"]?.length).toBeGreaterThan(52);
  expect(JSON.parse(files["GAME.JSON"]!.toString()).format).toBe("monotio.agi");
  expect(Object.keys(files)).not.toContain("PROJECT.JSON");
  expect(Object.keys(files)).not.toContain("transcript.json");
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await page.reload();
  // The live patch travels with the autosave, so the reload resumes the
  // patched world where the player left it (room 2) without reauthoring.
  await expect(page.getByText("Resumed where you left off")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  await openGameOptions(page, "game-actions-menu");
  await expect(page.getByTestId("btn-export-live-zip")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(0);
  // Re-entering room 2 runs its patched entry code: the sign is really there.
  await typeCommand(page, "west");
  expect(await printWindowText(page)).toContain("generated room 1");
  // typeCommand owns this acknowledgement; a second Enter can dismiss
  // room 2's message depending on when the worker publishes the transition.
  await typeCommand(page, "east");
  expect(await printWindowText(page)).toContain("generated room 2");
  await page.keyboard.press("Enter");
  await expect.poll(() => printWindowText(page)).toContain("weathered sign");
  await page.screenshot({ path: "test-results/live-zip-export.png" });
});

test("unknown input gets an offline AGI hint without an authoring call", async ({ page }) => {
  await bootAgentGame(page);
  await typeCommand(page, "sing to the trees");
  expect(await printWindowText(page)).toContain("Try LOOK, EAST or WEST.");
  await expect(page.getByTestId("agent-panel")).not.toContainText("say {");
  await expect(page.getByTestId("agent-panel")).not.toContainText("room {");
});

test("new.room: east authors a new room live; west returns to the old one", async ({ page }) => {
  await bootAgentGame(page);
  const room1Hash = (await settled(page)).picHash;

  await typeCommand(page, "east");
  // The agent authors room 2 and patches it into the VOL, live.
  await expect(page.getByTestId("agent-panel")).toContainText("authored room 2", {
    timeout: 10_000,
  });
  expect(await printWindowText(page)).toContain("generated room 2");
  const room2Hash = (await settled(page)).picHash;
  expect(room2Hash).not.toBe(room1Hash);

  // Old rooms stay alive: west returns to room 1 without new authoring.
  await typeCommand(page, "west");
  expect(await printWindowText(page)).toContain("generated room 1");
  expect((await settled(page)).picHash).toBe(room1Hash);
});

/**
 * Autosave and resume for a world the agent grew WHILE it was played
 *. Room 2 does not exist at genesis:
 * The harness writes it into the live container on the way east. A reload has to
 * bring back both halves — the save image, and the patched container the
 * image's replay sequence refers to — or the resumed game would restore into
 * a room whose logic the store never received.
 */
test("an autosave resumes a room the agent authored mid-play, across a reload", async ({
  page,
}) => {
  await bootAgentGame(page);

  await typeCommand(page, "east");
  await expect(page.getByTestId("agent-panel")).toContainText("authored room 2", {
    timeout: 10_000,
  });
  expect(await printWindowText(page)).toContain("generated room 2");

  // The window pauses the world, and an autosave is refused while it is up:
  // dismiss it, then wait for a snapshot taken in room 2.
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal, { timeout: 5_000 }).toBe(null);
  const room2Hash = (await settled(page)).picHash;
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);

  const stored = await storedAutosave(page, "custom");
  expect(stored).not.toBeNull();
  expect(stored!.room).toBe(2);

  await page.reload();

  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("resume-caption")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await textHook(page)).room, { timeout: 20_000 }).toBe(2);
  // The room came out of the persisted container, not out of the agent: a
  // second authoring turn would have logged one, and none did.
  await expect(page.getByTestId("agent-panel")).toContainText("Booting saved world");
  await expect(page.getByTestId("agent-panel")).not.toContainText("authored room 2");
  expect((await settled(page)).picHash).toBe(room2Hash);
  await page.screenshot({ path: "test-results/agent-game-resumed-room2.png" });

  // A fresh agent session must honour the destination already in bytecode.
  await typeCommand(page, "east");
  expect(await printWindowText(page)).toContain("generated room 3");
  await typeCommand(page, "west");
  expect(await printWindowText(page)).toContain("generated room 2");
  await typeCommand(page, "east");
  expect(await printWindowText(page)).toContain("generated room 3");
  const log = (await page.getByTestId("agent-panel").textContent()) ?? "";
  expect(log.match(/authored room 3:/g)).toHaveLength(1);
  await page.screenshot({ path: "test-results/agent-game-grown-after-reload.png" });
});

test("template picker displays built-in templates and allows selection", async ({ page }) => {
  await page.goto("/");
  await openCreateAdventure(page);
  await expect(page.getByTestId("template-knights-trial")).toBeVisible();
  await expect(page.getByTestId("template-badge-of-millhaven")).toBeVisible();
  await expect(page.getByTestId("template-mop-jockey")).toBeVisible();
  await expect(page.getByTestId("template-polyester-nights")).toBeVisible();
  await expect(page.getByTestId("template-custom")).toBeVisible();

  await page.getByTestId("template-mop-jockey").click();
  await expect(page.getByTestId("template-mop-jockey")).toHaveClass(/selected/);

  await page.getByTestId("template-custom").click();
  await expect(page.getByTestId("custom-adventure-input")).toBeVisible();
});

test("provider and model configuration adapts options and persists choices", async ({ page }) => {
  await page.goto("/");
  await openAiSettings(page);
  const dialog = page.getByTestId("ai-settings-dialog");
  const providerSelect = dialog.getByTestId("provider-select");
  await expect(providerSelect).toBeVisible();

  await providerSelect.selectOption("openai");
  const modelSelect = dialog.getByTestId("model-select");
  await expect(modelSelect).toContainText("GPT-5.6");

  await providerSelect.selectOption("anthropic");
  await expect(modelSelect).toContainText("Claude Opus 5");
  await expect(modelSelect).toContainText("Claude Fable 5.1");
  await dialog.getByTestId("ai-settings-save").click();
  await openAiSettings(page);
  await expect(dialog.getByTestId("provider-select")).toHaveValue("anthropic");
  await dialog.getByTestId("ai-settings-cancel").click();
  const repoLink = page.getByTestId("github-link");
  await expect(repoLink).toBeVisible();
  await expect(repoLink).toHaveAttribute("href", "https://github.com/monotio/agi");
});

test("sound controls allow toggling mute and switching sound chip mode", async ({ page }) => {
  await page.goto("/");
  await openDeveloperActivity(page);
  await page.getByTestId("boot-agent").click();
  await openGameOptions(page, "settings-menu");
  const muteBtn = page.getByTestId("toggle-mute");
  const modeBtn = page.getByTestId("toggle-sound-mode");

  await expect(muteBtn).toBeVisible();
  await expect(modeBtn).toBeVisible();

  // Initial state: Sound On, Tandy 4-Voice
  await expect(muteBtn).toContainText("Sound on");
  await expect(modeBtn).toContainText("Tandy 4-Voice");

  // Toggle mute
  await muteBtn.click();
  await expect(muteBtn).toContainText("Sound off");
  await muteBtn.click();
  await expect(muteBtn).toContainText("Sound on");

  // Toggle sound mode
  await modeBtn.click();
  await expect(modeBtn).toContainText("PC Speaker");
  await modeBtn.click();
  await expect(modeBtn).toContainText("Tandy 4-Voice");
});

/**
 * The power-up: one round button freezes
 * the world at a cycle boundary, the bubble takes an instruction into the
 * SAME session transcript the genesis and room turns used, the agent patches
 * real resources, the room re-enters, and the interpreter resumes on exactly
 * the cycle it parked on. The stub agent runs the real assembler, so this
 * proves the whole path with no API key.
 */
test("power-up: freezes the world, patches the room live, resumes", async ({ page }) => {
  await bootAgentGame(page);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  await expect.poll(async () => cycleOf(page)).toBeGreaterThanOrEqual(4);

  await page.getByTestId("power-up").click();
  await expect(page.getByTestId("agent-bubble")).toBeVisible();
  await expect(page.getByTestId("agent-bubble-room")).toContainText("room 1");
  // The freeze is instant and the interpreter is parked, not stopped.
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  await expect(page.getByTestId("agent-bubble-room")).toContainText("Paused");
  await expect(page.getByTestId("agent-mode-remix")).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "test-results/power-up-bubble-open.png" });

  const input = page.getByTestId("agent-bubble-input");
  await input.fill("put up a sign by the road");
  await input.press("Enter");

  // Every tool call streams into the debug feed, exactly like the genesis turn.
  await expect(page.getByTestId("agent-panel")).toContainText("[Remix]", { timeout: 15_000 });
  // read_room_context really reached the worker's frame ring and composited a sheet.
  await expect(page.getByTestId("agent-panel")).toContainText(
    /read_room_context -> Room \d+: .*4 frame\(s\), visual plane, stride 1, cycles \d+, \d+, \d+, \d+\./,
  );
  await expect(page.getByTestId("agent-panel")).toContainText("patched logic 1");
  await expect(page.getByTestId("agent-panel")).toContainText("Re-entering room 1");

  // Final text turn closes the bubble and the world runs again.
  await expect(page.getByTestId("agent-bubble")).toBeHidden({ timeout: 15_000 });
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);

  // The change is really in the running game: the re-entered room prints the
  // room description, then the patched line after its acknowledgement.
  expect(await printWindowText(page)).toContain("generated room 1");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await textHook(page)).rows.join(" ").replace(/#/g, " "), { timeout: 10_000 })
    .toContain("weathered sign");
  await page.screenshot({ path: "test-results/power-up-after-patch.png" });
});

test("power-up: Escape closes the bubble and resumes without changing anything", async ({
  page,
}) => {
  await bootAgentGame(page);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  const before = (await settled(page)).picHash;

  await page.getByTestId("power-up").click();
  await expect(page.getByTestId("agent-bubble")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);

  // Frozen means frozen: the interpreter's own cycle counter stops dead. The
  // observation window is browser frames, not a wall-clock guess — a slower
  // machine only gives the counter MORE chances to move, never fewer.
  const parkedAt = await cycleOf(page);
  expect(parkedAt).toBeGreaterThan(0);
  await observe(page);
  expect((await probe(page)).cycle).toBe(parkedAt);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-bubble")).toBeHidden();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);

  // Resumed from exactly where it parked, rather than after a fixed delay.
  await expect.poll(async () => cycleOf(page), { timeout: 15_000 }).toBeGreaterThan(parkedAt);

  // Nothing was patched, so the room is the room we froze.
  expect(await canvasPicHash(page)).toBe(before);
  await expect(page.getByTestId("agent-panel")).not.toContainText("patched logic");
});

test("walking across the east edge authors its standard new.room destination", async ({ page }) => {
  await bootAgentGame(page);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  await page.keyboard.down("ArrowRight");
  expect(await printWindowText(page)).toContain("generated room 2");
  await page.keyboard.up("ArrowRight");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await page.screenshot({ path: "test-results/agent-game-walked-east.png" });
});
