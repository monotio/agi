<script setup lang="ts">
import { computed } from "vue";
import UiButton from "../ui/UiButton.vue";
import type { BarNotice } from "./fillAdvice.ts";
import StudioBarNotice from "./StudioBarNotice.vue";
import { ROOM_TOOL_NAMES } from "./studioHelp.ts";
import { insertionShort, insertionText } from "./studioMessages.ts";
import { isDrawingTool, type InsertionPoint, type StudioTool } from "./studioTools.ts";

/**
 * The active tool's options, docked in the options bar above the canvas:
 * the tool's name, Filled for rect and polygon, the brush pen, where in the
 * draw order new content goes (with a way to the end), and a notice (a
 * fill that would flood nothing: what the spot holds, Why?, and the fix).
 * How the tool is used by pointer and keys is the status bar's line and the
 * `?` sheet, never here. Short of room (`fold`), where new shapes go gives
 * way first, then the notice's fix moves into its popover, then → End, then
 * the notice says itself in a few words (Why? still has it all).
 */
const {
  tool,
  insertion,
  commands,
  notice = null,
  fold = 0,
} = defineProps<{
  tool: StudioTool;
  insertion: InsertionPoint;
  /** Drawing commands in the picture. */
  commands: number;
  notice?: BarNotice | null;
  fold?: number;
}>();
const emit = defineEmits<{ end: []; fix: [] }>();
const filled = defineModel<boolean>("filled", { required: true });
const radius = defineModel<number>("radius", { required: true });
const stipple = defineModel<boolean>("stipple", { required: true });
const seed = defineModel<number>("seed", { required: true });
const draws = computed(() => isDrawingTool(tool));
const atEnd = computed(() => insertion.index >= commands);
const clampSeed = (value: number): number => Math.min(239, Math.max(0, Math.round(value) || 0));
</script>

<template>
  <div
    class="tool-options"
    role="group"
    :aria-label="`${ROOM_TOOL_NAMES[tool]} options`"
    data-testid="studio-tool-options"
    :data-tool="tool"
  >
    <b class="tool-options__name">{{ ROOM_TOOL_NAMES[tool] }}</b>
    <label v-if="tool === 'rect' || tool === 'polygon'" class="tool-options__toggle">
      <input v-model="filled" type="checkbox" data-testid="studio-tool-filled" />
      Filled
    </label>
    <template v-if="tool === 'brush'">
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
      <label class="tool-options__toggle">
        <input v-model="stipple" type="checkbox" data-testid="studio-brush-stipple" />
        Stipple
      </label>
      <label v-if="stipple" class="tool-options__field">
        Pattern
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
    </template>
    <span v-if="draws && fold < 1" class="tool-options__sep" aria-hidden="true"></span>
    <span
      v-if="draws && fold < 1"
      class="tool-options__at"
      :title="insertionText(insertion.index, commands)"
      data-testid="studio-insert-at"
      >{{ insertionShort(insertion.index, commands) }}</span
    >
    <UiButton
      v-if="draws && !atEnd && fold < 3"
      variant="ghost"
      class="tool-options__end"
      aria-label="Move playhead to end"
      title="New shapes are drawn at the playhead: move it to the end to draw on top"
      data-testid="studio-playhead-end"
      @click="emit('end')"
    >
      → End
    </UiButton>
    <StudioBarNotice
      v-if="notice"
      :notice
      :compact="fold > 1"
      :terse="fold > 3"
      @act="emit('fix')"
    />
  </div>
</template>

<style scoped>
.tool-options {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  color: var(--ink-2);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.tool-options__name {
  min-width: 5.5rem;
  color: var(--ink);
  font-weight: var(--weight-bold);
}
.tool-options__toggle,
.tool-options__field {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-h);
  padding: 0 var(--space-3);
  border-radius: var(--radius);
  color: var(--ink);
  font-weight: var(--weight-bold);
  cursor: pointer;
}
.tool-options__toggle:hover {
  background: var(--surface-3);
}
.tool-options__toggle:has(input:checked) {
  color: var(--action);
  background: var(--action-soft);
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
.tool-options__sep {
  width: 1px;
  height: var(--space-6);
  background: var(--hairline-strong);
}
.tool-options__at {
  color: var(--ink-3);
  font: var(--text-xs) var(--font-mono);
}
.tool-options__end {
  padding: 0 var(--space-3);
}
@media (pointer: coarse) {
  .tool-options__toggle,
  .tool-options__field {
    min-height: var(--control-h-touch);
  }
}
</style>
