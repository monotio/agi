<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef } from "vue";

/**
 * Create's quiet note that the game under the editor is a test run. Hover,
 * focus or a tap shows what that means; Esc puts it away. The words are the
 * chip's accessible description too.
 */
const SAYS =
  "Saves, items and progress here are for testing. Play keeps your own game. Your edits stay.";
const tipId = useId();
/** What holds the note open: a resting pointer, keyboard focus or a tap. */
const open = ref({ hover: false, focus: false, tap: false });
const dismissed = ref(false);
const shown = computed(
  () => (open.value.hover || open.value.focus || open.value.tap) && !dismissed.value,
);
const chip = useTemplateRef("chip");
const tip = useTemplateRef("tip");
/** The note sits above the chip, inside the window; it lives on the page body so no pane clips it. */
const place = ref({ left: 0, top: 0 });
async function position(): Promise<void> {
  await nextTick();
  const box = chip.value?.getBoundingClientRect();
  const height = tip.value?.getBoundingClientRect().height ?? 0;
  const width = tip.value?.getBoundingClientRect().width ?? 0;
  if (!box) return;
  const gutter = 16;
  const above = box.top - height - 8;
  place.value = {
    left: Math.max(gutter, Math.min(box.left, window.innerWidth - width - gutter)),
    top: above >= gutter ? above : box.bottom + 8,
  };
}
function show(why: "hover" | "focus" | "tap"): void {
  open.value = { ...open.value, [why]: true };
  dismissed.value = false;
  void position();
}
function release(...why: ("hover" | "focus" | "tap")[]): void {
  open.value = { ...open.value, ...Object.fromEntries(why.map((key) => [key, false])) };
}
function hide(): void {
  release("hover", "focus", "tap");
  dismissed.value = true;
}
</script>

<template>
  <span class="test-run" @mouseenter="show('hover')" @mouseleave="release('hover')">
    <button
      ref="chip"
      type="button"
      class="test-run__chip"
      data-testid="test-run-chip"
      :aria-describedby="tipId"
      :aria-expanded="shown"
      @focus="show('focus')"
      @blur="release('focus', 'tap')"
      @click="open.tap && !dismissed ? hide() : show('tap')"
      @keydown.esc.stop.prevent="hide"
    >
      Test run
    </button>
    <Teleport to="body"
      ><span
        v-show="shown"
        :id="tipId"
        ref="tip"
        role="tooltip"
        class="test-run__tip"
        :style="{ left: `${place.left}px`, top: `${place.top}px` }"
        >{{ SAYS }}</span
      ></Teleport
    >
  </span>
</template>

<style scoped>
.test-run {
  position: relative;
  display: inline-flex;
  flex: none;
}
.test-run__chip {
  display: inline-flex;
  align-items: center;
  min-height: var(--space-6);
  padding: 0 var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--ink-2);
  font: var(--weight-medium) var(--text-xs) / 1.4 var(--font-sans);
  white-space: nowrap;
  cursor: help;
}
.test-run__chip:hover,
.test-run__chip[aria-expanded="true"] {
  color: var(--ink);
  border-color: var(--ink-3);
}
.test-run__chip:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.test-run__tip {
  position: fixed;
  z-index: var(--z-popover);
  width: max-content;
  max-width: min(280px, calc(100vw - 32px));
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-3);
  color: var(--ink);
  font: var(--text-xs) / var(--leading) var(--font-sans);
  white-space: normal;
  box-shadow: var(--shadow-pop);
}
</style>
