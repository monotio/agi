import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider } from "../picture-fidelity.ts";
import { runProviderGenesis } from "../genesis-cli.ts";
import { createAgentSessionState } from "../../src/agent/agentState.ts";
import { executeAgentTool } from "../../src/agent/tools.ts";
import { providerSse } from "../../test/provider-stream.ts";
import { requestCost } from "../lib/usage.ts";
import { analyseRequests } from "../lib/cache-prefix.ts";
import { installScriptedProvider, queueScript } from "../lib/scripted-provider.ts";

// These assertions cover the runners' actual outbound bodies. Removing the
// client's top-level cache_control must fail even when prefix bytes stay stable.
function assertSettings(
  body: Record<string, unknown>,
  shape: "anthropic" | "openai",
  effort: string,
) {
  if (shape === "anthropic") {
    assert.deepEqual(body["cache_control"], { type: "ephemeral" });
    assert.deepEqual(body["output_config"], { effort });
    assert.deepEqual(body["thinking"], { type: "adaptive", display: "updates" });
    assert.equal(body["max_tokens"], 128000);
    assert.ok(body["context_management"]);
    assert.deepEqual((body["system"] as Record<string, unknown>[])[0]!["cache_control"], {
      type: "ephemeral",
      ttl: "1h",
    });
  } else {
    assert.deepEqual(body["reasoning"], { effort });
    assert.equal(body["max_output_tokens"], 128000);
    assert.deepEqual(body["prompt_cache_options"], { mode: "implicit", ttl: "30m" });
    assert.ok(body["prompt_cache_key"]);
    assert.ok(body["context_management"]);
    const input = body["input"] as Record<string, unknown>[];
    const tail = input.at(-1)!;
    const blocks = (tail["output"] ?? tail["content"]) as Record<string, unknown>[];
    assert.deepEqual(blocks.at(-1)!["prompt_cache_breakpoint"], { mode: "explicit" });
  }
}

for (const shape of ["anthropic", "openai"] as const)
  test(`picture turns use production caching and model settings (${shape})`, async (t) => {
    const key = shape === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const saved = process.env[key];
    process.env[key] = "offline-test-key";
    t.after(() => {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    });
    const scripted = installScriptedProvider(shape);
    t.after(() => scripted.restore());
    scripted.use(
      queueScript([
        { calls: [{ name: "write_picture", input: { room: 1, source: "end\n" } }] },
        { calls: [{ name: "write_picture", input: { room: 1, source: "end\n" } }] },
      ]),
    );
    const model = shape === "anthropic" ? "claude-fable-5-1" : "gpt-6-sol";
    const provider = createProvider(shape, model, undefined, undefined);
    const session = createAgentSessionState();
    let revision: unknown;
    await provider.recreate(
      "system",
      "user",
      (name, args) => {
        const result = executeAgentTool(session, name, args);
        revision ??= result.details?.["revision"];
        return result;
      },
      2,
    );
    assert.equal(scripted.requests.length, 2);
    for (const { body } of scripted.requests)
      assertSettings(body, shape, shape === "anthropic" ? "high" : "medium");
    const report = analyseRequests(
      "picture",
      shape,
      scripted.requests.map(({ body }) => body),
    );
    assert.equal(report.minStability, 1);
    const body = scripted.requests[1]!.body;
    const messages = body[shape === "anthropic" ? "messages" : "input"] as Record<
      string,
      unknown
    >[];
    const result =
      shape === "anthropic"
        ? (messages.at(-1)!["content"] as Record<string, unknown>[])[0]!["content"]
        : messages.at(-1)!["output"];
    const details = JSON.parse(String((result as Record<string, unknown>[])[0]!["text"])).details;
    assert.equal(details.revision, revision, "round instructions preserve the resource revision");
    assert.match(details.roundInstruction, /Revisions left: 1/);
    assert.match(
      JSON.stringify(result),
      shape === "anthropic" ? /"type":"image"/ : /"type":"input_image"/,
    );
  });

for (const shape of ["anthropic", "openai"] as const)
  for (const effort of [undefined, "low"] as const)
    test(`Genesis preserves tool images, nudges and traces (${shape}, ${effort ?? "default"})`, async (t) => {
      const scripted = installScriptedProvider(shape);
      t.after(() => scripted.restore());
      scripted.use(
        queueScript([
          { text: "Working on the opening." },
          { calls: [{ name: "write_picture", input: { room: 1, source: "vis 1\nend\n" } }] },
          { text: "Done with the picture." },
        ]),
      );
      const trace: Parameters<typeof runProviderGenesis>[3] = [];
      const session = createAgentSessionState();
      await runProviderGenesis(
        {
          provider: shape,
          model: shape === "anthropic" ? "claude-fable-5-1" : "gpt-6-sol",
          apiKey: "offline-test-key",
          template: "test",
          tracePath: "unused",
          maxTurns: 3,
          budgetUsd: 1,
          ...(effort === undefined ? {} : { effort }),
        },
        "Create an opening.",
        session,
        trace,
      );
      assert.equal(scripted.requests.length, 3);
      for (const { body } of scripted.requests)
        assertSettings(body, shape, effort ?? (shape === "anthropic" ? "high" : "medium"));
      const bodies = scripted.requests.map(({ body }) => body);
      assert.equal(analyseRequests("genesis", shape, bodies).minStability, 1);
      assert.match(JSON.stringify(bodies[1]), /Genesis is not yet complete/);
      assert.match(
        JSON.stringify(bodies[2]),
        shape === "anthropic" ? /"type":"image"/ : /"type":"input_image"/,
      );
      if (shape === "openai")
        assert.equal(bodies[0]!["prompt_cache_key"], bodies[2]!["prompt_cache_key"]);
      assert.ok(session.container.getResource("picture", 1));
      assert.equal(trace.filter((entry) => entry.type === "model_output").length, 3);
      assert.equal(trace.filter((entry) => entry.type === "tool_execution").length, 1);
      const output = trace.filter((entry) => entry.type === "model_output")[1]!.payload as {
        transcript: unknown[];
        usage: { input: number };
      };
      assert.ok(output.transcript.length > 0);
      assert.equal(output.usage.input, 0);
    });

for (const shape of ["anthropic", "openai"] as const)
  test(`picture brief and judge use production defaults and explicit effort (${shape})`, async (t) => {
    const key = shape === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const saved = process.env[key];
    process.env[key] = "offline-test-key";
    t.after(() => {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    });
    const scripted = installScriptedProvider(shape);
    t.after(() => scripted.restore());
    for (const effort of [undefined, "low"] as const) {
      scripted.use(queueScript([{ text: "A stone castle." }]));
      const model = shape === "anthropic" ? "claude-opus-5-5" : "gpt-6-sol";
      const judge = shape === "anthropic" ? "claude-fable-5-1" : "gpt-6-sol";
      const provider = createProvider(shape, model, judge, effort);
      const text = await provider.complete(
        "judge",
        [
          { type: "text", text: "Compare the images." },
          { type: "image", png: new Uint8Array([1, 2, 3]) },
          { type: "text", text: "Second image." },
          { type: "image", png: new Uint8Array([4, 5, 6]) },
          { type: "text", text: "Score the pair." },
        ],
        judge,
      );
      assert.equal(text, "A stone castle.");
      const body = scripted.requests.at(-1)!.body;
      assertSettings(body, shape, effort ?? (shape === "anthropic" ? "high" : "medium"));
      assert.equal(body["model"], judge);
      assert.match(JSON.stringify(body), /AQID/);
      assert.deepEqual(body["tools"], []);
      const messages = body[shape === "anthropic" ? "messages" : "input"] as Record<
        string,
        unknown
      >[];
      const content = messages[0]!["content"] as Record<string, unknown>[];
      const second = content.findIndex((block) => JSON.stringify(block).includes("BAUG"));
      assert.equal(content[second - 1]!["text"], "Second image.");
    }
  });

for (const shape of ["anthropic", "openai"] as const)
  test(`Genesis charges cached usage before requesting or executing another turn (${shape})`, async (t) => {
    let requests = 0;
    const model = shape === "anthropic" ? "claude-opus-5-5" : "gpt-6-sol";
    const bill = { input: 100000, output: 20000, cachedInput: 10000, cacheWriteInput: 5000 };
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      const payload =
        shape === "anthropic"
          ? {
              id: `msg_${requests}`,
              type: "message",
              role: "assistant",
              model,
              content: [
                {
                  type: "tool_use",
                  id: `call_${requests}`,
                  name: "write_words",
                  input: { words: ["look"] },
                },
              ],
              stop_reason: "tool_use",
              usage: {
                input_tokens: 85000,
                output_tokens: 20000,
                cache_read_input_tokens: 10000,
                cache_creation_input_tokens: 5000,
              },
            }
          : {
              id: `resp_${requests}`,
              model,
              status: "completed",
              output: [
                {
                  type: "function_call",
                  call_id: `call_${requests}`,
                  name: "write_words",
                  arguments: '{"words":["look"]}',
                },
              ],
              usage: {
                input_tokens: 100000,
                output_tokens: 20000,
                input_tokens_details: { cached_tokens: 10000, cache_write_tokens: 5000 },
              },
            };
      return new Response(providerSse(shape, payload), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const trace: Parameters<typeof runProviderGenesis>[3] = [];
    await assert.rejects(
      runProviderGenesis(
        {
          provider: shape,
          model,
          apiKey: "offline-test-key",
          template: "test",
          tracePath: "unused",
          maxTurns: 6,
          budgetUsd: requestCost(model, bill)! * 1.5,
        },
        "Create an opening.",
        createAgentSessionState(),
        trace,
      ),
      /Budget reached/,
    );
    assert.equal(requests, 2);
    assert.equal(trace.filter((entry) => entry.type === "tool_execution").length, 1);
    const output = trace.at(-1)!.payload as { usage: typeof bill };
    for (const [field, value] of Object.entries(bill))
      assert.equal(output.usage[field as keyof typeof bill], value);
  });
