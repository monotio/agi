<script setup lang="ts">
import UiButton from "../ui/UiButton.vue";
import UiExplain from "../ui/UiExplain.vue";
import { explain } from "./studioTerms.ts";
import type { DrawingPosition } from "./useStudioReadout.ts";

/**
 * Where new shapes draw while they draw earlier than the end, for every
 * tool: "Drawing before Cottage · Back to the end". It rides the frame's
 * context row, above the canvas; at the end it shows nothing.
 */
const { at } = defineProps<{ at: DrawingPosition }>();
const emit = defineEmits<{ end: [] }>();
</script>

<template>
  <span v-if="!at.atEnd" class="drawing-at" data-testid="studio-drawing-at">
    <span class="drawing-at__text" :title="at.text" data-testid="studio-insert-at">{{
      at.text
    }}</span>
    <UiExplain v-bind="explain('insert-at')" />
    <span class="drawing-at__dot" aria-hidden="true">·</span>
    <UiButton
      variant="ghost"
      size="sm"
      class="drawing-at__end"
      data-testid="studio-playhead-end"
      @click="emit('end')"
      >Back to the end</UiButton
    >
  </span>
</template>

<style scoped>
.drawing-at {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  margin-left: auto;
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.drawing-at__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drawing-at__dot {
  color: var(--ink-3);
}
.drawing-at__end {
  color: var(--action);
}
</style>
