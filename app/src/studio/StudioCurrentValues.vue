<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";
import { priorityForY } from "../../../src/runtime/priority.ts";
import { EGA_COLOUR_NAMES } from "../../../src/studio/sceneGroups.ts";
import UiButton from "../ui/UiButton.vue";
import UiExplain from "../ui/UiExplain.vue";
import StudioValuePicker from "./StudioValuePicker.vue";
import { depthValuesLocked, lockedPlanes, PLANE_NAMES, type LensUnlocks } from "./studioLocks.ts";
import { explain } from "./studioTerms.ts";
import { DEFAULT_BAND, type CurrentValues } from "./studioTools.ts";
import { CONTROL_VALUES, patternOn, priorityMeaning, type StudioLens } from "./studioView.ts";

/**
 * The values new shapes draw with, under the tool rail: an Art swatch and a
 * Depth swatch, each named under it and opening its picker. A plane the lens
 * locks says so, with Unlock for now; the Walk lens picks among the four walk
 * lines, the Depth lens can match the band under the cursor. The picker opens to the
 * rail's left, over the Scene list and away from the picture, when that
 * column has room for it (focus mode hides it: then it opens to the right).
 */
const {
  lens,
  unlocks,
  values,
  cursorY = undefined,
} = defineProps<{
  lens: StudioLens;
  unlocks: LensUnlocks;
  values: CurrentValues;
  cursorY?: number | undefined;
}>();
const emit = defineEmits<{
  values: [patch: Partial<CurrentValues>];
  unlocks: [next: LensUnlocks];
}>();

const open = ref<"visual" | "priority">();
const locked = computed(() => lockedPlanes(lens, unlocks));
const lockNote = (plane: "visual" | "priority"): string =>
  `${PLANE_NAMES[plane]} is locked. New shapes leave it as it is.`;
function unlock(plane: "visual" | "priority"): void {
  emit("unlocks", { ...unlocks, [plane]: true });
  open.value = undefined;
}
/** Walk offers walk lines only while depth values are locked there. */
const controlsOnly = computed(() => depthValuesLocked(lens, unlocks));

const band = computed(() => (cursorY === undefined ? DEFAULT_BAND : priorityForY(cursorY)));
const priorityShown = computed(() => (values.priority === "band" ? band.value : values.priority));
const visualText = computed(() =>
  values.visual === null ? "Art off" : `Art ${values.visual}, ${EGA_COLOUR_NAMES[values.visual]}`,
);
const priorityText = computed(() => {
  const value = priorityShown.value;
  if (value === null) return "Depth off";
  const meaning = `Depth ${value}, ${priorityMeaning(value)}`;
  return values.priority === "band" ? `${meaning} (the band under the cursor)` : meaning;
});

/** The picker's narrowest and widest, in CSS pixels (17rem). */
const POP_MIN = 180;
const POP_MAX = 272;
/** The gap between the picker and the rail, and the picker and the window's edge. */
const POP_GAP = 12;
const root = useTemplateRef("root");
/** Where the picker opens: over the Scene list when it fits there, with its width. */
const side = ref<{ left: boolean; width: number }>({ left: false, width: POP_MAX });
function toggle(plane: "visual" | "priority"): void {
  open.value = open.value === plane ? undefined : plane;
  const room = (root.value?.getBoundingClientRect().left ?? 0) - 2 * POP_GAP;
  side.value =
    room >= POP_MIN
      ? { left: true, width: Math.min(POP_MAX, room) }
      : { left: false, width: POP_MAX };
}
function pick(patch: Partial<CurrentValues>): void {
  emit("values", patch);
  open.value = undefined;
}
</script>

<template>
  <div
    ref="root"
    class="values"
    data-testid="studio-current-values"
    @keydown.esc.stop="open = undefined"
  >
    <button
      type="button"
      class="values__swatch"
      :class="{ 'is-off': values.visual === null, 'is-open': open === 'visual' }"
      :style="values.visual === null ? undefined : { background: `var(--agi-${values.visual})` }"
      :aria-label="`New shapes: ${visualText}. Change`"
      :aria-expanded="open === 'visual'"
      :title="visualText"
      data-testid="studio-value-visual"
      :data-value="values.visual ?? 'off'"
      @click="toggle('visual')"
    >
      <span v-if="values.visual === null">off</span>
    </button>
    <span class="values__name" aria-hidden="true">Art</span>
    <button
      type="button"
      class="values__swatch values__swatch--priority"
      :class="{ 'is-off': priorityShown === null, 'is-open': open === 'priority' }"
      :aria-label="`New shapes: ${priorityText}. Change`"
      :aria-expanded="open === 'priority'"
      :title="priorityText"
      data-testid="studio-value-priority"
      :data-value="values.priority ?? 'off'"
      @click="toggle('priority')"
    >
      {{ priorityShown ?? "off" }}<small v-if="values.priority === 'band'">here</small>
    </button>
    <span class="values__name" aria-hidden="true">Depth</span>

    <div
      v-if="open"
      class="values__pop"
      :class="{ 'is-left': side.left }"
      :style="{ width: `${side.width}px` }"
      role="dialog"
      :aria-label="open === 'visual' ? 'Art for new shapes' : 'Depth for new shapes'"
    >
      <p class="values__title">{{ open === "visual" ? "Art" : "Depth" }} for new shapes</p>
      <template v-if="locked.includes(open)">
        <p class="values__note">{{ lockNote(open) }}</p>
        <UiButton size="sm" @click="unlock(open)">Unlock for now</UiButton>
      </template>
      <template v-else-if="open === 'visual'">
        <StudioValuePicker
          plane="visual"
          label="Art for new shapes"
          :value="values.visual"
          @pick="pick({ visual: $event })"
        />
      </template>
      <template v-else-if="controlsOnly">
        <div class="values__controls" role="radiogroup" aria-label="Walk line for new shapes">
          <button
            v-for="control in CONTROL_VALUES"
            :key="control.value"
            type="button"
            role="radio"
            class="values__control"
            :aria-checked="values.priority === control.value"
            :data-value="control.value"
            @click="pick({ priority: control.value })"
          >
            <svg viewBox="0 0 8 2" width="32" height="8" aria-hidden="true">
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
            <span>{{ control.value }} · {{ control.name }}</span>
          </button>
        </div>
        <p class="values__note values__with">
          Walk lines 0–3 only <UiExplain v-bind="explain('walk-lines')" />
        </p>
      </template>
      <template v-else>
        <span v-if="lens === 'depth'" class="values__with">
          <button
            type="button"
            role="radio"
            class="values__control"
            :aria-checked="values.priority === 'band'"
            data-value="band"
            @click="pick({ priority: 'band' })"
          >
            <span>Match the band here · {{ band }}</span>
          </button>
          <UiExplain v-bind="explain('bands')" />
        </span>
        <StudioValuePicker
          plane="priority"
          label="Depth for new shapes"
          :value="values.priority === 'band' ? undefined : values.priority"
          @pick="pick({ priority: $event })"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.values {
  position: relative;
  display: grid;
  gap: var(--space-1);
  justify-items: center;
}
.values__swatch {
  display: grid;
  place-items: center;
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--surface-3);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
  font: var(--weight-semibold) var(--text-2xs) / 1 var(--font-mono);
  cursor: pointer;
}
.values__name {
  margin-bottom: var(--space-1);
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
/* A very short window keeps the rail's room for its tools: the swatches name themselves on hover. */
@media (max-height: 540px) {
  .values__name {
    display: none;
  }
}
.values__with {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.values__swatch small {
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  color: var(--ink-3);
}
.values__swatch.is-off {
  color: var(--ink-3);
  background: var(--surface-2);
}
.values__swatch.is-open,
.values__swatch:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.values__pop {
  position: absolute;
  bottom: 0;
  left: calc(100% + var(--space-3));
  z-index: var(--z-popover);
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-1);
  box-shadow: var(--shadow-pop);
}
.values__pop.is-left {
  right: calc(100% + var(--space-3));
  left: auto;
}
.values__title {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.values__note {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.values__controls {
  display: grid;
  gap: var(--space-1);
}
.values__control {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  background: transparent;
  font: inherit;
  font-size: var(--text-xs);
  text-align: left;
  cursor: pointer;
}
.values__control:hover {
  background: var(--surface-3);
}
.values__control[aria-checked="true"] {
  color: var(--action);
  background: var(--action-soft);
}
</style>
