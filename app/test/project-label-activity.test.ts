import assert from "node:assert/strict";
import { test } from "node:test";
import { computed, createApp, reactive, ref } from "vue";
import { engineKey, type EngineApi } from "../src/engine/engineContext.ts";
import { useProjectLabels } from "../src/shell/useProjectLabels.ts";
import { numberedLabel } from "../../src/logic/numberedLabels.ts";

test("Play labels read authored names without requesting room analysis", () => {
  let reads = 0;
  const state = reactive({ patchTick: 0, profile: "2.936" });
  const documents = {
    world: JSON.stringify({ rooms: { "1": { title: "Meadow" } } }),
    "picture:5": "# Clearing: room art\nend",
  };
  const analysisStatus = ref("idle");
  const engine = {
    state,
    getProjectSession: () => ({ workingSnapshot: () => ({ documents: () => documents }) }),
    roomMap: {
      analysisStatus,
      resources: computed(() => {
        reads++;
        return { shared: new Set(), scans: new Map([[2, { pictures: [5] }]]) };
      }),
      graph: computed(() => ({ nodes: [{ room: 2, title: "Room 2" }] })),
    },
  } as unknown as EngineApi;
  const app = createApp({});
  app.provide(engineKey, engine);
  const labels = app.runWithContext(useProjectLabels);
  assert.equal(numberedLabel("room", 1, labels.value, "row"), "Meadow · Room 1");
  assert.equal(reads, 0, "the Play heading must not request a resource scan");
  documents.world = JSON.stringify({ rooms: { "1": { title: "Garden" } } });
  state.patchTick++;
  assert.equal(numberedLabel("room", 1, labels.value, "row"), "Garden · Room 1");
  assert.equal(reads, 0);
  analysisStatus.value = "resolved";
  assert.equal(numberedLabel("room", 2, labels.value, "row"), "Clearing · Room 2");
  assert.equal(reads, 1, "labels can use the room analysis requested by an activity");
});
