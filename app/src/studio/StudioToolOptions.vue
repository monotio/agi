<script setup lang="ts">
import UiExplain from "../ui/UiExplain.vue";
import type { BarNotice } from "./fillAdvice.ts";
import StudioBarNotice from "./StudioBarNotice.vue";
import { ROOM_TOOL_NAMES } from "./studioHelp.ts";
import { explain } from "./studioTerms.ts";
import type { StudioTool } from "./studioTools.ts";

/**
 * The active tool's options, docked in the options bar above the canvas:
 * the tool's name, Filled for rect and polygon, the brush size, and a notice
 * (a fill that would flood nothing: what the spot holds and Why?). How the
 * tool is used by pointer and keys is the status bar's line and the `?`
 * sheet, and where new shapes draw is the context row's (StudioDrawingAt).
 * Short of room (`fold`), the notice's fix moves into its popover, then the
 * notice says itself in a few words (Why? still has it all).
 */
const {
  tool,
  notice = null,
  fold = 0,
} = defineProps<{
  tool: StudioTool;
  notice?: BarNotice | null;
  fold?: number;
}>();
const filled = defineModel<boolean>("filled", { required: true });
const radius = defineModel<number>("radius", { required: true });
const stipple = defineModel<boolean>("stipple", { required: true });
const seed = defineModel<number>("seed", { required: true });
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
    <b class="tool-options__name"
      >{{ ROOM_TOOL_NAMES[tool] }}<UiExplain v-if="tool === 'fill'" v-bind="explain('fill')"
    /></b>
    <label v-if="tool === 'rect' || tool === 'polygon'" class="tool-options__toggle">
      <input v-model="filled" type="checkbox" data-testid="studio-tool-filled" />
      Filled
    </label>
    <template v-if="tool === 'brush'">
      <label class="tool-options__field">
        Size {{ radius }}
        <input v-model.number="radius" type="range" min="0" max="7" aria-label="Brush size" />
      </label>
      <span class="tool-options__with">
        <label class="tool-options__toggle">
          <input v-model="stipple" type="checkbox" />
          Speckled
        </label>
        <UiExplain v-bind="explain('stipple')" />
      </span>
      <label v-if="stipple" class="tool-options__field">
        Pattern
        <input
          type="number"
          min="0"
          max="239"
          :value="seed"
          class="tool-options__number"
          @change="seed = clampSeed(Number(($event.target as HTMLInputElement).value))"
        />
      </label>
    </template>
    <StudioBarNotice v-if="notice" :notice :compact="fold > 1" :terse="fold > 3" />
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
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 5.5rem;
  color: var(--ink);
  font-weight: var(--weight-bold);
}
.tool-options__with {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
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
@media (pointer: coarse) {
  .tool-options__toggle,
  .tool-options__field {
    min-height: var(--control-h-touch);
  }
}
</style>
