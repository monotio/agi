<script setup lang="ts">
import { computed } from "vue";
import type { PicturePlane } from "../../../src/studio/pictureQuery.ts";
import { EGA_COLOUR_NAMES } from "../../../src/studio/sceneGroups.ts";
import { priorityMeaning } from "./studioView.ts";

/**
 * One plane's value for an item: the 16 AGI colours (visual) or priority
 * values 0–15 (0–3 are control lines), plus "off", which stops the item
 * drawing on that plane. A radio group; `value` undefined means the item
 * draws several values and none is checked.
 */
const {
  plane,
  value,
  label,
  disabled = false,
  allowed = () => true,
} = defineProps<{
  plane: PicturePlane;
  value: number | null | undefined;
  label: string;
  disabled?: boolean;
  /** Values that may be picked now; the rest are disabled. */
  allowed?: (value: number) => boolean;
}>();
const emit = defineEmits<{ pick: [value: number | null] }>();

const options = computed(() =>
  Array.from({ length: 16 }, (_, v) => ({
    value: v,
    name:
      plane === "visual"
        ? `Colour ${v}, ${EGA_COLOUR_NAMES[v]}`
        : `Priority ${v}, ${priorityMeaning(v)}`,
  })),
);

function pick(next: number | null): void {
  if (!disabled && next !== value) emit("pick", next);
}
</script>

<template>
  <div
    class="value-picker"
    :class="`value-picker--${plane}`"
    role="radiogroup"
    :aria-label="label"
    :aria-disabled="disabled || undefined"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      class="value-picker__cell"
      :class="{ 'is-control': plane === 'priority' && option.value < 4 }"
      :aria-checked="value === option.value"
      :aria-label="option.name"
      :title="option.name"
      :disabled="disabled || !allowed(option.value)"
      :data-value="option.value"
      :style="plane === 'visual' ? { background: `var(--agi-${option.value})` } : undefined"
      @click="pick(option.value)"
    >
      <template v-if="plane === 'priority'">{{ option.value }}</template>
    </button>
    <button
      type="button"
      role="radio"
      class="value-picker__cell value-picker__off"
      :aria-checked="value === null"
      :aria-label="`${plane === 'visual' ? 'Colour' : 'Priority'} off: draw nothing on this plane`"
      title="Off: draw nothing on this plane"
      :disabled="disabled"
      data-value="off"
      @click="pick(null)"
    >
      off
    </button>
  </div>
</template>

<style scoped>
.value-picker {
  display: grid;
  grid-template-columns: repeat(9, minmax(0, 1fr));
  gap: var(--space-1);
}
.value-picker__cell {
  min-width: 0;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  background: var(--surface-3);
  font: var(--text-2xs) var(--font-mono);
  cursor: pointer;
}
.value-picker--visual .value-picker__cell {
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
.value-picker__cell.is-control {
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
.value-picker__cell:hover:not(:disabled) {
  color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--action-line);
}
.value-picker__cell[aria-checked="true"] {
  color: var(--action-ink);
  box-shadow:
    0 0 0 2px var(--surface-1),
    0 0 0 3px var(--action);
}
.value-picker--priority .value-picker__cell[aria-checked="true"] {
  background: var(--action);
  font-weight: var(--weight-bold);
}
.value-picker__cell:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}
.value-picker__off {
  grid-column: span 2;
  color: var(--ink-2);
  background: var(--surface-2);
  font-family: var(--font-sans);
}
.value-picker__cell:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
</style>
