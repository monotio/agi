import { providerSse } from "../../test/provider-stream.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "../src/agent/agentSession.ts";
import { createAgentSessionState } from "../../src/agent/tools.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
import { createOpenAiConversation } from "../src/agent/llmClient.ts";

test("Ask refuses mutations even when the provider requests them, and keeps the conversation", async (t) => {
  const requests: { tool_choice: { tools: { name: string }[] }; input: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const output =
      requests.length === 1
        ? [
            {
              type: "function_call",
              call_id: "write",
              name: "write_words",
              arguments: '{"words":["changed"]}',
            },
          ]
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "The game is unchanged." }],
            },
          ];
    return new Response(providerSse("openai", { id: `ask${requests.length}`, output }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const state = createAgentSessionState();
  const before = [...state.getFiles()].map(([name, bytes]) => [name, [...bytes]]);
  const session = new AgentSession(
    { provider: "openai", apiKey: "test-placeholder", model: "test" },
    () => {},
    state,
  );
  const result = await session.runAsk("Why did the player disappear?", 4);
  assert.equal(result, "The game is unchanged.");
  assert.deepEqual(
    [...state.getFiles()].map(([name, bytes]) => [name, [...bytes]]),
    before,
  );
  assert.ok(
    requests[0]!.tool_choice.tools.every((tool: { name: string }) => tool.name !== "write_words"),
  );
  assert.match(JSON.stringify(requests[1]!.input), /Ask mode is read-only/);
  await session.runAsk("What should I try next?", 4);
  assert.match(JSON.stringify(requests[2]!.input), /Why did the player disappear/);
  assert.match(JSON.stringify(requests[2]!.input), /The game is unchanged/);
});

test("an unanswered historical tool call is reported as unexecuted, never successful", async (t) => {
  let request: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    request = JSON.parse(String(init.body));
    return new Response(providerSse("openai", { id: "test", output: [] }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const conversation = createOpenAiConversation(
    { provider: "openai", apiKey: "test-placeholder", model: "test" },
    [
      {
        type: "function_call",
        id: "item",
        call_id: "pending",
        name: "write_logic_source",
        arguments: '{"room":1,"source":"return;"}',
      },
    ],
  );
  await conversation.sendUserMessage("Continue inspecting.");
  const input = request["input"] as { type: string; call_id?: string; output?: string }[];
  const result = input.find(
    (item) => item.type === "function_call_output" && item.call_id === "pending",
  )!;
  assert.equal(JSON.parse(result.output!).success, false);
  assert.match(JSON.parse(result.output!).error, /not executed/);
});

test("a provider power-up returns compiled vocabulary and inventory files with its resource patches", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    const output =
      requests === 1
        ? [
            {
              type: "function_call",
              id: "word-item",
              call_id: "word",
              name: "write_words",
              arguments: JSON.stringify({ words: ["sparkle"] }),
            },
            {
              type: "function_call",
              id: "object-item",
              call_id: "object",
              name: "write_inventory_objects",
              arguments: JSON.stringify({ objects: [{ name: "Crystal", startingRoom: 255 }] }),
            },
          ]
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "You have a crystal." }],
            },
          ];
    return new Response(providerSse("openai", { id: `reply${requests}`, output }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const state = createAgentSessionState();
  const session = new AgentSession(
    { provider: "openai", apiKey: "test-placeholder", model: "test" },
    () => {},
    state,
  );
  const result = await session.runPowerUp("Give me a crystal and the sparkle command", 1);
  assert.equal(requests, 2);
  assert.deepEqual(result.files?.["OBJECT"], state.objectPayload);
  assert.ok(result.files?.["OBJECT"]);
  assert.ok(parseWordsTok(result.files!["WORDS.TOK"]!).some(({ word }) => word === "sparkle"));
  assert.equal(result.text, "You have a crystal.");
});

test("room helper edits are transactional and cannot rewrite another room", async (t) => {
  const { assembleLogic } = await import("../../src/logic/assembler.ts");
  const { resourceRevision } = await import("../../src/agent/authoringState.ts");
  const state = createAgentSessionState();
  const original = assembleLogic("assignn(v40, 1); return;", { dictionary: new Map() }).payload;
  state.container.putResource("logic", 1, original);
  state.sources.logics.set(1, "assignn(v40, 1); return;");
  let count = 0;
  let rejected = "";
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    count++;
    if (count === 2) rejected = JSON.stringify(request.input);
    const output =
      count === 1
        ? [
            {
              type: "function_call",
              call_id: "wrong",
              name: "edit_resource_source",
              arguments: JSON.stringify({
                kind: "logic",
                num: 1,
                expectedRevision: resourceRevision(original),
                find: "assignn(v40, 1);",
                replace: "assignn(v40, 2);",
              }),
            },
            {
              type: "function_call",
              call_id: "room",
              name: "write_logic_source",
              arguments: JSON.stringify({ room: 2, source: "return;" }),
            },
            {
              type: "function_call",
              call_id: "pic",
              name: "write_picture",
              arguments: JSON.stringify({ room: 2, source: "vis 1\nfill 0,0\nend" }),
            },
            {
              type: "function_call",
              call_id: "fact",
              name: "update_world",
              arguments: JSON.stringify({
                rooms: [],
                facts: [{ name: "weather", text: "rain" }],
                quests: [],
              }),
            },
          ]
        : [];
    return new Response(providerSse("openai", { id: String(count), output }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const session = new AgentSession(
    { provider: "openai", apiKey: "placeholder", model: "test" },
    () => {},
    state,
  );
  await session.handle({ op: "room", context: { room: 2, from: 1 } });
  assert.deepEqual(state.container.getResource("logic", 1), original);
  assert.match(rejected, /requested room/);
  assert.equal(state.authoring.world.facts["weather"], "rain");
});

test("a stalled remix pauses and can be discarded without claiming completion", async (t) => {
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        providerSse("openai", {
          id: String(++calls),
          output: [
            {
              type: "function_call",
              call_id: String(calls),
              name: "list_resources",
              arguments: '{"kind":null}',
            },
          ],
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const session = new AgentSession(
    { provider: "openai", apiKey: "placeholder", model: "test" },
    () => {},
  );
  const work = session.runPowerUp("Keep working", 1);
  const rejected = assert.rejects(work, /cancelled/i);
  for (let i = 0; i < 100 && session.task.snapshot().status !== "paused"; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.task.snapshot().status, "paused");
  assert.ok(calls < 24);
  session.task.cancel();
  await rejected;
});

test("offline room and remix snapshots track the resources applied to the worker", async () => {
  const session = new AgentSession(
    { provider: "stub", model: "offline-stub", apiKey: "" },
    () => {},
  );
  await session.startGenesis("");
  await session.handle({ op: "room", context: { room: 2, from: 1 } });
  assert.ok(session.state.container.getResource("logic", 2));
  const result = await session.runPowerUp("Add a sign", 2);
  assert.deepEqual(session.state.container.getResource("logic", 2), result.patched[0]?.payload);
});

test("a truncated response pauses without discarding earlier staged resources", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(
      providerSse("openai", {
        id: `truncated${calls}`,
        ...(calls === 2
          ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
          : {}),
        output:
          calls === 1
            ? [
                {
                  type: "function_call",
                  call_id: "word",
                  name: "write_words",
                  arguments: '{"words":["sparkle"]}',
                },
              ]
            : calls === 2
              ? []
              : [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "The vocabulary is ready." }],
                  },
                ],
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const session = new AgentSession(
    { provider: "openai", apiKey: "test-placeholder", model: "test" },
    () => {},
  );
  const work = session.runPowerUp("Add sparkle", 1);
  void work.catch(() => {});
  for (let i = 0; i < 100 && session.task.snapshot().status !== "paused"; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.task.snapshot().status, "paused");
  assert.equal(session.state.sources.words.has("sparkle"), false);
  session.task.resume();
  await work;
  assert.equal(session.state.sources.words.has("sparkle"), true);
});

test("Genesis executes advertised room inspection through the shared asynchronous dispatcher", async (t) => {
  let requests = 0;
  let result: { success?: boolean; error?: string } | undefined;
  t.mock.method(globalThis, "fetch", async () => {
    if (++requests > 1) throw new Error("End this bounded inspection test.");
    return new Response(
      providerSse("openai", {
        id: "genesis-context",
        output: [
          {
            type: "function_call",
            call_id: "context",
            name: "read_room_context",
            arguments: '{"room":1}',
          },
        ],
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const session = new AgentSession(
    { provider: "openai", apiKey: "test-placeholder", model: "gpt-5.6-sol" },
    (_type, message, data) => {
      const event = data as { result?: typeof result } | undefined;
      if (message.startsWith("[Genesis] read_room_context") && event?.result) result = event.result;
    },
  );
  await assert.rejects(session.startGenesis("A quiet courtyard."));
  assert.equal(requests, 2);
  assert.equal(result?.success, true, result?.error ?? "room context was not returned");
});
