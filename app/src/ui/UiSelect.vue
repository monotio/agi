<script setup lang="ts" generic="T extends string | number">
import UiIcon from "./UiIcon.vue";

/**
 * A single-choice picker: the platform's own <select>, so keyboard, screen
 * readers and the phone's wheel all work, drawn in the design system's
 * control shape with one chevron. Options (and optgroups) are the slot;
 * attributes such as id, aria-label, data-testid and disabled land on the
 * <select> itself, so labels and tests address the real control.
 */
const { size = "md", block = false } = defineProps<{
  size?: "sm" | "md";
  block?: boolean;
}>();
const model = defineModel<T>({ required: true });
defineOptions({ inheritAttrs: false });
</script>

<template>
  <span class="ui-select" :class="[`ui-select--${size}`, { 'ui-select--block': block }]">
    <select v-model="model" class="ui-select__control" v-bind="$attrs">
      <slot />
    </select>
    <UiIcon class="ui-select__chevron" name="chevron-down" :size="16" />
  </span>
</template>

<style scoped>
.ui-select {
  position: relative;
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
}
.ui-select--block {
  display: flex;
  width: 100%;
}
.ui-select__control {
  width: 100%;
  min-width: 0;
  min-height: var(--control-h);
  box-sizing: border-box;
  padding: 0 calc(var(--space-4) + 20px) 0 var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-md) / var(--leading) var(--font-sans);
  text-overflow: ellipsis;
  cursor: pointer;
  appearance: none;
  transition: border-color var(--duration-fast) var(--ease-out);
}
.ui-select--sm .ui-select__control {
  min-height: var(--control-h-sm);
  padding-left: var(--space-3);
  font-size: var(--text-sm);
}
@media (pointer: coarse) {
  .ui-select__control {
    min-height: var(--control-h-touch);
  }
}
.ui-select__control:hover:not(:disabled) {
  border-color: var(--ink-3);
}
.ui-select__control:disabled {
  color: var(--ink-disabled);
  cursor: not-allowed;
}
/* The popup list is the platform's; give it the app's surface where it can. */
.ui-select__control :deep(:is(option, optgroup)) {
  color: var(--ink);
  background: var(--surface-2);
}
.ui-select__chevron {
  position: absolute;
  top: 50%;
  right: var(--space-3);
  color: var(--ink-3);
  transform: translateY(-50%);
  pointer-events: none;
}
.ui-select__control:disabled + .ui-select__chevron {
  color: var(--ink-disabled);
}
</style>
