/**
 * Deny-by-default tool dispatch: every agent task names the tools it may
 * run, and the dispatcher refuses a call made without such a list. Each task
 * type is driven with a scripted provider that asks for a tool outside its
 * list; the refusal must come from the task's allowlist (or Ask's read-only
 * rule), before any other gate sees the call.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { providerSse } from "../../test/provider-stream.ts";
import { AgentSession } from "../src/agent/agentSession.ts";
import { createAgentSessionState } from "../../src/agent/agentState.ts";
import {
  ASK_TOOLS,
  executeAgentToolAsync,
  GENESIS_TOOLS,
  REMIX_TOOLS,
  ROOM_AUTHORING_TOOLS,
  SELECTION_TASK_TOOLS,
  type AgentToolDeps,
} from "../../src/agent/tools.ts";

const PHASE_REFUSAL = /is not available in this phase of the session/;

/** A provider whose first reply calls `tool`, then ends the turn in text. */
function scriptProvider(t: TestContext, tool: string, args: Record<string, unknown>): string[] {
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    // A 400 ends a task that would otherwise keep asking (genesis, room).
    if (bodies.length > 2) return new Response("End this bounded test.", { status: 400 });
    const output =
      bodies.length === 1
        ? [{ type: "function_call", call_id: "c", name: tool, arguments: JSON.stringify(args) }]
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done." }],
            },
          ];
    return new Response(providerSse("openai", { id: String(bodies.length), output }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  return bodies;
}

/** The tool result the session sent back to the provider for call "c". */
function toolResult(bodies: readonly string[]): string {
  const second = bodies[1];
  assert.ok(second, "the task answered the tool call");
  const output = (
    JSON.parse(second) as { input: { type?: string; output?: unknown }[] }
  ).input.find((item) => item.type === "function_call_output")?.output;
  assert.ok(output, "the second request carries the tool's result");
  return JSON.stringify(output);
}

function modelSession(): AgentSession {
  return new AgentSession(
    { provider: "openai", apiKey: "test-placeholder", model: "gpt-6-sol" },
    () => {},
    createAgentSessionState(),
  );
}

test("the dispatcher refuses a call that names no allowlist", async () => {
  const state = createAgentSessionState();
  const args = { exact: null, offset: null, limit: null, prefix: null };
  // Plain JavaScript callers bypass the required type; deny them all the same.
  for (const deps of [undefined, {}] as unknown as AgentToolDeps[]) {
    const result = await executeAgentToolAsync(state, "read_words", args, deps);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", PHASE_REFUSAL);
  }
  const listed = await executeAgentToolAsync(state, "read_words", args, {
    allowedTools: ["read_words"],
  });
  assert.equal(listed.success, true, listed.error ?? "");
});

test("a tool outside the task's list is refused before dispatch", async () => {
  const state = createAgentSessionState();
  const refused = await executeAgentToolAsync(
    state,
    "write_words",
    { words: ["lamp"], groups: null },
    { allowedTools: ["read_words"] },
  );
  assert.equal(refused.success, false);
  assert.match(refused.error ?? "", /'write_words' is not available in this phase/);
  assert.equal(state.sources.words.has("lamp"), false, "the refused write never ran");
});

test("every task type names its own allowlist", () => {
  // The Studio tools need a creator's selection: no writing task lists them.
  for (const [task, list] of Object.entries({ GENESIS_TOOLS, ROOM_AUTHORING_TOOLS, REMIX_TOOLS })) {
    assert.ok(list.includes("finish"), `${task} can finish its turn`);
    for (const studio of ["read_edit_context", "edit_selection", "withdraw_selection"])
      assert.ok(!list.includes(studio), `${task} lists ${studio}`);
  }
  assert.ok(SELECTION_TASK_TOOLS.includes("withdraw_selection"));
  for (const [task, list] of Object.entries({ ASK_TOOLS, SELECTION_TASK_TOOLS }))
    assert.ok(!list.includes("write_words") && !list.includes("finish"), task);
});

test("read_reference_image is listed for the reference tasks and offered only when a turn has art", async (t) => {
  for (const [task, list] of Object.entries({
    GENESIS_TOOLS,
    ROOM_AUTHORING_TOOLS,
    REMIX_TOOLS,
    ASK_TOOLS,
    SELECTION_TASK_TOOLS,
  }))
    assert.ok(list.includes("read_reference_image"), task);
  const bodies = scriptProvider(t, "read_words", {
    exact: null,
    offset: null,
    limit: null,
    prefix: null,
  });
  const offered = (index: number) =>
    (JSON.parse(bodies[index]!) as { tool_choice: { tools: { name: string }[] } }).tool_choice.tools
      .map((tool) => tool.name)
      .includes("read_reference_image");
  const session = modelSession();
  await session.runAsk("What is here?", 1);
  assert.equal(offered(0), false, "no art, not offered");
  const art = {
    id: "art-0123456789",
    label: "Room plate",
    target: { kind: "room" as const, num: 1 },
    note: "",
    attached: true,
    pixels: () => ({ width: 1, height: 1, rgba: new Uint8Array(4).fill(255) }),
  };
  const withArt = modelSession();
  withArt.setRuntime({ referenceArt: async () => ({ art: [art] }) });
  bodies.length = 0;
  await withArt.runAsk("What is here?", 1);
  assert.equal(offered(0), true, "a turn with art offers it");
  // Genesis carries no art: its turn never offers the tool.
  bodies.length = 0;
  await assert.rejects(withArt.startGenesis("A quiet courtyard."));
  assert.equal(offered(0), false);
});

test("Remix refuses a tool outside its list by its allowlist", async (t) => {
  const bodies = scriptProvider(t, "read_edit_context", { images: null });
  await modelSession().runPowerUp("change the lamp", 1);
  assert.match(toolResult(bodies), PHASE_REFUSAL);
});

test("genesis refuses a tool outside its list by its allowlist", async (t) => {
  const bodies = scriptProvider(t, "read_edit_context", { images: null });
  await assert.rejects(modelSession().startGenesis("A quiet courtyard."));
  assert.match(toolResult(bodies), PHASE_REFUSAL);
});

test("room writing refuses a tool outside its list by its allowlist", async (t) => {
  const bodies = scriptProvider(t, "read_edit_context", { images: null });
  await assert.rejects(modelSession().handle({ op: "room", context: { room: 2, from: 1 } }));
  assert.match(toolResult(bodies), PHASE_REFUSAL);
});

test("Ask refuses a writer by its read-only list", async (t) => {
  const bodies = scriptProvider(t, "write_words", { words: ["lamp"], groups: null });
  await modelSession().runAsk("What is here?", 1);
  assert.match(toolResult(bodies), /Ask mode is read-only/);
});
