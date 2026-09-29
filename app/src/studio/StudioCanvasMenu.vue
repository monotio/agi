<script setup lang="ts">
import { nextTick, useTemplateRef, watch } from "vue";
import type { Point } from "../../../src/studio/shapes.ts";

/**
 * The canvas's context menu (right-click, the Menu key or Shift+F10 at the
 * keyboard cursor): Play here from that spot, and in the Walk view a test
 * walk from or to it. Arrow keys move between items, Enter picks one, Esc
 * closes it; focus goes back to the canvas.
 */
export interface CanvasMenuItem {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  /** Why it is disabled, as its tooltip. */
  readonly title?: string;
}
const { at, cell, items } = defineProps<{
  /** Where it opens, in viewport pixels. */
  at: { x: number; y: number };
  cell: Point;
  items: readonly CanvasMenuItem[];
}>();
const emit = defineEmits<{ pick: [id: string]; close: [] }>();
const menu = useTemplateRef("menu");

function buttons(): HTMLButtonElement[] {
  return [...(menu.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
}
watch(
  () => at,
  async () => {
    await nextTick();
    buttons()[0]?.focus();
  },
  { immediate: true },
);
function onKeydown(event: KeyboardEvent): void {
  const list = buttons();
  const index = list.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "Escape") emit("close");
  else if (event.key === "ArrowDown") list[(index + 1) % list.length]?.focus();
  else if (event.key === "ArrowUp") list[(index - 1 + list.length) % list.length]?.focus();
  else if (event.key === "Tab") emit("close");
  else return;
  event.preventDefault();
  event.stopPropagation();
}
</script>

<template>
  <div
    ref="menu"
    class="canvas-menu"
    role="menu"
    :aria-label="`At ${cell.x},${cell.y}`"
    data-testid="canvas-menu"
    :style="{ left: `${at.x}px`, top: `${at.y}px` }"
    @keydown="onKeydown"
    @focusout="(event) => !menu?.contains(event.relatedTarget as Node) && emit('close')"
  >
    <p class="canvas-menu__head" aria-hidden="true">{{ cell.x }},{{ cell.y }}</p>
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      role="menuitem"
      class="canvas-menu__item"
      :disabled="item.disabled"
      :title="item.title"
      :data-item="item.id"
      @click="emit('pick', item.id)"
    >
      {{ item.label }}
    </button>
  </div>
</template>

<style scoped>
.canvas-menu {
  position: fixed;
  z-index: var(--z-popover);
  display: grid;
  min-width: calc(var(--space-9) * 4);
  padding: var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
}
.canvas-menu__head {
  margin: 0;
  padding: var(--space-1) var(--space-3);
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.canvas-menu__item {
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: none;
  font: var(--text-sm) / var(--leading) var(--font-sans);
  text-align: left;
  cursor: pointer;
}
.canvas-menu__item:hover,
.canvas-menu__item:focus-visible {
  outline: 0;
  background: var(--action-soft);
}
.canvas-menu__item:disabled {
  color: var(--ink-disabled);
  cursor: default;
}
</style>
