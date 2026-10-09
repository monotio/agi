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

for (const provider of ["openai", "anthropic", "stub"] as const) {
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
