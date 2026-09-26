<script setup lang="ts">
import { computed, useId, useTemplateRef } from "vue";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import { toLogical, toScreen, type Viewport } from "../../../src/studio/viewport.ts";
import { CONTROL_VALUES, maskFillPath, maskOutlinePath } from "./studioView.ts";
import type { GhostProbe } from "./useGhostProbe.ts";

/**
 * The ghost-actor overlay for one picture pane: the probe's cel drawn where
 * the engine would draw it (hidden pixels faint and hatched), its baseline and
 * footprint control hits, a drag handle and a readout card. It fills its
 * positioned parent exactly like StudioCanvas's own overlay, so it must sit
 * over a pane at the pane's origin. State lives in `useGhostProbe`.
 *
 * Mounting (the harness's `?probe=1` entry does the same): the host creates
 * `useGhostProbe({ views: listGameViews(files, profile), picture, profile,
 * priorityBase })`, wraps the art pane in a `position: relative` box with
 * this component beside the StudioCanvas, adds a pressed-state tool button
 * calling `probe.toggle()`, and routes its root keydown through
 * `probe.handleStudioKey` for G. Arrow keys on the focused ghost call
 * preventDefault, so a host that skips prevented keys keeps its own arrows.
 */
const {
  probe,
  viewport,
  describeCell = undefined,
} = defineProps<{
  probe: GhostProbe;
  viewport: Viewport;
  /** The priority-plane item owning a cell, for the verdict. */
  describeCell?: ((x: number, y: number) => string | undefined) | undefined;
}>();

const hatchId = `ghost-hatch-${useId()}`;
const root = useTemplateRef("root");
const width = computed(() => SCREEN_WIDTH * viewport.pixelAspect * viewport.zoom);
const height = computed(() => SCREEN_HEIGHT * viewport.zoom);

// The probe object is fixed for the component's life; its refs are the state.
const {
  result,
  pixels,
  cel,
  x,
  baselineY,
  loop,
  celIndex,
  loopCount,
  celCount,
  viewNumber,
  priority: fixedPriority,
} = probe;

function colourMasks(hidden: boolean): { color: number; d: string }[] {
  const masks = new Map<number, Uint8Array>();
  for (const pixel of pixels.value) {
    if (pixel.hidden !== hidden) continue;
    let mask = masks.get(pixel.color);
    if (!mask) masks.set(pixel.color, (mask = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT)));
    mask[pixel.cell] = 1;
  }
  return [...masks].map(([color, mask]) => ({ color, d: maskFillPath(mask) }));
}
const drawnLayers = computed(() => colourMasks(false));
const hiddenLayers = computed(() => colourMasks(true));
const hiddenPath = computed(() => (result.value ? maskFillPath(result.value.hiddenMask) : ""));
const outline = computed(() => {
  const mask = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  for (const pixel of pixels.value) mask[pixel.cell] = 1;
  return maskOutlinePath(mask);
});

/** The cel's box in pane pixels; the probe keeps it on the surface, so the blit never shifts it. */
const box = computed(() => {
  const c = cel.value;
  if (!c) return null;
  const top = toScreen(viewport, x.value, baselineY.value - c.height + 1);
  if (!top) return null;
  return {
    left: `${top.x}px`,
    top: `${top.y}px`,
    width: `${c.width * viewport.pixelAspect * viewport.zoom}px`,
    height: `${c.height * viewport.zoom}px`,
  };
});

const hiddenCount = computed(() => pixels.value.filter((p) => p.hidden).length);
const underBaseline = computed(() => {
  const c = cel.value;
  const r = result.value;
  if (!c || !r) return null;
  const cx = Math.min(SCREEN_WIDTH - 1, x.value + (c.width >> 1));
  const value = probe.picture.value.priority[baselineY.value * SCREEN_WIDTH + cx] ?? 4;
  const control = CONTROL_VALUES[value];
  const label = describeCell?.(cx, baselineY.value);
  const name = control ? `${control.name} line` : value === 4 ? "background" : `priority ${value}`;
  return { value, text: label ? `${label} · ${name}` : name };
});

/** The item that hides most hidden pixels, named by the host, else by its priority. */
const occluder = computed(() => {
  const r = result.value;
  if (!r || hiddenCount.value === 0) return "";
  const counts = new Map<string, number>();
  const priority = probe.picture.value.priority;
  for (const pixel of pixels.value) {
    if (!pixel.hidden) continue;
    const px = pixel.cell % SCREEN_WIDTH;
    const py = (pixel.cell - px) / SCREEN_WIDTH;
    const name = describeCell?.(px, py) ?? `priority ${priority[pixel.cell]}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
});

const verdict = computed(() => {
  const total = pixels.value.length;
  if (total === 0) return { kind: "empty", text: "No opaque pixels on the surface" };
  if (hiddenCount.value === 0) return { kind: "front", text: `In front · all ${total} px drawn` };
  const kind = hiddenCount.value === total ? "hidden" : "behind";
  return {
    kind,
    text: `Behind ${occluder.value} · ${hiddenCount.value} of ${total} px hidden`,
  };
});

const hits = computed(() =>
  (result.value?.controlHits ?? []).map((hit) => {
    const xs = hit.cells.map((cell) => cell.x);
    const runs: string[] = [];
    for (let i = 0; i < xs.length;) {
      let j = i;
      while (j + 1 < xs.length && xs[j + 1] === xs[j]! + 1) j++;
      runs.push(i === j ? `${xs[i]}` : `${xs[i]}–${xs[j]}`);
      i = j + 1;
    }
    return { ...hit, name: CONTROL_VALUES[hit.value]!.name, runs: runs.join(", ") };
  }),
);
const footprintText = computed(() => {
  const footprint = result.value?.footprint;
  if (!footprint) return "";
  if (footprint.bypassed) return "Priority 15 skips the footprint test";
  if (footprint.accepted) {
    const { signal, water } = footprint.controls;
    return `Footprint accepted${signal ? " · signal (f3 for ego)" : ""}${water ? " · all water (f0 for ego)" : ""}`;
  }
  return footprint.controls.barrier ? "Blocked by a barrier" : "Blocked unless ignore.blocks";
});

/** The readout sits on the side of the pane away from the ghost. */
const cardSide = computed(() => (x.value < SCREEN_WIDTH / 2 ? "right" : "left"));

const PRIORITIES = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
const viewLabel = (number: number, description: string | undefined): string =>
  description ? `VIEW ${number} · ${description}` : `VIEW ${number}`;

let grab: { dx: number; dy: number } | undefined;
function logicalAt(event: PointerEvent) {
  const rect = root.value!.getBoundingClientRect();
  return toLogical(viewport, event.clientX - rect.left, event.clientY - rect.top, { clamp: true })!;
}
function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const at = logicalAt(event);
  grab = { dx: at.x - x.value, dy: at.y - baselineY.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  (event.currentTarget as HTMLElement).focus({ preventScroll: true });
  event.preventDefault();
}
function onPointerMove(event: PointerEvent): void {
  if (!grab) return;
  const at = logicalAt(event);
  probe.moveTo(at.x - grab.dx, at.y - grab.dy);
}
function onPointerUp(): void {
  grab = undefined;
}

/** Arrows cycle cel (left/right) and loop (up/down); with Shift they nudge by one pixel. */
function onKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const nudge: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const step = nudge[event.key];
  if (!step) return;
  if (event.shiftKey) probe.moveTo(x.value + step[0], baselineY.value + step[1]);
  else if (step[0] !== 0) probe.cycleCel(step[0] as 1 | -1);
  else probe.cycleLoop(step[1] as 1 | -1);
  event.preventDefault();
}
</script>

<template>
  <div
    v-if="probe.active.value"
    ref="root"
    class="ghost"
    data-testid="ghost-probe"
    :data-verdict="verdict.kind"
    :style="{ width: `${width}px`, height: `${height}px` }"
  >
    <svg
      class="ghost__svg"
      :viewBox="`0 0 ${SCREEN_WIDTH} ${SCREEN_HEIGHT}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <pattern
          :id="hatchId"
          width="1.5"
          height="1.5"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="1.5" class="ghost__hatch" />
        </pattern>
      </defs>
      <line
        class="ghost__baseline-guide"
        x1="0"
        :x2="SCREEN_WIDTH"
        :y1="baselineY + 0.5"
        :y2="baselineY + 0.5"
        vector-effect="non-scaling-stroke"
      />
      <path
        v-for="layer in drawnLayers"
        :key="`d${layer.color}`"
        data-role="ghost-drawn"
        :d="layer.d"
        :style="{ fill: `var(--agi-${layer.color})` }"
      />
      <g class="ghost__hidden">
        <path
          v-for="layer in hiddenLayers"
          :key="`h${layer.color}`"
          :d="layer.d"
          :style="{ fill: `var(--agi-${layer.color})` }"
        />
      </g>
      <path data-role="ghost-hidden" :d="hiddenPath" :fill="`url(#${hatchId})`" />
      <path class="ghost__outline" :d="outline" vector-effect="non-scaling-stroke" />
      <line
        v-if="cel"
        class="ghost__baseline"
        data-role="ghost-baseline"
        :x1="x"
        :x2="x + cel.width"
        :y1="baselineY + 0.5"
        :y2="baselineY + 0.5"
        vector-effect="non-scaling-stroke"
      />
      <template v-for="hit in result?.controlHits ?? []" :key="hit.value">
        <rect
          v-for="cell in hit.cells"
          :key="cell.x"
          class="ghost__hit"
          data-role="ghost-control"
          :data-value="hit.value"
          :x="cell.x"
          :y="cell.y"
          width="1"
          height="1"
          :style="{ stroke: `var(--agi-${CONTROL_VALUES[hit.value]!.colour})` }"
          vector-effect="non-scaling-stroke"
        />
      </template>
    </svg>

    <div
      v-if="box"
      class="ghost__handle"
      data-testid="ghost-probe-handle"
      tabindex="0"
      role="application"
      :aria-label="`Ghost actor at x ${x}, baseline ${baselineY}. Drag to move; arrows change cel and loop; Shift+arrows nudge.`"
      :style="box"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onKeydown"
    ></div>

    <aside
      class="ghost__card"
      :class="`ghost__card--${cardSide}`"
      data-testid="ghost-probe-readout"
      aria-label="Ghost actor probe"
      aria-live="polite"
    >
      <header class="ghost__head">
        <b>Ghost actor</b>
        <span class="ghost__note" data-role="ghost-note">Static probe — not a walk test</span>
      </header>
      <label class="ghost__row">
        <span class="ghost__key">View</span>
        <select v-model="viewNumber" class="ghost__select" data-role="ghost-view">
          <option v-for="entry in probe.views.value" :key="entry.number" :value="entry.number">
            {{ viewLabel(entry.number, entry.view.description) }}
          </option>
        </select>
      </label>
      <p class="ghost__row" data-role="ghost-cel">
        <span class="ghost__key">Cel</span>
        <span>loop {{ loop }}/{{ loopCount }} · cel {{ celIndex }}/{{ celCount }}</span>
        <span class="ghost__hint">←→ cel · ↑↓ loop · ⇧ move</span>
      </p>
      <label class="ghost__row">
        <span class="ghost__key">Priority</span>
        <select v-model="fixedPriority" class="ghost__select" data-role="ghost-priority">
          <option value="band">Baseline band</option>
          <option v-for="p in PRIORITIES" :key="p" :value="p">Fixed {{ p }}</option>
        </select>
      </label>
      <p class="ghost__row" data-role="ghost-band">
        <span class="ghost__key">Baseline</span>
        <span
          >x {{ x }} y {{ baselineY }} → band {{ result?.bandPriority
          }}<template v-if="result && fixedPriority !== 'band'">
            · draws at {{ result.drawPriority }}</template
          ></span
        >
      </p>
      <p v-if="underBaseline" class="ghost__row" data-role="ghost-under">
        <span class="ghost__key">Under</span>
        <span>{{ underBaseline.text }}</span>
      </p>
      <p class="ghost__verdict" :data-kind="verdict.kind" data-role="ghost-verdict">
        {{ verdict.text }}
      </p>
      <div class="ghost__controls" data-role="ghost-controls">
        <p class="ghost__row">
          <span class="ghost__key">Footprint</span>
          <span>{{ footprintText }}</span>
        </p>
        <p
          v-for="hit in hits"
          :key="hit.value"
          class="ghost__hit-row"
          data-role="ghost-control-hit"
          :data-value="hit.value"
        >
          <i :style="{ background: `var(--agi-${CONTROL_VALUES[hit.value]!.colour})` }"></i>
          {{ hit.value }} · {{ hit.name }}: x {{ hit.runs }} at y {{ hit.cells[0]!.y }}
        </p>
        <p v-if="hits.length === 0" class="ghost__hit-row ghost__hit-row--none">
          No control lines under the baseline
        </p>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.ghost {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}
.ghost__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.ghost__hidden {
  opacity: 0.3;
}
.ghost__hatch {
  stroke: var(--ink);
  stroke-width: 0.4;
  stroke-opacity: 0.7;
}
.ghost__outline {
  fill: none;
  stroke: var(--action);
  stroke-width: 1px;
  stroke-dasharray: 2 2;
}
.ghost__baseline-guide {
  stroke: var(--action);
  stroke-opacity: 0.35;
  stroke-width: 1px;
  stroke-dasharray: 4 3;
}
.ghost__baseline {
  stroke: var(--action);
  stroke-width: 2px;
}
.ghost__hit {
  fill: none;
  stroke-width: 2px;
}
.ghost__handle {
  position: absolute;
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
  border-radius: var(--radius-sm);
}
.ghost__handle:active {
  cursor: grabbing;
}
.ghost__handle:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.ghost__card {
  position: absolute;
  font-family: var(--font-sans);
  top: var(--space-3);
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-1);
  width: 16rem;
  max-width: calc(50% - var(--space-5));
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  color: var(--ink-2);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  pointer-events: auto;
}
.ghost__card--right {
  right: var(--space-3);
}
.ghost__card--left {
  left: var(--space-3);
}
.ghost__card p {
  margin: 0;
}
.ghost__head {
  display: grid;
  gap: var(--space-0);
  color: var(--ink);
  font-size: var(--text-sm);
}
.ghost__note {
  color: var(--warn);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.ghost__row {
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr);
  align-items: baseline;
  gap: var(--space-0) var(--space-2);
}
.ghost__key {
  color: var(--ink-3);
}
.ghost__hint {
  grid-column: 2;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.ghost__select {
  width: 100%;
  min-width: 0;
  padding: var(--space-0) var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--ink);
  font: inherit;
}
.ghost__verdict {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--ok-soft);
  color: var(--ok);
  font-weight: var(--weight-semibold);
}
.ghost__verdict[data-kind="behind"],
.ghost__verdict[data-kind="hidden"] {
  background: var(--warn-soft);
  color: var(--warn);
}
.ghost__controls {
  display: grid;
  gap: var(--space-0);
}
.ghost__hit-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-mono);
}
.ghost__hit-row i {
  width: var(--space-3);
  height: var(--space-3);
  flex: none;
  border-radius: var(--radius-sm);
}
.ghost__hit-row--none {
  color: var(--ink-3);
  font-family: inherit;
}
</style>
