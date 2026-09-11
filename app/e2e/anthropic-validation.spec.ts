import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/zip.ts";
import { configureAi, textHook } from "./engineProbe.ts";

test("Anthropic Ask recovers from invalid runtime arguments and accepts omitted options", async ({
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
  const requests: {
    tools: { name: string; strict?: boolean }[];
    messages: {
      content: { tool_use_id: string; is_error: boolean; content: { text: string }[] }[];
    }[];
  }[] = [];
  await page.route("**/api/anthropic/v1/messages", async (route) => {
    requests.push(route.request().postDataJSON());
    const turn = requests.length;
    await route.fulfill(
      providerReply("anthropic", {
        id: `reply-${turn}`,
        type: "message",
        role: "assistant",
        stop_reason: turn <= 2 ? "tool_use" : "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        content:
          turn <= 2
            ? [
                {
                  type: "tool_use",
                  id: `inspect-${turn}`,
                  name: "read_room_context",
                  input:
                    turn === 1
                      ? { room: 1, state: null, frames: { count: "9" } }
                      : {
                          room: null,
                          state: { variables: null, flags: null, compact: true },
                          frames: null,
                        },
                },
              ]
            : [{ type: "text", text: "You are in room 1." }],
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
  await configureAi(page, { provider: "anthropic", key: "test-placeholder" });
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
  await page.getByTestId("agent-mode-ask").click();
  await page.getByTestId("agent-bubble-input").fill("Where am I?");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-conversation")).toContainText("You are in room 1.");
  await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();

  expect(requests).toHaveLength(3);
  expect(requests[0]!.tools.every((tool) => tool.strict !== true)).toBe(true);
  const rejected = requests[1]!.messages.at(-1)!.content[0]!;
  expect(rejected.tool_use_id).toBe("inspect-1");
  expect(rejected.is_error).toBe(true);
  expect(JSON.parse(rejected.content[0]!.text)).toMatchObject({
    success: false,
    error:
      "Invalid arguments for read_room_context; nothing was changed. frames.count must be integer or null, got string.",
  });
  const accepted = requests[2]!.messages.at(-1)!.content[0]!;
  expect(accepted.tool_use_id).toBe("inspect-2");
  expect(accepted.is_error).toBe(false);
  expect(JSON.parse(accepted.content[0]!.text)).toMatchObject({
    success: true,
    details: { room: 1 },
  });
  expect((await textHook(page)).paused).toBe(true);
});
