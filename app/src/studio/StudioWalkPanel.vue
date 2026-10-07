<script setup lang="ts">
import { computed, ref, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiChip from "../ui/UiChip.vue";
import UiExplain from "../ui/UiExplain.vue";
import { explain } from "./studioTerms.ts";
import type { PlayHereTarget } from "../../../src/runtime/playHere.ts";
import type { StudioTool } from "./studioTools.ts";
import { CONTROL_VALUES, patternOn } from "./studioView.ts";
import type { StudioWalk } from "./useStudioWalk.ts";
import type { RuleBox } from "../../../src/studio/rules/ruleModel.ts";
import {
  doorStatus,
  doorTestNote,
  EDGE_NAMES,
  outcomeTone,
  playTarget,
  resultPlace,
  ruleProblemText,
  WALK_STATE_LABEL,
  walkStateText,
  type WalkDoor,
} from "./walkView.ts";

/**
 * The Priority lens's room panel: the walkable estimate and the control
 * lines' legend, the test walk
 * (what to click next, "Walking…", and the result card with Test again and
 * Play here), and the room's doors: a list, and for the selected door where
 * it leads, its condition, the art it follows, its box, and its two-sided
 * status, with how to test it (or why the last walk aimed at it did not go
 * through). Doors written in the room's script are read-only here and open
 * as text instead. Every
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
  "play-here": [target: PlayHereTarget];
  /** Show the room's logic as text, at a line when one is known. */
  text: [line: number | null];
}>();
const tint = defineModel<boolean>("tint", { default: true });
/** Why the door fields are off, on each of them. */
const DOORS_OFF =
  "Door editing pauses while the room is read-only, a change is open, or its script needs repair.";
const doorsOff = computed(() => (walk.canEditDoors.value ? undefined : DOORS_OFF));

const result = computed(() => walk.result.value);
const place = computed(() =>
  result.value ? resultPlace(result.value.from, result.value.result, walk.room.value) : null,
);
const selected = computed(() => walk.selectedDoor.value);
const status = computed(() =>
  selected.value ? doorStatus(selected.value, walk.tested.value.has(selected.value.id)) : null,
);
/** How to test the selected door, or why the last walk aimed at it did not go through. */
const testNote = computed(() =>
  selected.value && status.value
    ? doorTestNote(selected.value, status.value.testedOk, walk.doorNote(selected.value.id))
    : null,
);
/** Play here from where the walk ended, in the room it ended in (walkView.ts `playTarget`). */
const playSpot = computed<PlayHereTarget | null>(() =>
  result.value ? playTarget(result.value.result, walk.room.value, walk.goal.value) : null,
);

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
/** Text belongs to the field until accepted, including across a landing room commit. */
const boxInputs = ref<Partial<Record<keyof RuleBox, string>>>({});
const boxError = ref("");
watch(
  () => selected.value?.id,
  () => {
    boxInputs.value = {};
    boxError.value = "";
  },
);
function typeBox(event: Event, field: keyof RuleBox): void {
  boxInputs.value[field] = (event.target as HTMLInputElement).value;
  boxError.value = "";
}
function onBox(event: Event, field: "x1" | "y1" | "x2" | "y2"): void {
  const door = selected.value;
  const input = event.target as HTMLInputElement;
  if (!door?.box) return;
  const value = Number(input.value);
  if (input.value === "" || !Number.isInteger(value)) {
    boxError.value = "Enter a whole number for the door box.";
    return;
  }
  // Merge this field into the latest box, including other accepted field edits.
  if (walk.moveDoor(door.id, { ...door.box, [field]: value })) delete boxInputs.value[field];
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
      <h3>Where characters walk</h3>
      <label class="walk-panel__check">
        <input v-model="tint" type="checkbox" />
        <i class="walk-panel__swatch" aria-hidden="true"></i>
        <span>Floor <em>(estimate)</em></span>
        <UiExplain v-bind="explain('floor-estimate')" />
      </label>
      <div
        class="walk-panel__legend"
        data-role="control-legend"
        role="list"
        aria-label="Walls, water, triggers, gates"
      >
        <span
          v-for="control in CONTROL_VALUES"
          :key="control.value"
          :title="`${control.help} ${control.technical}`"
          class="walk-panel__line"
          role="listitem"
        >
          <svg viewBox="0 0 8 2" width="24" height="6" aria-hidden="true">
            <rect
              v-for="x in 8"
              :key="x"
              :x="x - 1"
              y="0"
              width="1"
              height="2"
              :style="{
                fill: `var(--agi-${control.colour})`,
                opacity: patternOn(control.pattern, x - 1, 0) ? 1 : 0.45,
              }"
            />
          </svg>
          {{ control.value }} · {{ control.name }}
        </span>
        <UiExplain v-bind="explain('walk-lines')" />
      </div>
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
          @click="emit('tool', tool === 'walk' ? 'select' : 'walk')"
        >
          {{ tool === "walk" ? "Choosing…" : "Start" }}
        </UiButton>
      </h3>
      <label class="walk-panel__check">
        <input
          type="checkbox"
          :checked="walk.useLiveState.value"
          data-testid="walk-live-state"
          @change="walk.setUseLiveState(($event.target as HTMLInputElement).checked)"
        />
        <span>{{ WALK_STATE_LABEL }}</span>
        <UiExplain v-bind="explain('game-state')" />
      </label>
      <p class="walk-panel__prompt" aria-live="polite">
        {{
          walk.running.value
            ? "Walking…"
            : tool === "walk"
              ? walk.prompt.value
              : "Choose a start and a goal."
        }}
      </p>
      <p
        v-if="walk.estimate.value && !result && !walk.running.value"
        class="walk-panel__note"
        data-testid="walk-estimate"
      >
        {{ walk.estimate.value.path ? "Dashed line: the guess." : "The guess finds no route." }}
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
          {{ walkStateText(result.state) }}
        </p>
        <p v-if="walk.resultStale.value" class="walk-panel__note is-stale">
          The room changed since this walk: Test again to check it.
        </p>
        <dl>
          <dt>Cycles</dt>
          <dd>{{ result.result.cycles }}</dd>
          <dt data-testid="walk-result-place">{{ place?.term }}</dt>
          <dd data-testid="walk-result-end">{{ place?.text }}</dd>
        </dl>
        <details>
          <summary>Engine detail</summary>
          <p>{{ result.result.reason }}</p>
        </details>
        <div class="walk-panel__actions">
          <UiButton size="sm" icon="redo" data-testid="walk-again" @click="walk.again()">
            Test again
          </UiButton>
          <UiButton size="sm" variant="ghost" data-testid="walk-clear" @click="walk.clearWalk()">
            Clear
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
      <h3>Doors</h3>
      <p
        v-for="problem in walk.logicDiagnostics.value"
        :key="`${problem.line}:${problem.code}`"
        class="walk-panel__fail"
        role="alert"
      >
        {{ ruleProblemText(problem) }}
      </p>
      <p v-if="walk.doors.value.length === 0" class="walk-panel__note">No exits yet.</p>
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
            <UiChip
              v-if="!door.editable"
              :tone="door.planned ? 'warn' : 'neutral'"
              data-testid="walk-door-kind"
            >
              {{ door.planned ? "Planned" : "In script" }}
            </UiChip>
          </button>
          <UiExplain
            v-if="!door.editable"
            v-bind="explain(door.planned ? 'door-planned' : 'door-script')"
          />
        </li>
      </ul>

      <div v-if="selected" class="walk-panel__editor" data-testid="door-editor">
        <p class="walk-panel__status">
          <span data-testid="door-way-back">{{ status?.wayBack }}</span>
          <UiChip :tone="status?.testedOk ? 'ok' : 'neutral'" dot data-testid="door-tested">
            {{ status?.tested }}
          </UiChip>
        </p>
        <p v-if="testNote" class="walk-panel__note" data-testid="door-test-note">
          {{ testNote }}
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
            <UiButton size="sm" type="submit" :disabled="!walk.canEditDoors.value" :title="doorsOff"
              >Use</UiButton
            >
          </form>
          <p v-if="walk.flagError.value" class="walk-panel__fail" role="alert">
            {{ walk.flagError.value }}
          </p>
          <template v-if="selected.box">
            <label class="walk-panel__field">
              <span class="walk-panel__with"
                >Follows <UiExplain v-bind="explain('follows')"
              /></span>
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
            <div class="walk-panel__box" role="group" aria-label="Door box">
              <label v-for="[field, name] in BOX_FIELDS" :key="field">
                <span>{{ name }}</span>
                <input
                  class="walk-panel__input walk-panel__num"
                  type="number"
                  min="0"
                  :max="field[0] === 'x' ? 159 : 167"
                  :value="boxInputs[field] ?? selected.box[field]"
                  :data-testid="`door-box-${field}`"
                  :disabled="!walk.canEditDoors.value"
                  @input="typeBox($event, field)"
                  @change="onBox($event, field)"
                />
              </label>
            </div>
            <p v-if="boxError" class="walk-panel__fail" role="alert">{{ boxError }}</p>
          </template>
          <div class="walk-panel__actions">
            <UiButton
              size="sm"
              variant="danger"
              icon="trash"
              data-testid="door-remove"
              :disabled="!walk.canEditDoors.value"
              :title="doorsOff"
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
            {{ walk.labelOf(selected) }} is written in the room's script.
          </p>
          <UiButton
            size="sm"
            icon="pencil"
            data-testid="door-edit-text"
            @click="emit('text', selected.line)"
          >
            View as text
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
.walk-panel__with {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
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
/* The control lines' legend: one row of the four control values. */
.walk-panel__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  color: var(--ink-2);
  font-size: var(--text-2xs);
}
.walk-panel__line {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  white-space: nowrap;
}
.walk-panel__note.is-stale {
  color: var(--warn);
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
  /* A long description wraps onto its own line rather than into a narrow column. */
  flex: 1 1 9em;
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
