import assert from "node:assert/strict";
import { test } from "node:test";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { openContainer } from "../../src/container/container.ts";
import { AgentSession } from "../src/agent/agentSession.ts";

test("Genesis offers the same complete playable Starter before its first provider request", async (t) => {
  const seed = createStarterProject("starter");
  const expected = openContainer(seed.files());
  let requests = 0;
  let offered: ReturnType<typeof openContainer> | undefined;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    offered = openContainer(new Map(session.state.getFiles()));
    return new Response("End this bounded Starter parity test.", { status: 400 });
  });
  const session = new AgentSession(
    { provider: "openai", apiKey: "test-placeholder", model: "gpt-6.1-sol" },
    () => {},
  );
  await assert.rejects(session.startGenesis("A two-room garden adventure."));
  assert.equal(requests, 1);
  assert.ok(offered);
  assert.ok(offered.getResource("logic", 1), "the opening room must already be playable");
  for (const [kind, num] of [
    ["logic", 0],
    ["logic", 1],
    ["logic", 255],
    ["picture", 1],
    ["view", 1],
    ["sound", 255],
  ] as const) {
    assert.deepEqual(offered.getResource(kind, num), expected.getResource(kind, num));
    assert.deepEqual(
      session.state.container.getResource(kind, num),
      expected.getResource(kind, num),
    );
  }
  assert.equal(session.state.profile.id, seed.profileId);
  assert.deepEqual([...session.state.sources.words], [...seed.sources.words]);
  assert.deepEqual(session.state.authoring.bindings, seed.bindings);
  assert.equal(session.state.sources.logics.get(1), seed.sources.logics.get(1));
});
