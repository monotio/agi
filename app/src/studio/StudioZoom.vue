<script setup lang="ts">
import UiIconButton from "../ui/UiIconButton.vue";

/** The canvas's zoom, docked in the status bar: out, the level, in, and fit. */
const { zoom, fitted } = defineProps<{ zoom: number; fitted: boolean }>();
const emit = defineEmits<{ zoom: [step: 1 | -1 | "fit"] }>();
</script>

<template>
  <div class="studio-zoom" role="group" aria-label="Zoom">
    <UiIconButton icon="zoom-out" label="Zoom out" shortcut="-" @click="emit('zoom', -1)" />
    <span class="studio-zoom__level" title="Pixels are 2:1, as the game shows them"
      >{{ zoom * 100 }}%</span
    >
    <UiIconButton icon="zoom-in" label="Zoom in" shortcut="+" @click="emit('zoom', 1)" />
    <UiIconButton
      icon="fit"
      label="Zoom to fit"
      shortcut="0"
      :pressed="fitted"
      @click="emit('zoom', 'fit')"
    />
  </div>
</template>

<style scoped>
.studio-zoom {
  display: flex;
  align-items: center;
  flex: none;
}
.studio-zoom__level {
  min-width: 3.5em;
  color: var(--ink-2);
  font: var(--text-2xs) var(--font-mono);
  text-align: center;
}
</style>
