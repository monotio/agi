import { providerSse } from "../../test/provider-stream.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "../src/agent/agentSession.ts";
import { createAgentSessionState } from "../../src/agent/tools.ts";
import { openContainer } from "../../src/container/container.ts";
import { parseWordsTok, buildWordsTok } from "../../src/logic/words.ts";
import { buildView } from "../../src/view/view.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
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

test("a successful handover ends the turn with no provider request and rejects bundled calls", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(
      providerSse("openai", {
        id: `r${requests}`,
        output: [
          {
            type: "function_call",
            call_id: "w",
            name: "write_words",
            arguments: JSON.stringify({ words: ["lamp"], groups: null }),
          },
          {
            type: "function_call",
            call_id: "h",
            name: "handover",
            arguments: JSON.stringify({ notes: null }),
          },
          {
            type: "function_call",
            call_id: "x",
            name: "write_words",
            arguments: JSON.stringify({ words: ["oops"], groups: null }),
          },
        ],
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const state = createAgentSessionState();
  state.wordsPayload = buildWordsTok([{ word: "look", id: 10 }]);
  state.sources.words.set("look", 10);
  state.container.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, transparentColor: 0, pixels: [2] }] }] }),
  );
  state.container.putResource("picture", 1, compilePictureSource("vis 1\nfill 0,0\nend").bytes);
  state.container.putResource(
    "logic",
    0,
    assembleLogic("if (!isset(f200)) { set(f200); new.room(1); } call.v(v0); return;", {
      dictionary: state.sources.words,
    }).payload,
  );
  state.container.putResource(
    "logic",
    1,
    assembleLogic(
      "if (isset(f5)) { assignn(v10,1); load.pic(v10); draw.pic(v10); show.pic(); load.view(0); animate.obj(0); set.view(0,0); position(0,80,120); draw(0); accept.input(); } return;",
      { dictionary: state.sources.words },
    ).payload,
  );
  const session = new AgentSession(
    { provider: "openai", apiKey: "test-placeholder", model: "test" },
    () => {},
    state,
  );
  const result = await session.runPowerUp("add the word lamp then finish", 1);
  // The handover call was terminal: no second provider request was made.
  assert.equal(requests, 1);
  const words = parseWordsTok(state.wordsPayload!).map(({ word }) => word);
  assert.ok(words.includes("lamp"), "the write before handover committed");
  assert.ok(!words.includes("oops"), "the bundled write after handover never ran");
  const transcript = JSON.stringify(session.getTranscript());
  assert.match(transcript, /Not executed: this turn ended at a successful handover/);
  assert.equal(result.patched.length >= 0, true);
});

test("a remix ending in text commits only after the host verdict passes", async (t) => {
  // Offline bad case: the provider staged a write that broke a declared
  // exit, handover rejected it, and the model answered "Done." anyway.
  // The host must produce its own verdict on the exact staged candidate
  // instead of adopting it on the provider's word.
  const requests: Record<string, unknown>[] = [];
  let liveLogicWhenTexted: Uint8Array | null | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const n = requests.length;
    const output =
      n === 1
        ? [
            {
              type: "function_call",
              call_id: "break",
              name: "write_logic_source",
              arguments: JSON.stringify({ room: 1, source: "return;" }),
            },
            {
              type: "function_call",
              call_id: "h",
              name: "handover",
              arguments: '{"notes":null}',
            },
          ]
        : n === 3
          ? [
              {
                type: "function_call",
                call_id: "fix",
                name: "write_logic_source",
                arguments: JSON.stringify({
                  room: 1,
                  source:
                    'if (isset(f5)) { assignn(v10,1); load.pic(v10); draw.pic(v10); show.pic(); load.view(0); animate.obj(0); set.view(0,0); position(0,80,120); draw(0); accept.input(); } if (said("east")) { new.room(2); } return;',
                }),
              },
              {
                type: "function_call",
                call_id: "h2",
                name: "handover",
                arguments: '{"notes":null}',
              },
            ]
          : [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Done." }],
              },
            ];
    if (n === 2) liveLogicWhenTexted = state.container.getResource("logic", 1);
    return new Response(providerSse("openai", { id: `r${n}`, output }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const state = createAgentSessionState();
  state.wordsPayload = buildWordsTok([
    { word: "look", id: 10 },
    { word: "east", id: 20 },
  ]);
  state.sources.words.set("look", 10);
  state.sources.words.set("east", 20);
  state.container.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, transparentColor: 0, pixels: [2] }] }] }),
  );
  state.container.putResource("picture", 1, compilePictureSource("vis 1\nfill 0,0\nend").bytes);
  state.container.putResource(
    "logic",
    0,
    assembleLogic("if (!isset(f200)) { set(f200); new.room(1); } call.v(v0); return;", {
      dictionary: state.sources.words,
    }).payload,
  );
  const originalRoom = assembleLogic(
    'if (isset(f5)) { assignn(v10,1); load.pic(v10); draw.pic(v10); show.pic(); load.view(0); animate.obj(0); set.view(0,0); position(0,80,120); draw(0); accept.input(); } if (said("east")) { new.room(2); } return;',
    { dictionary: state.sources.words },
  ).payload;
  state.container.putResource("logic", 1, originalRoom);
  state.authoring.world.rooms["1"] = {
    title: "Hall",
    description: "",
    exits: { east: 2 },
  };
  const session = new AgentSession(
    { provider: "openai", apiKey: "test-placeholder", model: "test" },
    () => {},
    state,
  );

  const result = await session.runPowerUp("simplify room 1", 1);

  // Failed handover followed by "Done.": the host re-checked the staged
  // candidate itself, handed the verdict back for repair, and never
  // adopted it — the live logic was still the original at that moment.
  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[1]!["input"]), /Handover rejected: room 1 declares exit/);
  assert.deepEqual(liveLogicWhenTexted, originalRoom);
  assert.match(JSON.stringify(requests[2]!["input"]), /cannot be committed.*declares exit/);
  // The repaired candidate is what a passing handover commits.
  const { disassembleLogic } = await import("../../src/logic/disassembler.ts");
  assert.match(
    disassembleLogic(state.container.getResource("logic", 1)!, {
      dictionary: state.sources.words,
    }),
    /new\.room\(2\)/,
  );
  assert.equal(result.text, "Changes are ready.");
});

test("a staged change the model abandons in text is discarded, not adopted", async (t) => {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const n = requests.length;
    const output =
      n === 1
        ? [
            {
              type: "function_call",
              call_id: "break",
              name: "write_logic_source",
              arguments: JSON.stringify({ room: 1, source: "return;" }),
            },
          ]
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done." }],
            },
          ];
    return new Response(providerSse("openai", { id: `r${n}`, output }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const state = createAgentSessionState();
  state.sources.words.set("east", 20);
  state.container.putResource(
    "logic",
    0,
    assembleLogic("if (!isset(f200)) { set(f200); new.room(1); } return;", {
      dictionary: state.sources.words,
    }).payload,
  );
  const originalRoom = assembleLogic('if (said("east")) { new.room(2); } return;', {
    dictionary: state.sources.words,
  }).payload;
  state.container.putResource("logic", 1, originalRoom);
  state.authoring.world.rooms["1"] = {
    title: "Hall",
    description: "",
    exits: { east: 2 },
  };
  const session = new AgentSession(
    { provider: "openai", apiKey: "test-placeholder", model: "test" },
    () => {},
    state,
  );

  const result = await session.runPowerUp("simplify room 1", 1);

  // The verdict went out once; the second plain-text reply discards the
  // unvalidated candidate and says so instead of claiming it landed.
  assert.equal(requests.length, 3);
  assert.deepEqual(state.container.getResource("logic", 1), originalRoom);
  assert.match(result.text, /not applied/);
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

test("room helper edits are transactional and may rewrite another room", async (t) => {
  const { assembleLogic } = await import("../../src/logic/assembler.ts");
  const { sourceContextRevision } = await import("../../src/agent/authoringTools.ts");
  const state = createAgentSessionState();
  const original = assembleLogic("assignn(v40, 1); return;", { dictionary: new Map() }).payload;
  state.container.putResource("logic", 1, original);
  state.sources.logics.set(1, "assignn(v40, 1); return;");
  let count = 0;
  t.mock.method(globalThis, "fetch", async () => {
    count++;
    const output =
      count === 1
        ? [
            {
              type: "function_call",
              call_id: "cross",
              name: "edit_resource_source",
              arguments: JSON.stringify({
                kind: "logic",
                num: 1,
                expectedRevision: sourceContextRevision(
                  state,
                  "logic",
                  1,
                  "assignn(v40, 1); return;",
                ),
                edits: [{ find: "assignn(v40, 1);", replace: "assignn(v40, 2);" }],
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
        : [
            {
              type: "function_call",
              call_id: "done",
              name: "handover",
              arguments: '{"notes":null}',
            },
          ];
    return new Response(providerSse("openai", { id: String(count), output }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const session = new AgentSession(
    { provider: "openai", apiKey: "placeholder", model: "test" },
    () => {},
    state,
  );
  const response = await session.handle({ op: "room", context: { room: 2, from: 1 } });
  // The source-room rewrite lands in the same transaction as the new room.
  assert.deepEqual(
    state.container.getResource("logic", 1),
    assembleLogic("assignn(v40, 2); return;", { dictionary: new Map() }).payload,
  );
  const patch = JSON.parse(response);
  assert.deepEqual(
    patch.resources.map((r: { kind: string; num: number }) => [r.kind, r.num]),
    [
      ["logic", 1],
      ["logic", 2],
      ["picture", 2],
    ],
  );
  assert.equal(state.authoring.world.facts["weather"], "rain");
});

test("pinned map notes reach the room turn's request body", async (t) => {
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    const output =
      bodies.length === 1
        ? [
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
          ]
        : [
            {
              type: "function_call",
              call_id: "done",
              name: "handover",
              arguments: '{"notes":null}',
            },
          ];
    return new Response(providerSse("openai", { id: String(bodies.length), output }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const session = new AgentSession(
    { provider: "openai", apiKey: "placeholder", model: "test" },
    () => {},
    createAgentSessionState(),
  );
  await session.handle({
    op: "room",
    context: {
      room: 2,
      from: 1,
      playerNotes: ["the vault door should feel trapped"],
    },
  });
  const request = JSON.parse(bodies[0]!);
  const firstUser = request.input?.[0]?.content?.[0]?.text ?? JSON.stringify(request.input);
  assert.match(
    firstUser,
    /the vault door should feel trapped/,
    "the pinned note reaches the provider's request body",
  );
  assert.match(firstUser, /"playerNotes"/);
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
              name: "inspect_world_bible",
              arguments: '{"filter":"slots","section":null,"name":null,"offset":null,"kind":null}',
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

test("stub genesis installs the harness base template before the stub's room", async () => {
  const session = new AgentSession(
    { provider: "stub", model: "offline-stub", apiKey: "" },
    () => {},
  );
  await session.startGenesis("");
  // The default boot/menu/fallback logic, death logic and death sound are
  // supplied before the stub authors its room, picture and ego view.
  for (const [kind, num] of [
    ["logic", 0],
    ["logic", 255],
    ["sound", 255],
  ] as const)
    assert.ok(
      session.state.container.getResource(kind, num),
      `${kind} ${num} came from the template`,
    );
  assert.ok(session.state.sources.logics.has(0), "logic 0 source is on record");
  assert.ok(session.state.container.getResource("logic", 1), "the stub's room 1");
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
    // The one-flow genesis turn's read_room_context is the call under test.
    const output = [
      {
        type: "function_call",
        call_id: "context",
        name: "read_room_context",
        arguments: '{"room":1}',
      },
    ];
    return new Response(providerSse("openai", { id: `genesis-${requests}`, output }), {
      headers: { "Content-Type": "text/event-stream" },
    });
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

test("genesis is one turn: the world plan and resource writes share the tool surface", async (t) => {
  const requests: { tool_choice?: { tools: { name: string }[] }; input: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    if (requests.length > 1) throw new Error("End this bounded genesis test.");
    // One flow: update_world and a resource write land in the same turn —
    // no plan phase gates either of them.
    const output = [
      {
        type: "function_call",
        call_id: "world",
        name: "update_world",
        arguments: JSON.stringify({
          rooms: [
            {
              num: 1,
              title: "Dock",
              description: "Where it starts.",
              exits: [{ name: "east", room: 2 }],
            },
            { num: 2, title: "Tide Room", description: "The next stop.", exits: [] },
          ],
          facts: [],
          quests: [],
        }),
      },
      {
        type: "function_call",
        call_id: "words",
        name: "write_words",
        arguments: '{"words":["dock"],"groups":null}',
      },
    ];
    return new Response(providerSse("openai", { id: `p${requests.length}`, output }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const session = new AgentSession(
    { provider: "openai", apiKey: "test-placeholder", model: "test" },
    () => {},
  );
  await assert.rejects(session.startGenesis("A dockside mystery."));
  const tools = requests[0]!.tool_choice!.tools.map((tool) => tool.name);
  assert.ok(tools.includes("update_world"));
  assert.ok(tools.includes("write_logic_source"), "resource tools share the genesis surface");
  // Both calls ran: the plan recorded and the write landed in one turn.
  assert.equal(session.state.authoring.world.rooms["1"]?.title, "Dock");
  assert.equal(session.state.authoring.world.rooms["2"]?.title, "Tide Room");
  assert.ok(session.state.sources.words.has("dock"));
  assert.equal(requests.length, 2, "one turn — the plan never takes a provider round of its own");
});

test("a map edit mid-turn is refused, and the turn's world survives a clean adopt", async (t) => {
  // Hold the remix turn open on a deferred provider response; while it is in
  // flight, a plan commit would be overwritten by the staged fork's adopt.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  t.mock.method(globalThis, "fetch", async () => {
    await gate;
    return new Response(
      providerSse("openai", {
        id: "remix1",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done." }],
          },
        ],
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const state = createAgentSessionState();
  state.authoring.world.rooms["1"] = { title: "Hall", description: "", exits: {} };
  const session = new AgentSession(
    { provider: "openai", apiKey: "test-placeholder", model: "test" },
    () => {},
    state,
  );
  const { createWorldDraft, draftRenameRoom } = await import("../../src/agent/worldPlan.ts");
  const turn = session.runPowerUp("paint the room blue", 1);
  try {
    // The request is in flight — the map's commit is refused, not lost.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const draft = createWorldDraft(state.authoring.world);
    assert.equal(draftRenameRoom(draft, 1, "Parlor"), null);
    assert.equal(session.commitPlanDraft(draft).status, "busy");
  } finally {
    release();
  }
  await turn;
  // After the turn the world is editable again.
  const second = createWorldDraft(state.authoring.world);
  assert.equal(draftRenameRoom(second, 1, "Parlor"), null);
  assert.equal(session.commitPlanDraft(second).status, "committed");
  assert.equal(state.authoring.world.rooms["1"]?.title, "Parlor");
});

test("a finished turn's adopt keeps a live map edit the turn never touched", async () => {
  const { adoptTurnState, forkAgentState } = await import("../src/agent/sessionState.ts");
  const { worldRevision } = await import("../../src/agent/worldPlan.ts");
  const live = createAgentSessionState();
  live.authoring.world.rooms["1"] = { title: "Hall", description: "", exits: {} };
  const staged = forkAgentState(live);
  const fork = worldRevision(live.authoring.world);
  // The player edits while the turn runs; the turn's tools never touch world.
  live.authoring.world.rooms["2"] = { title: "Vault", description: "", exits: {} };
  assert.equal(adoptTurnState(live, staged, fork), false);
  assert.equal(live.authoring.world.rooms["2"]?.title, "Vault");
  // Both writing world is a conflict — the player's visible world wins and
  // the caller is told.
  const again = forkAgentState(live);
  const fork2 = worldRevision(live.authoring.world);
  live.authoring.world.rooms["3"] = { title: "Crypt", description: "", exits: {} };
  again.authoring.world.rooms["4"] = { title: "Tower", description: "", exits: {} };
  assert.equal(adoptTurnState(live, again, fork2), true);
  assert.equal(live.authoring.world.rooms["3"]?.title, "Crypt");
  assert.equal(live.authoring.world.rooms["4"], undefined);
});

test("adoptAuthoredData verifies the adopted revision and leaves the hold for the caller", async () => {
  const session = new AgentSession(
    { provider: "stub", model: "offline-stub", apiKey: "" },
    () => {},
  );
  await session.startGenesis("");
  const files = Object.fromEntries(session.state.getFiles());
  const revision = session.resourceSet();
  const snapshot = session.snapshotAuthoring();
  const planned = JSON.stringify(session.state.authoring);

  // The hold blocks every turn — a mid-adoption session cannot author.
  session.holdAdoption("the swap is still landing");
  await assert.rejects(session.runPowerUp("add a lamp", 1), /still landing/);

  // Bytes that are not the revision the worker adopted refuse before the
  // session's state moves — the hold survives the refusal.
  const foreign = openContainer(new Map(Object.entries(files)));
  foreign.putResource("logic", 7, assembleLogic("return;", { dictionary: new Map() }).payload);
  assert.throws(
    () => session.adoptAuthoredData(Object.fromEntries(foreign.files), [], snapshot, revision),
    /do not match the revision/,
  );
  await assert.rejects(session.runPowerUp("add a lamp", 1), /still landing/);

  // The matching revision installs — the hold is the caller's to release
  // once the whole transaction lands.
  session.adoptAuthoredData(files, [], snapshot, revision);
  await assert.rejects(session.runPowerUp("add a lamp", 1), /still landing/);
  session.releaseAdoption();
  assert.equal(JSON.stringify(session.state.authoring), planned);
});

test("adoptAuthoredData without a snapshot carries same-revision state, rebuilds foreign bytes clean", async () => {
  const session = new AgentSession(
    { provider: "stub", model: "offline-stub", apiKey: "" },
    () => {},
  );
  await session.startGenesis("");
  const files = Object.fromEntries(session.state.getFiles());
  const planned = JSON.stringify(session.state.authoring);

  // Same bytes, no checkpoint: the session's state already describes them —
  // it carries, keeping the plan.
  session.adoptAuthoredData(files, [], undefined, session.resourceSet());
  assert.equal(JSON.stringify(session.state.authoring), planned);

  // Foreign bytes, no checkpoint: nothing on the tape names this revision —
  // the session rebuilds clean rather than author a future it cannot see.
  const foreign = openContainer(new Map(Object.entries(files)));
  foreign.putResource("logic", 7, assembleLogic("return;", { dictionary: new Map() }).payload);
  session.adoptAuthoredData(Object.fromEntries(foreign.files), []);
  assert.notEqual(JSON.stringify(session.state.authoring), planned);
});

test("a reserved resource transaction refuses map commits and incoming adoptions", async () => {
  const { createWorldDraft, draftRenameRoom } = await import("../../src/agent/worldPlan.ts");
  const session = new AgentSession(
    { provider: "stub", model: "offline-stub", apiKey: "" },
    () => {},
  );
  await session.startGenesis("");
  const draft = createWorldDraft(session.state.authoring.world);
  assert.equal(draftRenameRoom(draft, 1, "Changed while keeping"), null);
  const snapshot = session.snapshotAuthoring();
  const files = Object.fromEntries(session.state.getFiles());
  const release = session.reserveMutation("Keeping a staged view");
  assert.equal(session.commitPlanDraft(draft).status, "invalid");
  assert.throws(() => session.adoptAuthoredData(files, [], snapshot), /Keeping a staged view/);
  assert.deepEqual(session.snapshotAuthoring(), snapshot);
  release();
  assert.equal(session.commitPlanDraft(draft).status, "committed");
  assert.equal(session.state.authoring.world.rooms["1"]?.title, "Changed while keeping");
});

test("a session keeps the game's interpreter override through adoption and reconfiguration", () => {
  // A synthetic v2 game detects as 2.936; the override must win everywhere
  // the session rebuilds its state, or tools compile for the wrong build.
  const files = Object.fromEntries(openContainer(new Map()).files);
  files["WORDS.TOK"] = buildWordsTok([]);
  const config = { provider: "stub", model: "offline-stub", apiKey: "" } as const;
  const session = AgentSession.fromAuthoredData(
    config,
    () => {},
    files,
    [],
    undefined,
    undefined,
    undefined,
    "2.089",
  );
  assert.equal(session.state.profile.id, "2.089");
  session.adoptAuthoredData(files, []);
  assert.equal(session.state.profile.id, "2.089");
  const replacement = session.reconfigure({ ...config, model: "offline-stub-2" });
  replacement.adoptAuthoredData(files, []);
  assert.equal(replacement.state.profile.id, "2.089");
  const automatic = AgentSession.fromAuthoredData(config, () => {}, files, []);
  assert.equal(automatic.state.profile.id, "2.936");
});
