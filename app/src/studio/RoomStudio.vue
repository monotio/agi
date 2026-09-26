<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import UiIconButton from "../ui/UiIconButton.vue";
import type { ResourceRevision } from "../../../src/gameIdentity.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { itemHandles } from "../../../src/studio/editPoints.ts";
import { footprintMask } from "../../../src/studio/editValidation.ts";
import DrawOrderScrubber from "./DrawOrderScrubber.vue";
import PixelInspector from "./PixelInspector.vue";
import SceneList from "./SceneList.vue";
import StudioCanvas, { type MaskPaths } from "./StudioCanvas.vue";
import StudioContextBar from "./StudioContextBar.vue";
import StudioItemEditor from "./StudioItemEditor.vue";
import StudioKeepDialog from "./StudioKeepDialog.vue";
import StudioLockNote from "./StudioLockNote.vue";
import StudioStageNotes from "./StudioStageNotes.vue";
import StudioTopBar, { type DraftStatus } from "./StudioTopBar.vue";
import StudioViewBar from "./StudioViewBar.vue";
import { studioKey, type StudioKeyActions } from "./studioKeys.ts";
import { depthValuesLocked, lockedPlanes, NO_UNLOCKS, type LensUnlocks } from "./studioLocks.ts";
import {
  bandGuides,
  controlLabels,
  maskBox,
  maskFillPath,
  maskOutlinePath,
  panesFor,
  type PaneLayer,
  type StudioLens,
  type StudioViewMode,
} from "./studioView.ts";
import { filterScene, resolveStudioSource, useStudioDocument } from "./useStudioDocument.ts";
import { useStudioDraft } from "./useStudioDraft.ts";
import { useStudioDrag } from "./useStudioDrag.ts";
import { useStudioEditing } from "./useStudioEditing.ts";
import { useStudioKeep, type KeepFn, type KeepRecovery } from "./useStudioKeep.ts";
import { useStudioReadout } from "./useStudioReadout.ts";
import { useStudioSelection } from "./useStudioSelection.ts";
import { useStudioViewport } from "./useStudioViewport.ts";

/**
 * Room Studio: one picture's items, draw order and planes, edited as a draft
 * (useStudioDraft) and kept through the resource transaction (useStudioKeep).
 * It takes the picture bytes (and authored text, trusted only while it
 * compiles to those bytes) and the revision they were read at. Keys are
 * handled at the root and stopped (studioKeys.ts), so none reach the game,
 * and focus never falls out of the studio while it is open.
 */
const {
  pictureNumber,
  bytes,
  authoredSource = undefined,
  profile,
  title,
  subtitle = undefined,
  baseRevision = undefined,
  keep: keepFn = undefined,
} = defineProps<{
  pictureNumber: number;
  bytes: Uint8Array;
  authoredSource?: string | undefined;
  profile: AgiProfile;
  title: string;
  subtitle?: string | undefined;
  /** The game revision the bytes were read at; without one the picture is view only. */
  baseRevision?: ResourceRevision | undefined;
  /** The Keep transaction; the engine's when omitted. */
  keep?: KeepFn | undefined;
}>();
const emit = defineEmits<{ close: []; reopen: [] }>();

const lens = ref<StudioLens>("art");
const mode = ref<StudioViewMode>("blend");
const showBands = ref(true);
const filter = ref("");
const unlocks = ref<LensUnlocks>(NO_UNLOCKS);
/** More points than this and the item shows no handles (the inspector still lists them). */
const MAX_HANDLES = 160;
const PANE_LABELS: Record<PaneLayer, string> = {
  art: "Picture, visual plane",
  depth: "Picture with the priority plane blended over it",
  "depth-only": "Priority plane",
  walk: "Picture dimmed, with control lines",
  "walk-only": "Control lines on the priority plane",
};

const resolved = computed(() => resolveStudioSource({ bytes, authoredSource, profile }));
const draft = useStudioDraft({
  base: () => ({ source: resolved.value.source, revision: baseRevision }),
  profile: () => profile,
  lens,
  unlocks,
});
const doc = useStudioDocument(() => ({
  source: draft.source.value,
  trusted: resolved.value.trusted,
  profile,
}));
const { model, playhead, total, surface } = doc;
const scene = computed(() => filterScene(model.value, filter.value));
const selection = useStudioSelection({
  rows: () => scene.value.steps,
  allRows: () => [...model.value.rows, ...model.value.folds],
  rowAt: (x, y) => doc.rowAtForLens(x, y, lens.value),
  membersOf: (id) => model.value.folds.find((fold) => fold.id === id)?.members,
});
const { hoveredId, selectedId, selectedRow, pinnedCell, announcement } = selection;
const readout = useStudioReadout({ doc, selection, lens });
const { ticks, current, drawn, single, pixel, fill, labelOf, status } = readout;
const keeper = useStudioKeep({ draft, pictureNumber: () => pictureNumber, keep: keepFn });
const editing = useStudioEditing({
  draft,
  selectedId,
  frozen: () => draft.kept.value.revision === undefined || keeper.needsReload.value,
});

const stage = useTemplateRef("stage");
const panes = computed(() => panesFor(lens.value, mode.value));
const { viewport, zoom, dpr, fitted, zoomBy, zoomToFit } = useStudioViewport(
  stage,
  () => panes.value.length,
);

/** The planes on screen: the drag's preview while one runs, else the scrubbed draft. */
const shown = computed(() => draft.preview.value?.compiled ?? surface.value);
const editableId = computed(() => editing.editable.value?.id);
const selectionMask = computed(() => {
  const id = selectedId.value;
  if (id === undefined) return null;
  const preview = draft.preview.value;
  if (preview && id === editableId.value) return footprintMask(preview.compiled, id, "both");
  return doc.rowMask(id, lens.value);
});
const pathsOf = (mask: Uint8Array | null): MaskPaths | null =>
  mask && { fill: maskFillPath(mask), outline: maskOutlinePath(mask) };
const drag = useStudioDrag({
  draft,
  editableId: () => editableId.value,
  pick: selection.pick,
  onSelection: ({ x, y }) => selectionMask.value?.[y * 160 + x] === 1,
  labelOf: (id) => editing.item.value?.label ?? id,
  report: editing.report,
});
const hoverPaths = computed(() =>
  drag.dragging.value || hoveredId.value === undefined
    ? null
    : pathsOf(doc.rowMask(hoveredId.value, lens.value)),
);
const selectionPaths = computed(() => pathsOf(selectionMask.value));
const flashPaths = computed(() => pathsOf(editing.flash.value));
const handleList = computed(() => {
  const id = editableId.value;
  return id === undefined
    ? []
    : itemHandles(draft.preview.value?.document ?? draft.document.value, id);
});
const handles = computed(() =>
  handleList.value.length > 0 && handleList.value.length <= MAX_HANDLES ? handleList.value : null,
);
const guides = computed(() => (showBands.value && lens.value !== "art" ? bandGuides() : null));
const labels = computed(() => (lens.value === "walk" ? controlLabels(shown.value.priority) : null));

/** The contextual toolbar sits above the selection (below it near the top), inside the pane. */
const ctxOpen = ref(false);
const ctxAt = computed(() => {
  const mask = selectionMask.value;
  const box = editableId.value === undefined || drag.dragging.value || !mask ? null : maskBox(mask);
  if (!box) return null;
  const { zoom: z, pixelAspect } = viewport.value;
  const above = box.y * z - 44;
  return {
    left: `${Math.max(0, Math.min(box.x * pixelAspect * z, 160 * pixelAspect * z - 360))}px`,
    top: `${above >= 4 ? above : (box.y + box.height) * z + 8}px`,
  };
});

/** The subtitle's parts that add something beyond the title and the PIC chip. */
const subtitleExtra = computed(() => {
  const known = [title.toLowerCase(), `pic ${pictureNumber}`];
  const parts = (subtitle ?? "")
    .split("·")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !known.includes(part.toLowerCase()));
  return parts.join(" · ");
});
const draftStatus = computed<DraftStatus>(() => {
  if (draft.kept.value.revision === undefined) return "view-only";
  if (keeper.needsReload.value) return "reload";
  if (keeper.busy.value) return "keeping";
  if (draft.dirty.value) return "changed";
  return keeper.kept.value ? "kept" : "clean";
});
const lensLock = (plane: "visual" | "priority"): string | null =>
  lockedPlanes(lens.value, unlocks.value).includes(plane)
    ? `locked in the ${lens.value} lens`
    : null;
const itemLocks = computed(() => ({
  visual: lensLock("visual"),
  priority: lensLock("priority"),
  depthValues: depthValuesLocked(lens.value, unlocks.value),
}));

function seek(k: number): void {
  playhead.value = Math.min(total.value, Math.max(0, k));
}

const dialog = ref<"close" | "discard">();
function requestClose(): void {
  if (draft.dirty.value && !keeper.needsReload.value) dialog.value = "close";
  else emit("close");
}
function discardChanges(close: boolean): void {
  dialog.value = undefined;
  draft.discard();
  if (close) emit("close");
  else editing.say({ tone: "ok", text: "Changes discarded." });
}
async function keepChanges(close: boolean): Promise<void> {
  dialog.value = undefined;
  if (!(await keeper.keep())) return;
  if (close) emit("close");
  else editing.say({ tone: "ok", text: `Kept PIC ${pictureNumber}. The game shows the edit now.` });
}
function recover(recovery: KeepRecovery): void {
  if (recovery === "retry") void keepChanges(false);
  else if (recovery === "reload") location.reload();
  else {
    // The draft was made on a game that moved on: start over from the running game.
    keeper.dismiss();
    draft.discard();
    emit("reopen");
  }
}

const root = useTemplateRef("root");
onMounted(() => root.value?.focus({ preventScroll: true }));
if (import.meta.env?.DEV) {
  const hook = {
    bytes: () => draft.compiled.value.bytes.slice(),
    source: () => draft.source.value,
  };
  window.__AGI_STUDIO__ = hook;
  onBeforeUnmount(() => {
    if (window.__AGI_STUDIO__ === hook) delete window.__AGI_STUDIO__;
  });
}

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

const keys: StudioKeyActions = {
  onCanvas: (target) => target === stage.value,
  dismiss: () => {
    if (ctxOpen.value) ctxOpen.value = false;
    else if (!drag.abort()) return false;
    return true;
  },
  close: requestClose,
  lens: (next) => (lens.value = next),
  seek: (to) => seek(to === "first" ? 0 : to === "last" ? total.value : playhead.value + to),
  zoom: (step) => (step === "fit" ? zoomToFit() : zoomBy(step)),
  step: (direction) => selection.step(direction),
  nudge: editing.nudge,
  remove: editing.remove,
  duplicate: editing.duplicate,
  reorder: editing.reorder,
  undo: editing.undo,
  redo: editing.redo,
};
/** Every key stops here so the game never sees it. */
function onKeydown(event: KeyboardEvent): void {
  event.stopPropagation();
  // An open confirmation takes the keys it needs (Esc cancels it) and nothing else runs.
  if (dialog.value !== undefined) return;
  if (studioKey(event, keys)) event.preventDefault();
  keepFocus();
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
    <StudioTopBar
      v-model:lens="lens"
      class="studio__top"
      :title
      :picture-number="pictureNumber"
      :subtitle="subtitleExtra"
      :diagnostics="model.diagnostics.length"
      :bytes="draft.compiled.value.bytes.length"
      :commands="total"
      :status="draftStatus"
      :changes="draft.changes.value"
      :can-undo="draft.canUndo.value && draftStatus !== 'reload'"
      :can-redo="draft.canRedo.value && draftStatus !== 'reload'"
      :can-keep="keeper.canKeep.value"
      @back="requestClose"
      @close="requestClose"
      @undo="editing.undo"
      @redo="editing.redo"
      @keep="keepChanges(false)"
      @discard="dialog = 'discard'"
    />

    <SceneList
      v-model:filter="filter"
      class="studio__scene"
      :branches="model.branches"
      :sections="model.sections"
      :matches="scene.matches"
      :loose="scene.loose"
      :hovered-id="hoveredId"
      :selected-id="selectedId"
      @hover="selection.listHover.value = $event"
      @select="selectedId = $event"
    >
      <template #notice><StudioLockNote v-model:unlocks="unlocks" :lens /></template>
    </SceneList>

    <main class="studio__frame">
      <div
        ref="stage"
        class="studio__stage"
        tabindex="0"
        role="group"
        aria-label="Canvas. Click an item to select it; drag it or its handles to edit. Arrow keys nudge the selection 1 pixel (Shift: 8); Alt+arrows step through items in draw order."
      >
        <div class="studio__panes">
          <StudioCanvas
            v-for="(layer, index) in panes"
            :key="layer"
            :layer
            :label="PANE_LABELS[layer]"
            :visual="shown.visual"
            :priority="shown.priority"
            :viewport
            :dpr
            :highlight="hoverPaths"
            :selection="selectionPaths"
            :guides="layer === 'art' ? null : guides"
            :labels="layer === 'art' ? null : labels"
            :handles
            :flash="flashPaths"
            :movable="editableId !== undefined"
            @hover="selection.canvasCell.value = $event"
            @press="drag.press"
            @drag="drag.drag"
            @release="drag.release"
            @abort="drag.abort"
          >
            <StudioContextBar
              v-if="ctxAt && index === panes.length - 1"
              v-model:open="ctxOpen"
              :style="ctxAt"
              :priority="single('priority')"
              :priority-locked="lensLock('priority')"
              :depth-values-locked="itemLocks.depthValues"
              :edit="editing"
            />
          </StudioCanvas>
        </div>
      </div>
      <StudioViewBar v-model:mode="mode" v-model:bands="showBands" :lens />
      <StudioStageNotes
        :banner="keeper.banner.value"
        :notice="editing.notice.value"
        :editing="editableId !== undefined"
        @recover="recover"
      />
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
      :commands="readout.commands.value"
      :colours="drawn('visual')"
      :priorities="drawn('priority')"
      :pixel
      :pinned="selection.canvasCell.value === undefined && pinnedCell !== undefined"
      :fill
      :trusted="model.trusted"
      :editing="editing.editable.value !== undefined"
      :playhead
      :label-of="labelOf"
      @seek="seek"
      @select="selectedId = $event"
    >
      <template #editor>
        <StudioItemEditor
          v-if="editing.editable.value"
          :item="editing.editable.value"
          :visual="single('visual')"
          :priority="single('priority')"
          :handles="handleList"
          :locks="itemLocks"
          :edit="editing"
        />
      </template>
    </PixelInspector>

    <footer class="studio__status">
      <span data-role="status">{{ status }}</span>
      <span class="studio__spacer"></span>
      <span>AGI {{ profile.id }} profile</span>
      <span>{{ model.trusted ? "authored source" : "disassembled" }}</span>
    </footer>
    <p class="studio__sr" aria-live="polite" data-role="announce">{{ announcement }}</p>

    <StudioKeepDialog
      v-model:ask="dialog"
      :picture-number="pictureNumber"
      :changes="draft.changes.value"
      :can-keep="keeper.canKeep.value"
      @keep="keepChanges(true)"
      @discard="discardChanges"
    />
  </div>
</template>

<style scoped>
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
