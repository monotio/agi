import { test, expect } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { sseEvent, providerSse } from "../../test/provider-stream.ts";
import { buildZip } from "../src/zip.ts";
import { configureAi, textHook } from "./engineProbe.ts";

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider}: live tool preparation, streamed Ask text, Stop and Continue`, async ({
    page,
  }) => {
    const requests: Record<string, unknown>[] = [];
    const responses: ServerResponse[] = [];
    const closed: number[] = [];
    const server = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Headers", "*");
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      if (request.method === "OPTIONS") {
        response.end();
        return;
      }
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        const index = responses.length;
        responses.push(response);
        response.on("close", () => closed.push(index));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        response.flushHeaders();
        if (provider === "anthropic")
          response.write(
            sseEvent({
              type: "message_start",
              message: {
                id: `r${index}`,
                type: "message",
                role: "assistant",
                content: [],
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            }),
          );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const endpoint = `http://127.0.0.1:${address.port}/stream`;
    await page.route(
      provider === "openai" ? "**/api/openai/v1/responses" : "**/api/anthropic/v1/messages",
      (route) => route.continue({ url: endpoint }),
    );
    const game = createContainer();
    game.putResource(
      "logic",
      0,
      assembleLogic(
        'assignn(v0, 1); display(5, 4, "A little adventure."); accept.input(); return;',
        { dictionary: new Map() },
      ).payload,
    );
    const zip = buildZip(
      [...game.files]
        .map(([name, data]) => ({ name, data }))
        .concat([{ name: "WORDS.TOK", data: new Uint8Array(52) }]),
    );
    try {
      await page.goto("/");
      await page.getByTestId("game-zip-input").setInputFiles({
        name: "adventure.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(zip),
      });
      await page.getByTestId("btn-resume-cached").click();
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await page.getByTestId("power-up").click();
      await configureAi(page, { provider, key: "test-placeholder" });
      await page.getByTestId("agent-mode-ask").click();
      await page.getByTestId("agent-bubble-input").fill("Where am I?");
      await page.getByTestId("agent-bubble-send").click();
      await expect.poll(() => responses.length).toBe(1);
      expect(requests[0]!["stream"]).toBe(true);
      responses[0]!.write(
        sseEvent(
          provider === "openai"
            ? {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "reason", summary: [] },
              }
            : {
                type: "content_block_start",
                index: 0,
                content_block: { type: "thinking", thinking: "", signature: "" },
              },
        ),
      );
      await expect(page.getByTestId("agent-stream-status")).toHaveText("Thinking…");
      if (provider === "anthropic") {
        responses[0]!.write(
          sseEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "opaque-signature" },
          }),
        );
        responses[0]!.write(sseEvent({ type: "content_block_stop", index: 0 }));
      }
      responses[0]!.write(
        sseEvent(
          provider === "openai"
            ? {
                type: "response.output_item.added",
                item: {
                  type: "function_call",
                  id: "tool",
                  call_id: "call",
                  name: "read_state",
                  arguments: "",
                },
              }
            : {
                type: "content_block_start",
                index: 1,
                content_block: { type: "tool_use", id: "call", name: "read_state", input: {} },
              },
        ),
      );
      await expect(page.getByTestId("agent-stream-status")).toHaveText(
        "Preparing a game inspection…",
      );
      expect(requests).toHaveLength(1);
      const toolsBeforeCompletion = await page.evaluate(() => JSON.stringify(window.__AGI_TRACE__));
      expect(toolsBeforeCompletion).not.toContain('"tool":"read_state"');
      if (provider === "openai")
        responses[0]!.end(
          providerSse(provider, {
            id: "r0",
            output: [
              {
                type: "reasoning",
                id: "reason",
                summary: [],
                encrypted_content: "opaque-reasoning",
              },
              {
                type: "function_call",
                id: "tool",
                call_id: "call",
                name: "read_state",
                arguments: "{}",
              },
            ],
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
        );
      else
        responses[0]!.end(
          [
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: "{}" },
            },
            { type: "content_block_stop", index: 1 },
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 2 },
            },
            { type: "message_stop" },
          ]
            .map(sseEvent)
            .join(""),
        );
      await expect.poll(() => responses.length).toBe(2);
      expect(JSON.stringify(requests[1])).toContain(
        provider === "openai" ? "opaque-reasoning" : "opaque-signature",
      );
      expect(JSON.stringify(requests[1])).toContain('\\"room\\":1');
      if (provider === "anthropic")
        responses[1]!.write(
          sseEvent({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
        );
      responses[1]!.write(
        sseEvent(
          provider === "openai"
            ? {
                type: "response.output_text.delta",
                delta: "I can see the café",
              }
            : {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "I can see the café" },
              },
        ),
      );
      await expect(page.getByTestId("agent-stream-text")).toHaveText("I can see the café");
      await expect(page.getByTestId("agent-bubble-send")).toBeDisabled();
      await page.screenshot({
        path: test.info().outputPath(`${provider}-stream-desktop.png`),
        animations: "disabled",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId("agent-stream-status")).toBeInViewport();
      await expect(page.getByTestId("agent-stop")).toBeInViewport();
      await page.screenshot({
        path: test.info().outputPath(`${provider}-stream-mobile.png`),
        animations: "disabled",
      });
      const conversation = page.getByTestId("agent-conversation");
      const longText = "\nAn earlier sentence.".repeat(30);
      responses[1]!.write(
        sseEvent(
          provider === "openai"
            ? {
                type: "response.output_text.delta",
                delta: longText,
              }
            : {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: longText },
              },
        ),
      );
      await expect(page.getByTestId("agent-stream-text")).toContainText(longText);
      await expect
        .poll(() => conversation.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
        .toBeLessThan(4);
      await conversation.evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll"));
      });
      responses[1]!.write(
        sseEvent(
          provider === "openai"
            ? {
                type: "response.output_text.delta",
                delta: "\nLatest sentence.",
              }
            : {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "\nLatest sentence." },
              },
        ),
      );
      await expect(page.getByTestId("agent-stream-text")).toContainText("Latest sentence.");
      expect(await conversation.evaluate((el) => el.scrollTop)).toBe(0);
      await page.getByTestId("agent-stop").click();
      await expect(page.getByTestId("agent-continue")).toBeVisible();
      await expect.poll(() => closed.includes(1)).toBe(true);
      await expect(page.getByTestId("agent-stream-text")).toBeHidden();
      await page.getByTestId("agent-continue").click();
      await expect.poll(() => responses.length).toBe(3);
      expect(JSON.stringify(requests[2])).not.toContain("I can see the café");
      if (provider === "openai")
        responses[2]!.end(
          providerSse(provider, {
            id: "r2",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "You are in room one." }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 3 },
          }),
        );
      else
        responses[2]!.end(
          [
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "You are in room one." },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 3 },
            },
            { type: "message_stop" },
          ]
            .map(sseEvent)
            .join(""),
        );
      await expect(page.getByTestId("agent-conversation")).toContainText("You are in room one.");
      await expect(page.getByTestId("agent-bubble-input")).toBeEnabled();
      await expect(page.getByTestId("agent-stream-progress")).toBeHidden();
      expect((await textHook(page)).paused).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
