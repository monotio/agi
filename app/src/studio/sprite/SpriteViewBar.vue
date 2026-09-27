<script setup lang="ts">
import { computed } from "vue";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
import { backdropKey, parseBackdrop, type SpriteBackdrop } from "./spriteView.ts";

/**
 * The canvas's view toggles, docked at the right of the options bar: the
 * contact sheet of every cel in place of the canvas, onion skins of the
 * previous and next cels (and how many of each, 1 to 3), the grid, the
 * baseline, and the backdrop behind transparent pixels. None of them
 * changes the view: the backdrop is only while drawing, never the view's
 * transparent colour.
 */
const { roomBackdrop = null } = defineProps<{
  /** The room a Room backdrop shows, when a room uses the view. */
  roomBackdrop?: number | null;
}>();
const sheet = defineModel<boolean>("sheet", { required: true });
const prev = defineModel<boolean>("prev", { required: true });
const next = defineModel<boolean>("next", { required: true });
const depth = defineModel<number>("depth", { required: true });
const grid = defineModel<boolean>("grid", { required: true });
const baseline = defineModel<boolean>("baseline", { required: true });
const backdrop = defineModel<SpriteBackdrop>("backdrop", { required: true });
const backdropValue = computed({
  get: () => backdropKey(backdrop.value),
  set: (value: string) => (backdrop.value = parseBackdrop(value)),
});
</script>

<template>
  <div class="sprite-view-bar" role="group" aria-label="Canvas view">
    <label
      class="sprite-view-bar__backdrop"
      title="Only while drawing: the view's transparent colour stays as it is"
    >
      <span>Backdrop</span>
      <select v-model="backdropValue" data-testid="sprite-backdrop">
        <option value="checker-dark">Dark checker</option>
        <option value="checker-light">Light checker</option>
        <option v-if="roomBackdrop !== null" value="room">Room {{ roomBackdrop }}</option>
        <optgroup label="Solid colour">
          <option
            v-for="(name, colour) in EGA_COLOUR_NAMES"
            :key="colour"
            :value="`colour-${colour}`"
          >
            {{ colour }} · {{ name }}
          </option>
        </optgroup>
      </select>
    </label>
    <button
      type="button"
      class="sprite-view-bar__toggle"
      :aria-pressed="sheet"
      data-testid="sprite-sheet-toggle"
      @click="sheet = !sheet"
    >
      Contact sheet
    </button>
    <template v-if="!sheet">
      <button
        type="button"
        class="sprite-view-bar__toggle"
        :aria-pressed="prev"
        data-testid="sprite-onion-prev"
        @click="prev = !prev"
      >
        <i class="sprite-view-bar__tint is-prev" aria-hidden="true"></i>Onion −{{ depth }}
      </button>
      <button
        type="button"
        class="sprite-view-bar__toggle"
        :aria-pressed="next"
        data-testid="sprite-onion-next"
        @click="next = !next"
      >
        <i class="sprite-view-bar__tint is-next" aria-hidden="true"></i>+{{ depth }}
      </button>
      <label class="sprite-view-bar__depth">
        <span class="sprite-view-bar__sr">Onion skin cels</span>
        <select v-model.number="depth" data-testid="sprite-onion-depth">
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="3">3</option>
        </select>
      </label>
      <button
        type="button"
        class="sprite-view-bar__toggle"
        :aria-pressed="grid"
        data-testid="sprite-grid"
        @click="grid = !grid"
      >
        Grid
      </button>
      <button
        type="button"
        class="sprite-view-bar__toggle"
        :aria-pressed="baseline"
        data-testid="sprite-baseline-toggle"
        @click="baseline = !baseline"
      >
        Baseline
      </button>
    </template>
  </div>
</template>

<style scoped>
.sprite-view-bar {
  display: flex;
  align-items: center;
  gap: var(--space-0);
}
.sprite-view-bar__toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--control-h);
  padding: 0 var(--space-3);
  border: 0;
  border-radius: var(--radius);
  color: var(--ink-2);
  background: transparent;
  font: var(--weight-bold) var(--text-sm) / 1 var(--font-sans);
  cursor: pointer;
}
.sprite-view-bar__toggle:hover {
  color: var(--ink);
}
.sprite-view-bar__toggle[aria-pressed="true"] {
  color: var(--ink);
  background: var(--surface-3);
}
.sprite-view-bar__toggle:focus-visible,
.sprite-view-bar__depth select:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.sprite-view-bar__tint {
  width: var(--space-5);
  height: var(--space-2);
  border-radius: var(--radius-pill);
}
.sprite-view-bar__tint.is-prev {
  background: var(--agi-12);
}
.sprite-view-bar__tint.is-next {
  background: var(--agi-11);
}
.sprite-view-bar__backdrop {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-right: var(--space-2);
  color: var(--ink-2);
  font: var(--weight-bold) var(--text-sm) / 1 var(--font-sans);
}
.sprite-view-bar__backdrop select {
  max-width: 9.5rem;
  height: var(--control-h);
  padding: 0 var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-2);
  font: var(--text-sm) var(--font-sans);
}
.sprite-view-bar__backdrop select:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.sprite-view-bar__depth select {
  height: var(--control-h);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink-2);
  background: var(--surface-2);
  font: var(--text-xs) var(--font-mono);
}
.sprite-view-bar__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (pointer: coarse) {
  .sprite-view-bar__toggle,
  .sprite-view-bar__backdrop select,
  .sprite-view-bar__depth select {
    height: var(--control-h-touch);
  }
}
</style>
