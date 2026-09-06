import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/zip.ts";
import { configureAi, textHook } from "./engineProbe.ts";

test("Astra is the new-user default; Stop and budget pauses retain a staged remix", async ({
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
  await page.route("**/api/openai/v1/responses", async (route) => {
    const request = ++requests;
    expect(route.request().postDataJSON().model).toBe("gpt-6-astra");
    expect(route.request().postDataJSON().max_output_tokens).toBeGreaterThan(4096);
    if (request === 2) await blocked;
    try {
      await route.fulfill(
        providerReply("openai", {
          id: `task${request}`,
          usage: { input_tokens: 0, output_tokens: request === 3 ? 100000 : 0 },
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
    await page.getByTestId("open-ai-settings").click();
    await expect(page.getByTestId("model-select")).toHaveValue("gpt-6-astra");
    await page.getByTestId("ai-settings-cancel").click();
    await page.getByTestId("game-zip-input").setInputFiles({
      name: "task.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(archive),
    });
    await page.getByTestId("btn-resume-cached").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await page.getByTestId("power-up").click();
    await configureAi(page, { provider: "openai", key: "test-placeholder" });
    await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
    await page.getByTestId("agent-bubble-input").fill("Add sparkle to the vocabulary");
    await page.getByTestId("agent-bubble-send").click();
    await expect.poll(() => requests).toBe(2);
    expect((await page.getByTestId("agent-stop").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByTestId("agent-stop").click();
    await expect(page.getByTestId("agent-pause-reason")).toContainText("Stopped");
    expect((await textHook(page)).paused).toBe(true);
    await page.screenshot({ path: "test-results/agent-stopped.png" });
    release();
    await page.getByTestId("agent-continue").click();
    await expect(page.getByTestId("agent-pause-reason")).toContainText("Budget");
    expect(requests).toBe(3);
    expect((await page.getByTestId("agent-bubble").boundingBox())!.y).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: "test-results/agent-budget.png" });
    await page.getByTestId("agent-continue").click();
    await expect(page.getByTestId("agent-bubble")).toBeHidden();
    const words = await page.evaluate(async () => {
      const path = "/src/cartridgeStorage.ts";
      const { listCachedCartridges, loadAuthoredCartridge } = await import(path);
      return (await loadAuthoredCartridge(listCachedCartridges()[0].slug)).words;
    });
    expect(words.map(([word]: [string, number]) => word)).toContain("sparkle");
  } finally {
    release();
  }
});
