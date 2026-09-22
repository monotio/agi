import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateWalkthroughArtifact } from "../src/walkthrough.ts";

// Route ceilings protect simulation savings without rerunning the games. Ending
// semantics remain covered by cold-boot route and browser replay tests.
const limits: Record<string, { polls: number; cycles: number; actions: number }> = {
  kq1: { polls: 110100, cycles: 15860, actions: 2750 },
  kq2: { polls: 127000, cycles: 18100, actions: 4600 },
  kq3: { polls: 260000, cycles: 34200, actions: 10600 },
  sq1: { polls: 143500, cycles: 19100, actions: 5100 },
  sq2: { polls: 144400, cycles: 18900, actions: 4600 },
  pq1: { polls: 401500, cycles: 39300, actions: 13400 },
  lsl1: { polls: 146000, cycles: 16000, actions: 5600 },
  bc: { polls: 106000, cycles: 12350, actions: 2400 },
  mumg: { polls: 59100, cycles: 21800, actions: 1550 },
  ddp: { polls: 10400, cycles: 2350, actions: 360 },
  mh1: { polls: 142500, cycles: 30000, actions: 6700 },
  mh2: { polls: 149100, cycles: 27900, actions: 5700 },
  gr1: { polls: 107000, cycles: 43400, actions: 8600 },
  kq4: { polls: 151400, cycles: 70800, actions: 8600 },
  "adventure-department": { polls: 1400, cycles: 90, actions: 145 },
};

for (const [alias, budget] of Object.entries(limits)) {
  test(`${alias}: shipped walkthrough retains its route budget and readable highlights`, () => {
    const artifact = validateWalkthroughArtifact(
      JSON.parse(
        readFileSync(new URL(`../public/walkthroughs/${alias}.json`, import.meta.url), "utf8"),
      ),
    );
    assert.ok(artifact.virtualTicks <= budget.polls, "simulation poll ceiling");
    assert.ok(artifact.cycles <= budget.cycles, "logic cycle ceiling");
    assert.ok(artifact.actions.length <= budget.actions, "recorded action ceiling");
    let tick = 0;
    const highlights: { tick: number; label: string }[] = [];
    for (const action of artifact.actions) {
      if (action.kind === "advance") tick += action.ticks;
      if (action.kind === "checkpoint") highlights.push({ tick, label: action.label });
    }
    assert.equal(tick, artifact.virtualTicks, "recorded advances cover the stated duration");
    assert.ok(highlights.length >= 4 && highlights.length <= 60, "a navigable set of highlights");
    assert.equal(
      new Set(highlights.map((h) => h.label)).size,
      highlights.length,
      "distinct labels",
    );
    for (let i = 0; i < highlights.length; i++) {
      const current = highlights[i]!;
      assert.doesNotMatch(
        current.label,
        /\b(?:room\s+\d+|[fv]\d+)\b/i,
        "story labels exclude debug state",
      );
      if (i > 0)
        assert.ok(current.tick > highlights[i - 1]!.tick, "no simultaneous duplicate markers");
    }
    if (tick > 10000) {
      const boundaries = [0, ...highlights.map((h) => h.tick), tick];
      for (let i = 1; i < boundaries.length; i++)
        assert.ok(
          boundaries[i]! - boundaries[i - 1]! <= tick * 0.15,
          "major story stretches need highlights; do not add delays to spread markers",
        );
    }
  });
}
