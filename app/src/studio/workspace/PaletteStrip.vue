<script setup lang="ts">
import { EGA_PALETTE } from "../../render/palette.ts";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
defineProps<{ value: number }>();
const emit = defineEmits<{ choose: [value: number] }>();
function key(event: KeyboardEvent, index: number): void {
  const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!offset) return;
  event.preventDefault();
  const next = (index + offset + 16) % 16;
  emit("choose", next);
  (event.currentTarget as HTMLElement).parentElement
    ?.querySelector<HTMLElement>(`[data-colour="${next}"]`)
    ?.focus();
}
</script>
<template>
  <div class="workspace-palette" role="radiogroup" aria-label="Palette">
    <button
      v-for="(rgb, index) in EGA_PALETTE"
      :key="index"
      type="button"
      role="radio"
      :aria-checked="value === index"
      :tabindex="value === index ? 0 : -1"
      :aria-label="`Colour ${index}: ${EGA_COLOUR_NAMES[index]}`"
      :data-colour="index"
      :style="{ background: `rgb(${rgb.join(',')})` }"
      @click="emit('choose', index)"
      @keydown="key($event, index)"
    ></button>
  </div>
</template>
<style scoped>
.workspace-palette {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
}
button {
  width: 24px;
  height: 24px;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
button[aria-checked="true"] {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}
</style>
