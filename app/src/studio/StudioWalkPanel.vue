<script setup lang="ts">
import { computed, ref, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiChip from "../ui/UiChip.vue";
import type { Point } from "../../../src/studio/shapes.ts";
import type { StudioTool } from "./studioTools.ts";
import type { StudioWalk } from "./useStudioWalk.ts";
import { doorStatus, EDGE_NAMES, outcomeTone, resultPlace, type WalkDoor } from "./walkView.ts";

/**
 * The Walk view's side panel: the walkable estimate's legend, the test walk
 * (what to click next, "Walking…", and the result card with Test again and
 * Play here), and the room's doors: a list, and for the selected door where
 * it leads, its condition, the art it follows, its box, and its two-sided
 * status. Native doors are read-only here and open as text instead. Every
 * control is a plain form control, so the keyboard reaches all of it.
 */
const { walk, tool, flags, items } = defineProps<{
  walk: StudioWalk;
  tool: StudioTool;
  /** The game's named flag bindings, for a door's condition. */
  flags: readonly string[];
  /** Picture items a door box can follow. */
  items: readonly { id: string; label: string }[];
}>();
const emit = defineEmits<{
  tool: [tool: StudioTool];
  "play-here": [at: Point];
  /** Show the room's logic as text, at a line when one is known. */
  text: [line: number | null];
}>();
const tint = defineModel<boolean>("tint", { default: true });

const result = computed(() => walk.result.value);
const place = computed(() =>
  result.value ? resultPlace(result.value.from, result.value.result, walk.room.value) : null,
);
const selected = computed(() => walk.selectedDoor.value);
const status = computed(() =>
  selected.value ? doorStatus(selected.value, walk.walked.value) : null,
);
/** Play here from where the walk ended; the goal when it never moved. */
const playSpot = computed<Point | null>(() => result.value?.result.end ?? walk.goal.value);

function describe(door: WalkDoor): string {
  if (door.shape === "box") return door.label;
  if (door.shape === "edge" && door.edge) return `${EDGE_NAMES[door.edge]} edge`;
  return door.label;
}

/** A new flag name typed for the condition. */
const newFlag = ref("");
watch(selected, () => (newFlag.value = ""));
const flagValue = computed(() => {
  const flag = selected.value?.requiresFlag ?? null;
  return flag === null ? "" : String(flag);
});
function onFlag(event: Event): void {
  const door = selected.value;
  if (!door) return;
  const value = (event.target as HTMLSelectElement).value;
  walk.setFlag(door.id, value === "" ? null : /^\d+$/.test(value) ? Number(value) : value);
}
function applyNewFlag(): void {
  const door = selected.value;
  const name = newFlag.value.trim().toLowerCase();
  if (!door || name === "") return;
  if (walk.setFlag(door.id, name)) newFlag.value = "";
}
function onDestination(event: Event): void {
  const door = selected.value;
  if (door) walk.setDestination(door.id, Number((event.target as HTMLSelectElement).value));
}
function onFollows(event: Event): void {
  const door = selected.value;
  const value = (event.target as HTMLSelectElement).value;
  if (door) walk.setFollows(door.id, value === "" ? null : value);
}
const BOX_FIELDS = [
  ["x1", "Left"],
  ["y1", "Top"],
  ["x2", "Right"],
  ["y2", "Bottom"],
] as const;
function onBox(event: Event, field: "x1" | "y1" | "x2" | "y2"): void {
  const door = selected.value;
  const input = event.target as HTMLInputElement;
  if (!door?.box) return;
  const value = Number(input.value);
  if (!Number.isInteger(value) || !walk.moveDoor(door.id, { ...door.box, [field]: value }))
    input.value = String(door.box[field]);
}
const roomChoices = computed(() => {
  const list = [...walk.rooms.value];
  const door = selected.value;
  if (door && !list.some((choice) => choice.room === door.destination))
    list.push({ room: door.destination, title: "" });
  return list.sort((a, b) => a.room - b.room);
});
</script>

<template>
  <div class="walk-panel" data-testid="walk-panel">
    <section class="walk-panel__sec">
      <h3>Walk</h3>
      <label class="walk-panel__check">
        <input v-model="tint" type="checkbox" data-testid="walk-tint-toggle" />
        <i class="walk-panel__swatch" aria-hidden="true"></i>
        <span>Where the player can stand <em>(estimate)</em></span>
      </label>
      <p class="walk-panel__note">
        From ego's size and the control lines; only a test walk says where the game really goes.
      </p>
    </section>

    <section class="walk-panel__sec" data-role="test-walk">
      <h3>
        Test walk
        <UiButton
          size="sm"
          variant="ghost"
          icon="footprints"
          shortcut="T"
          :aria-pressed="tool === 'walk'"
          data-testid="walk-tool"
          @click="emit('tool', tool === 'walk' ? 'select' : 'walk')"
        >
          {{ tool === "walk" ? "Choosing" : "Start" }}
        </UiButton>
      </h3>
      <label class="walk-panel__check">
        <input
          type="checkbox"
          :checked="walk.useLiveState.value"
          data-testid="walk-live-state"
          @change="walk.setUseLiveState(($event.target as HTMLInputElement).checked)"
        />
        <span>Use my current game state</span>
      </label>
      <p class="walk-panel__prompt" aria-live="polite" data-testid="walk-prompt">
        {{
          walk.running.value
            ? "Walking…"
            : tool === "walk"
              ? walk.prompt.value
              : "Press T, then click a start and a goal (or use the arrow keys and Space)."
        }}
      </p>
      <p
        v-if="walk.estimate.value && !result && !walk.running.value"
        class="walk-panel__note"
        data-testid="walk-estimate"
      >
        {{
          walk.estimate.value.path ? "Dashed: the estimated route." : "The estimate finds no route."
        }}
      </p>
      <div
        v-if="result"
        class="walk-panel__card"
        :class="`is-${outcomeTone(result.result.outcome)}`"
        data-testid="walk-result"
        :data-outcome="result.result.outcome"
      >
        <strong data-testid="walk-result-title">{{ result.title }}</strong>
        <p class="walk-panel__note" data-testid="walk-result-state">
          {{
            result.state === "live"
              ? "Tested with your game as it is now"
              : "Tested from a fresh start"
          }}
        </p>
        <dl>
          <dt>Cycles</dt>
          <dd>{{ result.result.cycles }}</dd>
          <dt data-testid="walk-result-place">{{ place?.term }}</dt>
          <dd data-testid="walk-result-end">{{ place?.text }}</dd>
        </dl>
        <details>
          <summary>What the engine said</summary>
          <p>{{ result.result.reason }}</p>
        </details>
        <div class="walk-panel__actions">
          <UiButton size="sm" icon="redo" data-testid="walk-again" @click="walk.again()">
            Test again
          </UiButton>
          <UiButton
            v-if="playSpot"
            size="sm"
            icon="play"
            data-testid="walk-play-here"
            @click="emit('play-here', playSpot)"
          >
            Play here
          </UiButton>
        </div>
      </div>
      <p v-if="walk.failure.value" class="walk-panel__fail" role="alert">
        {{ walk.failure.value }}
      </p>
    </section>

    <section class="walk-panel__sec" data-role="doors">
      <h3>Doors <em>D draws a door box · E adds an edge exit</em></h3>
      <p v-if="walk.doors.value.length === 0" class="walk-panel__note">
        This room has no exits yet.
      </p>
      <ul v-else class="walk-panel__doors" aria-label="Doors">
        <li v-for="door in walk.doors.value" :key="door.id">
          <button
            type="button"
            class="walk-panel__door"
            :aria-pressed="selected?.id === door.id"
            :data-door="door.id"
            data-testid="walk-door"
            @click="walk.selectDoor(door.id)"
          >
            <span>{{ walk.labelOf(door) }}</span>
            <em>{{ describe(door) }}</em>
            <UiChip v-if="!door.editable" :tone="door.planned ? 'warn' : 'neutral'">
              {{ door.planned ? "planned" : "native" }}
            </UiChip>
          </button>
        </li>
      </ul>

      <div v-if="selected" class="walk-panel__editor" data-testid="door-editor">
        <p class="walk-panel__status">
          <span data-testid="door-way-back">{{ status?.wayBack }}</span>
          <UiChip :tone="status?.testedOk ? 'ok' : 'neutral'" dot data-testid="door-tested">
            {{ status?.tested }}
          </UiChip>
        </p>
        <template v-if="selected.editable">
          <label class="walk-panel__field">
            <span>Leads to</span>
            <select
              class="walk-panel__input"
              :value="selected.destination"
              data-testid="door-destination"
              :disabled="!walk.canEditDoors.value"
              @change="onDestination"
            >
              <option v-for="choice in roomChoices" :key="choice.room" :value="choice.room">
                Room {{ choice.room }}{{ choice.title ? ` · ${choice.title}` : "" }}
              </option>
            </select>
          </label>
          <label class="walk-panel__field">
            <span>Opens when</span>
            <select
              class="walk-panel__input"
              :value="flagValue"
              data-testid="door-flag"
              :disabled="!walk.canEditDoors.value"
              @change="onFlag"
            >
              <option value="">Always open</option>
              <option v-for="flag in flags" :key="flag" :value="flag">{{ flag }} is set</option>
              <option v-if="flagValue !== '' && !flags.includes(flagValue)" :value="flagValue">
                {{ flagValue }} is set
              </option>
            </select>
          </label>
          <form class="walk-panel__row" @submit.prevent="applyNewFlag">
            <input
              v-model="newFlag"
              class="walk-panel__input"
              placeholder="or a new flag name"
              aria-label="New flag name for the door's condition"
              :disabled="!walk.canEditDoors.value"
            />
            <UiButton size="sm" type="submit" :disabled="!walk.canEditDoors.value">Use</UiButton>
          </form>
          <template v-if="selected.box">
            <label class="walk-panel__field">
              <span>Follows</span>
              <select
                class="walk-panel__input"
                :value="selected.item ?? ''"
                data-testid="door-follows"
                :disabled="!walk.canEditDoors.value"
                @change="onFollows"
              >
                <option value="">Nothing (stays put)</option>
                <option v-for="item in items" :key="item.id" :value="item.id">
                  {{ item.label }}
                </option>
              </select>
            </label>
            <p class="walk-panel__note">
              Or drag the round handle on the door box onto the art. Moving that art moves the door
              when you Keep.
            </p>
            <div class="walk-panel__box" role="group" aria-label="Door box">
              <label v-for="[field, name] in BOX_FIELDS" :key="field">
                <span>{{ name }}</span>
                <input
                  class="walk-panel__input walk-panel__num"
                  type="number"
                  min="0"
                  :max="field[0] === 'x' ? 159 : 167"
                  :value="selected.box[field]"
                  :data-testid="`door-box-${field}`"
                  :disabled="!walk.canEditDoors.value"
                  @change="onBox($event, field)"
                />
              </label>
            </div>
          </template>
          <div class="walk-panel__actions">
            <UiButton
              size="sm"
              variant="danger"
              icon="trash"
              data-testid="door-remove"
              :disabled="!walk.canEditDoors.value"
              @click="walk.removeDoor(selected.id)"
            >
              Remove
            </UiButton>
            <UiButton size="sm" variant="ghost" @click="emit('text', selected.line)">
              View as text
            </UiButton>
          </div>
        </template>
        <template v-else>
          <p class="walk-panel__note" data-testid="door-native">
            {{ walk.labelOf(selected) }}: this exit is written in the room's own logic, which the
            door tools can't change. Edit it as text, or ask the assistant.
          </p>
          <UiButton
            size="sm"
            icon="pencil"
            data-testid="door-edit-text"
            @click="emit('text', selected.line)"
          >
            Edit as text…
          </UiButton>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.walk-panel__sec {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.walk-panel__sec h3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.walk-panel__sec h3 em {
  font-style: normal;
  font-weight: var(--weight-medium);
  letter-spacing: 0;
  text-transform: none;
}
.walk-panel__check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink);
}
.walk-panel__check em {
  color: var(--ink-3);
  font-style: normal;
}
.walk-panel__swatch {
  width: var(--space-4);
  height: var(--space-4);
  border-radius: var(--radius-sm);
  background: var(--ok-soft);
  box-shadow: inset 0 0 0 1px var(--ok-line);
}
.walk-panel__note {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.walk-panel__prompt {
  margin: 0;
  color: var(--ink-2);
}
.walk-panel__fail {
  margin: 0;
  color: var(--danger);
}
.walk-panel__card {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-0);
}
.walk-panel__card.is-ok {
  border-color: var(--ok-line);
}
.walk-panel__card.is-warn {
  border-color: var(--warn-line);
}
.walk-panel__card strong {
  font-size: var(--text-md);
}
.walk-panel__card dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-0) var(--space-3);
  margin: 0;
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.walk-panel__card dd {
  margin: 0;
  font-family: var(--font-mono);
}
.walk-panel__card details {
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.walk-panel__card details p {
  margin: var(--space-1) 0 0;
}
.walk-panel__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.walk-panel__doors {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
.walk-panel__door {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-0);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.walk-panel__door em {
  flex: 1;
  color: var(--ink-3);
  font-style: normal;
  font-size: var(--text-xs);
}
.walk-panel__door[aria-pressed="true"] {
  border-color: var(--action);
  background: var(--action-soft);
}
.walk-panel__door:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -1px;
}
.walk-panel__editor {
  display: grid;
  gap: var(--space-3);
}
.walk-panel__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--ink);
}
.walk-panel__field {
  display: grid;
  gap: var(--space-1);
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.walk-panel__input {
  box-sizing: border-box;
  width: 100%;
  min-height: var(--control-h-sm);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.walk-panel__input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -1px;
}
.walk-panel__row {
  display: flex;
  gap: var(--space-2);
}
.walk-panel__box {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
}
.walk-panel__box label {
  display: grid;
  gap: var(--space-0);
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.walk-panel__num {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
</style>
