<script setup lang="ts">
import UiIconButton from "../ui/UiIconButton.vue";

/** The stage's zoom control, at its lower right: out, the level, in, and fit. */
const { zoom, fitted } = defineProps<{ zoom: number; fitted: boolean }>();
const emit = defineEmits<{ zoom: [step: 1 | -1 | "fit"] }>();
</script>

<template>
  <div class="studio__zoom" role="group" aria-label="Zoom">
    <UiIconButton
      icon="zoom-out"
      label="Zoom out"
      shortcut="-"
      size="sm"
      @click="emit('zoom', -1)"
    />
    <span class="studio__zoom-level">{{ zoom * 100 }}% · 2:1 px</span>
    <UiIconButton icon="zoom-in" label="Zoom in" shortcut="+" size="sm" @click="emit('zoom', 1)" />
    <UiIconButton
      icon="fit"
      label="Zoom to fit"
      shortcut="0"
      size="sm"
      :pressed="fitted"
      @click="emit('zoom', 'fit')"
    />
  </div>
</template>

<style scoped>
.studio__zoom {
  position: absolute;
  right: var(--space-4);
  bottom: var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-0);
  padding: var(--space-0);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
}
.studio__zoom-level {
  padding: 0 var(--space-2);
  white-space: nowrap;
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
</style>
