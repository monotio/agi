<script setup lang="ts">
import { computed } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiExplain from "../../ui/UiExplain.vue";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
import { explain } from "../studioTerms.ts";
import { swatchInk } from "./spriteView.ts";

/**
 * The fixed AGI palette with the edited cel's transparent colour marked T,
 * in two short rows of eight so the previews below stay in view. A radio
 * group: arrows move between colours. Choosing the transparent colour turns
 * the eraser on, which paints it. The heading's "Transparent colour ⓘ" says what
 * it is and offers "Choose another…" (`choose`), which opens the cel's
 * Details at its transparent colour. It is the view's data (what the game
 * leaves see-through); the drawing backdrop is the options bar's, and stays
 * out of the view.
 */
const { transparent } = defineProps<{ transparent: number }>();
const emit = defineEmits<{ erase: []; choose: [] }>();
const color = defineModel<number>({ required: true });
const COLOURS = Array.from({ length: 16 }, (_, index) => index);
/** The swatch Tab lands on: the paint colour, never the transparent one. */
const focusable = computed(() =>
  color.value !== transparent ? color.value : (transparent + 1) % 16,
);

function choose(value: number): void {
  if (value === transparent) emit("erase");
  else color.value = value;
}

/** Arrows move along the palette (Up/Down by a row of eight), Home/End jump. */
function onKey(event: KeyboardEvent, value: number): void {
  const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 };
  let next: number | undefined;
  if (event.key in step) next = (value + step[event.key]! + 16) % 16;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = 15;
  if (next === undefined) return;
  event.preventDefault();
  if (next !== transparent) color.value = next;
  (event.currentTarget as HTMLElement).parentElement
    ?.querySelector<HTMLElement>(`[data-colour="${next}"]`)
    ?.focus();
}
</script>

<template>
  <section
    class="sprite-palette"
    aria-labelledby="sprite-palette-title"
    data-testid="sprite-palette"
  >
    <header class="sprite-palette__head">
      <h3 id="sprite-palette-title">Palette</h3>
      <span class="sprite-palette__transparent" data-testid="sprite-transparent"
        >Transparent colour
        <UiExplain v-bind="explain('transparent')">
          <template #action="{ close }">
            <UiButton
              size="sm"
              data-testid="sprite-transparent-choose"
              @click="
                close();
                emit('choose');
              "
              >Choose another…</UiButton
            >
          </template>
        </UiExplain></span
      >
    </header>
    <div class="sprite-palette__grid" role="radiogroup" aria-labelledby="sprite-palette-title">
      <button
        v-for="value in COLOURS"
        :key="value"
        type="button"
        role="radio"
        class="sprite-palette__swatch"
        :class="{ 'is-transparent': value === transparent }"
        :style="{ background: `var(--agi-${value})` }"
        :aria-checked="value === color && value !== transparent"
        :aria-label="
          value === transparent
            ? `Colour ${value}, ${EGA_COLOUR_NAMES[value]}: this cel's transparent colour (use the eraser)`
            : `Colour ${value}, ${EGA_COLOUR_NAMES[value]}`
        "
        :tabindex="value === focusable ? 0 : -1"
        :data-colour="value"
        @click="choose(value)"
        @keydown="onKey($event, value)"
      >
        <span :style="{ color: swatchInk(value) }">{{ value === transparent ? "T" : value }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.sprite-palette {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5) var(--space-4);
  border-bottom: 1px solid var(--hairline);
}
.sprite-palette__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.sprite-palette__head h3 {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.sprite-palette__transparent {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.sprite-palette__grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: var(--space-1);
}
.sprite-palette__swatch {
  position: relative;
  height: var(--space-7);
  padding: 0;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
/* The label's colour is black or white per swatch (swatchInk), 4.5:1 or better. */
.sprite-palette__swatch span {
  position: absolute;
  bottom: 1px;
  left: 3px;
  font: var(--text-2xs) / 1 var(--font-mono);
}
.sprite-palette__swatch[aria-checked="true"] {
  outline: 2px solid var(--action);
  outline-offset: 1px;
}
.sprite-palette__swatch.is-transparent {
  cursor: not-allowed;
}
.sprite-palette__swatch.is-transparent span {
  top: 50%;
  bottom: auto;
  left: 50%;
  font-size: var(--text-md);
  transform: translate(-50%, -50%);
}
.sprite-palette__swatch:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
</style>
