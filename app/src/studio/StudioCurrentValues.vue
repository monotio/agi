<script setup lang="ts">
import { computed, ref } from "vue";
import { priorityForY } from "../../../src/runtime/priority.ts";
import { EGA_COLOUR_NAMES } from "../../../src/studio/sceneGroups.ts";
import StudioValuePicker from "./StudioValuePicker.vue";
import { depthValuesLocked, lockedPlanes, PLANE_NAMES, type LensUnlocks } from "./studioLocks.ts";
import { DEFAULT_BAND, type CurrentValues } from "./studioTools.ts";
import { CONTROL_VALUES, patternOn, priorityMeaning, type StudioLens } from "./studioView.ts";

/**
 * The values new content draws with, under the tool rail: a colour swatch
 * and a priority swatch, each opening its picker. A plane the lens locks
 * shows as locked; the Walk lens picks among the four control lines, the
 * Depth lens can follow the band under the cursor.
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
const emit = defineEmits<{ values: [patch: Partial<CurrentValues>] }>();

const open = ref<"visual" | "priority">();
const locked = computed(() => lockedPlanes(lens, unlocks));
const LENS_NAMES: Record<StudioLens, string> = { art: "Art", depth: "Depth", walk: "Walk" };
const lockNote = (plane: "visual" | "priority"): string =>
  `${PLANE_NAMES[plane]} is locked in the ${LENS_NAMES[lens]} lens.`;
/** Walk offers control lines only while depth values are locked there. */
const controlsOnly = computed(() => depthValuesLocked(lens, unlocks));

const band = computed(() => (cursorY === undefined ? DEFAULT_BAND : priorityForY(cursorY)));
const priorityShown = computed(() => (values.priority === "band" ? band.value : values.priority));
const visualText = computed(() =>
  values.visual === null
    ? "Colour off"
    : `Colour ${values.visual}, ${EGA_COLOUR_NAMES[values.visual]}`,
);
const priorityText = computed(() => {
  const value = priorityShown.value;
  if (value === null) return "Priority off";
  const meaning = `Priority ${value}, ${priorityMeaning(value)}`;
  return values.priority === "band" ? `${meaning} (the band under the cursor)` : meaning;
});

function toggle(plane: "visual" | "priority"): void {
  open.value = open.value === plane ? undefined : plane;
}
function pick(patch: Partial<CurrentValues>): void {
  emit("values", patch);
  open.value = undefined;
}
</script>

<template>
  <div class="values" data-testid="studio-current-values" @keydown.esc.stop="open = undefined">
    <button
      type="button"
      class="values__swatch"
      :class="{ 'is-off': values.visual === null, 'is-open': open === 'visual' }"
      :style="values.visual === null ? undefined : { background: `var(--agi-${values.visual})` }"
      :aria-label="`New content: ${visualText}. Change`"
      :aria-expanded="open === 'visual'"
      :title="visualText"
      data-testid="studio-value-visual"
      :data-value="values.visual ?? 'off'"
      @click="toggle('visual')"
    >
      <span v-if="values.visual === null">off</span>
    </button>
    <button
      type="button"
      class="values__swatch values__swatch--priority"
      :class="{ 'is-off': priorityShown === null, 'is-open': open === 'priority' }"
      :aria-label="`New content: ${priorityText}. Change`"
      :aria-expanded="open === 'priority'"
      :title="priorityText"
      data-testid="studio-value-priority"
      :data-value="values.priority ?? 'off'"
      @click="toggle('priority')"
    >
      {{ priorityShown ?? "off" }}<small v-if="values.priority === 'band'">band</small>
    </button>

    <div
      v-if="open"
      class="values__pop"
      role="dialog"
      :aria-label="open === 'visual' ? 'Colour for new content' : 'Priority for new content'"
    >
      <p class="values__title">{{ open === "visual" ? "Colour" : "Priority" }} for new content</p>
      <p v-if="locked.includes(open)" class="values__note">
        {{ lockNote(open) }} New content leaves it off; unlock it in the Scene list to draw on it.
      </p>
      <template v-else-if="open === 'visual'">
        <StudioValuePicker
          plane="visual"
          label="Colour for new content"
          :value="values.visual"
          @pick="pick({ visual: $event })"
        />
      </template>
      <template v-else-if="controlsOnly">
        <div class="values__controls" role="radiogroup" aria-label="Control line for new content">
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
        <p class="values__note">Depth values 4–15 are locked in the Walk lens.</p>
      </template>
      <template v-else>
        <button
          v-if="lens === 'depth'"
          type="button"
          role="radio"
          class="values__control"
          :aria-checked="values.priority === 'band'"
          data-value="band"
          @click="pick({ priority: 'band' })"
        >
          <span>Band under the cursor · now {{ band }}</span>
        </button>
        <StudioValuePicker
          plane="priority"
          label="Priority for new content"
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
  width: 17rem;
  padding: var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-1);
  box-shadow: var(--shadow-pop);
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
