import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "./test.ts";
import type { Page } from "@playwright/test";
import { isolateStorage, openAiSettings, openCreateAdventure, textHook } from "./engineProbe.ts";

/**
 * Browser proof for the Genesis/Boilerplate parity: the real Create entry runs a
 * real AgentSession against a mocked OpenAI transport (zero paid calls). The
 * first request must already describe the installed Boilerplate seed, and a
 * one-request genesis boots the seeded room. A refused first request leaves
 * the menu's error surface without persisting a half-authored project.
 */

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
});

/** Open Settings and connect the shipped default model with a placeholder key. */
async function connectDefaultOpenAi(page: Page): Promise<void> {
  await openAiSettings(page);
  const dialog = page.getByTestId("ai-settings-dialog");
  await dialog.getByTestId("provider-select").selectOption("openai");
  await expect(dialog.getByTestId("model-select")).toHaveValue("gpt-6.1-sol");
  await dialog.getByTestId("api-key-input").fill("test-placeholder");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
}

/** Pick a template, name the game and launch genesis through Create. */
async function launchGenesis(page: Page): Promise<void> {
  await openCreateAdventure(page);
  await page.getByTestId("template-mop-jockey").click();
  await page.getByTestId("local-create-title").fill("Seed Proof");
  await page.getByTestId("boot-game").click();
}

test("genesis through the real create entry is offered the installed Boilerplate seed", async ({
  page,
}) => {
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests.push(route.request().postDataJSON());
    // The minimum a genesis turn owes: record the plan, then hand over. The
    // seeded room carries the rest — nothing else needs to be written.
    await route.fulfill(
      providerReply("openai", {
        id: `seed-${requests.length}`,
        usage: { input_tokens: 0, output_tokens: 0 },
        output: [
          {
            type: "function_call",
            call_id: "plan",
            name: "update_world",
            arguments: JSON.stringify({
              rooms: [
                {
                  num: 1,
                  title: "The Clearing",
                  description: "The seeded opening, kept for the brief.",
                  exits: [],
                },
              ],
            }),
          },
          { type: "function_call", call_id: "hand", name: "handover", arguments: "{}" },
        ],
      }),
    );
  });

  await page.goto("/");
  await connectDefaultOpenAi(page);
  await launchGenesis(page);

  // Handover validated the seeded boot and the game is running room 1.
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });

  // One provider request, no retries, on the shipped default model — and the
  // prompt it carried describes the Boilerplate already installed, not a void.
  expect(requests).toHaveLength(1);
  expect(requests[0]!["model"]).toBe("gpt-6.1-sol");
  const sent = JSON.stringify(requests[0]);
  expect(sent).toContain("agihere.boilerplate");
  expect(sent).toContain("2.936");
  expect(sent).toContain("seeded room 1");

  // The stored session snapshot carries the Boilerplate's sources and words:
  // logic 1 existed in the session before the provider ever answered.
  const stored = await page.evaluate(async () => {
    const storage = await import("/src/project/gameStorage.ts");
    const entries = await storage.listStoredProjects();
    const entry = entries.find((game) => game.projectId.startsWith("mop-jockey-"));
    if (!entry) throw new Error("created project missing");
    const data = (await storage.loadAuthoredGame(entry.projectId))!;
    const sources = data.authoringState?.["sources"] as
      Record<string, [number, unknown][]> | undefined;
    return {
      title: data.title,
      logicNums: (sources?.["logics"] ?? []).map(([num]) => num).sort(),
      pictureNums: (sources?.["pictures"] ?? []).map(([num]) => num),
      viewNums: (sources?.["views"] ?? []).map(([num]) => num),
      soundNums: (sources?.["sounds"] ?? []).map(([num]) => num).sort(),
      words: data.words.map(([word]) => word).sort(),
    };
  });
  expect(stored.title).toBe("Seed Proof");
  expect(stored.logicNums).toEqual([0, 1, 255]);
  expect(stored.pictureNums).toEqual([1]);
  expect(stored.viewNums).toEqual([]);
  expect(stored.soundNums).toEqual([255]);
  expect(stored.words).toEqual([]);

  // Dismiss the welcome, then try the shared parser response.
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("Your game starts here.");
  await page.keyboard.press("Enter");
  const input = page.getByTestId("input-line");
  await input.focus();
  await input.fill("look");
  await input.press("Enter");
  await expect
    .poll(async () => (await textHook(page)).rows.join(" ").replace(/#/g, " "), {
      timeout: 10_000,
    })
    .toContain("I don't know the word");
  await page.screenshot({ path: test.info().outputPath("boilerplate-parser.png") });
});

test("a refused first genesis request surfaces an error and stores no half project", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    await route.fulfill({
      status: 400,
      json: { error: { message: "mocked refusal", type: "invalid_request_error" } },
    });
  });

  await page.goto("/");
  await connectDefaultOpenAi(page);
  await launchGenesis(page);

  // The failure surfaces on the menu and the request is not retried.
  await expect(page.getByTestId("error-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("error-panel")).toContainText("mocked refusal");
  expect(requests).toBe(1);

  // Nothing was persisted: no project record exists at all.
  const stored = await page.evaluate(async () => {
    const storage = await import("/src/project/gameStorage.ts");
    return (await storage.listStoredProjects()).length;
  });
  expect(stored).toBe(0);
});
