<script setup lang="ts">
import UiButton from "../ui/UiButton.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import { CONTROL_VALUES, patternOn, type StudioLens, type StudioViewMode } from "./studioView.ts";

/**
 * The stage's view toggles: how the planes show (blend, split, priority
 * only) and the band guides under the Depth and Walk lenses, plus the Walk
 * lens's legend of control lines.
 */
const { lens } = defineProps<{ lens: StudioLens }>();
const mode = defineModel<StudioViewMode>("mode", { required: true });
const bands = defineModel<boolean>("bands", { required: true });

const MODES = [
  { value: "blend", label: "Blend" },
  { value: "split", label: "Split" },
  { value: "priority", label: "Priority only" },
] as const;
</script>

<template>
  <div class="view-bar" role="toolbar" aria-label="View">
    <UiSegmented v-if="lens !== 'art'" v-model="mode" size="sm" label="Planes" :options="MODES" />
    <UiButton
      v-if="lens !== 'art'"
      variant="ghost"
      size="sm"
      class="view-bar__toggle"
      :aria-pressed="bands"
      @click="bands = !bands"
    >
      Bands
    </UiButton>
    <span v-if="lens === 'art'" class="view-bar__note">Art lens · visual plane</span>
  </div>
  <figure v-if="lens === 'walk'" class="view-legend" data-role="control-legend">
    <figcaption>Control lines</figcaption>
    <div v-for="control in CONTROL_VALUES" :key="control.value" class="view-legend__row">
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
    </div>
  </figure>
</template>

<style scoped>
.view-bar {
  position: absolute;
  top: var(--space-4);
  left: 50%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-0);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
  transform: translateX(-50%);
}
.view-bar :deep(.ui-seg) {
  border: 0;
  background: transparent;
}
.view-bar__note {
  padding: var(--space-1) var(--space-3);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.view-bar__toggle[aria-pressed="true"] {
  color: var(--action);
  background: var(--action-soft);
}
.view-legend {
  position: absolute;
  top: var(--space-4);
  left: var(--space-4);
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
  font-size: var(--text-xs);
}
.view-legend figcaption {
  color: var(--ink-3);
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.view-legend__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--ink-2);
}
</style>
