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
    // rc.15: deferred reposition placement, dispatch/condition bounds, input
    // fidelity and the new.room transition corrections; the Amiga 2.31x
    // opcode handlers ride on the same dispatch switch.
    lines: 6274,
    boundary:
      "the interpreter core: dispatch, original movement phases, modal timing and restore re-entry",
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
    boundary: "the inspector surface: resource controls, runtime state and visual diagnostics",
  },
  "src/runtime/persistence.ts": {
    // The Amiga profiles pin block-1 layouts inherited from their derivation
    // bases (unverified save images; docs/fidelity.md).
    lines: 1194,
    boundary: "the save format; the release contract pins its structure",
  },
  "src/runtime/profile.ts": {
    // rc.16: six Amiga interpreter profiles with their own dispatch bounds,
    // OBJECT layout and hunk/dirs detection evidence; the IIgs 1.014
    // profile adds its *.SYS16 banner detection and variant fields.
    lines: 813,
    boundary:
      "the interpreter profile contract: per-build variant fields, promotion evidence and detection",
  },
  "src/sound/sound.ts": {
    // The IIgs stream/wave decoders join the PC, booter and Amiga families;
    // each decoder feeds the one tick-driven playback state machine.
    lines: 836,
    boundary:
      "the sound resource decoders and the tick-driven playback state machine behind every output family",
  },
  "src/agent/history.ts": {
    lines: 970,
    boundary:
      "the history recording contract incl. the recorded clock, RNG-reseed and semantic-fingerprint lanes; the release contract pins its structure",
  },
  "app/src/WorldMap.vue": {
    lines: 1458,
    boundary: "the world-map overlay: graph, room list, room details and plan editing",
  },
  "app/src/TransportBar.vue": {
    lines: 748,
    boundary:
      "the one transport bar: timeline, marks, LIVE endpoint and mode extras for both sources",
  },
  "app/src/useHistoryView.ts": {
    lines: 1284,
    boundary:
      "the history-view controller: the always-on live/parked axis, seek, watch, marks, bookmarks, the branch-swap lifecycle and its transport source",
  },
  "app/src/useWalkthroughController.ts": {
    lines: 800,
    boundary:
      "the walkthrough session: artifact load, replay runner, snapshot-backed seek restarts and its transport source",
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
    lines: 1152,
    boundary:
      "the agent session lifecycle: genesis, room and remix turns, and revision-checked adoption",
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
    lines: 901,
    boundary: "the header and game-action menus",
  },
  "app/src/AgentBubble.vue": {
    lines: 779,
    boundary: "the agent bubble surface",
  },
  "app/src/useRoomMap.ts": {
    lines: 1344,
    boundary:
      "the world-map composable: merge, pause ownership, thumbnails, persistence, plan editing, durable-revision tracking, map-driven builds and background save retries",
  },
  "src/agent/gameTests.ts": {
    lines: 733,
    boundary: "the stored game-test runner",
  },
  "app/src/gameStorage.ts": {
    lines: 1008,
    boundary:
      "the local persistence records layer: conditional writes, coherent body/lifetime reads and transactional deletion receipts",
  },
  "app/src/historyStorage.ts": {
    lines: 1192,
    boundary:
      "the append-oriented tape store: immutable batches, content-keyed blobs, manifest and retained branches, with lifetime checks inside each write transaction",
  },
  "src/agent/roomMap.ts": {
    lines: 905,
    boundary:
      "the room-graph model: journal, plan and static-scan merge, plus the sidecar contract",
  },
  "app/src/useAuthoringController.ts": {
    lines: 1142,
    boundary:
      "the authoring controller: host-request turns, patches, map-driven builds, session adoption and the reserved, conditional reference-art Keep transaction",
  },
  "app/src/ReferenceUpload.vue": {
    lines: 649,
    boundary:
      "the reference-art dialog: room and character uploads, sheet manifest, staged preview, keep/revise and the attached list",
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
    lines: 728,
    boundary:
      "the worker session state: ports, cycle, input, replay incl. checkpoint snapshots, and history fields",
  },
  "app/src/worker/history.ts": {
    lines: 683,
    boundary:
      "the one recorder: always-on tape, stored game-test recording lifecycle, anchors and batches",
  },
  "app/src/worker/replay.ts": {
    lines: 956,
    boundary:
      "the one replay drive: the live-session drive with checkpoint snapshots and the scratch tape drive on the shared tick",
  },
  "app/src/App.vue": {
    lines: 608,
    boundary: "the shell root: engine boot, library/catalog routing and global key handling",
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
