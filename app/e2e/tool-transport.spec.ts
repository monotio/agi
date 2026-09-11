import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider}: browser tool images remain image blocks across a correction turn`, async ({
    page,
  }) => {
    const requests: Record<string, unknown>[] = [];
    await page.route(
      provider === "openai" ? "**/api/openai/v1/responses" : "**/api/anthropic/v1/messages",
      async (route) => {
        requests.push(route.request().postDataJSON());
        await route.fulfill(
          providerReply(
            provider,
            provider === "openai"
              ? { id: "test", output: [] }
              : {
                  id: "test",
                  type: "message",
                  role: "assistant",
                  content: [],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
          ),
        );
      },
    );
    await page.goto("/");
    const sizes = await page.evaluate(
      async ({ vendor, toolsPath }) => {
        const clientPath = "/src/agent/llmClient.ts";
        const client = await import(clientPath);
        const config = { provider: vendor, apiKey: "test-placeholder", model: "test" };
        const conversation =
          vendor === "openai"
            ? client.createOpenAiConversation(config)
            : client.createAnthropicConversation(config);
        const tools = await import(toolsPath);
        const state = tools.createAgentSessionState();
        const result = tools.executeAgentTool(state, "write_picture", {
          room: 1,
          source: "vis 1\nfill 0,0\nend",
        });
        const sprite = tools.executeAgentTool(state, "write_view", {
          num: 0,
          spec: {
            loops: [
              { cels: [{ width: 3, height: 2, pixels: [4, 0, 1, 2, 0, 3] }] },
              { mirrorLoop: 0 },
            ],
          },
        });
        conversation.setAvailableTools(["read_view", "read_picture"]);
        await conversation.sendUserMessage("Inspect a room.");
        conversation.setAvailableTools();
        conversation.appendToolResults([{ toolCallId: "picture", result }]);
        await conversation.complete();
        conversation.appendToolResults([{ toolCallId: "sprite", result: sprite }]);
        await conversation.complete();
        const recovery = tools.executeAgentTool(state, "write_logic_source", {
          room: 2,
          source: "relese.priorty(o1); return;",
        });
        const reference = tools.executeAgentTool(state, "read_command_reference", {
          query: "release.priority",
          kind: "action",
          offset: null,
        });
        conversation.appendToolResults([
          { toolCallId: "compile", result: recovery },
          { toolCallId: "reference", result: reference },
        ]);
        await conversation.complete();
        return conversation.getTranscript().length;
      },
      {
        vendor: provider,
        toolsPath: "/@fs" + fileURLToPath(new URL("../../src/agent/tools.ts", import.meta.url)),
      },
    );
    expect(sizes).toBeGreaterThan(0);
    expect(requests).toHaveLength(4);
    if (provider === "openai")
      expect(requests[0]!["prompt_cache_options"]).toEqual({ mode: "implicit", ttl: "30m" });
    if (provider === "openai") {
      const allowed = (requests[0]!["tool_choice"] as { tools: { name: string }[] }).tools;
      expect(allowed.map((tool) => tool.name).sort()).toEqual(["read_picture", "read_view"]);
    } else {
      // Anthropic has no allowed-tools field: the request advertises the
      // full stable catalog and the host dispatcher denies unavailable tools.
      const advertised = (requests[0]!["tools"] as { name: string }[]).map((tool) => tool.name);
      expect(advertised).toContain("read_picture");
      expect(advertised).toContain("read_view");
      expect(advertised).toContain("write_view");
    }
    if (provider === "openai") expect(requests[0]!["tools"]).toEqual(requests[1]!["tools"]);
    expect(
      (requests[1]!["tools"] as { name: string }[]).some((tool) => tool.name === "write_view"),
    ).toBe(true);
    expect(
      (requests[1]!["tools"] as { name: string }[]).some(
        (tool) => tool.name === "read_command_reference",
      ),
    ).toBe(true);
    const recoveryRequest = JSON.stringify(requests[3]);
    expect(recoveryRequest).toContain("release.priority(object)");
    expect(recoveryRequest).toContain("relatedCommands");
    expect(recoveryRequest).toContain("automatic depth");
    const request = requests[1]! as {
      input?: { type: string; output: { type: string; text?: string; image_url?: string }[] }[];
      messages?: {
        role: string;
        content: { content: { type: string; text?: string; source?: { data: string } }[] }[];
      }[];
    };
    const blocks =
      provider === "openai"
        ? request.input!.find((item) => item.type === "function_call_output")!.output
        : request.messages!.find((item) => item.role === "user" && Array.isArray(item.content))!
            .content[0]!.content;
    expect(blocks[0]!.text!.length).toBeLessThan(2000);
    expect(JSON.parse(blocks[0]!.text!).images).toBeUndefined();
    expect(blocks).toHaveLength(3);
    expect(blocks[2]!.type).toBe(provider === "openai" ? "input_image" : "image");
    const spriteRequest = requests[2]! as typeof request;
    const spriteBlocks =
      provider === "openai"
        ? spriteRequest.input!.filter((item) => item.type === "function_call_output").at(-1)!.output
        : spriteRequest
            .messages!.filter((item) => item.role === "user" && Array.isArray(item.content))
            .at(-1)!.content[0]!.content;
    expect(spriteBlocks[0]!.text!.length).toBeLessThan(1600);
    expect(JSON.parse(spriteBlocks[0]!.text!).images).toBeUndefined();
    expect(spriteBlocks).toHaveLength(3);
    expect(spriteBlocks[1]!.text).toContain("L0 C0, L1 C0");
    expect(spriteBlocks[2]!.type).toBe(provider === "openai" ? "input_image" : "image");
    await page.screenshot({ path: `test-results/${provider}-tool-transport.png` });
  });
}
