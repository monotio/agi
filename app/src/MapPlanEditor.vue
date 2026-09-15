<script setup lang="ts">
/**
 * The detail pane's plan editor: when the selected room is in the plan it
 * edits its title, brief and exits; a planned room can be dropped from the
 * plan, and — while a game is running — built where it stands. "Add a room"
 * grows the plan off the selected node. Every write goes through the map's
 * validated edit path (the review draft or a revision-checked commit on the
 * session world); refusals surface in map.planError.
 */
import { computed, ref, watch } from "vue";
import { useEngineApi } from "./engineContext.ts";
import type { RoomGraphNode } from "../../src/agent/roomMap.ts";
import type { PlanRoomEdit } from "./useRoomMap.ts";

const props = defineProps<{ node: RoomGraphNode }>();
const engine = useEngineApi();
const map = engine.roomMap;

const entry = computed(() => map.plannedEntry(props.node.room));
const planExits = computed(() => Object.entries(entry.value?.exits ?? {}));

/**
 * The field-edit session for the selected room: drafts carry per-field
 * bases captured when the session opened, so a plan update landing under
 * the open form flags a conflict instead of being silently overwritten.
 */
const edit = ref<PlanRoomEdit>();
const newExitName = ref("");
const newExitTarget = ref("");
const addOpen = ref(false);
const addTitle = ref("");
const addBrief = ref("");
const addExitName = ref("");

watch(
  () => props.node.room,
  () => {
    edit.value = map.beginPlanEdit(props.node.room) ?? undefined;
    newExitName.value = "";
    newExitTarget.value = "";
    addOpen.value = false;
    addTitle.value = "";
    addBrief.value = "";
    addExitName.value = "";
  },
  { immediate: true },
);

// The plan moved under the open form — an agent turn or a take adopting a
// different world. Clean fields follow; dirty ones wait for the user. A
// room entering the plan while selected opens its session here.
watch(entry, (next) => {
  if (!next) return;
  if (!edit.value) edit.value = map.beginPlanEdit(props.node.room) ?? undefined;
  else map.syncPlanEdit(edit.value);
});

function commitField(field: "title" | "brief"): void {
  if (edit.value) map.commitPlanField(edit.value, field);
}

function addExit(): void {
  const to = Number(newExitTarget.value);
  if (!Number.isInteger(to) || to < 1 || to > 255) {
    map.planError.value = "An exit needs a target room number 1–255.";
    return;
  }
  if (map.addPlannedExit(props.node.room, newExitName.value, to) === null) {
    newExitName.value = "";
    newExitTarget.value = "";
  }
}

function addRoom(): void {
  const result = map.addPlannedRoom(
    props.node.room,
    addTitle.value,
    addBrief.value,
    addExitName.value,
  );
  if (result.room !== undefined) {
    addOpen.value = false;
    addTitle.value = "";
    addBrief.value = "";
    addExitName.value = "";
    map.select(result.room);
  }
}

/** A planned room the resources don't cover yet can be built in place. */
const canBuild = computed(() => props.node.planned && !props.node.authored);
const building = computed(() => map.buildingRoom.value === props.node.room);
</script>

<template>
  <div class="plan-editor" data-testid="map-plan-editor">
    <template v-if="entry && edit">
      <label class="plan-field">
        Name
        <input
          v-model="edit.title.draft"
          maxlength="160"
          data-testid="plan-room-title"
          @change="commitField('title')"
        />
      </label>
      <div
        v-if="edit.title.conflict !== null"
        class="plan-conflict"
        role="alert"
        data-testid="plan-title-conflict"
      >
        The plan now says “{{ edit.title.conflict }}”.
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="plan-title-keep"
          @click="map.resolvePlanField(edit, 'title', 'mine')"
        >
          Keep mine
        </button>
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="plan-title-use-plan"
          @click="map.resolvePlanField(edit, 'title', 'plan')"
        >
          Use the plan's
        </button>
      </div>
      <label class="plan-field">
        What happens here
        <textarea
          v-model="edit.brief.draft"
          rows="2"
          data-testid="plan-room-brief"
          @change="commitField('brief')"
        />
      </label>
      <div
        v-if="edit.brief.conflict !== null"
        class="plan-conflict"
        role="alert"
        data-testid="plan-brief-conflict"
      >
        The plan now says “{{ edit.brief.conflict }}”.
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="plan-brief-keep"
          @click="map.resolvePlanField(edit, 'brief', 'mine')"
        >
          Keep mine
        </button>
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="plan-brief-use-plan"
          @click="map.resolvePlanField(edit, 'brief', 'plan')"
        >
          Use the plan's
        </button>
      </div>
      <div class="plan-exits">
        <h4>Planned exits</h4>
        <p v-if="!planExits.length" class="map-none">None planned.</p>
        <ul v-else>
          <li v-for="[name, to] in planExits" :key="name">
            {{ name }} → Room {{ to }}
            <button
              type="button"
              class="plan-remove"
              aria-label="Remove exit"
              :data-testid="`plan-exit-remove-${name}`"
              @click="map.removePlannedExit(node.room, name)"
            >
              ×
            </button>
          </li>
        </ul>
        <div class="plan-inline-form">
          <input
            v-model="newExitName"
            maxlength="32"
            placeholder="exit name"
            data-testid="plan-exit-name"
          />
          <input
            v-model="newExitTarget"
            maxlength="3"
            placeholder="to room"
            data-testid="plan-exit-to"
          />
          <button
            type="button"
            class="ui-button ui-button--secondary"
            data-testid="plan-exit-add"
            @click="addExit"
          >
            Add
          </button>
        </div>
      </div>
    </template>
    <p v-else-if="!entry" class="map-none" data-testid="plan-not-planned">
      This room is not in the plan.
    </p>

    <div class="plan-actions">
      <button
        v-if="canBuild"
        type="button"
        class="ui-button ui-button--primary"
        data-testid="map-build-room"
        :disabled="map.buildingRoom.value !== undefined"
        @click="map.buildPlannedRoom(node.room)"
      >
        {{ building ? "Building…" : "Build this room" }}
      </button>
      <button
        type="button"
        class="ui-button ui-button--secondary"
        data-testid="map-add-room-toggle"
        @click="addOpen = !addOpen"
      >
        {{ addOpen ? "Cancel" : "Add a room off this one" }}
      </button>
      <button
        v-if="entry"
        type="button"
        class="ui-button ui-button--secondary"
        data-testid="map-remove-room"
        @click="map.removePlannedRoom(node.room)"
      >
        Remove from plan
      </button>
    </div>
    <div v-if="addOpen" class="plan-add-room">
      <input
        v-model="addTitle"
        maxlength="160"
        placeholder="Room title"
        data-testid="plan-add-title"
      />
      <input
        v-model="addExitName"
        maxlength="32"
        placeholder="exit name, e.g. north"
        data-testid="plan-add-exit"
      />
      <textarea
        v-model="addBrief"
        rows="2"
        placeholder="What happens there"
        data-testid="plan-add-brief"
      />
      <button
        type="button"
        class="ui-button ui-button--primary"
        data-testid="plan-add-room"
        @click="addRoom"
      >
        Add room
      </button>
    </div>
    <p v-if="map.planError.value" class="plan-error" role="alert" data-testid="map-plan-error">
      {{ map.planError.value }}
    </p>
  </div>
</template>

<style scoped>
.plan-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #2a4048;
}
.plan-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #8aa4ac;
}
.plan-field input,
.plan-field textarea,
.plan-inline-form input,
.plan-add-room input,
.plan-add-room textarea {
  background: #0b1518;
  border: 1px solid #3a5661;
  border-radius: 6px;
  color: #e3ecee;
  font-size: 13px;
  padding: 6px 8px;
  font-family: inherit;
}
.plan-exits h4 {
  margin: 0 0 4px;
  font-size: 12px;
  color: #8aa4ac;
  font-weight: 600;
}
.plan-exits ul {
  list-style: none;
  margin: 0 0 6px;
  padding: 0;
  font-size: 13px;
}
.plan-exits li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.plan-remove {
  background: none;
  border: none;
  color: #ff9b9b;
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}
.plan-inline-form {
  display: flex;
  gap: 6px;
}
.plan-inline-form input {
  width: 90px;
}
.plan-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.plan-add-room {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px dashed #3a5661;
  border-radius: 6px;
}
.plan-error {
  color: #ff9b9b;
  font-size: 12px;
  margin: 0;
}
.plan-conflict {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: #e8c98a;
  border: 1px dashed #6a5a34;
  border-radius: 6px;
  padding: 6px 8px;
  margin: 0;
}
</style>
