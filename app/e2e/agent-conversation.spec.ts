import { test, expect } from "./test.ts";
import { isolateStorage, configureAi, textHook, openWorkspaceAgent } from "./engineProbe.ts";
import {
  openWorkspaceLogic,
  replaceWorkspaceDocument,
  workspaceDocument,
} from "./workspaceShared.ts";
import { providerReply } from "../../test/provider-stream.ts";
import type { Page } from "@playwright/test";

async function starter(page: Page) {
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await openWorkspaceAgent(page);
}

test("one Agent keeps the draft across Play, Create, resource selection and closing @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await openWorkspaceAgent(page);
  const panel = page.getByTestId("workspace-agent-panel");
  const composer = panel.getByTestId("agent-message");
  await expect(composer).toBeVisible();
  await expect(composer).toHaveAttribute("placeholder", "Ask or describe a change…");
  await composer.fill("Keep this question while I inspect the game");
  await openWorkspaceLogic(page);
  await expect(panel).toBeVisible();
  await expect(composer).toHaveValue("Keep this question while I inspect the game");
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(composer).toHaveAttribute("placeholder", "Ask about this game…");
  await expect(composer).toHaveValue("Keep this question while I inspect the game");
  await panel.getByTestId("agent-panel-close").click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(composer).toHaveValue("Keep this question while I inspect the game");
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(composer).toHaveValue("Keep this question while I inspect the game");
  await expect(panel.getByRole("heading", { name: "Agent", exact: true })).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`native review survives Apply and opens its earlier preview with the composer intact ${width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await starter(page);
    const composer = page.getByTestId("agent-message");
    await composer.fill("Add a welcome sign");
    await page.getByTestId("agent-send").click();
    const result = page.getByTestId("agent-result-preview");
    await expect(result).toBeVisible();
    await expect(result.getByTestId("agent-code-diff")).toBeVisible();
    await expect(result.getByTestId("agent-art-review")).toBeVisible();
    await result.getByRole("button", { name: "Back to chat", exact: true }).click();
    await composer.fill("My next question stays here");
    await page.getByTestId("agent-view-result").click();
    await expect(result).toBeVisible();
    if (width === 390) expect((await result.boundingBox())!.width).toBe(390);
    await result.getByTestId("agent-approve").click();
    await expect(result).toBeHidden();
    await expect(composer).toHaveValue("My next question stays here");
    await expect(page.getByTestId("agent-view-result")).toBeVisible();
    const boot = await workspaceDocument(page, "logic:0");
    if (width === 390) {
      await page.getByTestId("agent-panel-close").click();
      await page.getByTestId("workspace-parts").click();
    }
    await replaceWorkspaceDocument(page, "logic:0", `${boot}\n// Later human edit\n`);
    if (width === 390) await openWorkspaceAgent(page);
    await page.getByTestId("agent-view-result").click();
    await expect(result).toBeVisible();
    await expect(result.getByTestId("agent-earlier-version")).toBeVisible();
    await expect(result.getByTestId("agent-code-diff")).not.toContainText("Later human edit");
    await expect(result.getByTestId("agent-approve")).toHaveCount(0);
    await expect(
      result.getByRole("button", { name: "Open current resource", exact: true }).first(),
    ).toBeVisible();
    await result.getByRole("button", { name: "Back to chat", exact: true }).click();
    await expect(composer).toHaveValue("My next question stays here");
  });
}

test("a prepared proposal remains inspectable in Play and requires returning to Create to apply @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("agent-message").fill("Add a welcome sign");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await expect(page.getByTestId("agent-approve")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue in Create", exact: true }).click();
  await expect(page.getByTestId("agent-approve")).toBeEnabled();
});

test("captured view opens a cel in the already-mounted native editor @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("part-view:0").click();
  const studio = page.getByTestId("sprite-studio").filter({ visible: true });
  await expect(studio).toBeVisible();
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    await route.fulfill(
      providerReply("openai", {
        id: `native-${requests}`,
        output:
          requests === 1
            ? [
                {
                  type: "function_call",
                  name: "read_document",
                  call_id: "view",
                  arguments: JSON.stringify({ key: "view:0", offset: null, limit: null }),
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "The hero has four loops." }],
                },
              ],
      }),
    );
  });
  await page.getByTestId("agent-message").fill("Inspect the hero view");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("agent-conversation")).toContainText("The hero has four loops.");
  const resource = page.getByTestId("agent-result").getByRole("button");
  await resource.click();
  const result = page.getByTestId("agent-result-preview");
  const view = result.getByTestId("agent-view-review");
  await expect(view.locator("details")).toHaveCount(4);
  await expect(result.getByTestId("agent-earlier-version")).toHaveCount(0);
  const loop = view.locator("details").nth(2);
  await loop.locator("summary").click();
  await loop.getByRole("button", { name: "Open current cel", exact: true }).nth(1).click();
  await expect(result).toBeHidden();
  await expect(studio.getByRole("button", { name: "Loop 2, cel 1", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await resource.click();
  await view
    .locator("details")
    .first()
    .getByRole("button", { name: "Open current cel", exact: true })
    .first()
    .click();
  await expect(studio.getByRole("button", { name: "Loop 0, cel 0", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("coordinated tests proposal has a native test review @webkit-desktop", async ({ page }) => {
  await starter(page);
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await page.route("**/api/openai/v1/responses", async (route) => {
    await route.fulfill(
      providerReply("openai", {
        id: "tests",
        output: [
          {
            type: "function_call",
            call_id: "write-tests",
            name: "write_game_tests",
            arguments: JSON.stringify({
              mode: "merge",
              names: null,
              tests: [
                {
                  name: "Starting score",
                  room: 1,
                  spawnX: null,
                  spawnY: null,
                  steps: [{ action: "wait", ticks: 1 }],
                  expect: { score: 0 },
                  cycleBudget: 100,
                },
              ],
            }),
          },
          { type: "function_call", call_id: "finish", name: "finish", arguments: '{"notes":null}' },
        ],
      }),
    );
  });
  await page.getByTestId("agent-message").fill("Add a starting score test");
  await page.getByTestId("agent-send").click();
  const tests = page.getByTestId("agent-result-preview").getByTestId("agent-tests-review");
  await expect(tests).toBeVisible();
  await expect(tests.getByRole("row", { name: "Starting score 1 1", exact: true })).toBeVisible();
  await expect(page.getByTestId("agent-approve")).toBeEnabled();
});
