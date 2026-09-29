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
import UiButton from "../ui/UiButton.vue";
import UiField from "../ui/UiField.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import { useEngineApi } from "../engine/engineContext.ts";
import type { RoomGraphNode } from "../../../src/agent/roomMap.ts";
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
  <section class="plan-editor" aria-label="Plan" data-testid="map-plan-editor">
    <h4 class="plan-editor__title">Plan</h4>
    <template v-if="entry && edit">
      <UiField v-slot="{ id }" label="Name" dense>
        <input
          :id
          v-model="edit.title.draft"
          maxlength="160"
          data-testid="plan-room-title"
          @change="commitField('title')"
        />
      </UiField>
      <div
        v-if="edit.title.conflict !== null"
        class="plan-conflict"
        role="alert"
        data-testid="plan-title-conflict"
      >
        The plan now says “{{ edit.title.conflict }}”.
        <UiButton
          size="sm"
          data-testid="plan-title-keep"
          @click="map.resolvePlanField(edit, 'title', 'mine')"
        >
          Keep mine
        </UiButton>
        <UiButton
          size="sm"
          variant="ghost"
          data-testid="plan-title-use-plan"
          @click="map.resolvePlanField(edit, 'title', 'plan')"
        >
          Use the plan's
        </UiButton>
      </div>
      <UiField v-slot="{ id }" label="What happens here" dense>
        <textarea
          :id
          v-model="edit.brief.draft"
          rows="2"
          data-testid="plan-room-brief"
          @change="commitField('brief')"
        />
      </UiField>
      <div
        v-if="edit.brief.conflict !== null"
        class="plan-conflict"
        role="alert"
        data-testid="plan-brief-conflict"
      >
        The plan now says “{{ edit.brief.conflict }}”.
        <UiButton
          size="sm"
          data-testid="plan-brief-keep"
          @click="map.resolvePlanField(edit, 'brief', 'mine')"
        >
          Keep mine
        </UiButton>
        <UiButton
          size="sm"
          variant="ghost"
          data-testid="plan-brief-use-plan"
          @click="map.resolvePlanField(edit, 'brief', 'plan')"
        >
          Use the plan's
        </UiButton>
      </div>
      <div class="plan-exits">
        <p class="plan-label">Planned exits</p>
        <p v-if="!planExits.length" class="plan-none">None planned.</p>
        <ul v-else class="plan-exit-list">
          <li v-for="[name, to] in planExits" :key="name">
            <span class="plan-exit-name">{{ name }}</span>
            <span class="plan-exit-to">→ Room {{ to }}</span>
            <UiIconButton
              icon="trash"
              size="sm"
              :label="`Remove the ${name} exit`"
              :data-testid="`plan-exit-remove-${name}`"
              @click="map.removePlannedExit(node.room, name)"
            />
          </li>
        </ul>
        <form class="plan-inline-form" @submit.prevent="addExit">
          <input
            v-model="newExitName"
            maxlength="32"
            placeholder="Exit name"
            aria-label="New exit name"
            data-testid="plan-exit-name"
          />
          <input
            v-model="newExitTarget"
            maxlength="3"
            inputmode="numeric"
            placeholder="Room #"
            aria-label="Room the new exit leads to"
            data-testid="plan-exit-to"
          />
          <UiButton type="submit" size="sm" icon="plus" data-testid="plan-exit-add">Add</UiButton>
        </form>
      </div>
    </template>
    <p v-else-if="!entry" class="plan-none" data-testid="plan-not-planned">
      This room is not in the plan.
    </p>

    <div class="plan-actions">
      <UiButton
        v-if="canBuild"
        size="sm"
        icon="sparkles"
        data-testid="map-build-room"
        :disabled="map.buildingRoom.value !== undefined"
        :title="
          map.buildingRoom.value === undefined
            ? undefined
            : `Room ${map.buildingRoom.value} is building`
        "
        @click="map.buildPlannedRoom(node.room)"
      >
        {{ building ? "Building…" : "Build this room" }}
      </UiButton>
      <UiButton
        size="sm"
        variant="ghost"
        :icon="addOpen ? 'x' : 'plus'"
        data-testid="map-add-room-toggle"
        @click="addOpen = !addOpen"
      >
        {{ addOpen ? "Cancel" : "Add a room off this one" }}
      </UiButton>
      <UiButton
        v-if="entry"
        size="sm"
        variant="ghost"
        icon="trash"
        data-testid="map-remove-room"
        @click="map.removePlannedRoom(node.room)"
      >
        Remove from plan
      </UiButton>
    </div>
    <form v-if="addOpen" class="plan-add-room" @submit.prevent="addRoom">
      <UiField v-slot="{ id }" label="Room name" dense>
        <input :id v-model="addTitle" maxlength="160" data-testid="plan-add-title" />
      </UiField>
      <UiField v-slot="{ id }" label="Exit to it" hint="For example north" dense>
        <input
          :id
          v-model="addExitName"
          maxlength="32"
          placeholder="north"
          data-testid="plan-add-exit"
        />
      </UiField>
      <UiField v-slot="{ id }" label="What happens there" dense>
        <textarea :id v-model="addBrief" rows="2" data-testid="plan-add-brief" />
      </UiField>
      <UiButton type="submit" size="sm" variant="primary" data-testid="plan-add-room">
        Add room
      </UiButton>
    </form>
    <p v-if="map.planError.value" class="plan-error" role="alert" data-testid="map-plan-error">
      {{ map.planError.value }}
    </p>
  </section>
</template>

<style scoped>
/* A section of the room inspector (WorldRoomDetail): same rhythm and type. */
.plan-editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.plan-editor__title {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.plan-exits {
  display: grid;
  gap: var(--space-2);
}
.plan-label {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-xs) / var(--leading-tight) var(--font-sans);
}
.plan-none {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.plan-exit-list {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-sm);
}
.plan-exit-list li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.plan-exit-name {
  font-weight: var(--weight-semibold);
}
.plan-exit-to {
  flex: 1;
  color: var(--ink-2);
}
.plan-inline-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 72px auto;
  gap: var(--space-2);
}
.plan-inline-form input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: var(--control-h-sm);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.plan-inline-form input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -1px;
}
.plan-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
}
.plan-add-room {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-0);
}
.plan-add-room > .ui-btn {
  justify-self: start;
}
.plan-error {
  margin: 0;
  color: var(--danger);
  font-size: var(--text-xs);
}
.plan-conflict {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px dashed var(--warn-line);
  border-radius: var(--radius);
  color: var(--warn);
  font-size: var(--text-xs);
}
</style>
