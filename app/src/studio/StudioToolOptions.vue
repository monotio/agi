<script setup lang="ts">
import { computed } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiKbd from "../ui/UiKbd.vue";
import type { FillExplanation } from "../../../src/studio/pictureQuery.ts";
import { isDrawingTool, type InsertionPoint, type StudioTool } from "./studioTools.ts";

/**
 * The active tool's options and help, at the stage's lower left: how the
 * tool is used, Filled for rect and polygon, the brush pen, where in the
 * draw order new content goes (with a way to the end), and, for a fill that
 * would flood nothing, the AGI rule that says why.
 */
const {
  tool,
  insertion,
  commands,
  fillWhy = null,
  points = 0,
} = defineProps<{
  tool: StudioTool;
  insertion: InsertionPoint;
  /** Drawing commands in the picture. */
  commands: number;
  fillWhy?: FillExplanation | null;
  /** Points of the line or polygon being clicked out. */
  points?: number;
}>();
const emit = defineEmits<{ end: [] }>();
const filled = defineModel<boolean>("filled", { required: true });
const radius = defineModel<number>("radius", { required: true });
const stipple = defineModel<boolean>("stipple", { required: true });
const seed = defineModel<number>("seed", { required: true });
const HELP: Record<StudioTool, string> = {
  select: "",
  point: "Drag a point's handle; the item itself stays put.",
  line: "Click points; Enter or double-click finishes.",
  rect: "Drag a rectangle; Shift keeps it square.",
  polygon: "Click points; click the first point or press Enter to close.",
  fill: "Click a seed: a colour fill floods white (15), a priority fill floods priority 4.",
  brush: "Drag to place plot points, one per pixel.",
  pipette: "Click to pick the colour and priority under the cursor.",
  hand: "Drag to pan. Space pans with any tool.",
};
const draws = computed(() => isDrawingTool(tool));
const atEnd = computed(() => insertion.index >= commands);
const whyText = computed(() => {
  const why = fillWhy;
  if (!why) return "";
  const rule =
    why.plane === "visual"
      ? "a colour fill floods only white (15) cells, 4-connected"
      : "a priority fill (colour off) floods only priority 4 cells, 4-connected";
  const plane = why.plane === "visual" ? "colour" : "priority";
  const owner = why.line === null ? "" : ` (drawn by line ${why.line})`;
  return `Nothing to fill: at this point in the draw order ${why.x},${why.y} holds ${plane} ${why.value}${owner}, and ${rule}.`;
});
const clampSeed = (value: number): number => Math.min(239, Math.max(0, Math.round(value) || 0));
</script>

<template>
  <div class="tool-options" data-testid="studio-tool-options" :data-tool="tool">
    <p class="tool-options__help">
      {{ HELP[tool] }}
      <template v-if="(tool === 'line' || tool === 'polygon') && points > 0">
        <UiKbd>Backspace</UiKbd> removes a point, <UiKbd>Esc</UiKbd> cancels.
      </template>
    </p>
    <div v-if="tool === 'rect' || tool === 'polygon'" class="tool-options__row">
      <label class="tool-options__check">
        <input v-model="filled" type="checkbox" data-testid="studio-tool-filled" />
        Filled
      </label>
    </div>
    <div v-if="tool === 'brush'" class="tool-options__row">
      <label class="tool-options__field">
        Pen {{ radius }}
        <input
          v-model.number="radius"
          type="range"
          min="0"
          max="7"
          aria-label="Pen radius"
          data-testid="studio-brush-radius"
        />
      </label>
      <label class="tool-options__check">
        <input v-model="stipple" type="checkbox" data-testid="studio-brush-stipple" />
        Stipple
      </label>
      <label v-if="stipple" class="tool-options__field">
        Seed
        <input
          type="number"
          min="0"
          max="239"
          :value="seed"
          class="tool-options__number"
          data-testid="studio-brush-seed"
          @change="seed = clampSeed(Number(($event.target as HTMLInputElement).value))"
        />
      </label>
    </div>
    <p v-if="draws" class="tool-options__at" data-testid="studio-insert-at">
      <span v-if="atEnd">Inserting at the end, #{{ insertion.index + 1 }}</span>
      <span v-else>Inserting at #{{ insertion.index + 1 }} of {{ commands + 1 }}</span>
      <UiButton
        v-if="!atEnd"
        size="sm"
        variant="ghost"
        data-testid="studio-playhead-end"
        @click="emit('end')"
      >
        Move playhead to end
      </UiButton>
    </p>
    <p v-if="whyText" class="tool-options__why" role="status" data-testid="studio-fill-why">
      {{ whyText }}
    </p>
  </div>
</template>

<style scoped>
.tool-options {
  position: absolute;
  bottom: var(--space-4);
  left: var(--space-4);
  display: grid;
  gap: var(--space-2);
  max-width: min(30rem, calc(100% - 20rem));
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  color: var(--ink-2);
  background: var(--surface-overlay);
  font-size: var(--text-xs);
}
.tool-options p {
  margin: 0;
}
.tool-options__help {
  color: var(--ink-2);
}
.tool-options__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
}
.tool-options__check,
.tool-options__field {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink);
}
.tool-options__number {
  width: 4.5rem;
  padding: var(--space-0) var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--surface-2);
  font: inherit;
}
.tool-options__at {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-3);
  font-family: var(--font-mono);
}
.tool-options__why {
  padding: var(--space-2);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius-sm);
  color: var(--warn);
  background: var(--warn-soft);
}
</style>
