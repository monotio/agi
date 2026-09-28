<script setup lang="ts">
import { computed, onMounted, onScopeDispose, shallowRef, watch } from "vue";
import UiIconButton from "../../ui/UiIconButton.vue";
import UiSegmented from "../../ui/UiSegmented.vue";
import type { SpriteDocument } from "../../../../src/view/spriteDocument.ts";
import SpriteThumb from "../../world/SpriteThumb.vue";
import { paceWords, previewPacing, type PreviewCycler } from "./spriteView.ts";
import { useShortWindow } from "./useShortWindow.ts";

/**
 * The loop at game speed, and beside it the loop to check a fix against:
 * the edited loop's linked partner, else the view's first mirrored loop.
 * Game is what the player sees (spriteView.ts `previewPacing`: the
 * cycle delay v10 times the cycle time of an object showing the view);
 * Half runs it at half that, and Step holds it for the arrow keys or the
 * step buttons, to study a motion cel by cel. Reduced motion starts on Step.
 */
const {
  document,
  loop,
  partner,
  speed,
  view,
  cyclers = [],
} = defineProps<{
  document: SpriteDocument;
  loop: number;
  partner: number | undefined;
  /** The game's cycle delay (v10). */
  speed: number;
  /** The VIEW being edited: whose objects pace the preview. */
  view: number;
  /** The live objects when Studio opened. */
  cyclers?: readonly PreviewCycler[];
}>();

/** A short window shows smaller panes, so the side panel fits (useShortWindow.ts). */
const short = useShortWindow();
type Pace = "game" | "half" | "step";
const pace = shallowRef<Pace>("game");
const pacing = computed(() => previewPacing(speed, cyclers, view, loop));
/** Game, Half and Step; the first two say their pace on their tooltips (spriteView.ts `paceWords`). */
const paces = computed(() => [
  { value: "game" as const, label: "Game", title: paceWords(pacing.value, "game").text },
  { value: "half" as const, label: "Half", title: paceWords(pacing.value, "half").text },
  { value: "step" as const, label: "Step", title: "One cel at a time: ← → step" },
]);
const interval = computed(() => pacing.value.intervalMs * (pace.value === "half" ? 2 : 1));
const tick = shallowRef(0);
let frame: number | undefined;
let started = 0;
let from = 0;

function run(now: number): void {
  if (!started) started = now;
  tick.value = from + Math.floor((now - started) / interval.value);
  frame = requestAnimationFrame(run);
}
function stop(): void {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
}
function start(): void {
  stop();
  from = tick.value;
  started = 0;
  frame = requestAnimationFrame(run);
}
watch(pace, (next) => (next === "step" ? stop() : start()));
function step(direction: 1 | -1): void {
  pace.value = "step";
  tick.value += direction;
}
onMounted(() => {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  if (reduce) pace.value = "step";
  else start();
});
onScopeDispose(stop);

const wrap = (value: number, count: number): number => ((value % count) + count) % count;
const celTotal = computed(() => document.loops[loop]?.cels.length ?? 0);
function celOf(index: number | undefined) {
  if (index === undefined) return undefined;
  const cels = document.loops[index]?.cels;
  return cels && cels.length > 0 ? cels[wrap(tick.value, cels.length)] : undefined;
}
const panes = computed(() =>
  [loop, partner].flatMap((index) => {
    const cel = celOf(index);
    if (index === undefined || !cel) return [];
    const alias = document.loops[index]!.alias;
    const label = alias === null ? `loop ${index}` : `loop ${index} ⇋ ${alias}`;
    return [{ index, cel, label }];
  }),
);
/** Stepping: which cel shows. */
const paceText = computed(
  () =>
    `cel ${celTotal.value ? wrap(tick.value, celTotal.value) : 0} of ${celTotal.value} · ← → step`,
);
/** Where the game's pace comes from, said whole, on the panes' tooltip. */
const paceTitle = computed(() => paceWords(pacing.value, "game").title);
function onKey(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  step(event.key === "ArrowRight" ? 1 : -1);
}
</script>

<template>
  <section
    class="sprite-preview"
    :class="{ 'is-short': short }"
    aria-labelledby="sprite-preview-title"
    data-testid="sprite-preview"
  >
    <header class="sprite-preview__head">
      <h3 id="sprite-preview-title">Preview</h3>
      <UiSegmented
        v-model="pace"
        label="Preview pace"
        :options="paces"
        data-testid="sprite-preview-pace"
      />
    </header>
    <p v-if="pace === 'step'" class="sprite-preview__pace" data-testid="sprite-preview-speed">
      {{ paceText }}
    </p>
    <div
      class="sprite-preview__panes"
      tabindex="0"
      role="group"
      aria-label="Loop preview: the arrow keys step it a cel at a time"
      :title="paceTitle"
      data-testid="sprite-preview-panes"
      @keydown="onKey"
    >
      <figure
        v-for="pane in panes"
        :key="pane.index"
        class="sprite-preview__pane"
        :data-loop="pane.index"
        data-testid="sprite-preview-pane"
      >
        <figcaption>{{ pane.label }}</figcaption>
        <SpriteThumb :cel="pane.cel" :width="116" :height="short ? 40 : 88" />
      </figure>
    </div>
    <div v-if="pace === 'step'" class="sprite-preview__steps">
      <UiIconButton icon="chevron-left" label="Previous cel" @click="step(-1)" />
      <UiIconButton icon="chevron-right" label="Next cel" @click="step(1)" />
    </div>
  </section>
</template>

<style scoped>
.sprite-preview {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.sprite-preview.is-short {
  padding-block: var(--space-2);
}
.sprite-preview.is-short .sprite-preview__pane {
  min-height: 0;
  padding: var(--space-1);
}
.sprite-preview__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.sprite-preview__head h3 {
  flex: 1;
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.sprite-preview__head :deep(.ui-seg__item) {
  padding: 0 var(--space-3);
  font-weight: var(--weight-bold);
}
.sprite-preview__pace {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.sprite-preview__panes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  border-radius: var(--radius);
  outline: 0;
}
.sprite-preview__panes:focus-visible {
  box-shadow: 0 0 0 2px var(--focus);
}
.sprite-preview__pane {
  display: grid;
  grid-template-rows: auto 1fr;
  justify-items: center;
  align-items: end;
  min-height: 108px;
  margin: 0;
  padding: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-sunken);
}
.sprite-preview__pane figcaption {
  justify-self: start;
  align-self: start;
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.sprite-preview__steps {
  display: flex;
  justify-content: center;
  gap: var(--space-2);
}
</style>
