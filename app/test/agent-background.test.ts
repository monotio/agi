import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "../src/agent/agentSession.ts";
test("runtime room authoring keeps independent task transcripts and leaves the user conversation intact", async () => {
  const session = new AgentSession(
    { provider: "stub", model: "offline-stub", apiKey: "" },
    () => {},
  );
  await session.startGenesis("A friendly garden");
  const before = session.getTranscript();
  const messages = session.getMessages();
  await session.handle({ op: "room", context: { room: 2, from: 1 } });
  await session.handle({ op: "room", context: { room: 3, from: 2 } });
  const entries = session.getBackgroundChats();
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.title, "Built room 2");
  assert.equal(entries[1]!.title, "Built room 3");
  assert.ok(entries.every((chat) => chat.background && chat.transcript.length));
  assert.deepEqual(session.getTranscript(), before);
  assert.deepEqual(session.getMessages(), messages);
});
