<script setup lang="ts">
/**
 * The world-map window: the graph filling the window beside a column that
 * holds either the room list or the selected room's details (the World
 * panel's drill-in, useRoomDrill.ts). Which rooms depends on the view, a
 * segmented choice the caller opens on: "Discovered" (experience "play")
 * shows discovered places and observed crossings only; "Full map" or "Plan"
 * (experience "create") adds the plan (authoring intent) and the static scan
 * (a literal new.room in the logic). Node positions and notes are project UI
 * data in either view; plan editing is a creator action.
 *
 * A native modal dialog: Escape closes only this shell overlay and returns
 * focus to its invoker, the game's own dialog and prompt state untouched.
 * The graph, list and details are shared with Create mode's World panel
 * (world/); this file is the window around them.
 */
import { computed, ref, useTemplateRef, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import { useWorkspaceEditor } from "../shell/workspaceEditor.ts";
import { useShell } from "../shell/useShell.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import WorldGraph from "./WorldGraph.vue";
import WorldRoomDetail from "./WorldRoomDetail.vue";
import WorldRoomList from "./WorldRoomList.vue";
import { useRoomDrill } from "./useRoomDrill.ts";
import type { MapExperience } from "../../../src/agent/roomMap.ts";

const engine = useEngineApi();
const { state } = engine;
const map = engine.roomMap;
const editor = useWorkspaceEditor();
const shell = useShell();
// Top-level refs unwrap in the template; .value stays in the script.
const { unsaved, storageError } = map;
const runtimeExits = computed(() =>
  [...map.resources.value.scans.values()].some(
    (scan) => scan.variableTarget || scan.unresolvedCall,
  ),
);
const computedRoomJump = computed(() =>
  [...map.resources.value.scans.values()].some((scan) => scan.variableTarget),
);

const graphView = useTemplateRef("graphView");
const sideEl = useTemplateRef("sideEl");
const detailView = useTemplateRef("detailView");

/** Shown while mounted: App mounts the window only while the map is open. */
const shown = ref(true);
watch(shown, (value) => {
  if (value) return;
  map.closeMap();
  // A refused review close (storage would not keep the draft) leaves the
  // map's state open — reopen the shell so the player sees why.
  if (map.open.value) shown.value = true;
});

/** The two views, each named for what it shows. */
const views = computed(() => [
  {
    value: "play" as const,
    label: "Discovered",
    title: "The rooms the player has found",
    testid: "btn-world-discovered",
  },
  {
    value: "create" as const,
    label: map.planAvailable.value ? "Plan" : "Full map",
    title: map.planAvailable.value ? "Edit rooms, exits and intent" : "Every room the logic names",
    testid: "btn-world-plan",
  },
]);
const view = computed<MapExperience>({
  get: () => map.experience.value,
  set: (value) => {
    map.experience.value = value;
  },
});

/** A list pick is a lookup gesture — the graph answers it visually. */
function pickRoom(room: number): void {
  graphView.value?.selectRoom(room, true);
}

const { selectedNode, pickFromList, showAllRooms, onDetailKeydown } = useRoomDrill({
  map,
  root: sideEl,
  detail: detailView,
  pick: pickRoom,
});

function openRoomPicture(room: number): void {
  if (shell.mode.value !== "create") return;
  const resources = map.resources.value;
  const picture = resources.scans
    .get(room)
    ?.pictures.find((number) => resources.picture.has(number));
  if (picture === undefined) return;
  editor.open(`picture:${picture}`);
  shown.value = false;
}

/** A bare room in the plan — no connection yet; the detail pane names it. */
function addStandaloneRoom(): void {
  const result = map.addPlannedRoom(null, "New room", "", "");
  if (result.room !== undefined) pickFromList(result.room);
}
</script>

<template>
  <UiDialog
    v-model:open="shown"
    title="Map"
    size="lg"
    flush
    class="world-map"
    close-testid="map-close"
    data-testid="world-map"
    :data-analysis="map.analysisStatus.value"
  >
    <template #actions>
      <span v-if="state.paused" class="map-paused" data-testid="map-paused">Game paused</span>
      <UiSegmented v-model="view" size="sm" label="Map view" :options="views" />
      <UiButton size="sm" variant="ghost" data-testid="map-reset-layout" @click="map.resetLayout()">
        Reset layout
      </UiButton>
    </template>
    <div
      v-if="
        storageError ||
        unsaved ||
        (map.canPlan.value && (map.planDirty.value || map.planSaveError.value))
      "
      class="map-alerts"
    >
      <span v-if="storageError" class="map-error" role="alert" data-testid="map-error">
        {{ storageError }}
      </span>
      <span v-if="unsaved" class="map-unsaved" data-testid="map-unsaved">
        Map data is not saved yet. Retrying in the background.
        <UiButton size="sm" variant="ghost" @click="map.retrySave()">Retry now</UiButton>
      </span>
      <span
        v-if="map.canPlan.value && (map.planDirty.value || map.planSaveError.value)"
        class="map-unsaved"
        role="alert"
        data-testid="map-plan-unsaved"
      >
        {{ map.planSaveError.value || "The plan has unsaved edits." }}
        <UiButton
          size="sm"
          variant="ghost"
          data-testid="map-plan-retry"
          @click="map.retryPlanSave()"
        >
          Retry
        </UiButton>
      </span>
    </div>
    <p
      :class="{ 'is-clear': !runtimeExits }"
      :aria-hidden="!runtimeExits"
      class="map-runtime"
      data-testid="map-runtime-exits"
    >
      Some exits are worked out while you play.<template v-if="computedRoomJump">
        A computed room jump can reach a missing room.</template
      >
    </p>
    <div class="map-body">
      <section ref="sideEl" class="map-side" aria-label="Rooms">
        <div v-show="!selectedNode">
          <WorldRoomList @pick="pickFromList" />
          <UiButton
            v-if="map.canPlan.value"
            icon="plus"
            size="sm"
            variant="ghost"
            class="map-add-room"
            data-testid="map-add-room"
            @click="addStandaloneRoom"
          >
            Add a room
          </UiButton>
        </div>
        <template v-if="selectedNode">
          <UiButton
            icon="chevron-left"
            size="sm"
            variant="ghost"
            class="map-back"
            data-testid="world-all-rooms"
            @click="showAllRooms"
          >
            All rooms
          </UiButton>
          <WorldRoomDetail ref="detailView" :node="selectedNode" @keydown="onDetailKeydown" />
        </template>
      </section>
      <WorldGraph ref="graphView" @pick="openRoomPicture" />
    </div>
  </UiDialog>
</template>

<style scoped>
/* Expand exists so the graph can be read: the window takes most of the
   screen and the graph fills everything beside the side column. */
.world-map.ui-dialog {
  width: min(1280px, 96vw);
  height: 88dvh;
  max-height: 88dvh;
}
.world-map :deep(.ui-dialog__body) {
  display: flex;
  flex-direction: column;
}
.map-paused {
  color: var(--ok);
  font-size: var(--text-xs);
}
.map-alerts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-5);
  padding: 0 var(--space-6) var(--space-3);
}
.map-error,
.map-unsaved {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--danger);
  font-size: var(--text-xs);
}
.map-runtime {
  margin: 0;
  padding: 0 var(--space-6) var(--space-3);
  color: var(--ink-3);
  font-size: var(--text-sm);
}
.map-runtime.is-clear {
  visibility: hidden;
}
.map-body {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
  border-top: 1px solid var(--hairline);
}
.map-side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  border-right: 1px solid var(--hairline);
}
.map-add-room {
  margin: var(--space-3) var(--space-4);
}
.map-back {
  align-self: flex-start;
  margin: var(--space-2) var(--space-3) 0;
}
@media (max-width: 520px) {
  .world-map :deep(.ui-dialog__head) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .world-map :deep(.ui-dialog__actions) {
    grid-column: 1 / -1;
    grid-row: 2;
    margin-left: 0;
  }
}
@media (max-width: 700px) {
  .map-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .map-side {
    max-height: 40dvh;
    border-right: none;
    border-bottom: 1px solid var(--hairline);
  }
}
@media (prefers-reduced-motion: reduce) {
  .world-map * {
    animation: none;
    transition: none;
  }
}
</style>
