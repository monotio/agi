import { providerReply } from "../../test/provider-stream.ts";
import { test, expect, reviewShot } from "./test.ts";
import type { Page } from "@playwright/test";
import {
  isolateStorage,
  openAiSettings,
  openCreateAdventure,
  textHook,
  waitForAutosaveAfter,
  waitForRoom,
} from "./engineProbe.ts";

/**
 * Browser proof for Genesis starter recovery. A real Create whose provider
 * request is refused or cancelled keeps the canonical Starter prepared;
 * "Open starter" on the error surface commits it once — no provider call,
 * no AI key — and opens it as an ordinary manual project: editable source,
 * vocabulary, menus and the play surface intact. The refusal alone still
 * stores nothing.
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

/** The stored project's record: identity, provider independence and profile. */
async function storedStarter(page: Page) {
  return page.evaluate(async () => {
    const storage = await import("/src/project/gameStorage.ts");
    const entries = await storage.listStoredProjects();
    const entry = entries.find((game) => game.projectId.startsWith("local-"));
    if (!entry) throw new Error("recovery project missing");
    const data = (await storage.loadAuthoredGame(entry.projectId))!;
    return {
      id: data.projectId,
      title: data.title,
      provider: data.provider ?? null,
      model: data.model ?? null,
      roomGeneration: data.roomGeneration ?? null,
      profile: data.library?.profile ?? null,
      keys: data.workspace?.documents.map((doc) => doc.key),
      words: data.words.map(([word]) => word),
    };
  });
}

async function storedProjectCount(page: Page): Promise<number> {
  return page.evaluate(async () =>
    (await import("/src/project/gameStorage.ts")).listStoredProjects().then((p) => p.length),
  );
}

test("a refused genesis offers Open starter and opens a real editable starter project @webkit-desktop", async ({
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

  // The refusal surfaces with the recovery offer; nothing stored on its own.
  await expect(page.getByTestId("error-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("error-panel")).toContainText("mocked refusal");
  const openStarter = page.getByTestId("open-starter");
  await expect(openStarter).toBeVisible();
  expect(requests).toBe(1);
  expect(await storedProjectCount(page)).toBe(0);
  await reviewShot(page, "genesis-refusal-open-starter");

  // The key is disconnected before the click: recovery asks for none.
  await openAiSettings(page);
  const dialog = page.getByTestId("ai-settings-dialog");
  await dialog.getByTestId("api-key-input").fill("");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();

  await openStarter.click();
  await waitForRoom(page, 1, { coldBoot: true });
  await expect(page).toHaveURL(/#create\/local-/);
  await expect(page.getByTestId("create-dock-left")).toBeVisible();
  await expect(page.getByTestId("input-line")).toBeVisible();
  expect(requests).toBe(1);
  await reviewShot(page, "genesis-recovered-starter");

  const project = await storedStarter(page);
  expect(project.id).toMatch(/^local-/);
  expect(project.title).toBe("Seed Proof");
  expect(project.provider).toBeNull();
  expect(project.model).toBeNull();
  expect(project.roomGeneration).toBe(false);
  expect(project.profile).toBe("2.936");
  expect(project.keys).toEqual(
    expect.arrayContaining(["bindings", "words", "inventory", "world", "logic:1", "sound:1"]),
  );
  expect(project.words).toContain("listen");
  expect(project.words).toContain("hear");

  // The starter is playable: menus and the revision-2 listen vocabulary.
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect(page).toHaveURL(/#play\/local-/);
  const input = page.getByTestId("input-line");
  await input.focus();
  await input.fill("listen");
  await input.press("Enter");
  await expect
    .poll(async () => (await textHook(page)).rows.join(" ").replace(/#/g, " "), {
      timeout: 10_000,
    })
    .toContain("meadowlark");

  // The listen reply is a print window; acknowledge it before the menu.
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await textHook(page)).modal).toBe("menu");
  expect((await textHook(page)).rows[0]).toContain("File");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await textHook(page)).modal).toBe(null);

  // The provider config a refusal left behind stays as the player saved it.
  await openAiSettings(page);
  await expect(page.getByTestId("ai-settings-dialog").getByTestId("model-select")).toHaveValue(
    "gpt-6.1-sol",
  );
  await page.keyboard.press("Escape");

  // Keep/reload coherence: the stored checkpoint resumes the manual project.
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await page.reload();
  await waitForRoom(page, 1, { coldBoot: true });
  await expect(page).toHaveURL(/#play\/local-/);
  expect(requests).toBe(1);
});

test("a cancelled genesis offers the same recovery, and late bytes cannot take the slot @webkit-desktop", async ({
  page,
}) => {
  let requests = 0;
  const answer = deferredAnswer();
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    await answer.promise;
    await route.fulfill(
      providerReply("openai", {
        id: "late-reply",
        usage: { input_tokens: 0, output_tokens: 0 },
        output: [
          {
            type: "function_call",
            call_id: "plan",
            name: "update_world",
            arguments: JSON.stringify({
              rooms: [
                { num: 1, title: "Late world", description: "Arrived after cancel.", exits: [] },
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

  // Stop, then discard the in-flight attempt: the same error surface offers
  // the starter.
  await expect(page.getByTestId("agent-stop")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("agent-stop").click();
  await page.getByTestId("agent-discard").click();
  await expect(page.getByTestId("error-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("open-starter")).toBeVisible();
  expect(await storedProjectCount(page)).toBe(0);

  await page.getByTestId("open-starter").click();
  await waitForRoom(page, 1, { coldBoot: true });
  const project = await storedStarter(page);
  expect(project.title).toBe("Seed Proof");
  expect(project.roomGeneration).toBe(false);

  // The abandoned request's reply arrives now; the recovered project keeps
  // the slot and stays the only stored one.
  answer.release();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/#create\/local-/);
  expect(requests).toBe(1);
  expect(await storedProjectCount(page)).toBe(1);
  expect(await storedStarter(page).then((p) => p.id)).toBe(project.id);
});

function deferredAnswer() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
