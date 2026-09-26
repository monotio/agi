<script setup lang="ts">
import { computed, onScopeDispose, ref, useTemplateRef } from "vue";
import type { ResourceRevision } from "../../../src/gameIdentity.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { itemHandles } from "../../../src/studio/editPoints.ts";
import { footprintMask } from "../../../src/studio/editValidation.ts";
import { useOptionalCreateCenter } from "../shell/useCreateWorkspace.ts";
import DrawOrderScrubber from "./DrawOrderScrubber.vue";
import GhostProbe from "./GhostProbe.vue";
import PixelInspector from "./PixelInspector.vue";
import SceneList from "./SceneList.vue";
import StudioCanvas, { type MaskPaths } from "./StudioCanvas.vue";
import StudioContextBar from "./StudioContextBar.vue";
import StudioItemEditor from "./StudioItemEditor.vue";
import StudioKeepDialog from "./StudioKeepDialog.vue";
import StudioLockNote from "./StudioLockNote.vue";
import StudioStageNotes from "./StudioStageNotes.vue";
import StudioToolOptions from "./StudioToolOptions.vue";
import StudioToolOverlay from "./StudioToolOverlay.vue";
import StudioToolRail from "./StudioToolRail.vue";
import StudioTopBar from "./StudioTopBar.vue";
import StudioViewBar from "./StudioViewBar.vue";
import StudioZoom from "./StudioZoom.vue";
import { studioKey, type StudioKeyActions } from "./studioKeys.ts";
import { lensItemLocks, NO_UNLOCKS, type LensUnlocks } from "./studioLocks.ts";
import {
  bandGuides,
  controlLabels,
  maskBox,
  maskFillPath,
  maskOutlinePath,
  PANE_LABELS,
  panesFor,
  subtitleExtra,
  type StudioLens,
  type StudioViewMode,
} from "./studioView.ts";
import { listGameViews, useGhostProbe } from "./useGhostProbe.ts";
import { filterScene, resolveStudioSource, useStudioDocument } from "./useStudioDocument.ts";
import { exposeStudioDraft, useStudioDraft } from "./useStudioDraft.ts";
import { useStudioFocus } from "./useStudioFocus.ts";
import { useStudioDrag } from "./useStudioDrag.ts";
import { useStudioEditing } from "./useStudioEditing.ts";
import { useStudioKeep, type KeepFn, type KeepRecovery } from "./useStudioKeep.ts";
import { useStudioLeave } from "./useStudioLeave.ts";
import { useStudioReadout } from "./useStudioReadout.ts";
import { useStudioSelection } from "./useStudioSelection.ts";
import { useStudioTools } from "./useStudioTools.ts";
import { useStudioViewport } from "./useStudioViewport.ts";

/**
 * Room Studio: one picture's items, draw order and planes, edited as a draft
 * (useStudioDraft) and kept through the resource transaction (useStudioKeep).
 * It takes the picture bytes (and authored text, trusted only while it
 * compiles to those bytes) and the revision they were read at. Keys are
 * handled at the root and stopped (studioKeys.ts), so none reach the game,
 * and focus never falls out of the studio while it is open. The tool rail
 * (useStudioTools) inserts new items at the playhead; the actor probe
 * stands a VIEW from the game's `files` on the draft; every way out settles
 * unkept changes first (useStudioLeave).
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
  files = undefined,
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
  /** The game's container files, read at the same revision: the actor probe's VIEWs. */
  files?: ReadonlyMap<string, Uint8Array> | undefined;
}>();
const emit = defineEmits<{ close: []; reopen: [] }>();

const lens = ref<StudioLens>("art");
const mode = ref<StudioViewMode>("blend");
const showBands = ref(true);
const filter = ref("");
const unlocks = ref<LensUnlocks>(NO_UNLOCKS);
/** More points than this and the item shows no handles (the inspector still lists them). */
const MAX_HANDLES = 160;

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
/** Editing is blocked: view only, or a Keep that needs a reload first. */
const frozen = (): boolean => draft.kept.value.revision === undefined || keeper.needsReload.value;
const editing = useStudioEditing({ draft, selectedId, frozen });

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
  movesItems: () => tools.tool.value !== "point",
});
const tools = useStudioTools({
  draft,
  doc,
  lens,
  unlocks,
  selectedId,
  surface: () => shown.value,
  report: editing.report,
  say: editing.say,
  frozen,
  stage: () => stage.value,
  probe: () => views.value.length > 0 && ghost.toggle(),
});
const views = computed(() => (files ? listGameViews(files, profile) : []));
const ghost = useGhostProbe({ views, picture: () => shown.value, profile: () => profile });
/** The priority-plane item under a cell, named for the probe's verdict. */
const describeCell = (x: number, y: number): string | undefined => {
  const id = doc.rowAt(x, y, "priority");
  return id === undefined ? undefined : labelOf(id);
};
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
  const hidden =
    editableId.value === undefined || drag.dragging.value || !mask || tools.drawing.value;
  const box = hidden ? null : maskBox(mask);
  if (!box) return null;
  const { zoom: z, pixelAspect } = viewport.value;
  const above = box.y * z - 44;
  return {
    left: `${Math.max(0, Math.min(box.x * pixelAspect * z, 160 * pixelAspect * z - 360))}px`,
    top: `${above >= 4 ? above : (box.y + box.height) * z + 8}px`,
  };
});

const itemLocks = computed(() => lensItemLocks(lens.value, unlocks.value));

function seek(k: number): void {
  playhead.value = Math.min(total.value, Math.max(0, k));
}

/** Keep / Discard / Cancel before any way out of Studio, here or in the shell. */
const leave = useStudioLeave({
  unkept: () => draft.dirty.value && !keeper.needsReload.value,
  keep: () => keepChanges(),
  discard: () => draft.discard(),
});
const center = useOptionalCreateCenter();
if (center) onScopeDispose(center.guardStudio(leave));
const dialog = leave.ask;
async function requestClose(): Promise<void> {
  if (await leave.confirm()) emit("close");
}
function discardChanges(): void {
  leave.discarding.value = false;
  draft.discard();
  editing.say({ tone: "ok", text: "Changes discarded." });
}
/** Keep the draft and say so; resolves whether it was kept. */
async function keepChanges(): Promise<boolean> {
  const kept = await keeper.keep();
  // Keep disables itself once the draft is kept: the keys must not fall out of Studio.
  keepFocus();
  if (!kept) return false;
  editing.say({ tone: "ok", text: `Kept PIC ${pictureNumber}. The game shows the edit now.` });
  return true;
}
function recover(recovery: KeepRecovery): void {
  if (recovery === "retry") void keepChanges();
  else if (recovery === "reload") location.reload();
  else {
    // The draft was made on a game that moved on: start over from the running game.
    keeper.dismiss();
    draft.discard();
    emit("reopen");
  }
}

const keepFocus = useStudioFocus(useTemplateRef("root"));
exposeStudioDraft(draft);

const keys: StudioKeyActions = {
  onCanvas: (target) => target === stage.value,
  dismiss: () => {
    if (tools.cancel()) return true;
    if (tools.tool.value !== "select") tools.setTool("select");
    else if (ctxOpen.value) ctxOpen.value = false;
    else if (!drag.abort()) return false;
    return true;
  },
  close: () => void requestClose(),
  lens: (next) => (lens.value = next),
  seek: (to) => seek(to === "first" ? 0 : to === "last" ? total.value : playhead.value + to),
  zoom: (step) => (step === "fit" ? zoomToFit() : zoomBy(step)),
  step: (direction) => selection.step(direction),
  nudge: editing.nudge,
  remove: () => tools.backspace() || editing.remove(),
  duplicate: editing.duplicate,
  reorder: editing.reorder,
  undo: editing.undo,
  redo: editing.redo,
  tool: tools.shortcut,
  finish: tools.finish,
};
/** Canvas pointer input: the active tool takes it first, then selection and dragging. */
const pointer = tools.pointer(drag, (cell) => (selection.canvasCell.value = cell));
/** Every key stops here so the game never sees it. */
function onKeydown(event: KeyboardEvent): void {
  event.stopPropagation();
  // An open confirmation takes the keys it needs (Esc cancels it) and nothing else runs.
  if (dialog.value !== undefined) return;
  if (tools.spaceKey(event, true) || studioKey(event, keys)) event.preventDefault();
  keepFocus();
}
function onKeyup(event: KeyboardEvent): void {
  event.stopPropagation();
  tools.spaceKey(event, false);
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
    @keyup="onKeyup"
    @keypress.stop
    @click="keepFocus"
  >
    <StudioTopBar
      v-model:lens="lens"
      class="studio__top"
      :title
      :picture-number="pictureNumber"
      :subtitle="subtitleExtra(title, pictureNumber, subtitle)"
      :diagnostics="model.diagnostics.length"
      :bytes="draft.compiled.value.bytes.length"
      :commands="total"
      :status="keeper.status.value"
      :changes="draft.changes.value"
      :can-undo="draft.canUndo.value && !keeper.needsReload.value"
      :can-redo="draft.canRedo.value && !keeper.needsReload.value"
      :can-keep="keeper.canKeep.value"
      @back="requestClose"
      @close="requestClose"
      @undo="editing.undo"
      @redo="editing.redo"
      @keep="keepChanges()"
      @discard="leave.discarding.value = true"
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

    <StudioToolRail
      :tool="tools.tool.value"
      class="studio__rail"
      :frozen="frozen()"
      :probe-active="ghost.active.value"
      :probe-available="views.length > 0"
      :lens
      :unlocks
      :values="tools.current.value"
      :cursor-y="tools.cursor.value?.y"
      @update:tool="tools.setTool"
      @probe="ghost.toggle()"
      @values="tools.setValues"
    />
    <main class="studio__frame">
      <div
        ref="stage"
        class="studio__stage"
        :class="{ 'is-panning': tools.panning.value, 'is-drawing': tools.tool.value !== 'select' }"
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
            :movable="editableId !== undefined && tools.tool.value === 'select'"
            @hover="pointer.hover"
            @press="pointer.press"
            @drag="pointer.drag"
            @release="pointer.release"
            @abort="pointer.abort"
            @dblclick="tools.finish()"
          >
            <StudioToolOverlay v-if="tools.tool.value !== 'select'" v-bind="tools.overlay.value" />
            <!-- The probe's own presses never reach the pane below. -->
            <GhostProbe
              v-if="index === 0"
              :probe="ghost"
              :viewport
              :describe-cell="describeCell"
              @pointerdown.stop
              @pointermove.stop
            />
            <StudioContextBar
              v-if="ctxAt && index === panes.length - 1"
              v-model:open="ctxOpen"
              :style="ctxAt"
              :priority="single('priority')"
              :priority-locked="itemLocks.priority"
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
        :editing="editableId !== undefined && tools.tool.value === 'select'"
        @recover="recover"
      />
      <StudioToolOptions
        v-if="tools.tool.value !== 'select'"
        v-model:filled="tools.filled.value"
        v-model:radius="tools.radius.value"
        v-model:stipple="tools.stipple.value"
        v-model:seed="tools.seed.value"
        :tool="tools.tool.value"
        :insertion="tools.insertion.value"
        :commands="total"
        :fill-why="tools.fillWhy.value"
        :points="tools.path.value?.points.length ?? 0"
        @end="seek(total)"
      />
      <StudioZoom :zoom :fitted @zoom="(step) => (step === 'fit' ? zoomToFit() : zoomBy(step))" />
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
      @keep="leave.answer('keep')"
      @discard="(closing) => (closing ? leave.answer('discard') : discardChanges())"
    />
  </div>
</template>

<style scoped>
.studio {
  position: relative;
  display: grid;
  grid-template-rows: 52px minmax(0, 1fr) 92px 28px;
  /* The Scene list gives up a little width on smaller screens, so the rail
     leaves the canvas its 200% zoom at 1280 wide. */
  grid-template-columns: clamp(208px, 18vw, 256px) 48px minmax(0, 1fr) 300px;
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
/* The rail stops above the scrubber, which keeps the full width under it. */
.studio__rail {
  grid-row: 2;
  grid-column: 2;
}
.studio__frame {
  position: relative;
  grid-row: 2;
  grid-column: 3;
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
.studio__stage.is-drawing :deep(.studio-pane) {
  cursor: crosshair;
}
.studio__stage.is-panning :deep(.studio-pane) {
  cursor: grab;
}
/* Gap and inset match PANE_GAP and STAGE_INSET in useStudioViewport.ts. */
.studio__panes {
  display: flex;
  gap: var(--space-5);
  margin: auto;
  padding: var(--space-7);
}
.studio__scrubber {
  grid-row: 3;
  grid-column: 2 / 4;
}
.studio__inspector {
  grid-row: 2 / 4;
  grid-column: 4;
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
