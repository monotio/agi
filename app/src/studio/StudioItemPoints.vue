<script setup lang="ts">
import { computed, ref } from "vue";
import UiButton from "../ui/UiButton.vue";
import type { LineHandle } from "../../../src/studio/editPoints.ts";
import { MAX_X, MAX_Y } from "../../../src/studio/editSource.ts";
import type { StudioEditing } from "./useStudioEditing.ts";

/**
 * The selected item's points as numbers, under the inspector's Details: one
 * row per point (its line and place in it), x and y fields that move it as
 * one kernel edit, the first few rows until Show all. The arrow keys nudge
 * the whole item on the canvas; these place one point exactly.
 */
const {
  handles,
  edit,
  locked = false,
} = defineProps<{
  handles: readonly LineHandle[];
  edit: StudioEditing;
  /** The item is locked: its points read only. */
  locked?: boolean;
}>();

/** Point rows shown before "Show all". */
const FEW = 6;
const showAll = ref(false);
const shown = computed(() => (showAll.value ? handles : handles.slice(0, FEW)));

function commitPoint(event: Event, handle: LineHandle, axis: "x" | "y"): void {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  const x = axis === "x" ? value : handle.x;
  const y = axis === "y" ? value : handle.y;
  if (!Number.isInteger(value) || !edit.setPoint(handle.line, handle.index, x, y))
    input.value = String(handle[axis]);
}
</script>

<template>
  <section v-if="handles.length > 0" class="points" data-role="points">
    <h3>Points</h3>
    <div class="points__grid">
      <template v-for="handle in shown" :key="`${handle.line}:${handle.index}`">
        <span class="points__pt" :title="`Source line ${handle.line}`"
          >{{ handle.kind === "seed" ? "seed" : "line" }} {{ handle.line }} ·
          {{ handle.index + 1 }}</span
        >
        <input
          class="points__num"
          type="number"
          min="0"
          :max="MAX_X"
          :value="handle.x"
          :aria-label="`Point ${handle.index} of line ${handle.line}, x`"
          :disabled="locked"
          @change="commitPoint($event, handle, 'x')"
        />
        <input
          class="points__num"
          type="number"
          min="0"
          :max="MAX_Y"
          :value="handle.y"
          :aria-label="`Point ${handle.index} of line ${handle.line}, y`"
          :disabled="locked"
          @change="commitPoint($event, handle, 'y')"
        />
      </template>
    </div>
    <UiButton
      v-if="handles.length > FEW"
      variant="ghost"
      size="sm"
      class="points__more"
      @click="showAll = !showAll"
    >
      {{ showAll ? "Show fewer" : `Show all ${handles.length}` }}
    </UiButton>
  </section>
</template>

<style scoped>
.points {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.points h3 {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.points__grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: var(--space-1) var(--space-2);
}
.points__pt {
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
  white-space: nowrap;
}
.points__num {
  box-sizing: border-box;
  width: 100%;
  min-height: 28px;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-xs) / var(--leading) var(--font-mono);
}
.points__num:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -1px;
}
.points__more {
  justify-self: start;
}
</style>
