import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { providerReply } from "../../test/provider-stream.ts";
import { TUTORIAL_LOGIC_SOURCES } from "../../games/adventure-department/game.ts";
import { readGameZip } from "../src/gameZip.ts";
import { configureAi, isolateStorage, openGameOptions, textHook } from "./engineProbe.ts";

/**
 * Brief item 8, end to end: record a playthrough as a game test, patch the
 * game so the stored test fails, repair it, export the project, and rerun
 * the recorded test in a fresh browser that imports the archive.
 *
 * The recorded test replays from its setup image (the interpreter state at
 * record-start), so the fresh-context rerun is the proof that the whole
 * contract — capture, storage, transport, restore, replay — holds together.
 */

const MURAL_TEXT = "You paint a sun, mountains and a river.";
const BROKEN_TEXT = "You splash paint everywhere.";
const ROOM_ONE = TUTORIAL_LOGIC_SOURCES[1]!;
const BROKEN_ROOM_ONE = ROOM_ONE.replace(MURAL_TEXT, BROKEN_TEXT);

/** The assistant turns one remix needs: the tool call, then the closing text. */
function remixResponses(
  idPrefix: string,
  calls: [string, Record<string, unknown>][],
  text: string,
) {
  return [
    {
      id: `${idPrefix}-calls`,
      output: calls.map(([name, args], i) => ({
        type: "function_call",
        id: `item-${i}`,
        call_id: `call-${i}`,
        name,
        arguments: JSON.stringify(args),
      })),
    },
    {
      id: `${idPrefix}-done`,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    },
  ];
}

async function agentFeed(page: Page): Promise<string> {
  return page.evaluate(() =>
    (window.__AGI_TRACE__ ?? []).map((entry) => String(entry.detail)).join("\n"),
  );
}

test("record a playthrough, break and repair it, and rerun it in a fresh browser", async ({
  page,
  browser,
}) => {
  let requests = 0;
  const respond = (body: unknown) => providerReply("openai", body);
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    const turns = [
      ...remixResponses(
        "break",
        [["write_logic_source", { room: 1, source: BROKEN_ROOM_ONE }]],
        "The mural lesson is remixed.",
      ),
      ...remixResponses(
        "repair",
        [["write_logic_source", { room: 1, source: ROOM_ONE }]],
        "The mural lesson is restored.",
      ),
    ];
    await route.fulfill(respond(turns[Math.min(requests - 1, turns.length - 1)]));
  });
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);

  // Record: walk to the frame, paint the mural, dismiss the payoff window.
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-record-test").click();
  await expect(page.getByTestId("recording-bar")).toBeVisible();
  await page.getByTestId("input-line").focus();
  await page.keyboard.down("ArrowRight");
  await expect
    .poll(async () => (await textHook(page)).egoX, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(60);
  await page.keyboard.up("ArrowRight");
  const input = page.getByTestId("input-line");
  await input.fill("paint mural");
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await page.getByTestId("record-stop").click();
  const dialog = page.getByTestId("record-dialog");
  await expect(dialog).toBeVisible();
  // The playthrough's meaningful diffs come preselected.
  // Logic 0's walk bookkeeping (position mirrors, cycle counters) rides along
  // as suggestions; the player keeps the puzzle-relevant assertions — that
  // curation is what the dialog is for.
  for (const box of await page.locator('[data-testid^="record-check-var-"]').all())
    if (await box.isChecked()) await box.click();
  await expect(page.getByTestId("record-check-flag-30")).toBeChecked();
  await expect(page.getByTestId("record-check-score")).toBeChecked();
  await expect(page.getByTestId("record-check-printed-0")).toBeChecked();
  await page.getByTestId("record-name").fill("recorded mural repair");
  await page.getByTestId("record-save").click();
  await expect(dialog).toBeHidden();
  // The four tutorial tests plus the recording; saving converted the catalog
  // game into its writable remix cartridge, exactly like a remix does.
  await expect(page.getByTestId("record-result")).toContainText("5 game tests stored");

  // Patch the game so the recorded observation no longer holds: the write
  // tool reruns every room-1 test and leads with the failure verdict.
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await page.getByTestId("power-up").click();
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await page.getByTestId("agent-bubble-input").fill("Change the mural lesson text");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-bubble")).toBeHidden();
  await expect.poll(() => agentFeed(page)).toContain("Game tests: 1 game test pass, 2 fail");

  // Repair: the same rerun reports the whole selection green again.
  await page.getByTestId("power-up").click();
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await page.getByTestId("agent-bubble-input").fill("Restore the mural lesson text");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-bubble")).toBeHidden();
  await expect.poll(() => agentFeed(page)).toContain("Game tests: 3 game tests pass, 0 fail");

  // Export the project; the recorded test travels only in the project archive.
  const download = page.waitForEvent("download");
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-save-live-project").click();
  const projectPath = await (await download).path();
  const project = await readGameZip(new Uint8Array(await readFile(projectPath!)));
  const testsJson = new TextDecoder().decode(project.files["TESTS.JSON"]);
  expect(testsJson).toContain("recorded mural repair");
  expect(testsJson).toContain('"setup"');

  // A fresh browser imports the project and reruns every stored test there:
  // the recording replays from its setup image against the same resources.
  const fresh = await browser.newContext();
  try {
    const other = await fresh.newPage();
    let imports = 0;
    await other.route("**/api/openai/v1/responses", async (route) => {
      imports++;
      const turns = remixResponses(
        "imported",
        [["run_game_tests", { names: null }]],
        "All stored tests pass.",
      );
      await route.fulfill(respond(turns[Math.min(imports - 1, turns.length - 1)]));
    });
    await other.goto(page.url());
    await other.getByTestId("game-zip-input").setInputFiles(projectPath!);
    await other.getByTestId("btn-resume-cached").click();
    await expect.poll(async () => (await textHook(other)).room).toBe(1);
    await configureAi(other, { provider: "openai", key: "test-placeholder" });
    await other.getByTestId("power-up").click();
    await expect(other.getByTestId("agent-bubble-input")).toBeEnabled();
    await other.getByTestId("agent-bubble-input").fill("Run every stored game test");
    await other.getByTestId("agent-bubble-send").click();
    await expect(other.getByTestId("agent-bubble")).toBeHidden();
    await expect
      .poll(() => agentFeed(other), { timeout: 30_000 })
      .toContain("5 game tests pass, 0 fail");
  } finally {
    await fresh.close();
  }
});
