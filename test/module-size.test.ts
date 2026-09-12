// Module-size policy: production modules under src/ and app/src/ stay under
// LIMIT. Files already over it carry an explicit baseline entry that pins
// their size and names the concrete boundary it protects; growing one past
// its baseline fails here and is a recorded decision, not drift. When a file
// shrinks under the limit its entry is stale and must be removed — no global
// exemptions and no filler wrappers to satisfy a limit.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const LIMIT = 600;
const ROOTS = ["src", "app/src"];

const BASELINE: Record<string, { lines: number; boundary: string }> = {
  "src/runtime/engine.ts": {
    lines: 5853,
    boundary: "the interpreter core: dispatch, object table, motion, text surface",
  },
  "src/agent/tools.ts": {
    lines: 2004,
    boundary: "the agent tool surface: one implementation behind each schema",
  },
  "src/agent/playtest.ts": {
    lines: 1373,
    boundary: "the playtest loop: plan, run, judge",
  },
  "app/src/DebugDock.vue": {
    lines: 1233,
    boundary: "the inspector surface; size-only splits are out of scope for rc.10",
  },
  "src/runtime/persistence.ts": {
    lines: 1132,
    boundary: "the save format; the release contract pins its structure",
  },
  "src/picture/source.ts": {
    lines: 1085,
    boundary: "the picture vector-stream renderer",
  },
  "src/logic/assembler.ts": {
    lines: 1010,
    boundary: "the logic compiler, the validator of last resort",
  },
  "app/src/agent/agentSession.ts": {
    lines: 895,
    boundary: "the agent session lifecycle; size-only splits are out of scope for rc.10",
  },
  "app/src/useGameLibrary.ts": {
    lines: 882,
    boundary: "library import, export and storage operations",
  },
  "app/src/PlayArea.vue": {
    lines: 879,
    boundary: "the play surface: stage, input and presentation wiring",
  },
  "app/src/GameHeader.vue": {
    lines: 839,
    boundary: "the header and game-action menus",
  },
  "app/src/WorldMap.vue": {
    lines: 799,
    boundary: "the world-map overlay: graph, room list and room details",
  },
  "app/src/AgentBubble.vue": {
    lines: 755,
    boundary: "the agent bubble surface",
  },
  "src/agent/gameTests.ts": {
    lines: 733,
    boundary: "the stored game-test runner",
  },
  "app/src/gameStorage.ts": {
    lines: 716,
    boundary: "the local persistence records layer",
  },
  "app/src/agent/llmClient.ts": {
    lines: 705,
    boundary: "the provider client surface",
  },
  "src/agent/coreToolDefinitions.ts": {
    lines: 701,
    boundary: "the agent tool schemas",
  },
  "app/src/three/AgiStage.ts": {
    lines: 666,
    boundary: "the GPU stage: layers, picking and presentation",
  },
};

function* productionFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* productionFiles(path);
    else if (/\.(ts|vue)$/.test(entry.name)) yield path;
  }
}

function lineCount(path: string): number {
  return (readFileSync(path, "utf8").match(/\n/g) ?? []).length;
}

test("baseline entries are live and still needed", () => {
  for (const [path, entry] of Object.entries(BASELINE)) {
    const actual = lineCount(path);
    assert.ok(actual > LIMIT, `${path} is ${actual} lines — remove its baseline entry`);
    assert.ok(entry.boundary.length > 0, `${path} needs a boundary note`);
  }
});

test("no production module exceeds the limit or its baseline", () => {
  const violations: string[] = [];
  for (const root of ROOTS) {
    for (const path of productionFiles(root)) {
      const actual = lineCount(path);
      const entry = BASELINE[path];
      if (actual <= LIMIT) continue;
      if (!entry) {
        violations.push(`${path}: ${actual} lines over ${LIMIT} with no baseline`);
      } else if (actual > entry.lines) {
        violations.push(
          `${path}: ${actual} lines over its ${entry.lines}-line baseline (${entry.boundary})`,
        );
      }
    }
  }
  assert.deepEqual(violations, []);
});
