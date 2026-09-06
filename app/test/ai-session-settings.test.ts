import { providerSse } from "../../test/provider-stream.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "../src/agent/agentSession.ts";
import { createAgentSessionState } from "../../src/agent/tools.ts";

test("reconfiguration preserves authored state and chat while the next request uses the new model and key", async (t) => {
  const requests: { authorization: string | null; body: Record<string, unknown> }[] = [];
  const events: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push({
      authorization: new Headers(init.headers).get("authorization"),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const text = requests.length === 1 ? "First answer." : "Second answer.";
    return new Response(
      providerSse("openai", {
        id: `reply-${requests.length}`,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ],
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });

  const state = createAgentSessionState();
  state.sources.logics.set(7, "return;");
  const session = new AgentSession(
    { provider: "openai", apiKey: "old-private-key", model: "old-model" },
    (kind, detail, data) => events.push({ kind, detail, data }),
    state,
  );
  await session.runAsk("First question?", 7);

  const replacement = session.reconfigure({
    provider: "openai",
    apiKey: "new-private-key",
    model: "new-model",
    effort: "high",
  });
  assert.equal(replacement.state, state);
  assert.equal(replacement.state.sources.logics.get(7), "return;");
  assert.deepEqual(replacement.getMessages(), session.getMessages());
  await replacement.runAsk("Second question?", 7);

  assert.equal(requests[1]?.authorization, "Bearer new-private-key");
  assert.equal(requests[1]?.body["model"], "new-model");
  assert.equal(
    (requests[1]?.body["reasoning"] as Record<string, unknown> | undefined)?.["effort"],
    "high",
  );
  assert.match(JSON.stringify(requests[1]?.body["input"]), /Previous authoring conversation/);
  assert.doesNotMatch(JSON.stringify(events), /old-private-key|new-private-key/);
});

test("provider changes retain only a scrubbed text continuation", () => {
  const session = new AgentSession(
    { provider: "openai", apiKey: "old-key", model: "old-model" },
    () => {},
    undefined,
    [
      {
        type: "reasoning",
        id: "reasoning-item",
        encrypted_content: "provider-private-payload",
      },
      { role: "assistant", content: "A useful prior answer." },
    ],
    "response-session",
  );

  const replacement = session.reconfigure({
    provider: "stub",
    apiKey: "",
    model: "offline-stub",
  });
  const transcript = replacement.getTranscript();
  assert.equal(transcript.length, 1);
  assert.equal((transcript[0] as Record<string, unknown>)["role"], "user");
  assert.match(
    String((transcript[0] as Record<string, unknown>)["content"]),
    /Previous authoring conversation.*useful prior answer/s,
  );
  assert.doesNotMatch(JSON.stringify(transcript), /provider-private-payload|encrypted_content/);
  assert.equal(replacement.getSessionId(), undefined);
});

test("effort and key changes keep a compatible provider transcript and session id", () => {
  const transcript = [
    { role: "user", content: "A prior question." },
    { role: "assistant", content: "A prior answer." },
  ];
  const session = new AgentSession(
    { provider: "openai", apiKey: "old-key", model: "same-model", effort: "low" },
    () => {},
    undefined,
    transcript,
    "same-session",
  );

  const replacement = session.reconfigure({
    provider: "openai",
    apiKey: "new-key",
    model: "same-model",
    effort: "high",
  });
  assert.deepEqual(replacement.getTranscript(), transcript);
  assert.equal(replacement.getSessionId(), "same-session");
});

test("clearing a key disconnects the old client and blocks later model requests", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(providerSse("openai", { id: "unused", output: [] }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const session = new AgentSession(
    { provider: "openai", apiKey: "old-key", model: "model" },
    () => {},
  );
  const disconnected = session.reconfigure({
    provider: "openai",
    apiKey: "",
    model: "model",
  });

  assert.equal(disconnected.isConfigured(), false);
  await assert.rejects(disconnected.runAsk("Can the old key answer?", 1), /API key/i);
  await assert.rejects(disconnected.runPowerUp("Change the room", 1), /API key/i);
  assert.equal(requests, 0);
});

test("a running or paused session cannot be reconfigured", async () => {
  const session = new AgentSession(
    { provider: "stub", apiKey: "", model: "offline-stub" },
    () => {},
  );
  let reachCheckpoint: (() => void) | undefined;
  const active = session.task.run(async () => {
    await new Promise<void>((resolve) => {
      reachCheckpoint = resolve;
    });
    session.task.pause("Paused for test.");
    await session.task.checkpoint(false);
  });

  assert.equal(session.task.snapshot().status, "running");
  assert.throws(
    () => session.reconfigure({ provider: "stub", apiKey: "", model: "other" }),
    /finish.*AI settings/i,
  );
  reachCheckpoint!();
  for (let attempt = 0; attempt < 20 && session.task.snapshot().status !== "paused"; attempt++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.task.snapshot().status, "paused");
  assert.throws(
    () => session.reconfigure({ provider: "stub", apiKey: "", model: "other" }),
    /finish.*AI settings/i,
  );
  session.task.resume();
  await active;
});
