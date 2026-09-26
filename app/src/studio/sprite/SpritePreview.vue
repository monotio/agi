<script setup lang="ts">
import { computed, onMounted, onScopeDispose, shallowRef } from "vue";
import UiIconButton from "../../ui/UiIconButton.vue";
import type { SpriteDocument } from "../../../../src/studio/sprite/spriteDocument.ts";
import SpriteThumb from "./SpriteThumb.vue";
import { celIntervalMs } from "./spriteView.ts";

/**
 * The loop at game speed, and beside it the loop to check a fix against:
 * the edited loop's linked partner, else the view's first mirrored loop. A
 * cel shows for one logic cycle (spriteView.ts `celIntervalMs`: the game's
 * cycle delay v10 and an object's default cycle time of 1), so the preview
 * runs as the game would. Reduced motion starts it paused.
 */
const { document, loop, partner, speed } = defineProps<{
  document: SpriteDocument;
  loop: number;
  partner: number | undefined;
  /** The game's cycle delay (v10). */
  speed: number;
}>();

const interval = computed(() => celIntervalMs(speed));
const tick = shallowRef(0);
const playing = shallowRef(true);
let frame: number | undefined;
let started = 0;

function run(now: number): void {
  if (!started) started = now;
  tick.value = Math.floor((now - started) / interval.value);
  frame = requestAnimationFrame(run);
}
function toggle(): void {
  playing.value = !playing.value;
  if (playing.value) {
    started = 0;
    frame = requestAnimationFrame(run);
  } else if (frame !== undefined) cancelAnimationFrame(frame);
}
onMounted(() => {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  if (reduce) playing.value = false;
  else frame = requestAnimationFrame(run);
});
onScopeDispose(() => {
  if (frame !== undefined) cancelAnimationFrame(frame);
});

function celOf(index: number | undefined) {
  if (index === undefined) return undefined;
  const cels = document.loops[index]?.cels;
  return cels && cels.length > 0 ? cels[tick.value % cels.length] : undefined;
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
</script>

<template>
  <section class="sprite-preview" aria-labelledby="sprite-preview-title">
    <header class="sprite-preview__head">
      <h3 id="sprite-preview-title">Preview</h3>
      <span data-testid="sprite-preview-speed"
        >game speed · {{ Math.round(interval) }} ms a cel</span
      >
      <UiIconButton
        :icon="playing ? 'pause' : 'play'"
        :label="playing ? 'Pause the preview' : 'Play the preview'"
        size="sm"
        @click="toggle"
      />
    </header>
    <div class="sprite-preview__panes">
      <figure
        v-for="pane in panes"
        :key="pane.index"
        class="sprite-preview__pane"
        :data-loop="pane.index"
        data-testid="sprite-preview-pane"
      >
        <figcaption>{{ pane.label }}</figcaption>
        <SpriteThumb :cel="pane.cel" :width="116" :height="100" />
      </figure>
    </div>
  </section>
</template>

<style scoped>
.sprite-preview {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
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
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.sprite-preview__head span {
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.sprite-preview__panes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
.sprite-preview__pane {
  display: grid;
  grid-template-rows: auto 1fr;
  justify-items: center;
  align-items: end;
  min-height: 132px;
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
</style>
