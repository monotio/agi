<script setup lang="ts">
import UiIconButton from "./UiIconButton.vue";

/**
 * A transient notice over the stage: it slides up into place (the motion
 * recipe's toast), never takes focus and never blocks the game. The slot is
 * the message and any inline action; `dismissible` adds the × that emits
 * `dismiss`. `tone` tints the edge: warn for "something changed under you".
 */
const { tone = "neutral", dismissible = false } = defineProps<{
  tone?: "neutral" | "warn";
  dismissible?: boolean;
}>();
defineEmits<{ dismiss: [] }>();
</script>

<template>
  <p class="ui-toast" :class="[`ui-toast--${tone}`]" role="status">
    <span class="ui-toast__body"><slot /></span>
    <UiIconButton
      v-if="dismissible"
      icon="x"
      label="Dismiss"
      size="sm"
      class="ui-toast__dismiss"
      @click="$emit('dismiss')"
    />
  </p>
</template>

<style scoped>
.ui-toast {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: calc(var(--space-9) * 10);
  margin: var(--space-2) 0 0;
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  font: var(--text-sm) / var(--leading) var(--font-sans);
  animation: ui-sheet-in-up var(--duration) var(--ease-out);
}
.ui-toast--warn {
  border-color: var(--warn-line);
}
.ui-toast__body {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  min-width: 0;
}
@media (prefers-reduced-motion: reduce) {
  .ui-toast {
    animation: none;
  }
}
</style>
