import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/zip.ts";
import { configureAi, textHook } from "./engineProbe.ts";

test("Ask stays paused, remembers the conversation after reload, and hands context to Remix", async ({
  page,
}) => {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic('assignn(v0, 1); display(5, 4, "A little adventure."); accept.input(); return;', {
      dictionary: new Map(),
    }).payload,
  );
  const zip = buildZip(
    [...game.files]
      .map(([name, data]) => ({ name, data }))
      .concat([{ name: "WORDS.TOK", data: new Uint8Array(52) }]),
  );
  const requests: string[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests.push(route.request().postData()!);
    await route.fulfill(
      providerReply("openai", {
        id: `reply${requests.length}`,
        output:
          requests.length <= 20
            ? [
                {
                  type: "function_call",
                  call_id: `inspect-${requests.length}`,
                  name: "read_state",
                  arguments: JSON.stringify({
                    compact: true,
                    variables: [requests.length],
                    flags: null,
                  }),
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "Look around the room for a clue.",
                    },
                  ],
                },
              ],
      }),
    );
  });
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "adventure.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("power-up").click();
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await page.getByTestId("agent-mode-ask").click();
  await page.getByTestId("agent-mode-remix").click();
  await page.getByRole("button", { name: "Back to game", exact: true }).first().click();
  await page.getByTestId("power-up").click();
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await page.getByTestId("agent-mode-ask").click();
  expect(requests.length).toBe(0);
  await page.getByTestId("agent-bubble-input").fill("Could I have a small hint?");
  await page.getByTestId("agent-bubble-send").click();
  const conversation = page.getByTestId("agent-conversation");
  await expect(conversation).toContainText("Look around the room for a clue.");
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  expect((await textHook(page)).paused).toBe(true);
  expect(requests.length).toBe(21); // Productive investigation passes the old 16-round stop.
  const firstInput = JSON.parse(requests[0]!).input;
  expect(firstInput).toHaveLength(1);
  expect(firstInput[0].content).toContain("### ORIENTATION");
  expect(firstInput[0].content).toContain("Current room: 1");
  expect(firstInput[0].content).toContain("Could I have a small hint?");
  expect(firstInput[0].content).toContain("### ASK REQUEST");
  await expect(page.getByTestId("agent-bubble-feed")).toBeHidden();
  const input = (await page.getByTestId("agent-bubble-input").boundingBox())!;
  const send = (await page.getByTestId("agent-bubble-send").boundingBox())!;
  expect(Math.abs(input.y - send.y)).toBeLessThan(1);
  expect(Math.abs(input.height - send.height)).toBeLessThan(1);
  await page.screenshot({ path: "test-results/ask-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Back to game", exact: true }).first(),
  ).toBeInViewport();
  await expect(page.getByTestId("agent-bubble-input")).toBeInViewport();
  await page.screenshot({ path: "test-results/ask-mobile.png" });
  await page.getByRole("button", { name: "Back to game", exact: true }).first().click();
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("power-up").click();
  await expect(conversation).toContainText("Could I have a small hint?");
  await expect(conversation).toContainText("Look around the room for a clue.");
  await expect(page.getByTestId("agent-mode-remix")).toBeEnabled();
  await page.getByTestId("agent-mode-remix").click();
  expect(requests.length).toBe(21);
  await page.getByTestId("agent-bubble-input").fill("Apply your suggestion");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-bubble")).toBeHidden();
  expect(requests.at(-1)).toContain("Could I have a small hint?");
  expect(requests.at(-1)).toContain("Apply your suggestion");
});
