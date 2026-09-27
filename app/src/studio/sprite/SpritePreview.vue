<script setup lang="ts">
import { computed, onMounted, onScopeDispose, shallowRef, watch } from "vue";
import UiIconButton from "../../ui/UiIconButton.vue";
import UiSegmented from "../../ui/UiSegmented.vue";
import type { SpriteDocument } from "../../../../src/view/spriteDocument.ts";
import SpriteThumb from "../../world/SpriteThumb.vue";
import { previewPacing, type PreviewCycler } from "./spriteView.ts";

/**
 * The loop at game speed, and beside it the loop to check a fix against:
 * the edited loop's linked partner, else the view's first mirrored loop.
 * Game speed is what the player sees (spriteView.ts `previewPacing`: the
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

type Pace = "game" | "half" | "step";
const PACES = [
  { value: "game", label: "Game speed" },
  { value: "half", label: "Half" },
  { value: "step", label: "Step" },
] as const;
const pace = shallowRef<Pace>("game");
const pacing = computed(() => previewPacing(speed, cyclers, view, loop));
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
    const label = alias === null ? `loop ${index}` : `loop ${index} = mirror of ${alias}`;
    return [{ index, cel, label }];
  }),
);
/** Where the pace comes from, said plainly: one short line, and the whole sentence as its title. */
const paceText = computed(() => {
  const { intervalMs, cycleTime, object } = pacing.value;
  if (pace.value === "step")
    return `cel ${celTotal.value ? wrap(tick.value, celTotal.value) : 0} of ${celTotal.value} · ← → step`;
  const ms = `${Math.round(interval.value)} ms a cel`;
  if (pace.value === "half") return `${ms} · half of ${Math.round(intervalMs)} ms`;
  if (object === null) return `${ms}: no object shows it now`;
  const who = object === 0 ? "ego" : `object ${object}`;
  return `${ms} · ${who}: every ${cycleTime} cycle${cycleTime === 1 ? "" : "s"}`;
});
const paceTitle = computed(() => {
  const { intervalMs, cycleTime, object } = pacing.value;
  const game = `Game speed: ${Math.round(intervalMs)} ms a cel`;
  return object === null
    ? `${game}, 1 cel per cycle (no object shows this view now).`
    : `${game}: ${object === 0 ? "ego" : `object ${object}`} changes cel every ${cycleTime} cycle${cycleTime === 1 ? "" : "s"}, at the game's cycle delay.`;
});
function onKey(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  step(event.key === "ArrowRight" ? 1 : -1);
}
</script>

<template>
  <section class="sprite-preview" aria-labelledby="sprite-preview-title">
    <header class="sprite-preview__head">
      <h3 id="sprite-preview-title">Preview</h3>
      <UiSegmented
        v-model="pace"
        label="Preview pace"
        :options="PACES"
        data-testid="sprite-preview-pace"
      />
    </header>
    <p class="sprite-preview__pace" :title="paceTitle" data-testid="sprite-preview-speed">
      {{ paceText }}
    </p>
    <div
      class="sprite-preview__panes"
      tabindex="0"
      role="group"
      aria-label="Loop preview: the arrow keys step it a cel at a time"
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
        <SpriteThumb :cel="pane.cel" :width="116" :height="88" />
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
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--hairline);
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
