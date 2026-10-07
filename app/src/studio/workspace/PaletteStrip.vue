<script setup lang="ts">
import { computed } from "vue";
import { EGA_PALETTE } from "../../render/palette.ts";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
import type { paletteContext } from "../useStudioPalette.ts";
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
/**
 * Visual offers the 16 colours. Priority offers the four control lines
 * (wall, gate, trigger, water), then the distance bands 4–15, each marked
 * with the colour the canvas paints it in.
 */
const options = computed(() => {
  if (state.value.lens === "art")
    return Array.from({ length: 16 }, (_, value) => ({
      value,
      colour: value,
      label: `Colour ${value}: ${EGA_COLOUR_NAMES[value]}`,
      text: "",
    }));
  return [
    ...CONTROL_VALUES.map((control) => ({
      value: control.value as number,
      colour: control.colour,
      label: `${control.name}: ${control.help}`,
      text: String(control.value),
    })),
    ...Array.from({ length: 12 }, (_, k) => ({
      value: k + 4,
      colour: k + 4,
      label: `Depth ${k + 4}: ${priorityMeaning(k + 4)}`,
      text: String(k + 4),
    })),
  ];
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
    <!-- With nothing to paint or recolour, the strip holds its place, empty. -->
    <div
      v-if="state.action !== 'hint'"
      class="workspace-palette__choices"
      :class="`is-${state.lens}`"
      role="radiogroup"
      :aria-label="state.lens === 'art' ? 'Palette' : 'Priority'"
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
        :class="{ 'is-band-start': state.lens !== 'art' && option.value === 4 }"
        :style="
          state.lens === 'art'
            ? { background: `rgb(${EGA_PALETTE[option.colour]!.join(',')})` }
            : { '--mark': `var(--agi-${option.colour})` }
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
/* Priority values keep their number readable over a strip of the canvas colour. */
.is-depth button {
  box-shadow: inset 0 -4px 0 0 var(--mark);
}
.is-depth .is-band-start {
  margin-left: var(--space-2);
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
