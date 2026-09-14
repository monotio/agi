// Module-size policy: production modules under src/ and app/src/ stay under
// LIMIT. Files already over it carry an explicit baseline entry that pins
// their size and names the concrete boundary it protects; growing one past
// its baseline plus HEADROOM fails here and is a recorded decision, not
// drift — the headroom keeps small deliberate edits from needing a re-pin.
// When a file shrinks under the limit its entry is stale and must be
// removed — no global exemptions and no filler wrappers to satisfy a limit.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const LIMIT = 600;
/** Slack above a pinned baseline before growth becomes a recorded decision. */
const HEADROOM = 50;
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
    lines: 1246,
    boundary: "the inspector surface; size-only splits are out of scope for rc.10",
  },
  "src/runtime/persistence.ts": {
    lines: 1132,
    boundary: "the save format; the release contract pins its structure",
  },
  "src/agent/history.ts": {
    lines: 765,
    boundary:
      "the history recording contract incl. the recorded clock lane; the release contract pins its structure",
  },
  "app/src/WorldMap.vue": {
    lines: 1458,
    boundary: "the world-map overlay: graph, room list, room details and plan editing",
  },
  "app/src/TransportBar.vue": {
    lines: 656,
    boundary: "the one transport bar: timeline, marks and mode extras for both sources",
  },
  "app/src/useHistoryView.ts": {
    lines: 864,
    boundary:
      "the history-view controller: seek, watch, marks, bookmarks, the staged-swap lifecycle and its transport source",
  },
  "app/src/useWalkthroughController.ts": {
    lines: 703,
    boundary:
      "the walkthrough session: artifact load, replay runner, seek restarts and its transport source",
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
    lines: 960,
    boundary: "the agent session lifecycle: genesis, room and remix turns",
  },
  "app/src/useGameLibrary.ts": {
    lines: 896,
    boundary: "library import, export and storage operations",
  },
  "app/src/PlayArea.vue": {
    lines: 879,
    boundary: "the play surface: stage, input and presentation wiring",
  },
  "app/src/GameHeader.vue": {
    lines: 844,
    boundary: "the header and game-action menus",
  },
  "app/src/AgentBubble.vue": {
    lines: 779,
    boundary: "the agent bubble surface",
  },
  "app/src/useRoomMap.ts": {
    lines: 1008,
    boundary:
      "the world-map composable: merge, pause ownership, thumbnails, persistence, plan editing and map-driven builds",
  },
  "src/agent/gameTests.ts": {
    lines: 733,
    boundary: "the stored game-test runner",
  },
  "app/src/gameStorage.ts": {
    lines: 716,
    boundary: "the local persistence records layer",
  },
  "src/agent/roomMap.ts": {
    lines: 765,
    boundary:
      "the room-graph model: journal, plan and static-scan merge, plus the sidecar contract",
  },
  "app/src/useAuthoringController.ts": {
    lines: 689,
    boundary: "the authoring controller: host-request turns, patches and map-driven room builds",
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
  "app/src/worker/context.ts": {
    lines: 671,
    boundary: "the worker session state: ports, cycle, input, replay and history fields",
  },
  "app/src/worker/history.ts": {
    lines: 683,
    boundary:
      "the one recorder: always-on tape, stored game-test recording lifecycle, anchors and batches",
  },
  "app/src/worker/replay.ts": {
    lines: 731,
    boundary:
      "the one replay drive: the live-session drive and the scratch tape drive on the shared tick",
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
      } else if (actual > entry.lines + HEADROOM) {
        violations.push(
          `${path}: ${actual} lines over its ${entry.lines}-line baseline + ${HEADROOM} headroom (${entry.boundary})`,
        );
      }
    }
  }
  assert.deepEqual(violations, []);
});
