<script setup lang="ts">
import { computed } from "vue";
import { EGA_PALETTE } from "../../render/palette.ts";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
import { PALETTE_HINT, type paletteContext } from "../useStudioPalette.ts";
import { CONTROL_VALUES, priorityMeaning } from "../studioView.ts";
const {
  context = undefined,
  value,
  disabled = false,
} = defineProps<{
  context?: ReturnType<typeof paletteContext>;
  value: number | null | "band" | undefined;
  disabled?: boolean;
}>();
const emit = defineEmits<{ choose: [value: number] }>();
const state = computed(() => context ?? { action: "draw", lens: "art" });
const options = computed(() => {
  if (state.value.lens === "walk")
    return CONTROL_VALUES.map((control) => ({
      value: control.value,
      colour: control.colour,
      label: control.name,
      text: control.name,
    }));
  const start = state.value.lens === "art" ? 0 : 4;
  return Array.from({ length: 16 - start }, (_, k) => {
    const value = k + start;
    return {
      value,
      colour: value,
      label:
        state.value.lens === "art"
          ? `Colour ${value}: ${EGA_COLOUR_NAMES[value]}`
          : `Depth ${value}: ${priorityMeaning(value)}`,
      text: state.value.lens === "art" ? "" : String(value),
    };
  });
});
function key(event: KeyboardEvent, index: number): void {
  const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!offset || disabled) return;
  event.preventDefault();
  const next = options.value[(index + offset + options.value.length) % options.value.length]!;
  emit("choose", next.value);
  (event.currentTarget as HTMLElement).parentElement
    ?.querySelector<HTMLElement>(`[data-colour="${next.value}"]`)
    ?.focus();
}
</script>
<template>
  <div class="workspace-palette" :class="{ 'is-contextual': context !== undefined }">
    <p v-if="state.action === 'hint'" class="workspace-palette__hint">{{ PALETTE_HINT }}</p>
    <div
      v-else
      class="workspace-palette__choices"
      :class="`is-${state.lens}`"
      role="radiogroup"
      :aria-label="
        state.lens === 'art' ? 'Palette' : state.lens === 'depth' ? 'Distance bands' : 'Walk lines'
      "
    >
      <button
        v-for="(option, index) in options"
        :key="option.value"
        type="button"
        role="radio"
        :aria-checked="value === option.value"
        :tabindex="
          value === option.value ||
          (!options.some((option) => option.value === value) && index === 0)
            ? 0
            : -1
        "
        :aria-label="option.label"
        :title="option.label"
        :disabled
        :data-colour="option.value"
        :style="
          state.lens === 'art'
            ? { background: `rgb(${EGA_PALETTE[option.colour]!.join(',')})` }
            : undefined
        "
        @click="emit('choose', option.value)"
        @keydown="key($event, index)"
      >
        {{ option.text }}
      </button>
    </div>
  </div>
</template>
<style scoped>
.workspace-palette {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 56px;
  box-sizing: border-box;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
}
.workspace-palette__choices {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  max-width: 480px;
}
.workspace-palette:not(.is-contextual) {
  height: auto;
  padding: var(--space-3);
}
.workspace-palette:not(.is-contextual) .workspace-palette__choices {
  width: auto;
  max-width: none;
  gap: var(--space-2);
}
.workspace-palette:not(.is-contextual) button {
  flex: none;
  width: 24px;
}
.workspace-palette__hint {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
  text-align: center;
}
button {
  flex: 1 1 24px;
  min-width: 0;
  max-width: 32px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--ink);
  font: var(--text-xs) var(--font-mono);
  cursor: pointer;
}
.is-walk button {
  max-width: none;
  font-family: var(--font-sans);
}
button[aria-checked="true"] {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}
button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
