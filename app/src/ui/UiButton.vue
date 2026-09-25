<script setup lang="ts">
import UiIcon from "./UiIcon.vue";
import type { IconName } from "./icons.ts";

/**
 * The one button. `primary` is reserved for the single most important action
 * in a region; `secondary` for the rest; `ghost` for toolbar and inline
 * actions; `danger` for destructive ones. Icon-only buttons are UiIconButton.
 */
const {
  variant = "secondary",
  size = "md",
  type = "button",
  icon = undefined,
  trailingIcon = undefined,
  shortcut = undefined,
  block = false,
} = defineProps<{
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  type?: "button" | "submit";
  icon?: IconName | undefined;
  trailingIcon?: IconName | undefined;
  /** Shown as a quiet hint inside the button, e.g. "⌘K". */
  shortcut?: string | undefined;
  block?: boolean;
}>();
</script>

<template>
  <button
    :type
    class="ui-btn"
    :class="[`ui-btn--${variant}`, `ui-btn--${size}`, { 'ui-btn--block': block }]"
  >
    <UiIcon v-if="icon" :name="icon" :size="size === 'sm' ? 16 : 18" />
    <span class="ui-btn__label"><slot /></span>
    <kbd v-if="shortcut" class="ui-btn__kbd">{{ shortcut }}</kbd>
    <UiIcon v-if="trailingIcon" :name="trailingIcon" :size="16" />
  </button>
</template>

<style scoped>
.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  min-height: var(--control-h);
  box-sizing: border-box;
  padding: 0 var(--space-5);
  border: 1px solid transparent;
  border-radius: var(--radius);
  font: var(--weight-semibold) var(--text-md) / var(--leading-tight) var(--font-sans);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.ui-btn--sm {
  min-height: var(--control-h-sm);
  padding: 0 var(--space-4);
  gap: var(--space-2);
  font-size: var(--text-sm);
}
.ui-btn--block {
  width: 100%;
}
@media (pointer: coarse) {
  .ui-btn {
    min-height: var(--control-h-touch);
  }
}

.ui-btn--primary {
  color: var(--action-ink);
  background: var(--action);
}
.ui-btn--primary:hover:not(:disabled) {
  background: var(--action-hover);
}
.ui-btn--secondary {
  color: var(--action);
  border-color: var(--action-line);
  background: transparent;
}
.ui-btn--secondary:hover:not(:disabled) {
  border-color: var(--action);
  background: var(--action-soft);
}
.ui-btn--ghost {
  color: var(--ink-2);
  background: transparent;
}
.ui-btn--ghost:hover:not(:disabled) {
  color: var(--ink);
  background: var(--surface-3);
}
.ui-btn--danger {
  color: var(--danger);
  border-color: var(--danger-line);
  background: transparent;
}
.ui-btn--danger:hover:not(:disabled) {
  color: var(--danger-hover);
  border-color: var(--danger-hover);
  background: var(--danger-soft);
}
/* Disabled reads as unavailable, not as a dimmed primary. */
.ui-btn:disabled {
  cursor: not-allowed;
  color: var(--ink-disabled);
  border-color: var(--hairline);
  background: transparent;
}
.ui-btn__kbd {
  font: var(--text-2xs) var(--font-mono);
  opacity: 0.7;
}
</style>
