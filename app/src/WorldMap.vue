<script setup lang="ts">
/**
 * The world-map window: rooms as a list beside a graph, and the selected
 * room's details. Which rooms depends on the experience the caller chose:
 * "play" shows discovered places and observed crossings only; "create" adds
 * the plan (authoring intent) and the static scan (a literal new.room in the
 * logic). Node positions and notes are project UI data in either view; plan
 * editing is a creator action.
 *
 * A native modal dialog: Escape closes only this shell overlay and returns
 * focus to its invoker, the game's own dialog and prompt state untouched.
 * The graph, list and details are shared with Create mode's World panel
 * (world/); this file is the window around them.
 */
import { computed, onMounted, onUnmounted, useTemplateRef } from "vue";
import { useEngineApi } from "./engineContext.ts";
import WorldGraph from "./world/WorldGraph.vue";
import WorldRoomDetail from "./world/WorldRoomDetail.vue";
import WorldRoomList from "./world/WorldRoomList.vue";

const engine = useEngineApi();
const { state } = engine;
const map = engine.roomMap;
// Top-level refs unwrap in the template; .value stays in the script.
const { unsaved, storageError } = map;

const dialog = useTemplateRef("dialog");
const graphView = useTemplateRef("graphView");

onMounted(() => {
  dialog.value?.showModal();
});
onUnmounted(() => {
  if (dialog.value?.open) dialog.value.close();
});

function onDialogClose(): void {
  map.closeMap();
  // A refused review close (storage would not keep the draft) leaves the
  // map's state open — reopen the shell so the player sees why.
  if (map.open.value && dialog.value && !dialog.value.open) dialog.value.showModal();
}

const selectedNode = computed(
  () => map.graph.value.nodes.find((n) => n.room === map.selected.value) ?? null,
);

/** A list pick is a lookup gesture — the graph answers it visually. */
function pickRoom(room: number): void {
  graphView.value?.selectRoom(room, true);
}

/** A bare room in the plan — no connection yet; the detail pane names it. */
function addStandaloneRoom(): void {
  const result = map.addPlannedRoom(null, "New room", "", "");
  if (result.room !== undefined) pickRoom(result.room);
}
</script>

<template>
  <dialog
    ref="dialog"
    class="world-map"
    aria-labelledby="world-map-title"
    data-testid="world-map"
    @close="onDialogClose"
  >
    <header class="map-header">
      <h2 id="world-map-title">
        {{
          map.experience.value === "create"
            ? map.canPlan.value
              ? "World plan"
              : "Full map"
            : "World map"
        }}
      </h2>
      <span v-if="state.paused" class="map-paused" data-testid="map-paused">Game paused</span>
      <span v-if="storageError" class="map-error" role="alert" data-testid="map-error">
        {{ storageError }}
      </span>
      <span v-if="unsaved" class="map-unsaved" data-testid="map-unsaved">
        Map data is not saved — retrying in the background.
        <button type="button" class="ui-button ui-button--secondary" @click="map.retrySave()">
          Retry now
        </button>
      </span>
      <span
        v-if="map.canPlan.value && (map.planDirty.value || map.planSaveError.value)"
        class="map-unsaved"
        role="alert"
        data-testid="map-plan-unsaved"
      >
        {{ map.planSaveError.value || "The plan has unsaved edits." }}
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="map-plan-retry"
          @click="map.retryPlanSave()"
        >
          Retry
        </button>
      </span>
      <span class="map-header-actions">
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="btn-world-plan"
          :title="
            map.experience.value === 'create'
              ? 'Back to the discovered map'
              : map.planAvailable.value
                ? 'Edit rooms, exits and intent'
                : 'Every room the logic names'
          "
          @click="map.experience.value = map.experience.value === 'create' ? 'play' : 'create'"
        >
          {{
            map.experience.value === "create"
              ? "World map"
              : map.planAvailable.value
                ? "World plan"
                : "Full map"
          }}
        </button>
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="map-reset-layout"
          @click="map.resetLayout()"
        >
          Reset layout
        </button>
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="map-close"
          @click="map.closeMap()"
        >
          Close
        </button>
      </span>
    </header>
    <div class="map-body">
      <section class="map-list-pane" aria-label="Rooms">
        <WorldRoomList @pick="pickRoom" />
        <button
          v-if="map.canPlan.value"
          type="button"
          class="map-add-room ui-button ui-button--secondary"
          data-testid="map-add-room"
          @click="addStandaloneRoom"
        >
          + Add a room
        </button>
      </section>
      <WorldGraph ref="graphView" />
      <WorldRoomDetail v-if="selectedNode" class="map-detail-pane" :node="selectedNode" />
    </div>
  </dialog>
</template>

<style scoped>
.world-map {
  width: min(980px, 96vw);
  max-height: 88dvh;
  padding: 0;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-1);
}
.world-map::backdrop {
  background: var(--scrim);
}
.map-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.map-header h2 {
  margin: 0;
  font-size: var(--text-lg);
}
.map-header-actions {
  display: flex;
  gap: var(--space-3);
  margin-left: auto;
}
.map-paused {
  color: var(--ok);
  font-size: var(--text-xs);
}
.map-error,
.map-unsaved {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--danger);
  font-size: var(--text-xs);
}
.map-body {
  display: grid;
  grid-template-columns: minmax(200px, 260px) 1fr;
  grid-template-rows: minmax(0, 1fr) auto;
  max-height: calc(88dvh - 60px);
}
.map-list-pane {
  min-height: 160px;
  overflow-y: auto;
  border-right: 1px solid var(--hairline);
}
.map-add-room {
  margin: var(--space-3) var(--space-4);
}
.map-detail-pane {
  grid-column: 1 / -1;
  /* The auto row takes the detail's content height; without a cap a tall
     detail starves the list row and its scrollport hides list items under
     this pane. */
  max-height: 38dvh;
  overflow-y: auto;
  border-top: 1px solid var(--hairline);
}
@media (max-width: 700px) {
  .map-body {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto auto;
  }
  .map-list-pane {
    max-height: 34dvh;
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
