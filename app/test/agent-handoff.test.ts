import assert from "node:assert/strict";
import { test } from "node:test";
import { agentHandoffContext } from "../src/agent/agentHandoff.ts";
import type { AgentChat } from "../../src/agent/chats.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { migrateAgentChats } from "../../src/agent/chats.ts";

const payload = "cHJldmlld2J5dGVz";
const image = `data:image/png;base64,${payload}`;
const snapshot = writeProjectWorkspace({ "picture:7": Uint8Array.of(251, 252, 253) });
const binary = JSON.stringify({
  success: true,
  message: `picture:7: 3 bytes, base64 window at offset 0 (3 bytes): ${payload}`,
  details: { key: "picture:7", kind: "bytes", length: 3, sha256: "d".repeat(64), base64: payload },
});
const ordinary = JSON.stringify({
  success: false,
  error: "Room is missing",
  details: { snapshot },
});

test("migrated stub tool envelopes in assistant message text exclude binary payloads", () => {
  const migrated = migrateAgentChats({
    provider: "stub",
    model: "old",
    transcript: [
      { role: "user", text: "Inspect picture" },
      {
        role: "assistant",
        text: JSON.stringify({
          toolCallId: "read",
          result: {
            success: true,
            message: "Read image",
            images: [{ caption: "Reference", png: { 0: 251, 1: 252, 2: 253 } }],
            details: { snapshot },
          },
        }),
      },
    ],
  });
  const handoff = agentHandoffContext(migrated.chats[0]!);
  assert.doesNotMatch(handoff, /png|251|snapshot/);
  assert.match(handoff, /Inspect picture/);
  assert.match(handoff, /Read image/);
});

function chat(transcript: unknown[]): AgentChat {
  const review = {
    label: "Change room",
    messageId: "answer",
    baseRevision: 0,
    baseDocumentId: "a".repeat(64),
    baseCommit: "base",
    base: snapshot,
    baseImage: snapshot,
    candidate: snapshot,
  };
  return {
    id: "chat",
    title: "Title",
    provider: "stub",
    model: "stub",
    transcript,
    pendingReview: review,
    summary: `Keep the sign. ${image}`,
    messages: [
      { id: "ask", role: "user", text: "Keep the room quiet", context: "Room 7" },
      {
        id: "answer",
        role: "assistant",
        text: "Inspected room 7",
        review,
        result: {
          kind: "resources",
          resources: ["picture:7"],
          documentId: "a".repeat(64),
          snapshot,
          resourceSnapshots: { "picture:7": snapshot },
        },
      },
    ],
  };
}

test("handoff accepts only versioned actions with a known string decision", () => {
  const transcript = [
    { format: "other", version: 1, decision: "undo" },
    { format: "monotio.agi.user-action", version: 2, decision: "undo" },
    { format: "monotio.agi.user-action", version: 1, decision: "delete" },
    { format: "monotio.agi.user-action", version: 1, decision: ["undo"] },
  ].map((value) => ({ role: "user", text: JSON.stringify(value) }));
  assert.deepEqual(JSON.parse(agentHandoffContext(chat(transcript)).split("\n")[3]!), []);
});

test("migrated user-action message text retains semantics without nested payloads", () => {
  const value = JSON.stringify({
    format: "monotio.agi.user-action",
    version: 1,
    decision: "undo",
    messageId: "answer",
    resultingRevision: { documentId: "a".repeat(64), revision: 2, commit: "before", snapshot },
    snapshot,
    unknown: { image, bytes: [251, 252, 253] },
  });
  const migrated = migrateAgentChats({
    provider: "stub",
    model: "old",
    transcript: [{ role: "user", text: value }],
  });
  const handoff = agentHandoffContext(migrated.chats[0]!);
  const messages = JSON.parse(handoff.split("\n")[1]!) as { text: string }[];
  assert.deepEqual(JSON.parse(messages[0]!.text), {
    decision: "undo",
    messageId: "answer",
    resultingRevision: { documentId: "a".repeat(64), revision: 2, commit: "before" },
  });
  assert.doesNotMatch(handoff, /snapshot|unknown|bytes|251|data:image/);
  assert.ok(!handoff.includes(payload));
});

for (const provider of ["openai", "anthropic", "stub"] as const) {
  test(`${provider} handoff retains undo and restore in order with tool outcomes and their applied answer`, () => {
    const envelope = (value: unknown) => ({
      role: "user",
      ...(provider === "stub"
        ? { text: JSON.stringify(value) }
        : { content: JSON.stringify(value) }),
    });
    const revision = { documentId: "b".repeat(64), revision: 2, commit: "before" };
    const actions = ["undo", "restore"].map((decision) => ({
      format: "monotio.agi.user-action",
      version: 1,
      decision,
      messageId: "answer",
      checkpoint: "before",
      outcome: "applied",
      resultingRevision: { ...revision, snapshot },
      unknown: { snapshot, bytes: [251, 252, 253], image },
    }));
    const tool =
      provider === "openai"
        ? { type: "function_call_output", call_id: "room", output: ordinary }
        : provider === "anthropic"
          ? {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "room", content: ordinary }],
            }
          : {
              role: "assistant",
              text: JSON.stringify({ toolCallId: "room", result: JSON.parse(ordinary) }),
            };
    const current = chat([envelope(actions[0]), tool, envelope(actions[1])]);
    current.messages[1] = {
      ...current.messages[1]!,
      result: {
        kind: "changes",
        documentId: "a".repeat(64),
        resources: ["picture:7"],
        status: "applied",
      },
    };
    const handoff = agentHandoffContext(current);
    const messages = JSON.parse(handoff.split("\n")[1]!) as Record<string, unknown>[];
    const records = JSON.parse(handoff.split("\n")[3]!);
    assert.equal(messages[1]!["id"], "answer");
    assert.equal((messages[1]!["result"] as Record<string, unknown>)["status"], "applied");
    const expected = (decision: string) => ({
      decision,
      messageId: "answer",
      checkpoint: "before",
      outcome: "applied",
      resultingRevision: revision,
    });
    assert.deepEqual(records, [
      expected("undo"),
      { outcomes: [{ success: false, error: "Room is missing" }] },
      expected("restore"),
    ]);
    assert.doesNotMatch(handoff, /snapshot|unknown|bytes|251|data:image/);
    assert.ok(!handoff.includes(payload));
  });

  test(`${provider} handoff projects approval, rejection and interruption without nested payloads`, () => {
    const revision = { documentId: "c".repeat(64), revision: 3, commit: null };
    const persisted = { resources: ["picture:7"], documentId: "a".repeat(64), commit: "kept" };
    const events = [
      { decision: "approve", resources: ["picture:7", { snapshot }], outcome: "committed" },
      { decision: "reject", resources: ["notes"], outcome: "discarded" },
      {
        decision: "interruption",
        outcome: "interrupted",
        error: `Stopped ${image}`,
        discarded: ["notes", { snapshot }],
        persisted: [
          { ...persisted, snapshot, bytes: [251] },
          { resources: ["notes"], documentId: { snapshot }, commit: { snapshot } },
        ],
      },
      {
        decision: "interruption",
        outcome: "interrupted",
        explanation: `Outstanding tools stopped ${image}`,
      },
    ];
    const transcript = events.map((event) => {
      const value = JSON.stringify({
        format: "monotio.agi.user-action",
        version: 1,
        ...event,
        ...("explanation" in event ? {} : { resultingRevision: { ...revision, snapshot } }),
        snapshot,
      });
      return { role: "user", ...(provider === "stub" ? { text: value } : { content: value }) };
    });
    const handoff = agentHandoffContext(chat(transcript));
    assert.deepEqual(JSON.parse(handoff.split("\n")[3]!), [
      {
        decision: "approve",
        resources: ["picture:7"],
        outcome: "committed",
        resultingRevision: revision,
      },
      {
        decision: "reject",
        resources: ["notes"],
        outcome: "discarded",
        resultingRevision: revision,
      },
      {
        decision: "interruption",
        outcome: "interrupted",
        error: "Stopped [image]",
        discarded: ["notes"],
        persisted: [persisted, { resources: ["notes"] }],
        resultingRevision: revision,
      },
      {
        decision: "interruption",
        outcome: "interrupted",
        explanation: "Outstanding tools stopped [image]",
      },
    ]);
    assert.doesNotMatch(handoff, /snapshot|bytes|251|data:image/);
    assert.ok(!handoff.includes(payload));
  });

  test(`${provider} handoff retains tool outcomes and binary metadata while omitting preview and protocol payloads`, () => {
    const transcript =
      provider === "openai"
        ? [
            { type: "reasoning", encrypted_content: "private-thinking", summary: [] },
            { role: "user", content: [{ type: "input_image", image_url: image }] },
            {
              type: "function_call",
              call_id: "read",
              name: "read_document",
              arguments: JSON.stringify({ key: "picture:7" }),
            },
            {
              type: "function_call_output",
              call_id: "read",
              output: [
                { type: "input_text", text: binary },
                { type: "input_image", image_url: image },
              ],
            },
            { type: "function_call", call_id: "room", name: "read_room", arguments: '{"room":7}' },
            { type: "function_call_output", call_id: "room", output: ordinary },
          ]
        : provider === "anthropic"
          ? [
              {
                role: "assistant",
                content: [
                  {
                    type: "thinking",
                    thinking: "private-thinking",
                    signature: "private-signature",
                  },
                  {
                    type: "tool_use",
                    id: "read",
                    name: "read_document",
                    input: { key: "picture:7" },
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "read",
                    content: [
                      { type: "text", text: binary },
                      {
                        type: "image",
                        source: { type: "base64", media_type: "image/png", data: payload },
                      },
                    ],
                  },
                ],
              },
              {
                role: "assistant",
                content: [{ type: "tool_use", id: "room", name: "read_room", input: { room: 7 } }],
              },
              {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "room", content: ordinary }],
              },
            ]
          : [
              {
                role: "assistant",
                text: JSON.stringify({ toolCallId: "read", result: JSON.parse(binary) }),
              },
              {
                role: "assistant",
                text: JSON.stringify({ toolCallId: "room", result: JSON.parse(ordinary) }),
              },
              { role: "user", content: [image] },
            ];
    const handoff = agentHandoffContext(chat(transcript));
    assert.doesNotMatch(
      handoff,
      /snapshot|candidate|baseImage|bytes":\[|private-thinking|private-signature|data:image/,
    );
    assert.ok(!handoff.includes(payload));
    assert.match(handoff, /Keep the room quiet/);
    assert.match(handoff, /Change room/);
    assert.match(handoff, /picture:7/);
    assert.match(handoff, /Room is missing/);
    assert.ok(handoff.includes("d".repeat(64)));
    assert.ok(handoff.includes('"length":3'));
  });
}
