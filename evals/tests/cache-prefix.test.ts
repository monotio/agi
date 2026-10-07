/**
 * Prompt-cache regression: every provider request a task sends must extend
 * its predecessor byte for byte. The scenarios in evals/lib/cache-scenarios.ts
 * play through the production AgentSession and the real provider clients
 * with a scripted model (no key, no network); evals/lib/cache-prefix.ts
 * measures the prefix each request shares with the one before.
 *
 * The floors are the values measured after the 1.1 cache audit, less a
 * margin for the cacheable share, which depends on how much a turn adds:
 *
 *   scenario          shape       min stability   mean cacheable share
 *   remix-references  anthropic   100%            95.3%
 *   remix-references  openai      100%            95.4%
 *   room-build        anthropic   100% within each background task
 *   room-build        openai      100% within each background task
 *   ask               anthropic   100%            96.1%
 *   ask               openai      100%            96.1%
 *
 * Stability below 100% means an earlier message was rewritten, the tool
 * catalog or its order changed, or the system prompt carried per-request
 * data. Watched failing by putting the time into the system
 * prompt and by reversing the catalog: both drop stability to under 1%.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MODELS } from "../../src/agent/modelEffort.ts";
import { analyseRequests } from "../lib/cache-prefix.ts";
import { probeScenario, scenarioSession, SCENARIOS } from "../lib/cache-scenarios.ts";
import { captureLive } from "../lib/live-capture.ts";
import { installScriptedProvider, queueScript } from "../lib/scripted-provider.ts";

const CACHEABLE_FLOOR: Record<string, number> = {
  "remix-references": 0.92,
  "room-build": 0.9,
  ask: 0.93,
};

for (const scenario of SCENARIOS)
  for (const shape of ["anthropic", "openai"] as const)
    test(`${scenario.id} keeps an append-only prefix in the ${shape} shape`, async () => {
      const conversations = await probeScenario(scenario, shape, DEFAULT_MODELS[shape]);
      assert.ok(conversations.flat().length >= 4, "expected a multi-request scenario");
      assert.equal(conversations.length, scenario.id === "room-build" ? 2 : 1);
      for (const requests of conversations) {
        const report = analyseRequests(
          scenario.id,
          shape,
          requests.map((request) => request.body),
        );
        assert.ok(report.requests >= 3, `expected a multi-request task, got ${report.requests}`);
        const broken = report.pairs.filter((pair) => pair.divergence);
        assert.equal(
          report.minStability,
          1,
          `request prefix rewritten: ${broken.map((pair) => `#${pair.request} ${pair.divergence!.kind} in ${pair.divergence!.segment}`).join("; ")}`,
        );
        assert.equal(report.catalogHashes.length, 1, "the tool catalog changed within the session");
        assert.ok(
          report.meanCacheableShare >= CACHEABLE_FLOOR[scenario.id]!,
          `mean cacheable share ${(report.meanCacheableShare * 100).toFixed(1)}% is below the floor`,
        );
      }
    });

/**
 * The live harness's capture must see every request the session sends: it
 * wraps fetch before the session builds its client (which binds fetch at
 * construction) and forwards the body unchanged unless diagnostics are on.
 * Watched failing with the wrapper installed after the session: zero bodies.
 */
test("the live capture records every body the session sends and forwards diagnostics", async () => {
  const scenario = SCENARIOS.find((candidate) => candidate.id === "ask")!;
  const scripted = installScriptedProvider("anthropic");
  const captured = captureLive("anthropic", true);
  try {
    const session = scenarioSession({
      provider: "anthropic",
      apiKey: "cache-probe-offline",
      model: DEFAULT_MODELS.anthropic,
    });
    for (const turn of scenario.turns) {
      scripted.use(queueScript(turn.script));
      await turn.run(session);
    }
  } finally {
    captured.restore();
    scripted.restore();
  }
  assert.ok(captured.bodies.length >= 4);
  assert.equal(captured.bodies.length, scripted.requests.length);
  // The kept copy is what the client built; the forwarded one adds the
  // diagnostics field that names the previous response.
  assert.ok(captured.bodies.every((body) => !("diagnostics" in body)));
  assert.deepEqual(scripted.requests[0]!.body["diagnostics"], { previous_message_id: null });
  assert.deepEqual(scripted.requests[1]!.body["diagnostics"], { previous_message_id: "msg_1" });
  assert.deepEqual(
    captured.bodies.map((body) => (body["messages"] as unknown[]).length),
    scripted.requests.map((request) => (request.body["messages"] as unknown[]).length),
  );
});
