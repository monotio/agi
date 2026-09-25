<script setup lang="ts" generic="T extends string">
import { useTemplateRef } from "vue";

/**
 * A single-choice segmented control (radio group). Arrow keys move and select,
 * Home/End jump; only the selected segment is in the tab order.
 */
const { size = "md" } = defineProps<{
  label: string;
  options: readonly { value: T; label: string; shortcut?: string; disabled?: boolean }[];
  size?: "sm" | "md";
}>();
const model = defineModel<T>({ required: true });
const group = useTemplateRef("group");

function move(
  step: number | "first" | "last",
  options: readonly { value: T; disabled?: boolean }[],
) {
  const enabled = options.filter((option) => !option.disabled);
  if (enabled.length === 0) return;
  const current = enabled.findIndex((option) => option.value === model.value);
  const next =
    step === "first"
      ? 0
      : step === "last"
        ? enabled.length - 1
        : (current + step + enabled.length) % enabled.length;
  model.value = enabled[next]!.value;
  const buttons = group.value?.querySelectorAll<HTMLButtonElement>("[role=radio]:not(:disabled)");
  buttons?.[next]?.focus();
}
</script>

<template>
  <div
    ref="group"
    role="radiogroup"
    :aria-label="label"
    class="ui-seg"
    :class="[`ui-seg--${size}`]"
    @keydown.right.prevent="move(1, options)"
    @keydown.down.prevent="move(1, options)"
    @keydown.left.prevent="move(-1, options)"
    @keydown.up.prevent="move(-1, options)"
    @keydown.home.prevent="move('first', options)"
    @keydown.end.prevent="move('last', options)"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      class="ui-seg__item"
      :aria-checked="option.value === model"
      :tabindex="option.value === model ? 0 : -1"
      :disabled="option.disabled"
      @click="model = option.value"
    >
      {{ option.label }}<kbd v-if="option.shortcut" class="ui-seg__kbd">{{ option.shortcut }}</kbd>
    </button>
  </div>
</template>

<style scoped>
.ui-seg {
  display: inline-flex;
  gap: var(--space-0);
  padding: 3px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  background: var(--surface-0);
}
.ui-seg__item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: calc(var(--control-h) - 8px);
  padding: 0 var(--space-4);
  border: 0;
  border-radius: var(--radius);
  color: var(--ink-2);
  background: transparent;
  font: var(--weight-semibold) var(--text-sm) / 1 var(--font-sans);
  cursor: pointer;
}
.ui-seg--sm .ui-seg__item {
  min-height: calc(var(--control-h-sm) - 8px);
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
}
.ui-seg__item:hover:not(:disabled) {
  color: var(--ink);
}
.ui-seg__item[aria-checked="true"] {
  color: var(--ink);
  background: var(--surface-3);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
.ui-seg__item:disabled {
  color: var(--ink-disabled);
  cursor: not-allowed;
}
.ui-seg__kbd {
  font: var(--text-2xs) var(--font-mono);
  color: var(--ink-3);
}
</style>
