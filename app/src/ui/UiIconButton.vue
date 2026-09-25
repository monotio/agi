<script setup lang="ts">
import UiIcon from "./UiIcon.vue";
import type { IconName } from "./icons.ts";

/** An icon-only button. `label` is required: it is the accessible name and the tooltip. */
const {
  size = "md",
  pressed = undefined,
  shortcut = undefined,
} = defineProps<{
  icon: IconName;
  label: string;
  size?: "sm" | "md";
  /** Set for toggle buttons (tools, visibility); leave undefined for actions. */
  pressed?: boolean | undefined;
  shortcut?: string | undefined;
}>();
</script>

<template>
  <button
    type="button"
    class="ui-icon-btn"
    :class="[`ui-icon-btn--${size}`]"
    :aria-label="label"
    :aria-pressed="pressed"
    :title="shortcut ? `${label} (${shortcut})` : label"
  >
    <UiIcon :name="icon" :size="size === 'sm' ? 16 : 18" />
  </button>
</template>

<style scoped>
.ui-icon-btn {
  display: inline-grid;
  place-items: center;
  width: var(--control-h);
  height: var(--control-h);
  flex: none;
  padding: 0;
  border: 0;
  border-radius: var(--radius);
  color: var(--ink-2);
  background: transparent;
  cursor: pointer;
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.ui-icon-btn--sm {
  width: var(--control-h-sm);
  height: var(--control-h-sm);
}
@media (pointer: coarse) {
  .ui-icon-btn {
    width: var(--control-h-touch);
    height: var(--control-h-touch);
  }
}
.ui-icon-btn:hover:not(:disabled) {
  color: var(--ink);
  background: var(--surface-3);
}
.ui-icon-btn[aria-pressed="true"] {
  color: var(--action);
  background: var(--action-soft);
  box-shadow: inset 0 0 0 1px var(--action-line);
}
.ui-icon-btn:disabled {
  cursor: not-allowed;
  color: var(--ink-disabled);
}
</style>
