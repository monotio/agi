<script setup lang="ts">
import { nextTick, ref, useId, useTemplateRef } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiIcon from "../ui/UiIcon.vue";
import type { BarNotice } from "./fillAdvice.ts";

/**
 * A notice in the options bar: a short summary that always fits (never
 * cut off), a Why? button that opens the whole reason in a small popover
 * under it (Esc closes it and focus returns to the button), and the fix as
 * one click, in the bar or, when the bar is `compact`, in the popover.
 * `terse` shows the summary's few-word form; Why? still has it all.
 */
const {
  notice,
  compact = false,
  terse = false,
} = defineProps<{
  notice: BarNotice;
  /** The bar is short of room: the fix waits in the popover. */
  compact?: boolean;
  /** Shorter still: the summary in a few words. */
  terse?: boolean;
}>();
const emit = defineEmits<{ act: [] }>();
const open = ref(false);
const popId = useId();
const why = useTemplateRef("why");

/** Esc with the popover open closes it and hands focus back to Why?; else it goes on to Studio. */
function onEscape(event: KeyboardEvent): void {
  if (!open.value) return;
  event.stopPropagation();
  open.value = false;
  void nextTick(() => why.value?.$el.focus());
}
function act(): void {
  open.value = false;
  emit("act");
}
</script>

<template>
  <span class="bar-notice" data-testid="studio-bar-notice" @keydown.esc="onEscape">
    <span
      class="bar-notice__summary"
      role="status"
      data-testid="bar-notice-summary"
      :title="terse ? notice.summary : undefined"
      ><UiIcon name="warning" :size="14" />{{ terse ? notice.short : notice.summary }}</span
    >
    <UiButton
      ref="why"
      variant="ghost"
      size="sm"
      :aria-expanded="open"
      :aria-controls="popId"
      data-testid="bar-notice-why"
      @click="open = !open"
      >Why?</UiButton
    >
    <UiButton
      v-if="notice.action && !compact"
      size="sm"
      data-testid="bar-notice-action"
      @click="act"
      >{{ notice.action }}</UiButton
    >
    <div
      v-if="open"
      :id="popId"
      class="bar-notice__pop"
      role="dialog"
      aria-label="Why"
      data-testid="bar-notice-detail"
    >
      <p v-if="terse">{{ notice.summary }}</p>
      <p>{{ notice.detail }}</p>
      <UiButton
        v-if="notice.action"
        size="sm"
        variant="primary"
        data-testid="bar-notice-pop-action"
        @click="act"
        >{{ notice.action }}</UiButton
      >
    </div>
  </span>
</template>

<style scoped>
.bar-notice {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
}
.bar-notice__summary {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-0) var(--space-2);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius-sm);
  color: var(--warn);
  background: var(--warn-soft);
  font-size: var(--text-xs);
  white-space: nowrap;
}
.bar-notice__pop {
  position: absolute;
  z-index: var(--z-popover);
  top: calc(100% + var(--space-2));
  left: 0;
  display: grid;
  justify-items: start;
  gap: var(--space-3);
  width: 320px;
  padding: var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-1);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-sm);
  white-space: normal;
}
.bar-notice__pop p {
  margin: 0;
}
</style>
