<script setup lang="ts">
import UiButton from "../ui/UiButton.vue";

/**
 * An open line or polygon, off the picture: "Line · 3 points" with Undo point
 * and Done. It rides the frame's context row above the canvas and takes the
 * whole row while the path is open, at the row's own height, so the canvas
 * stays where it was aimed at. Enter, a double-click and (for a polygon) the
 * first point finish it too; Esc cancels. The buttons leave the keyboard's
 * focus on the canvas.
 */
const { name, points } = defineProps<{ name: string; points: number }>();
const emit = defineEmits<{ undo: []; done: [] }>();
</script>

<template>
  <span class="studio-path" role="group" :aria-label="name" data-testid="studio-path">
    <span class="studio-path__text" aria-live="polite"
      >{{ name }} · {{ points }} {{ points === 1 ? "point" : "points" }}</span
    >
    <UiButton variant="ghost" size="sm" @mousedown.prevent @click="emit('undo')"
      >Undo point</UiButton
    >
    <UiButton variant="primary" size="sm" @mousedown.prevent @click="emit('done')">Done</UiButton>
  </span>
</template>

<style scoped>
.studio-path {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  color: var(--ink);
  font-size: var(--text-xs);
}
.studio-path__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
