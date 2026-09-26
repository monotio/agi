<script setup lang="ts">
/**
 * The inspector's controls for its current tab:
 *
 *   Screen   — view modes (game / Sierra priority / blend / split / GPU
 *              exploded layers), the object overlay, and point-select.
 *   State    — live vars/flags grids with pins, change highlight, and
 *              Sierra's SET VAR / SET FLAG writes; the object table.
 *   Timeline — the per-cycle var/flag diff lane plus the structured
 *              instruction trace stream.
 *
 * Hosted by the floating dock (DebugDock.vue) or Create's Inspect tab; the
 * host draws the tab strip. `viewOnly` (a phone's Create) shows the state
 * without its write controls.
 */
import { computed, ref, useTemplateRef, watch } from "vue";
import { useEngineApi } from "../engineContext.ts";
import { usePresentation } from "../usePresentation.ts";
import {
  describeDebugEvent,
  describeObject,
  formatTraceRecord,
  type DebugViewMode,
  type PickPoint,
} from "../debugView.ts";
import { useInspector } from "./useInspector.ts";

const { viewOnly = false } = defineProps<{ viewOnly?: boolean }>();

const { state } = useEngineApi();
const { debugViewMode, gpuBackend } = usePresentation();
const inspector = useInspector();
const { tab, overlayOn, inspectArmed, hover, picked, report, varEdit } = inspector;
const pickedObject = computed(() => picked.value?.object ?? null);

const COLOR_NAMES = [
  "black",
  "blue",
  "green",
  "cyan",
  "red",
  "magenta",
  "brown",
  "l.gray",
  "d.gray",
  "l.blue",
  "l.green",
  "l.cyan",
  "l.red",
  "l.magenta",
  "yellow",
  "white",
];

const MODES: { id: DebugViewMode; label: string; title: string }[] = [
  { id: "visual", label: "Game", title: "Normal picture" },
  { id: "priority", label: "Priority", title: "Priority surface (Sierra show.pri.screen)" },
  { id: "blend", label: "Blend", title: "Depth ramp over the game; control lines hatch" },
  { id: "split", label: "Split", title: "Half game, half priority" },
  { id: "explode", label: "Layers", title: "Exploded priority layers (GPU, pointer parallax)" },
];

function layerLabel(point: PickPoint): string {
  const b = point.layerBand;
  switch (point.layerKind) {
    case "control":
      return "control lines";
    case "picture":
      return `picture band ${b}`;
    case "sprite":
      return `sprite band ${b}`;
    case "preview":
      return "modal preview";
    case "text":
      return "text surface";
    case "background":
      return "background";
    default:
      return "outside picture band";
  }
}

async function copyPick(): Promise<void> {
  const p = picked.value;
  if (!p) return;
  const payload = {
    logical: p.point.logical,
    displayed: p.point.displayed,
    layer: p.point.layerKind ? { kind: p.point.layerKind, band: p.point.layerBand } : null,
    color: p.inspection.color,
    priority: p.inspection.priority,
    owner: p.inspection.owner,
    object: p.object,
    cycle: p.cycle,
    patchGeneration: p.patchGeneration,
  };
  try {
    await navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
  } catch {
    // Clipboard is optional (permissions); the card stays readable.
  }
}

function togglePin(set: Set<number>, i: number): void {
  if (set.has(i)) set.delete(i);
  else set.add(i);
}

function onVarClick(i: number): void {
  if (!viewOnly) varEdit.value = { index: i, text: String(report.value?.vars[i] ?? 0) };
}

function onFlagClick(i: number): void {
  if (!viewOnly) void inspector.toggleFlag(i);
}

const filter = ref("");
const eventsFiltered = computed(() => {
  const f = filter.value.trim().toLowerCase();
  const list = inspector.events.value;
  if (!f) return list;
  return list.filter((e) => describeDebugEvent(e).toLowerCase().includes(f));
});
const traceFiltered = computed(() => {
  const f = filter.value.trim().toLowerCase();
  const list = state.debugTrace;
  if (!f) return list;
  return list.filter((r) => formatTraceRecord(r).toLowerCase().includes(f));
});

const traceEl = useTemplateRef("traceEl");
watch(
  () => state.debugTrace.length,
  () => {
    const el = traceEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);
</script>

<template>
  <!-- ================= SCREEN ================= -->
  <section v-if="tab === 'screen'" class="dd-body">
    <div class="dd-row dd-modes">
      <button
        v-for="m in MODES"
        :key="m.id"
        type="button"
        class="dd-mode"
        :class="{ on: debugViewMode === m.id }"
        :aria-pressed="debugViewMode === m.id"
        :disabled="m.id === 'explode' && !gpuBackend"
        :title="m.id === 'explode' && !gpuBackend ? 'Needs the GPU stage' : m.title"
        :data-testid="`dbg-mode-${m.id}`"
        @click="debugViewMode = m.id"
      >
        {{ m.label }}
      </button>
    </div>
    <div class="dd-row">
      <label class="dd-check">
        <input
          :checked="overlayOn"
          type="checkbox"
          data-testid="dbg-overlay-toggle"
          @change="inspector.setOverlay(($event.target as HTMLInputElement).checked)"
        />
        Objects
      </label>
      <label class="dd-check">
        <input
          :checked="inspectArmed"
          type="checkbox"
          data-testid="dbg-inspect-toggle"
          @change="inspector.setInspectArmed(($event.target as HTMLInputElement).checked)"
        />
        Inspect
      </label>
      <span v-if="inspectArmed" class="dd-hint">click the scene to latch a pick</span>
    </div>

    <div v-if="inspectArmed && hover?.point" class="dd-hover">
      <template v-if="hover.point.logical">
        ({{ hover.point.logical.x }},{{ hover.point.logical.y }}) disp ({{
          hover.point.displayed.x
        }},{{ hover.point.displayed.y }})
        <template v-if="hover.inspection">
          · {{ COLOR_NAMES[hover.inspection.color] }} · pri {{ hover.inspection.priority }}
          <template v-if="hover.inspection.owner !== null">
            · o{{ hover.inspection.owner }}
          </template>
        </template>
      </template>
      <template v-else>{{ layerLabel(hover.point) }}</template>
    </div>

    <div v-if="picked" class="pick-card" data-testid="dbg-pick">
      <img
        v-if="picked.cropUrl"
        class="pick-crop"
        :src="picked.cropUrl"
        alt="crop around picked pixel"
      />
      <dl class="pick-fields">
        <dt v-if="picked.point.layerKind">layer</dt>
        <dd v-if="picked.point.layerKind">{{ layerLabel(picked.point) }}</dd>
        <dt>logical</dt>
        <dd>({{ picked.point.logical?.x }}, {{ picked.point.logical?.y }})</dd>
        <dt>displayed</dt>
        <dd>({{ picked.point.displayed.x }}, {{ picked.point.displayed.y }})</dd>
        <dt>pixel</dt>
        <dd>{{ COLOR_NAMES[picked.inspection.color] }} · pri {{ picked.inspection.priority }}</dd>
        <dt>owner</dt>
        <dd>{{ pickedObject ? describeObject(pickedObject) : "background" }}</dd>
        <dt>cycle</dt>
        <dd>{{ picked.cycle }} · rev {{ picked.patchGeneration }}</dd>
      </dl>
      <div class="dd-row">
        <button type="button" class="ui-button ui-button--secondary" @click="copyPick">
          Copy pick
        </button>
        <button type="button" class="ui-button ui-button--secondary" @click="picked = undefined">
          Clear
        </button>
      </div>
    </div>
  </section>

  <!-- ================= STATE ================= -->
  <section v-else-if="tab === 'state'" class="dd-body">
    <div class="dd-row dd-statehead">
      <span
        >room {{ report?.room ?? "?" }} · ego ({{ report?.egoX }},{{ report?.egoY }}) dir
        {{ report?.egoDirection }}</span
      >
      <span>rev {{ report?.patchGeneration ?? 0 }}</span>
    </div>

    <h3 class="dd-h3">
      Vars
      <span class="dd-hint">{{
        viewOnly ? "alt-click pins" : "click to set · alt-click pins"
      }}</span>
    </h3>
    <div class="cell-grid" data-testid="dbg-vars">
      <button
        v-for="(v, i) in report?.vars ?? []"
        :key="`v${i}`"
        type="button"
        class="cell"
        :class="{
          set: v !== 0,
          hot: inspector.changedVars.value.has(i),
          pin: inspector.pinnedVars.value.has(i),
        }"
        :title="`v${i} = ${v}`"
        @click.exact="onVarClick(i)"
        @click.alt.prevent="togglePin(inspector.pinnedVars.value, i)"
      >
        {{ v }}
      </button>
    </div>
    <form v-if="varEdit" class="dd-row var-edit" @submit.prevent="inspector.applyVar">
      <label
        >v{{ varEdit.index }} =
        <input v-model="varEdit.text" data-testid="dbg-var-set" size="4" autofocus
      /></label>
      <button type="submit" class="ui-button ui-button--secondary">set</button>
      <button type="button" class="ui-button ui-button--secondary" @click="varEdit = undefined">
        ×
      </button>
    </form>
    <div v-if="inspector.pinnedVars.value.size" class="dd-pins">
      <span
        v-for="i in [...inspector.pinnedVars.value].sort((a, b) => a - b)"
        :key="`pv${i}`"
        class="pin-tag"
      >
        v{{ i }}={{ report?.vars[i] ?? "?" }}
      </span>
    </div>

    <h3 class="dd-h3">
      Flags
      <span class="dd-hint">{{
        viewOnly ? "alt-click pins" : "click toggles · alt-click pins"
      }}</span>
    </h3>
    <div class="cell-grid" data-testid="dbg-flags">
      <button
        v-for="(f, i) in report?.flags ?? []"
        :key="`f${i}`"
        type="button"
        class="cell"
        :class="{
          set: f !== 0,
          hot: inspector.changedFlags.value.has(i),
          pin: inspector.pinnedFlags.value.has(i),
        }"
        :title="`f${i} ${f ? 'set' : 'reset'}`"
        @click.exact="onFlagClick(i)"
        @click.alt.prevent="togglePin(inspector.pinnedFlags.value, i)"
      >
        {{ f ? "1" : "·" }}
      </button>
    </div>
    <div v-if="inspector.pinnedFlags.value.size" class="dd-pins">
      <span
        v-for="i in [...inspector.pinnedFlags.value].sort((a, b) => a - b)"
        :key="`pf${i}`"
        class="pin-tag"
      >
        f{{ i }}={{ report?.flags[i] ?? "?" }}
      </span>
    </div>

    <h3 class="dd-h3">Objects</h3>
    <table class="obj-table" data-testid="dbg-objects">
      <tbody>
        <tr v-for="o in state.debugObjects" :key="o.num">
          <td>o{{ o.num }}</td>
          <td>v{{ o.view }} l{{ o.loop }} c{{ o.cel }}</td>
          <td>({{ o.x }},{{ o.y }})</td>
          <td>p{{ o.priority }}</td>
          <td>{{ ["—", "move", "follow", "wander"][o.motionMode] }}</td>
        </tr>
        <tr v-if="!state.debugObjects.length">
          <td colspan="5" class="dd-hint">no animated objects</td>
        </tr>
      </tbody>
    </table>
  </section>

  <!-- ================= TIMELINE ================= -->
  <section v-else class="dd-body">
    <div class="dd-row">
      <input v-model="filter" class="dd-filter" placeholder="filter…" data-testid="dbg-filter" />
      <label class="dd-check">
        <input
          type="checkbox"
          :checked="state.debugChannels.trace"
          data-testid="dbg-trace-toggle"
          @change="inspector.toggleTrace"
        />
        Trace
      </label>
    </div>
    <h3 class="dd-h3">State diffs</h3>
    <ol class="dd-list" data-testid="dbg-events">
      <li v-for="e in eventsFiltered.slice(-300)" :key="e.seq">
        <span class="cyc">c{{ e.cycle }}</span> {{ describeDebugEvent(e) }}
      </li>
      <li v-if="!eventsFiltered.length" class="dd-hint">no writes observed yet</li>
    </ol>
    <h3 class="dd-h3">Instruction trace</h3>
    <ol ref="traceEl" class="dd-list dd-trace" data-testid="dbg-trace">
      <li v-if="state.debugTraceDropped > 0" class="dd-hint" data-testid="dbg-trace-dropped">
        …{{ state.debugTraceDropped }} records dropped while the inspector was stalled
      </li>
      <li v-for="r in traceFiltered.slice(-400)" :key="r.seq">
        <span class="cyc">c{{ r.cycle }}</span> {{ formatTraceRecord(r) }}
      </li>
      <li v-if="!state.debugChannels.trace" class="dd-hint">arm Trace to stream instructions</li>
    </ol>
  </section>
</template>

<style scoped>
.dd-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  color: var(--ink-2);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.dd-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-2) 0;
}
.dd-modes {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-1);
}
.dd-mode {
  padding: var(--space-2) 0;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--action);
  background: transparent;
  font: inherit;
  font-size: var(--text-2xs);
  cursor: pointer;
}
.dd-mode:hover:not(:disabled) {
  border-color: var(--action-hover);
  color: var(--action-hover);
  background: var(--surface-3);
}
.dd-mode.on {
  border-color: var(--action);
  color: var(--action-ink);
  background: var(--action);
}
.dd-mode:disabled {
  opacity: 0.45;
  cursor: default;
}
.dd-check {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  cursor: pointer;
}
.dd-check input {
  accent-color: var(--action);
}
.dd-hint {
  color: var(--ink-3);
  font-size: var(--text-2xs);
  font-style: italic;
}
.dd-hover {
  margin: var(--space-2) 0;
  padding: var(--space-1) var(--space-3);
  overflow: hidden;
  border-left: 2px solid var(--action);
  border-radius: 0 var(--radius) var(--radius) 0;
  color: var(--ink);
  background: var(--surface-0);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dd-h3 {
  display: flex;
  justify-content: space-between;
  margin: var(--space-4) 0 var(--space-2);
  padding-bottom: var(--space-1);
  border-bottom: 1px solid var(--hairline);
  color: var(--action);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.dd-statehead {
  justify-content: space-between;
  color: var(--warn);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}
.pick-card {
  margin-top: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius-lg);
  background: var(--surface-0);
}
.pick-crop {
  display: block;
  width: 100%;
  margin-bottom: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  image-rendering: pixelated;
}
.pick-fields {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-0) var(--space-4);
  margin: 0 0 var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}
.pick-fields dt {
  color: var(--ink-3);
}
.pick-fields dd {
  margin: 0;
  color: var(--ink);
}
.cell-grid {
  display: grid;
  grid-template-columns: repeat(16, 1fr);
  gap: 1px;
  font-family: var(--font-mono);
}
.cell {
  min-width: 0;
  padding: var(--space-0) 0;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--ink-3);
  background: var(--surface-0);
  font: inherit;
  font-size: calc(var(--text-2xs) * 0.82);
  cursor: pointer;
}
.cell.set {
  color: var(--ink);
  background: var(--surface-3);
}
.cell.hot {
  color: var(--warn);
  background: var(--warn-soft);
}
.cell.pin {
  outline: 1px solid var(--action);
}
.var-edit input {
  width: 5ch;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--warn);
  background: var(--surface-sunken);
  font: inherit;
  font-family: var(--font-mono);
}
.dd-pins {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}
.pin-tag {
  padding: 1px var(--space-1);
  border: 1px solid var(--action);
  border-radius: var(--radius-sm);
  color: var(--action);
}
.obj-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}
.obj-table td {
  padding: var(--space-0) var(--space-1);
  border-bottom: 1px dotted var(--hairline);
  white-space: nowrap;
}
.dd-filter {
  flex: 1;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-sunken);
  font: inherit;
  font-size: var(--text-2xs);
}
.dd-list {
  max-height: 180px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  list-style: none;
}
.dd-list li {
  padding: var(--space-0) 0;
  overflow: hidden;
  border-bottom: 1px dotted var(--hairline);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dd-trace {
  max-height: 220px;
}
.cyc {
  margin-right: var(--space-1);
  color: var(--warn);
}
</style>
