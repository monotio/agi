import { providerReply } from "../../test/provider-stream.ts";
import { expect, test } from "./test.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/archive/zip.ts";
import {
  configureAi,
  openAiSettings,
  textHook,
  enterCreateMode,
  openWorkspaceAgent,
  workspaceSaved,
} from "./engineProbe.ts";

test("GPT-6.1 Sol is the new-user default; Stop and budget pauses retain a staged remix", async ({
  page,
}) => {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic("assignn(v0, 1); accept.input(); return;", { dictionary: new Map() }).payload,
  );
  const archive = buildZip(
    [...game.files]
      .map(([name, data]) => ({ name, data }))
      .concat([{ name: "WORDS.TOK", data: new Uint8Array(52) }]),
  );
  let requests = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reviewRequested = false;
  let releaseReview!: () => void;
  const reviewBlocked = new Promise<void>((resolve) => {
    releaseReview = resolve;
  });
  await page.route("**/src/agent/AgentResourceReview.vue", async (route) => {
    reviewRequested = true;
    await reviewBlocked;
    await route.continue();
  });
  await page.route("**/api/openai/v1/responses", async (route) => {
    const request = ++requests;
    expect(route.request().postDataJSON().model).toBe("gpt-6.1-sol");
    expect(route.request().postDataJSON().max_output_tokens).toBe(128000);
    expect(route.request().postDataJSON().context_management).toEqual([
      { type: "compaction", compact_threshold: 691500 },
    ]);
    if (request === 2) await blocked;
    try {
      await route.fulfill(
        providerReply("openai", {
          id: `task${request}`,
          usage: { input_tokens: 0, output_tokens: request === 3 ? 60000 : 0 },
          output:
            request === 1
              ? [
                  {
                    type: "function_call",
                    call_id: "word",
                    name: "write_words",
                    arguments: '{"words":["sparkle"]}',
                  },
                ]
              : request === 3
                ? [
                    {
                      type: "function_call",
                      call_id: "read",
                      name: "read_words",
                      arguments: '{"prefix":null,"exact":null,"offset":0,"limit":100}',
                    },
                  ]
                : [
                    {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "output_text", text: "Ready." }],
                    },
                  ],
        }),
      );
    } catch {
      /* The stopped request has been aborted. */
    }
  });
  try {
    await page.goto("/");
    await openAiSettings(page);
    await expect(page.getByTestId("model-select")).toHaveValue("gpt-6.1-sol");
    await page.getByTestId("ai-settings-cancel").click();
    await page.getByTestId("game-zip-input").setInputFiles({
      name: "task.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(archive),
    });
    await page.getByTestId("btn-resume-cached").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await enterCreateMode(page);
    await openWorkspaceAgent(page);
    await configureAi(page, { provider: "openai", key: "test-placeholder", budget: 1 });
    await openWorkspaceAgent(page);
    await expect(page.getByTestId("agent-message")).toBeEnabled();
    await page.getByTestId("agent-message").fill("Add sparkle to the vocabulary");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => requests).toBe(2);
    // UiButton's fine-pointer height is --control-h (40px); touch gets 44px via
    // the pointer:coarse media query.
    expect((await page.getByTestId("agent-stop").boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await page.getByTestId("agent-stop").click();
    await expect(page.getByTestId("agent-pause-reason")).toBeVisible();
    await expect(page.getByTestId("agent-pause-reason")).toContainText("Stopped");
    expect((await textHook(page)).paused).toBe(false);
    await page.screenshot({ path: test.info().outputPath("agent-stopped.png") });
    release();
    await page.getByTestId("agent-continue").click();
    await expect(page.getByTestId("agent-pause-reason")).toBeVisible();
    await expect(page.getByTestId("agent-pause-reason")).toContainText("Budget");
    expect(requests).toBe(3);
    expect(
      (await page.getByTestId("workspace-agent-panel").boundingBox())!.y,
    ).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath("agent-budget.png") });
    await page.getByTestId("agent-continue").click();
    await expect.poll(() => reviewRequested).toBe(true);
    await expect(page.getByTestId("agent-review")).toBeHidden();
    releaseReview();
    await expect(page.getByTestId("agent-review")).toBeVisible();
    await page.getByTestId("agent-approve").click();
    await expect(page.getByTestId("agent-review")).toHaveCount(0);
    await workspaceSaved(page);
    const words = await page.evaluate(async () => {
      const path = "/src/project/gameStorage.ts";
      const { listCachedGames, loadAuthoredGame } = await import(path);
      return (await loadAuthoredGame(listCachedGames()[0].projectId)).words;
    });
    expect(words.map(([word]: [string, number]) => word)).toContain("sparkle");
  } finally {
    release();
    releaseReview();
  }
});

test("unknown spend waits for a request allowance in the real assistant", async ({ page }) => {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic("assignn(v0, 1); accept.input(); return;", { dictionary: new Map() }).payload,
  );
  const archive = buildZip(
    [...game.files]
      .map(([name, data]) => ({ name, data }))
      .concat([{ name: "WORDS.TOK", data: new Uint8Array(52) }]),
  );
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    await route.fulfill(
      providerReply("openai", {
        id: "allowed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Inspection complete." }],
          },
        ],
      }),
    );
  });
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "allowance.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await enterCreateMode(page);
  await openWorkspaceAgent(page);
  // Simulate a selectable model whose price has not yet been verified.
  const modelModule = `/@fs${new URL("../../src/agent/modelEffort.ts", import.meta.url).pathname}`;
  await page.evaluate(async (path) => {
    const { MODEL_CAPABILITIES } = await import(path);
    delete MODEL_CAPABILITIES["gpt-6-sol"].price;
  }, modelModule);
  await configureAi(page, { provider: "openai", model: "gpt-6-sol", key: "placeholder" });
  await page.getByTestId("agent-message").fill("Inspect this room.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-pause-reason")).toBeVisible();
  await expect(page.getByTestId("agent-pause-reason")).toContainText("Choose how many requests");
  const usage = page.getByRole("link", { name: "See your usage", exact: true });
  await expect(usage).toBeVisible();
  await expect(usage).toHaveCSS("color", "rgb(121, 229, 230)");
  await expect(usage).toHaveAttribute("href", "https://platform.openai.com/usage");
  expect(requests).toBe(0);
  await page.getByTestId("agent-request-limit").fill("2");
  await page.screenshot({ path: test.info().outputPath("request-allowance.png") });
  await page.getByTestId("agent-continue").click();
  await expect(page.getByTestId("agent-message")).toBeEnabled();
  expect(requests).toBe(1);
});
