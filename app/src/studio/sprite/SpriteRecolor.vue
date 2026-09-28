<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiIconButton from "../../ui/UiIconButton.vue";
import UiSegmented from "../../ui/UiSegmented.vue";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
import type { SpriteDocument } from "../../../../src/view/spriteDocument.ts";
import { recolorCount, recolorEdit, type RecolorEdit, type RecolorScope } from "./spriteRecolor.ts";
import { swatchInk } from "./spriteView.ts";

/**
 * The recolour tool's popover: one colour becomes another over this cel,
 * this loop or the whole view. The colour to change comes from a click on
 * the canvas (useSpriteTools `recolorFrom`) or a From swatch, the new one
 * from a To swatch; the count of pixels that will change is live
 * (spriteRecolor.ts). Linked loops follow copy-on-write like every edit, and
 * the transparent colour is never a new colour: it would make pixels
 * transparent, which is the eraser's job.
 */
const { document, loop, cel, propagate, frozen } = defineProps<{
  document: SpriteDocument;
  loop: number;
  cel: number;
  /** Edits change the loop's whole linked group. */
  propagate: boolean;
  frozen: boolean;
}>();
const emit = defineEmits<{ apply: [edit: RecolorEdit]; close: [] }>();
const from = defineModel<number | null>("from", { required: true });
/** The new colour; unset until one is picked. */
const to = ref<number>();
const scope = ref<RecolorScope>("loop");

const COLOURS = Array.from({ length: 16 }, (_, index) => index);
const SCOPES: readonly { value: RecolorScope; label: string }[] = [
  { value: "cel", label: "This cel" },
  { value: "loop", label: "This loop" },
  { value: "view", label: "Whole view" },
];
const WHERE: Record<RecolorScope, string> = {
  cel: "this cel",
  loop: "this loop",
  view: "the whole view",
};

const transparent = computed(() => document.loops[loop]?.cels[cel]?.transparent ?? 0);
const name = (value: number): string => `colour ${value}, ${EGA_COLOUR_NAMES[value]}`;
const edit = computed(() =>
  from.value === null
    ? null
    : recolorEdit(scope.value, { loop, cel }, from.value, to.value ?? from.value, propagate),
);
const count = computed(() => (edit.value ? recolorCount(document, edit.value) : null));
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
const summary = computed(() => {
  const counted = count.value;
  if (from.value === null || !counted)
    return "Pick the colour to change: click a pixel on the canvas or a From swatch.";
  if (counted.pixels === 0) return `No pixels of ${name(from.value)} in ${WHERE[scope.value]}.`;
  if (to.value === undefined || to.value === from.value)
    return `${plural(counted.pixels, "pixel")} of ${name(from.value)} in ${WHERE[scope.value]}. Pick the new colour.`;
  return `${plural(counted.pixels, "pixel")} in ${plural(counted.cels, "cel")} will change to ${name(to.value)}.`;
});
const clash = computed(() => {
  const at = to.value === undefined ? null : count.value?.clash;
  return at
    ? `Colour ${to.value} is the transparent colour of loop ${at.loop}, cel ${at.cel}, so its pixels can't become it. Pick another colour or a smaller scope.`
    : null;
});
const copies = computed(() => {
  const split = to.value === undefined ? [] : (count.value?.copies ?? []);
  if (split.length === 0) return null;
  const loops = split.length === 1 ? `Loop ${split[0]}` : `Loops ${split.join(", ")}`;
  return `${loops} will become a separate copy; the loops linked to it keep their pixels.`;
});
const ready = computed(
  () =>
    !frozen &&
    to.value !== undefined &&
    to.value !== from.value &&
    (count.value?.pixels ?? 0) > 0 &&
    clash.value === null,
);
/** Why Recolour is off: an open proposal or a view-only view, else what the count says. */
const blocked = computed(() =>
  frozen
    ? "Editing waits while the view is view only or an AI proposal is open"
    : (clash.value ?? summary.value),
);

const root = useTemplateRef("root");

function apply(): void {
  if (!ready.value || from.value === null || to.value === undefined) return;
  emit("apply", recolorEdit(scope.value, { loop, cel }, from.value, to.value, propagate));
  // The spent button disables itself (no pixels of From are left): focus
  // stays in the popover, on the From colour, rather than dropping out of Studio.
  void nextTick(() =>
    root.value
      ?.querySelector<HTMLElement>('[data-testid="sprite-recolor-from"] [tabindex="0"]')
      ?.focus(),
  );
}

/** A swatch row's arrows: along the row (Up/Down by eight), Home/End, skipping disabled swatches. */
function onSwatchKey(event: KeyboardEvent, row: "from" | "to", value: number): void {
  const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 };
  let next: number | undefined;
  if (event.key in step) next = (value + step[event.key]! + 16) % 16;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = 15;
  if (next === undefined) return;
  event.preventDefault();
  if (next === transparent.value) next = (next + (step[event.key]! < 0 ? 15 : 1)) % 16;
  if (row === "from") from.value = next;
  else to.value = next;
  (event.currentTarget as HTMLElement).parentElement
    ?.querySelector<HTMLElement>(`[data-colour="${next}"]`)
    ?.focus();
}
const tabStop = (chosen: number | null | undefined): number =>
  chosen ?? (transparent.value === 0 ? 1 : 0);
</script>

<template>
  <section
    ref="root"
    class="recolor"
    role="group"
    aria-labelledby="sprite-recolor-title"
    data-testid="sprite-recolor"
  >
    <header class="recolor__head">
      <h3 id="sprite-recolor-title">Recolour</h3>
      <UiIconButton icon="x" label="Close recolour (Esc)" size="sm" @click="emit('close')" />
    </header>
    <div v-for="row in ['from', 'to'] as const" :key="row" class="recolor__row">
      <span :id="`sprite-recolor-${row}`" class="recolor__label">{{
        row === "from" ? "From" : "To"
      }}</span>
      <div
        class="recolor__swatches"
        role="radiogroup"
        :aria-labelledby="`sprite-recolor-${row}`"
        :data-testid="`sprite-recolor-${row}`"
      >
        <button
          v-for="value in COLOURS"
          :key="value"
          type="button"
          role="radio"
          class="recolor__swatch"
          :style="{ background: `var(--agi-${value})` }"
          :aria-checked="(row === 'from' ? from : to) === value"
          :aria-label="
            value === transparent
              ? `${name(value)}: this cel's transparent colour`
              : `${row === 'from' ? 'From' : 'To'} ${name(value)}`
          "
          :disabled="value === transparent"
          :title="
            value === transparent ? 'The transparent colour: the eraser (E) paints it' : undefined
          "
          :tabindex="value === tabStop(row === 'from' ? from : to) ? 0 : -1"
          :data-colour="value"
          @click="row === 'from' ? (from = value) : (to = value)"
          @keydown="onSwatchKey($event, row, value)"
        >
          <span :style="{ color: swatchInk(value) }">{{
            value === transparent ? "∅" : value
          }}</span>
        </button>
      </div>
    </div>
    <p class="recolor__hint">
      ∅ {{ transparent }} is transparent: the eraser (E) makes pixels transparent.
    </p>
    <UiSegmented v-model="scope" label="Recolour where" size="sm" :options="SCOPES" />
    <p class="recolor__count" aria-live="polite" data-testid="sprite-recolor-count">
      {{ summary }}
    </p>
    <p v-if="clash" class="recolor__warn" data-testid="sprite-recolor-clash">{{ clash }}</p>
    <p v-else-if="copies" class="recolor__note" data-testid="sprite-recolor-copies">
      {{ copies }}
    </p>
    <UiButton
      size="sm"
      variant="primary"
      :disabled="!ready"
      :title="ready ? undefined : blocked"
      data-testid="sprite-recolor-apply"
      @click="apply"
    >
      Recolour
    </UiButton>
  </section>
</template>

<style scoped>
.recolor {
  position: absolute;
  top: var(--space-4);
  left: var(--space-4);
  z-index: 2;
  display: grid;
  justify-items: start;
  gap: var(--space-2);
  box-sizing: border-box;
  width: 16rem;
  max-height: calc(100% - 2 * var(--space-4));
  overflow-y: auto;
  padding: var(--space-3) var(--space-4) var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-xs);
}
.recolor__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.recolor__head h3 {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.recolor__row {
  display: grid;
  grid-template-columns: 2.5rem 1fr;
  align-items: start;
  width: 100%;
}
.recolor__label {
  color: var(--ink-2);
}
.recolor__swatches {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: var(--space-1);
}
.recolor__swatch {
  position: relative;
  height: calc(var(--space-5) + var(--space-0));
  padding: 0;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
/* The label's colour is black or white per swatch (swatchInk), 4.5:1 or better. */
.recolor__swatch span {
  position: absolute;
  bottom: 1px;
  left: 3px;
  font: var(--text-2xs) / 1 var(--font-mono);
}
.recolor__swatch:disabled {
  cursor: not-allowed;
}
.recolor__swatch:disabled span {
  top: 50%;
  bottom: auto;
  left: 50%;
  transform: translate(-50%, -50%);
}
.recolor__swatch[aria-checked="true"] {
  outline: 2px solid var(--action);
  outline-offset: 1px;
}
.recolor__swatch:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.recolor__hint,
.recolor__count,
.recolor__warn,
.recolor__note {
  margin: 0;
}
.recolor__hint {
  color: var(--ink-3);
}
.recolor__count {
  color: var(--ink);
}
.recolor__warn {
  color: var(--warn);
}
.recolor__note {
  color: var(--ink-2);
}
</style>
