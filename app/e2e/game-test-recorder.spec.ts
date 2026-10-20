import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { TUTORIAL_LOGIC_SOURCES } from "../../games/adventure-department/game.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import {
  configureAi,
  enterCreateMode,
  downloadFromSettings,
  isolateStorage,
  openWorkspaceAgent,
  textHook,
  waitForRoom,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

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

/** The agent turns one remix needs: the tool call, then the closing text. */
function remixResponses(
  idPrefix: string,
  calls: [string, Record<string, unknown>][],
  text: string,
  testReasons?: { test: string; reason: string }[] | null,
) {
  return [
    {
      id: `${idPrefix}-calls`,
      output: calls.map(([name, args], i) => ({
        type: "function_call",
        id: `${idPrefix}-item-${i}`,
        call_id: `${idPrefix}-call-${i}`,
        name,
        arguments: JSON.stringify(args),
      })),
    },
    {
      id: `${idPrefix}-done`,
      output:
        testReasons !== undefined
          ? [
              {
                type: "function_call",
                id: `${idPrefix}-finish`,
                call_id: `${idPrefix}-finish`,
                name: "finish",
                arguments: JSON.stringify({ testReasons }),
              },
            ]
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    },
  ];
}

async function agentFeed(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const { borrowWorkspaceAgent } = await import("/src/agent/workspaceAgent.ts");
    const owner = borrowWorkspaceAgent({
      session,
      profileId: "2.936",
      config: () => {
        throw new Error("Reuse the current conversation owner");
      },
    });
    return owner.progress.join("\n");
  });
}

test("Tests never block edits: record a playthrough, Apply a failing game edit, repair and rerun after import", async ({
  page,
  browser,
}) => {
  let requests = 0;
  let recordedFailure: { success: boolean; error?: string } | undefined;
  const modules: string[] = [];
  page.on("request", (request) => modules.push(request.url()));
  const respond = (body: unknown) => providerReply("openai", body);
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    const body = route.request().postDataJSON() as {
      input?: { type?: string; call_id?: string; output?: { text?: string }[] }[];
    };
    const verdict = body.input
      ?.find(
        (item) => item.type === "function_call_output" && item.call_id === "broken-test-call-0",
      )
      ?.output?.find((block) => typeof block.text === "string")?.text;
    if (verdict) recordedFailure = JSON.parse(verdict);
    const turns = [
      ...remixResponses(
        "break",
        [["write_logic", { room: 1, source: BROKEN_ROOM_ONE }]],
        "The mural lesson is remixed.",
        ["paint the mural", "recorded mural repair"].map((test) => ({
          test,
          reason: "the lesson text changed; restoring it repairs this test.",
        })),
      ),
      ...remixResponses(
        "broken-test",
        [["run_game_tests", { names: ["recorded mural repair"] }]],
        recordedFailure?.error ?? "The recorded test was run.",
      ),
      ...remixResponses(
        "repair",
        [["write_logic", { room: 1, source: ROOM_ONE }]],
        "The mural lesson is restored.",
        null,
      ),
    ];
    await route.fulfill(respond(turns[Math.min(requests - 1, turns.length - 1)]));
  });
  await isolateStorage(page);
  await page.addInitScript(() => localStorage.setItem("monotio_agi.touchControls", "on"));
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });

  // Record: walk to the frame, paint the mural, dismiss the payoff window.
  // Playtest recording lives in the editing tools — the remix bubble.
  await enterCreateMode(page);
  await openWorkspaceAgent(page);
  if (!(await page.getByTestId("btn-record-test").isVisible()))
    await page
      .getByTestId("workspace-agent-panel")
      .getByRole("button", { name: "Agent settings", exact: true })
      .click();
  await page.getByTestId("btn-record-test").click();
  await expect(page.getByTestId("workspace-agent-panel")).toBeHidden();
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
  await page.locator(".screen").dispatchEvent("pointerdown", { pointerType: "touch" });
  await page.locator(".screen").dispatchEvent("click");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await page.getByTestId("record-stop").click();
  const dialog = page.getByTestId("record-dialog");
  await expect(dialog).toBeVisible();
  // Keep the suggested game checks; interpreter clocks remain unchecked.
  await expect(page.getByTestId("record-check-flag-30")).toBeChecked();
  await expect(page.getByTestId("record-check-score")).toBeChecked();
  await expect(page.getByTestId("record-check-printed-0")).toBeChecked();
  // Recording and saving are ordinary project edits; no provider is configured yet.
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.aiSettings"))).toBeNull();
  await page.getByTestId("record-name").fill("recorded mural repair");
  await page.getByTestId("record-save").click();
  await expect(dialog).toBeHidden();
  expect(modules.some((url) => url.includes("/src/agent/authoringStack.ts"))).toBe(false);
  // The seven tutorial tests plus the recording; saving converted the catalog
  // game into its writable remix project, exactly like a remix does.
  await expect(page.getByTestId("record-result")).toContainText("8 game tests saved");

  // Tests never block game edits: Apply the Agent's candidate even though its
  // recorded observation will fail against the changed lesson text.
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await enterCreateMode(page);
  await openWorkspaceAgent(page);
  await expect(page.getByTestId("agent-message")).toBeEnabled();
  await page.getByTestId("agent-message").fill("Change the mural lesson text");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await expect.poll(() => agentFeed(page)).toContain("6 game tests pass, 2 fail");
  await expect(page.getByTestId("workspace-agent-panel")).toContainText(
    "2 tests fail: paint the mural, recorded mural repair",
  );
  await page.getByTestId("agent-approve").click();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
          ).__AGI_PROJECT__
            .getSession()
            .model.capture()
            .read("logic:1")?.content,
      ),
    )
    .toBe(BROKEN_ROOM_ONE);

  // Runs use committed tests: the recorded document now fails against the
  // actual applied game, with the missing printed observation named plainly.
  await page.getByTestId("agent-message").fill("Run the recorded mural repair test");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => recordedFailure?.success).toBe(false);
  expect(recordedFailure!.error).toContain('0 game tests pass, 1 fail: "recorded mural repair"');
  expect(recordedFailure!.error).toContain(MURAL_TEXT);
  await expect(page.getByTestId("workspace-agent-panel")).toContainText(recordedFailure!.error!);
  await expect(page.getByTestId("agent-message")).toBeEnabled();

  // Repair: the same rerun reports the whole selection green again.
  await enterCreateMode(page);
  await openWorkspaceAgent(page);
  await expect(page.getByTestId("agent-message")).toBeEnabled();
  await page.getByTestId("agent-message").fill("Restore the mural lesson text");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await page.getByTestId("agent-approve").click();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  await expect.poll(() => agentFeed(page)).toContain("Game tests: 8 game tests pass, 0 fail");

  // Export the project; the recorded test travels only in the project archive.
  const download = page.waitForEvent("download");
  await downloadFromSettings(page, true);
  const projectPath = await (await download).path();
  const project = await readGameZip(new Uint8Array(await readFile(projectPath!)));
  const testsJson = new TextDecoder().decode(project.files["TESTS.JSON"]);
  expect(testsJson).toContain("recorded mural repair");
  expect(testsJson).toContain('"setup"');
  const stored = JSON.parse(testsJson).tests.find(
    (test: { name: string }) => test.name === "recorded mural repair",
  );
  const replay = JSON.parse(stored.setup.replay);
  expect(replay.operations.some((op: unknown[]) => op[0] === "ack")).toBe(true);
  expect(stored.cycleBudget).toBe(
    replay.operations.filter((op: unknown[]) => op[0] === "tick").length,
  );
  expect(stored.steps).toEqual([]);

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
    expect(project.progress?.autosave).not.toBeNull();
    await expect
      .poll(async () => (await textHook(other)).room)
      .toBe(project.progress!.autosave!.room);
    await configureAi(other, { provider: "openai", key: "test-placeholder" });
    await enterCreateMode(other);
    await openWorkspaceAgent(other);
    await expect(other.getByTestId("agent-message")).toBeEnabled();
    await other.getByTestId("agent-message").fill("Run every stored game test");
    await other.getByRole("button", { name: "Send", exact: true }).click();
    await expect(other.getByTestId("agent-message")).toBeEnabled();
    await expect
      .poll(() => agentFeed(other), { timeout: 30_000 })
      .toContain("8 game tests pass, 0 fail");
  } finally {
    await fresh.close();
  }
});
