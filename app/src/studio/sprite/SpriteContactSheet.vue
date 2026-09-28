<script setup lang="ts">
import { computed, nextTick, onMounted, useTemplateRef } from "vue";
import UiIcon from "../../ui/UiIcon.vue";
import type { SpriteDocument } from "../../../../src/view/spriteDocument.ts";
import SpriteThumb from "../../world/SpriteThumb.vue";
import { aliasGroup, loopFacing } from "./spriteView.ts";

/**
 * The contact sheet: every cel of every loop at a readable zoom, one row a
 * loop, labelled with its facing. A loop that shares another's data block
 * shows its cels as the game displays them (a mirror flipped) and is marked
 * linked. The edited cel is highlighted; choosing a cel (click, or Enter or
 * Space on it) selects it and returns to the editor. Arrows move between
 * cels (Up and Down between loops), Home and End along a loop.
 */
const { document, loop, cel } = defineProps<{
  document: SpriteDocument;
  loop: number;
  cel: number;
}>();
const emit = defineEmits<{ select: [loop: number, cel: number] }>();

const root = useTemplateRef("root");
const rows = computed(() =>
  document.loops.map((entry, index) => ({
    index,
    alias: entry.alias,
    linked: aliasGroup(document, index).filter((member) => member !== index),
    facing: loopFacing(index, document.loops.length),
    flipped: entry.cels.some((one) => one.mirrored),
    cels: entry.cels,
  })),
);

function focusCel(target: number, index: number): void {
  void nextTick(() =>
    root.value?.querySelector<HTMLElement>(`[data-loop="${target}"][data-cel="${index}"]`)?.focus(),
  );
}
onMounted(() => focusCel(loop, cel));

function onKey(event: KeyboardEvent, l: number, c: number): void {
  const count = document.loops[l]?.cels.length ?? 1;
  const loops = document.loops.length;
  let next: [number, number] | undefined;
  if (event.key === "ArrowLeft") next = [l, Math.max(0, c - 1)];
  else if (event.key === "ArrowRight") next = [l, Math.min(count - 1, c + 1)];
  else if (event.key === "Home") next = [l, 0];
  else if (event.key === "End") next = [l, count - 1];
  else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const target = Math.min(loops - 1, Math.max(0, l + (event.key === "ArrowUp" ? -1 : 1)));
    next = [target, Math.min(c, (document.loops[target]?.cels.length ?? 1) - 1)];
  }
  if (!next) return;
  event.preventDefault();
  focusCel(...next);
}
</script>

<template>
  <section
    ref="root"
    class="sheet"
    aria-labelledby="sprite-sheet-title"
    data-testid="sprite-contact-sheet"
  >
    <h3 id="sprite-sheet-title" class="sheet__title">All cels</h3>
    <div class="sheet__rows" role="grid" aria-labelledby="sprite-sheet-title">
      <div
        v-for="row in rows"
        :key="row.index"
        role="row"
        class="sheet__row"
        :class="{ 'is-linked': row.linked.length > 0 }"
        :data-testid="`sprite-sheet-loop-${row.index}`"
      >
        <div role="rowheader" class="sheet__loop">
          <b>Loop {{ row.index }}</b>
          <span v-if="row.facing">{{ row.facing }}</span>
          <span
            v-if="row.linked.length > 0"
            class="sheet__chip"
            :data-testid="`sprite-sheet-linked-${row.index}`"
          >
            <UiIcon name="link" :size="12" />{{
              row.alias !== null ? `mirror of ${row.alias}` : `linked to ${row.linked.join(", ")}`
            }}{{ row.flipped ? " · shown flipped" : "" }}
          </span>
        </div>
        <div v-for="(entry, index) in row.cels" :key="index" role="gridcell">
          <button
            type="button"
            class="sheet__cel"
            :class="{ 'is-current': row.index === loop && index === cel }"
            :aria-current="row.index === loop && index === cel ? 'true' : undefined"
            :aria-label="`Loop ${row.index}, cel ${index}: ${entry.width} by ${entry.height}${row.linked.length > 0 ? ', linked' : ''}`"
            :tabindex="row.index === loop && index === cel ? 0 : -1"
            :data-loop="row.index"
            :data-cel="index"
            @click="emit('select', row.index, index)"
            @keydown="onKey($event, row.index, index)"
          >
            <SpriteThumb :cel="entry" :width="96" :height="128" />
            <span class="sheet__label">{{ index }}</span>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sheet {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: auto;
  padding: calc(var(--space-7) + var(--control-h)) var(--space-7) var(--space-7);
  background: var(--surface-sunken);
}
.sheet__title {
  margin: 0 0 var(--space-4);
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.sheet__rows {
  display: grid;
  gap: var(--space-4);
}
.sheet__row {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-1);
}
.sheet__row.is-linked {
  background-image: repeating-linear-gradient(135deg, transparent 0 6px, var(--surface-3) 6px 8px);
}
.sheet__loop {
  display: grid;
  align-self: stretch;
  align-content: start;
  gap: var(--space-1);
  width: 9rem;
  font-size: var(--text-xs);
}
.sheet__loop span {
  color: var(--ink-2);
}
.sheet__loop .sheet__chip {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  border: 1px solid var(--action-line);
  border-radius: var(--radius-pill);
  color: var(--action);
  font-size: var(--text-2xs);
}
.sheet__cel {
  display: grid;
  justify-items: center;
  align-content: end;
  gap: var(--space-1);
  min-width: 6.5rem;
  min-height: 9.5rem;
  padding: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--ink-3);
  background: var(--surface-sunken);
  cursor: pointer;
}
.sheet__cel:hover {
  border-color: var(--hairline-strong);
}
.sheet__cel.is-current {
  border-color: var(--action);
  box-shadow: 0 0 0 1px var(--action);
}
.sheet__cel:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.sheet__label {
  font: var(--text-2xs) / 1 var(--font-mono);
}
</style>
