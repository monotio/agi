<script setup lang="ts">
import UiIconButton from "../../ui/UiIconButton.vue";
import type { IconName } from "../../ui/icons.ts";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
import type { SpriteTool } from "./useSpriteTools.ts";

/**
 * The tool rail on the canvas's left edge: the drawing tools, the eraser and
 * the recolour, the paint colour, the selection, the pipette and the flip,
 * each with its key.
 */
const { frozen, color } = defineProps<{
  /** Drawing is blocked: the tools that change pixels are disabled. */
  frozen: boolean;
  /** The paint colour. */
  color: number;
}>();
const emit = defineEmits<{ flip: [] }>();
const tool = defineModel<SpriteTool>("tool", { required: true });
interface RailTool {
  readonly id: SpriteTool;
  readonly icon: IconName;
  readonly label: string;
  readonly key: string;
  readonly draws?: boolean;
}
const DRAW: readonly RailTool[] = [
  { id: "pencil", icon: "pencil", label: "Pencil", key: "B", draws: true },
  { id: "eraser", icon: "eraser", label: "Eraser (writes transparency)", key: "E", draws: true },
  { id: "fill", icon: "fill", label: "Fill", key: "G", draws: true },
  { id: "line", icon: "line", label: "Line", key: "L", draws: true },
  { id: "rect", icon: "rect", label: "Rectangle", key: "R", draws: true },
  {
    id: "recolor",
    icon: "palette",
    label: "Recolour: one colour to another in the cel, loop or view",
    key: "C",
    draws: true,
  },
];
const PICK: readonly RailTool[] = [
  { id: "select", icon: "marquee", label: "Select: move, copy, flip or delete", key: "M" },
  { id: "pipette", icon: "pipette", label: "Pick colour", key: "I" },
];
</script>

<template>
  <aside class="sprite-rail" role="toolbar" aria-orientation="vertical" aria-label="Tools">
    <div v-for="entry in DRAW" :key="entry.id" class="sprite-rail__tool">
      <UiIconButton
        :icon="entry.icon"
        :label="entry.label"
        :shortcut="entry.key"
        :pressed="tool === entry.id"
        :disabled="entry.draws && frozen"
        :data-tool="entry.id"
        @click="tool = entry.id"
      />
      <kbd aria-hidden="true">{{ entry.key }}</kbd>
    </div>
    <span
      class="sprite-rail__colour"
      :style="{ background: `var(--agi-${color})` }"
      role="img"
      :aria-label="`Colour ${color}, ${EGA_COLOUR_NAMES[color]}`"
      :title="`Colour ${color}, ${EGA_COLOUR_NAMES[color]}`"
      data-testid="sprite-rail-colour"
    ></span>
    <span class="sprite-rail__sep" aria-hidden="true"></span>
    <div v-for="entry in PICK" :key="entry.id" class="sprite-rail__tool">
      <UiIconButton
        :icon="entry.icon"
        :label="entry.label"
        :shortcut="entry.key"
        :pressed="tool === entry.id"
        :data-tool="entry.id"
        @click="tool = entry.id"
      />
      <kbd aria-hidden="true">{{ entry.key }}</kbd>
    </div>
    <div class="sprite-rail__tool">
      <UiIconButton
        icon="flip"
        label="Flip horizontally (the selection, else the cel)"
        shortcut="H"
        :disabled="frozen"
        data-tool="flip"
        @click="emit('flip')"
      />
      <kbd aria-hidden="true">H</kbd>
    </div>
  </aside>
</template>

<style scoped>
.sprite-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-0);
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  padding: var(--space-2) 0;
  border-right: 1px solid var(--hairline);
  background: var(--surface-1);
}
.sprite-rail__tool {
  position: relative;
}
.sprite-rail__tool kbd {
  position: absolute;
  right: 1px;
  bottom: 0;
  color: var(--ink-3);
  font: var(--text-2xs) / 1 var(--font-mono);
  pointer-events: none;
}
.sprite-rail__colour {
  width: var(--space-6);
  height: var(--space-4);
  margin: var(--space-2) 0;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
}
.sprite-rail__sep {
  width: var(--space-6);
  height: 1px;
  margin: var(--space-1) 0;
  background: var(--hairline);
}
/* A short window (1280×720) keeps every tool in view with the small buttons. */
@media (max-height: 800px) {
  .sprite-rail :deep(.ui-icon-btn) {
    width: var(--control-h-sm);
    height: var(--control-h-sm);
  }
  .sprite-rail__colour {
    margin: var(--space-1) 0;
  }
}
</style>
