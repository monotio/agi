<script setup lang="ts">
/**
 * An on/off setting: a button with role="switch" whose label is the slot and
 * whose state is a drawn track and thumb, never "On"/"Off" text. The whole
 * row is the hit target; `aria-checked` carries the state for assistive tech
 * and tests. Put a `<small>` in the label for a one-line description.
 */
const { size = "md" } = defineProps<{ size?: "sm" | "md" }>();
const on = defineModel<boolean>({ required: true });
</script>

<template>
  <button
    type="button"
    role="switch"
    class="ui-switch"
    :class="[`ui-switch--${size}`]"
    :aria-checked="on"
    @click="on = !on"
  >
    <span class="ui-switch__label"><slot /></span>
    <span class="ui-switch__track" aria-hidden="true"><span class="ui-switch__thumb"></span></span>
  </button>
</template>

<style scoped>
.ui-switch {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  box-sizing: border-box;
  padding: 0;
  border: 0;
  color: var(--ink);
  background: transparent;
  font: var(--weight-semibold) var(--text-md) / 1.4 var(--font-sans);
  text-align: left;
  cursor: pointer;
}
.ui-switch--sm {
  gap: var(--space-3);
  font-size: var(--text-sm);
}
.ui-switch__label {
  flex: 1;
  min-width: 0;
}
.ui-switch__label :slotted(small) {
  display: block;
  color: var(--ink-3);
  font-size: var(--text-xs);
  font-weight: 400;
}
.ui-switch__track {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  box-sizing: border-box;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-pill);
  background: var(--surface-sunken);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}
.ui-switch--sm .ui-switch__track {
  width: 28px;
  height: 16px;
}
.ui-switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--ink-3);
  transition:
    transform var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}
.ui-switch--sm .ui-switch__thumb {
  width: 10px;
  height: 10px;
}
.ui-switch[aria-checked="true"] .ui-switch__track {
  border-color: var(--action);
  background: var(--action);
}
.ui-switch[aria-checked="true"] .ui-switch__thumb {
  background: var(--action-ink);
  transform: translateX(14px);
}
.ui-switch--sm[aria-checked="true"] .ui-switch__thumb {
  transform: translateX(12px);
}
.ui-switch:hover:not(:disabled) .ui-switch__track {
  border-color: var(--ink-3);
}
.ui-switch[aria-checked="true"]:hover:not(:disabled) .ui-switch__track {
  border-color: var(--action-hover);
  background: var(--action-hover);
}
.ui-switch:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
