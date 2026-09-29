<script setup lang="ts">
/** A compact status or metadata label. `dot` adds a status dot; tone never carries meaning alone. */
const { tone = "neutral", dot = false } = defineProps<{
  tone?: "neutral" | "action" | "ok" | "warn" | "danger";
  dot?: boolean;
}>();
</script>

<template>
  <span class="ui-chip" :class="[`ui-chip--${tone}`]">
    <span v-if="dot" class="ui-chip__dot" aria-hidden="true"></span>
    <slot />
  </span>
</template>

<style scoped>
.ui-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-0) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-pill);
  color: var(--ink-2);
  font: var(--weight-medium) var(--text-xs) / 1.4 var(--font-sans);
  white-space: nowrap;
}
.ui-chip--action {
  color: var(--action);
  border-color: var(--action-line);
}
.ui-chip--ok {
  color: var(--ok);
  border-color: var(--ok-line);
}
.ui-chip--warn {
  color: var(--warn);
  border-color: var(--warn-line);
}
.ui-chip--danger {
  color: var(--danger);
  border-color: var(--danger-line);
}
.ui-chip__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
</style>
