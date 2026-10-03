<script setup lang="ts">
import UiSegmented from "../ui/UiSegmented.vue";

/**
 * The canvas's before/after switch while an AI proposal awaits a verdict,
 * docked in the options bar above the canvas: the canvas (and every
 * preview drawn from it) shows the draft as it is or with the proposal
 * applied; the changed cells stay outlined either way, and those of other
 * items it changes (its side effects) in their own colour.
 */
const { stale = false, spilled = false } = defineProps<{
  stale?: boolean;
  /** The proposal changes other items too: their key shows. */
  spilled?: boolean;
}>();
const mode = defineModel<"before" | "after">({ required: true });
const OPTIONS = [
  { value: "before", label: "Before" },
  { value: "after", label: "After" },
] as const;
</script>

<template>
  <div class="compare" role="group" aria-label="AI change" data-testid="assist-compare">
    <span class="compare__label">{{ stale ? "Stale change" : "AI change" }}</span>
    <UiSegmented v-model="mode" size="sm" label="Show the canvas" :options="OPTIONS" />
    <span class="compare__key"><i aria-hidden="true"></i>changed</span>
    <span v-if="spilled" class="compare__key is-spilled" data-testid="assist-compare-spilled"
      ><i aria-hidden="true"></i>other items</span
    >
  </div>
</template>

<style scoped>
.compare {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-3);
  white-space: nowrap;
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
.compare__key.is-spilled i {
  border-color: var(--warn);
}
</style>
