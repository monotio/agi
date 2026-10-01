<script setup lang="ts">
import { computed } from "vue";
import { SCREEN_WIDTH } from "../../../src/types.ts";
import UiExplain from "../ui/UiExplain.vue";
import { explain } from "./studioTerms.ts";
import { keyLabel } from "../ui/keyLabel.ts";
import { VOCABULARY } from "../../../src/vocabulary.ts";
import { CONTROL_VALUES } from "./studioView.ts";
import type { GhostProbe } from "./useGhostProbe.ts";

/**
 * The probe's readout, docked at the top of the inspector while the probe
 * stands on the picture (GhostProbe.vue draws the figure and its handle):
 * which view, loop and cel, the priority it draws at, where its feet stand
 * and what the engine makes of that spot.
 */
const { probe, describeCell = undefined } = defineProps<{
  probe: GhostProbe;
  /** The priority-plane item owning a cell, for the verdict. */
  describeCell?: ((x: number, y: number) => string | undefined) | undefined;
}>();

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

const hiddenCount = computed(() => pixels.value.filter((p) => p.hidden).length);
/** What the feet stand on: the item and its priority there. */
const standing = computed(() => {
  const c = cel.value;
  const r = result.value;
  if (!c || !r) return null;
  const cx = Math.min(SCREEN_WIDTH - 1, x.value + (c.width >> 1));
  const value = probe.picture.value.priority[baselineY.value * SCREEN_WIDTH + cx] ?? 4;
  const control = CONTROL_VALUES[value];
  const label = describeCell?.(cx, baselineY.value);
  const name = control ? `${control.name} line` : value === 4 ? "background" : `depth ${value}`;
  return label ? `${label} · ${name}` : name;
});

/** The item that hides most hidden pixels, named by the host, else by its priority. */
const occluder = computed(() => {
  if (!result.value || hiddenCount.value === 0) return "";
  const counts = new Map<string, number>();
  const priority = probe.picture.value.priority;
  for (const pixel of pixels.value) {
    if (!pixel.hidden) continue;
    const px = pixel.cell % SCREEN_WIDTH;
    const py = (pixel.cell - px) / SCREEN_WIDTH;
    const name = describeCell?.(px, py) ?? `depth ${priority[pixel.cell]}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
});

const verdict = computed(() => {
  const total = pixels.value.length;
  if (total === 0) return { kind: "empty", text: "Place a visible cel on the picture." };
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
  if (footprint.bypassed) return "Anywhere (depth 15)";
  if (footprint.accepted) {
    const { signal, water } = footprint.controls;
    return `Allowed${signal ? " · Trigger (sets flag 3 for the hero)" : ""}${water ? " · Water (sets flag 0 for the hero)" : ""}`;
  }
  return footprint.controls.barrier ? "Stopped at a Wall" : "Stopped at a Gate";
});

const PRIORITIES = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
const viewLabel = (number: number, description: string | undefined): string =>
  description ? `VIEW ${number} · ${description}` : `VIEW ${number}`;
</script>

<template>
  <section
    class="ghost-readout"
    data-testid="ghost-probe-readout"
    aria-label="Stand-in"
    aria-live="polite"
  >
    <div class="ghost-readout__title">
      <h2 class="ghost-readout__head">Stand-in</h2>
      <UiExplain v-bind="explain('ghost')" />
    </div>
    <label class="ghost-readout__row">
      <span class="ghost-readout__key">{{ VOCABULARY.view.label }}</span>
      <select v-model="viewNumber" class="ghost-readout__select" data-role="ghost-view">
        <option v-for="entry in probe.views.value" :key="entry.number" :value="entry.number">
          {{ viewLabel(entry.number, entry.view.description) }}
        </option>
      </select>
    </label>
    <p class="ghost-readout__row" data-role="ghost-cel">
      <span class="ghost-readout__key">Cel</span>
      <span>loop {{ loop }}/{{ loopCount }} · cel {{ celIndex }}/{{ celCount }}</span>
      <span class="ghost-readout__hint">←→ cel · ↑↓ loop · {{ keyLabel("Shift") }} move</span>
    </p>
    <label class="ghost-readout__row">
      <span class="ghost-readout__key ghost-readout__with"
        >Depth <UiExplain v-bind="explain('depth')"
      /></span>
      <select v-model="fixedPriority" class="ghost-readout__select" data-role="ghost-priority">
        <option value="band">Depth band at feet</option>
        <option v-for="p in PRIORITIES" :key="p" :value="p">Fixed {{ p }}</option>
      </select>
    </label>
    <p class="ghost-readout__row" data-role="ghost-band">
      <span class="ghost-readout__key ghost-readout__with"
        >Feet <UiExplain v-bind="explain('feet')"
      /></span>
      <span
        >x {{ x }} y {{ baselineY }} → {{ VOCABULARY.depthBand.label }} {{ result?.bandPriority
        }}<template v-if="result && fixedPriority !== 'band'">
          · draws at {{ result.drawPriority }}</template
        ></span
      >
    </p>
    <p v-if="standing" class="ghost-readout__row" data-role="ghost-under">
      <span class="ghost-readout__key">Standing</span>
      <span>{{ standing }}</span>
    </p>
    <p class="ghost-readout__verdict" :data-kind="verdict.kind" data-role="ghost-verdict">
      {{ verdict.text }}
    </p>
    <div class="ghost-readout__controls" data-role="ghost-controls">
      <p class="ghost-readout__row">
        <span class="ghost-readout__key">Footprint</span>
        <span>{{ footprintText }}</span>
      </p>
      <p
        v-for="hit in hits"
        :key="hit.value"
        class="ghost-readout__hit"
        data-role="ghost-control-hit"
        :data-value="hit.value"
      >
        <i :style="{ background: `var(--agi-${CONTROL_VALUES[hit.value]!.colour})` }"></i>
        {{ hit.value }} · {{ hit.name }}: x {{ hit.runs }} at y {{ hit.cells[0]!.y }}
      </p>
      <p v-if="hits.length === 0" class="ghost-readout__hit ghost-readout__hit--none">
        No walk lines under the feet
      </p>
    </div>
  </section>
</template>

<style scoped>
.ghost-readout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-1);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
  color: var(--ink-2);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
}
.ghost-readout p {
  margin: 0;
}
.ghost-readout__title {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0 0 var(--space-2);
}
.ghost-readout__with {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.ghost-readout__head {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.ghost-readout__row {
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr);
  align-items: baseline;
  gap: var(--space-0) var(--space-2);
}
.ghost-readout__key {
  color: var(--ink-3);
}
.ghost-readout__hint {
  grid-column: 2;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.ghost-readout__select {
  width: 100%;
  min-width: 0;
  padding: var(--space-0) var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--ink);
  font: inherit;
}
.ghost-readout__verdict {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--ok-soft);
  color: var(--ok);
  font-weight: var(--weight-semibold);
}
.ghost-readout__verdict[data-kind="behind"],
.ghost-readout__verdict[data-kind="hidden"] {
  background: var(--warn-soft);
  color: var(--warn);
}
.ghost-readout__controls {
  display: grid;
  gap: var(--space-0);
}
.ghost-readout__hit {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-mono);
}
.ghost-readout__hit i {
  width: var(--space-3);
  height: var(--space-3);
  flex: none;
  border-radius: var(--radius-sm);
}
.ghost-readout__hit--none {
  color: var(--ink-3);
  font-family: inherit;
}
</style>
