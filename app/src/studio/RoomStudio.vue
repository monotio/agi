<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiChip from "../ui/UiChip.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { pictureCommandText } from "../../../src/studio/pictureDocument.ts";
import DrawOrderScrubber from "./DrawOrderScrubber.vue";
import PixelInspector from "./PixelInspector.vue";
import SceneList from "./SceneList.vue";
import StudioCanvas, { type MaskPaths } from "./StudioCanvas.vue";
import {
  bandGuides,
  CONTROL_VALUES,
  controlLabels,
  maskFillPath,
  maskOutlinePath,
  panesFor,
  patternOn,
  priorityMeaning,
  tickFor,
  type PaneLayer,
  type StudioLens,
  type StudioViewMode,
} from "./studioView.ts";
import { filterScene, lensPlanes, useStudioDocument } from "./useStudioDocument.ts";
import { useStudioSelection } from "./useStudioSelection.ts";
import { useStudioViewport } from "./useStudioViewport.ts";

/**
 * Room Studio (rc.1, read-only): one picture's items, draw order and planes.
 * Self-contained: it takes the picture bytes (and authored text, trusted only
 * while it compiles to those bytes) and never talks to the worker or storage.
 * Keys are handled at the root and stopped, so none reach the game, and focus
 * never falls out of the studio while it is open.
 */
const {
  pictureNumber,
  bytes,
  authoredSource = undefined,
  profile,
  title,
  subtitle = undefined,
} = defineProps<{
  pictureNumber: number;
  bytes: Uint8Array;
  authoredSource?: string | undefined;
  profile: AgiProfile;
  title: string;
  subtitle?: string | undefined;
}>();
const emit = defineEmits<{ close: [] }>();

const doc = useStudioDocument(() => ({ bytes, authoredSource, profile }));
const { model, playhead, total, surface } = doc;
const lens = ref<StudioLens>("art");
const mode = ref<StudioViewMode>("blend");
const showBands = ref(true);
const filter = ref("");

const LENSES = [
  { value: "art", label: "Art", shortcut: "1" },
  { value: "depth", label: "Depth", shortcut: "2" },
  { value: "walk", label: "Walk", shortcut: "3" },
] as const;
const MODES = [
  { value: "blend", label: "Blend" },
  { value: "split", label: "Split" },
  { value: "priority", label: "Priority only" },
] as const;
const PANE_LABELS: Record<PaneLayer, string> = {
  art: "Picture, visual plane",
  depth: "Picture with the priority plane blended over it",
  "depth-only": "Priority plane",
  walk: "Picture dimmed, with control lines",
  "walk-only": "Control lines on the priority plane",
};

const scene = computed(() => filterScene(model.value, filter.value));
const matches = computed(() => scene.value.matches);
const loose = computed(() => scene.value.loose);
const selection = useStudioSelection({
  rows: () => scene.value.steps,
  allRows: () => [...model.value.rows, ...model.value.folds],
  rowAt: (x, y) => doc.rowAtForLens(x, y, lens.value),
  membersOf: (id) => model.value.folds.find((fold) => fold.id === id)?.members,
});
const { hoveredId, selectedId, selectedRow, inspectedCell, pinnedCell, announcement } = selection;

const stage = useTemplateRef("stage");
const panes = computed(() => panesFor(lens.value, mode.value));
const { viewport, zoom, dpr, fitted, zoomBy, zoomToFit } = useStudioViewport(
  stage,
  () => panes.value.length,
);

function paths(id: string | undefined): MaskPaths | null {
  if (id === undefined) return null;
  const mask = doc.rowMask(id, lens.value);
  return { fill: maskFillPath(mask), outline: maskOutlinePath(mask) };
}
const hoverPaths = computed(() => paths(hoveredId.value));
const selectionPaths = computed(() => paths(selectedId.value));
const guides = computed(() => (showBands.value && lens.value !== "art" ? bandGuides() : null));
const labels = computed(() =>
  lens.value === "walk" ? controlLabels(surface.value.priority) : null,
);

const commandText = (entry: number): string => {
  const line = model.value.timeline[entry]?.line;
  return line === undefined ? "" : pictureCommandText(model.value.document.lines[line - 1] ?? "");
};
/** One tick per drawing command; the closing `end` draws nothing and gets none. */
const ticks = computed(() => model.value.timeline.slice(0, total.value).map(tickFor));
const current = computed(() => {
  const entry = model.value.timeline[playhead.value - 1];
  if (!entry) return "";
  const owner =
    entry.itemId === undefined ? undefined : model.value.rows.find((r) => r.id === entry.itemId);
  return `${commandText(playhead.value - 1)}${owner ? ` · ${owner.label}` : ""}`;
});
const drawn = (pick: "visual" | "priority"): number[] => {
  const row = selectedRow.value;
  if (!row) return [];
  const values = row.entries
    .map((k) => model.value.timeline[k]!)
    .filter((entry) => tickFor(entry).kind !== "state")
    .map((entry) => entry[pick])
    .filter((value): value is number => value !== null);
  return [...new Set(values)].sort((a, b) => a - b);
};
const inspectorCommands = computed(() =>
  (selectedRow.value?.entries ?? []).map((entry) => ({
    entry,
    line: model.value.timeline[entry]!.line,
    text: commandText(entry),
  })),
);
const pixel = computed(() =>
  inspectedCell.value ? doc.pixelInfo(inspectedCell.value.x, inspectedCell.value.y) : null,
);
const fill = computed(() =>
  pinnedCell.value && playhead.value > 0
    ? doc.explainFill(playhead.value - 1, pinnedCell.value.x, pinnedCell.value.y)
    : undefined,
);
const labelOf = (id: string): string =>
  [...model.value.rows, ...model.value.folds].find((row) => row.id === id)?.label ?? id;
/** The subtitle's parts that add something beyond the title and the PIC chip. */
const subtitleExtra = computed(() => {
  const known = [title.toLowerCase(), `pic ${pictureNumber}`];
  const parts = (subtitle ?? "")
    .split("·")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !known.includes(part.toLowerCase()));
  return parts.join(" · ");
});
const status = computed(() => {
  const info = pixel.value;
  if (!info) return "Point at the picture to read a pixel";
  const plane = info[lensPlanes(lens.value)[0]];
  const by =
    plane.entry === null ? "not drawn" : `last written by #${plane.entry + 1} ${plane.text ?? ""}`;
  return `x ${info.x}  y ${info.y} · visual ${info.visual.value} · priority ${info.priority.value} (${priorityMeaning(info.priority.value)}) · ${by}`;
});

function seek(k: number): void {
  playhead.value = Math.min(total.value, Math.max(0, k));
}

const root = useTemplateRef("root");
onMounted(() => root.value?.focus({ preventScroll: true }));

/**
 * After a key or click inside the studio has taken effect, a focused control
 * may have gone (a lens change hides Planes and Bands) or never taken focus
 * (Safari leaves clicked buttons unfocused). Focus then returns to the root,
 * so the studio shortcuts keep working instead of the keys landing on the page.
 */
function keepFocus(): void {
  void nextTick(() => {
    const element = root.value;
    const active = document.activeElement;
    if (element?.isConnected && (active === null || active === document.body))
      element.focus({ preventScroll: true });
  });
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** Canvas arrows: Up/Left the previous item in draw order, Down/Right the next. */
const ARROW_STEPS: Record<string, 1 | -1> = {
  ArrowUp: -1,
  ArrowLeft: -1,
  ArrowDown: 1,
  ArrowRight: 1,
};

/**
 * Studio shortcuts, for any key pressed inside the studio (widgets such as
 * the Scene list, the lens switch and the scrubber keep the keys they use).
 * Every key stops here so the game never sees it.
 */
function onKeydown(event: KeyboardEvent): void {
  event.stopPropagation();
  handleKey(event);
  keepFocus();
}
function handleKey(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (typing(event.target)) return;
  const arrow = ARROW_STEPS[event.key];
  if (arrow !== undefined) {
    if (event.target !== stage.value) return;
    selection.step(arrow);
    event.preventDefault();
    return;
  }
  const lensKey = LENSES.find((option) => option.shortcut === event.key);
  if (lensKey) lens.value = lensKey.value;
  else if (event.key === ",") seek(playhead.value - 1);
  else if (event.key === ".") seek(playhead.value + 1);
  else if (event.key === "Home") seek(0);
  else if (event.key === "End") seek(total.value);
  else if (event.key === "+" || event.key === "=") zoomBy(1);
  else if (event.key === "-") zoomBy(-1);
  else if (event.key === "0") zoomToFit();
  else return;
  event.preventDefault();
}
</script>

<template>
  <div
    ref="root"
    class="studio"
    data-testid="room-studio"
    tabindex="-1"
    role="region"
    :aria-label="`Room Studio: ${title}`"
    @keydown="onKeydown"
    @keyup.stop
    @keypress.stop
    @click="keepFocus"
  >
    <header class="studio__top">
      <div class="studio__crumbs">
        <UiIconButton icon="chevron-left" label="Back" size="sm" @click="emit('close')" />
        <b class="studio__title">{{ title }}</b>
        <UiChip data-testid="studio-picture">PIC {{ pictureNumber }}</UiChip>
        <span v-if="subtitleExtra" class="studio__subtitle">{{ subtitleExtra }}</span>
      </div>
      <UiSegmented v-model="lens" class="studio__lenses" label="Lens" :options="LENSES" />
      <div class="studio__meta">
        <UiChip v-if="model.diagnostics.length > 0" tone="warn" dot>
          {{ model.diagnostics.length }} annotation issues
        </UiChip>
        <UiChip data-role="size" data-testid="studio-bytes"
          >{{ bytes.length }} B · {{ total }} cmds</UiChip
        >
        <UiChip tone="warn"><UiIcon name="lock" :size="12" />View only</UiChip>
        <UiIconButton
          icon="x"
          label="Close studio"
          shortcut="Esc"
          data-testid="studio-close"
          @click="emit('close')"
        />
      </div>
    </header>

    <SceneList
      v-model:filter="filter"
      class="studio__scene"
      :branches="model.branches"
      :sections="model.sections"
      :matches
      :loose
      :hovered-id="hoveredId"
      :selected-id="selectedId"
      @hover="selection.listHover.value = $event"
      @select="selectedId = $event"
    />

    <main class="studio__frame">
      <div
        ref="stage"
        class="studio__stage"
        tabindex="0"
        role="group"
        aria-label="Canvas. Arrow keys step through items in draw order; click a pixel to inspect it."
      >
        <div class="studio__panes">
          <StudioCanvas
            v-for="layer in panes"
            :key="layer"
            :layer
            :label="PANE_LABELS[layer]"
            :visual="surface.visual"
            :priority="surface.priority"
            :viewport
            :dpr
            :highlight="hoverPaths"
            :selection="selectionPaths"
            :guides="layer === 'art' ? null : guides"
            :labels="layer === 'art' ? null : labels"
            @hover="selection.canvasCell.value = $event"
            @pick="selection.pick"
          />
        </div>
      </div>
      <div class="studio__float" role="toolbar" aria-label="View">
        <UiSegmented
          v-if="lens !== 'art'"
          v-model="mode"
          size="sm"
          label="Planes"
          :options="MODES"
        />
        <UiButton
          v-if="lens !== 'art'"
          variant="ghost"
          size="sm"
          class="studio__toggle"
          :aria-pressed="showBands"
          @click="showBands = !showBands"
        >
          Bands
        </UiButton>
        <span v-if="lens === 'art'" class="studio__float-note">Art lens · visual plane</span>
      </div>
      <figure v-if="lens === 'walk'" class="studio__legend" data-role="control-legend">
        <figcaption>Control lines</figcaption>
        <div v-for="control in CONTROL_VALUES" :key="control.value" class="studio__legend-row">
          <svg viewBox="0 0 8 2" width="32" height="8" aria-hidden="true">
            <rect
              v-for="x in 8"
              :key="x"
              :x="x - 1"
              y="0"
              width="1"
              height="2"
              :style="{
                fill: `var(--agi-${control.colour})`,
                opacity: patternOn(control.pattern, x - 1, 0) ? 1 : 0.45,
              }"
            />
          </svg>
          <span>{{ control.value }} · {{ control.name }}</span>
        </div>
      </figure>
      <div class="studio__zoom" role="group" aria-label="Zoom">
        <UiIconButton icon="zoom-out" label="Zoom out" shortcut="-" size="sm" @click="zoomBy(-1)" />
        <span class="studio__zoom-level">{{ zoom * 100 }}% · 2:1 px</span>
        <UiIconButton icon="zoom-in" label="Zoom in" shortcut="+" size="sm" @click="zoomBy(1)" />
        <UiIconButton
          icon="fit"
          label="Zoom to fit"
          shortcut="0"
          size="sm"
          :pressed="fitted"
          @click="zoomToFit"
        />
      </div>
    </main>

    <DrawOrderScrubber
      v-model="playhead"
      class="studio__scrubber"
      :ticks
      :marked="selectedRow?.entries ?? []"
      :command="current"
    />

    <PixelInspector
      class="studio__inspector"
      :row="selectedRow"
      :commands="inspectorCommands"
      :colours="drawn('visual')"
      :priorities="drawn('priority')"
      :pixel
      :pinned="selection.canvasCell.value === undefined && pinnedCell !== undefined"
      :fill
      :trusted="model.trusted"
      :playhead
      :label-of="labelOf"
      @seek="seek"
      @select="selectedId = $event"
    />

    <footer class="studio__status">
      <span data-role="status">{{ status }}</span>
      <span class="studio__spacer"></span>
      <span>AGI {{ profile.id }} profile</span>
      <span>{{ model.trusted ? "authored source" : "disassembled" }}</span>
    </footer>
    <p class="studio__sr" aria-live="polite" data-role="announce">{{ announcement }}</p>
  </div>
</template>

<style scoped>
.studio__subtitle {
  overflow: hidden;
  color: var(--ink-3);
  font-size: var(--text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.studio {
  position: relative;
  display: grid;
  grid-template-rows: 52px minmax(0, 1fr) 92px 28px;
  grid-template-columns: 256px minmax(0, 1fr) 300px;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: var(--ink);
  background: var(--surface-1);
  font: var(--text-sm) / var(--leading) var(--font-sans);
  outline: 0;
}
.studio__top {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: var(--space-5);
  padding: 0 var(--space-4) 0 var(--space-3);
  border-bottom: 1px solid var(--hairline);
}
.studio__crumbs {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.studio__title {
  overflow: hidden;
  font-weight: var(--weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.studio__meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
}
.studio__scene {
  grid-row: 2 / 4;
  grid-column: 1;
  border-right: 1px solid var(--hairline);
}
.studio__frame {
  position: relative;
  grid-row: 2;
  grid-column: 2;
  min-width: 0;
  min-height: 0;
  background-color: var(--surface-sunken);
  background-image: radial-gradient(var(--surface-3) 1px, transparent 1px);
  background-size: 16px 16px;
}
.studio__stage {
  position: absolute;
  inset: 0;
  display: flex;
  overflow: auto;
  outline: 0;
}
.studio__stage:focus-visible {
  box-shadow: inset 0 0 0 2px var(--focus);
}
/* Gap and inset match PANE_GAP and STAGE_INSET in useStudioViewport.ts. */
.studio__panes {
  display: flex;
  gap: var(--space-5);
  margin: auto;
  padding: var(--space-7);
}
.studio__float {
  position: absolute;
  top: var(--space-4);
  left: 50%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-0);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
  transform: translateX(-50%);
}
.studio__float :deep(.ui-seg) {
  border: 0;
  background: transparent;
}
.studio__float-note {
  padding: var(--space-1) var(--space-3);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.studio__toggle[aria-pressed="true"] {
  color: var(--action);
  background: var(--action-soft);
}
.studio__legend {
  position: absolute;
  bottom: var(--space-4);
  left: var(--space-4);
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
  font-size: var(--text-xs);
}
.studio__legend figcaption {
  color: var(--ink-3);
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.studio__legend-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--ink-2);
}
.studio__zoom {
  position: absolute;
  right: var(--space-4);
  bottom: var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-0);
  padding: var(--space-0);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
}
.studio__zoom-level {
  padding: 0 var(--space-2);
  white-space: nowrap;
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.studio__scrubber {
  grid-row: 3;
  grid-column: 2;
}
.studio__inspector {
  grid-row: 2 / 4;
  grid-column: 3;
}
.studio__status {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--space-5);
  padding: 0 var(--space-4);
  border-top: 1px solid var(--hairline);
  color: var(--ink-3);
  background: var(--surface-0);
  font: var(--text-2xs) var(--font-mono);
  white-space: nowrap;
}
.studio__status [data-role="status"] {
  overflow: hidden;
  color: var(--ink-2);
  text-overflow: ellipsis;
}
.studio__spacer {
  flex: 1;
}
.studio__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
