<script setup lang="ts">
import UiSegmented from "../ui/UiSegmented.vue";

/**
 * The canvas's before/after switch while an AI proposal awaits a verdict:
 * the canvas (and every preview drawn from it) shows the draft as it is or
 * with the proposal applied; the changed cells stay outlined either way.
 */
const { stale = false, belowBar = false } = defineProps<{
  stale?: boolean;
  /** The frame has a view bar at its top: sit under it. */
  belowBar?: boolean;
}>();
const mode = defineModel<"before" | "after">({ required: true });
const OPTIONS = [
  { value: "before", label: "Before" },
  { value: "after", label: "After" },
] as const;
</script>

<template>
  <div
    class="compare"
    :class="{ 'compare--below-bar': belowBar }"
    role="group"
    aria-label="AI proposal"
    data-testid="assist-compare"
  >
    <span class="compare__label">{{ stale ? "Stale proposal" : "AI proposal" }}</span>
    <UiSegmented v-model="mode" size="sm" label="Show the canvas" :options="OPTIONS" />
    <span class="compare__key"><i aria-hidden="true"></i>changed</span>
  </div>
</template>

<style scoped>
.compare {
  position: absolute;
  top: var(--space-3);
  left: 50%;
  z-index: var(--z-popover);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  transform: translateX(-50%);
  white-space: nowrap;
}
.compare--below-bar {
  top: calc(var(--control-h) + var(--space-5));
}
.compare__label {
  color: var(--ink-2);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
}
.compare__key {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.compare__key i {
  width: 10px;
  height: 10px;
  border: 2px dashed var(--ok);
}
</style>
