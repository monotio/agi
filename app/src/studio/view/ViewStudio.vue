<script setup lang="ts">
import { numberedLabel } from "../../../../src/logic/numberedLabels.ts";
import { useProjectLabels } from "../../shell/useProjectLabels.ts";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from "vue";
import type { ResourceRevision } from "../../../../src/gameIdentity.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import type { AgentTarget } from "../../agent/agentNavigation.ts";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/itemGroups.ts";
import { openContainer } from "../../../../src/container/container.ts";
import { renderPicture } from "../../../../src/picture/renderer.ts";
import { createPictureSurface } from "../../../../src/types.ts";
import type { ViewEdit } from "../../../../src/studio/view/viewOperations.ts";
import { usageText, type ViewUsage } from "../../../../src/agent/viewUsage.ts";
import PaletteStrip from "../workspace/PaletteStrip.vue";
import UiButton from "../../ui/UiButton.vue";
import UiChip from "../../ui/UiChip.vue";
import UiExplain from "../../ui/UiExplain.vue";
import type { LessonSession } from "../../lessons/lessonCheck.ts";
import LessonCard from "../../lessons/LessonCard.vue";
import { useStudioLesson } from "../../lessons/useStudioLesson.ts";
import type {
  ResourceCommitResult,
  ViewEdit as ViewResourceEdit,
} from "../../project/resourceCommit.ts";
import type { ViewRoom } from "../../world/studioSource.ts";
import { VIEW_TOOL_HINTS, VIEW_TOOL_NAMES, viewKeySheet } from "../studioHelp.ts";
import { readViewerPref, useStudioCalm, writeViewerPref } from "../useStudioCalm.ts";
import { useFold } from "../useFold.ts";
import StudioStatusNotice from "../StudioStatusNotice.vue";
import StudioZoom from "../StudioZoom.vue";
import { useStudioFocus } from "../useStudioFocus.ts";
import { useStudioNotice } from "../useStudioNotice.ts";
import { useStudioViewport } from "../useStudioViewport.ts";
import { explain } from "../studioTerms.ts";
import { useMaybeWorkspaceEditor } from "../../shell/workspaceEditor.ts";
import ViewCanvas, { type OnionSkin } from "./ViewCanvas.vue";
import ViewCelPanel, { type CelEdit } from "./ViewCelPanel.vue";
import ViewContactSheet from "./ViewContactSheet.vue";
import ViewMirrorNote from "./ViewMirrorNote.vue";
import ViewPalette from "./ViewPalette.vue";
import ViewPreview from "./ViewPreview.vue";
import ViewRecolor from "./ViewRecolor.vue";
import ViewRoomPreview from "./ViewRoomPreview.vue";
import ViewTimeline from "./ViewTimeline.vue";
import ViewToolRail from "./ViewToolRail.vue";
import ViewLoopBar from "./ViewLoopBar.vue";
import { viewKey, type ViewKeyActions } from "./viewKeys.ts";
import { recolorTargets } from "./viewRecolor.ts";
import {
  aliasGroup,
  backgroundKey,
  feetWarning,
  parseBackground,
  usageChip,
  previewPartner,
  type PreviewCycler,
  type RoomBackground,
  type CelBackground,
} from "./viewStudioView.ts";
import { exposeViewDraft, useViewDraft, type ViewOutcome } from "./useViewDraft.ts";
import { VIEW_TOOL_KEYS, useViewTools } from "./useViewTools.ts";

/** A VIEW commit transaction: the edit, and the staged reference it spends, if any. */
export type ViewKeepFn = (
  edit: ViewResourceEdit,
  stagedReference: string | undefined,
) => Promise<ResourceCommitResult>;

/**
 * The VIEW editor: one VIEW's loops and cels, edited as a draft
 * (useViewDraft) through the view kernel inside the workspace; each
 * settled change is emitted for the workspace to save. It takes the VIEW
 * bytes and the revision they were read at. Copy-on-write is the default:
 * editing a loop that shares its data block makes it a separate copy, and
 * every edit is validated against the loops it targets, so no other loop
 * changes by accident. The recolour tool swaps a colour over a cel, a loop
 * or the view (ViewRecolor.vue), and the contact sheet shows every cel in
 * place of the canvas (ViewContactSheet.vue). Keys are handled at the
 * root and stopped (viewKeys.ts), so none reach the game, and focus never
 * falls out of the editor while it is open.
 */
const {
  viewNumber,
  bytes,
  profile,
  baseRevision = undefined,
  files = new Map(),
  usage = { rooms: [], logics: [], dynamic: false },
  rooms = [],
  speed = 1,
  cyclers = [],
  priorityBase = undefined,
  stagedReference = undefined,
  readOnly = false,
  lessonSession = undefined,
  workspaceFocus = false,
  active = true,
  location = undefined,
} = defineProps<{
  readOnly?: boolean;
  lessonSession?: LessonSession | undefined;
  /** Accepted while the dev harness mounts the editor outside the workspace. */
  embedded?: boolean;
  workspaceFocus?: boolean;
  /** Whether this tab is showing: its status bar and keys join the frame's. */
  active?: boolean;
  location?: AgentTarget | undefined;
  viewNumber: number;
  bytes: Uint8Array;
  profile: AgiProfile;
  /** The game revision the bytes were read at; without one the view is view only. */
  baseRevision?: ResourceRevision | undefined;
  /** The game's container files, read at the same revision: the rooms' pictures. */
  files?: ReadonlyMap<string, Uint8Array>;
  usage?: ViewUsage;
  rooms?: readonly ViewRoom[];
  /** The game's cycle delay (v10): the loop preview's pace. */
  speed?: number;
  /** The live objects when the editor opened: whose cycle time paces the preview. */
  cyclers?: readonly PreviewCycler[] | undefined;
  priorityBase?: number | undefined;
  /** The staged character-sheet candidate these bytes are: Use VIEW spends the offer. */
  stagedReference?: string | undefined;
}>();
const emit = defineEmits<{
  edit: [bytes: Uint8Array];
  "use-staged": [bytes: Uint8Array];
  "agent-context": [context: { label: string; text: string }];
}>();
const labels = useProjectLabels();

const draft = useViewDraft({
  base: () => ({ bytes, revision: baseRevision }),
  profile: () => profile,
});
watch([draft.bytes, draft.gesturing], ([next, gesturing]) => {
  if (
    !readOnly &&
    !gesturing &&
    (next.length !== bytes.length || !next.every((value, index) => bytes[index] === value))
  )
    emit("edit", next.slice());
  if (!gesturing) lesson.check({ kind: "view", num: viewNumber, after: next, profile });
});
/** A Help guide lesson the editor opened from: every settled edit runs its challenge. */
const contextOpen = ref(false);
const lesson = useStudioLesson(() => lessonSession);
watch(
  () => lessonSession,
  (next) => {
    if (next) contextOpen.value = true;
  },
  { immediate: true },
);
watch(
  () => lessonSession,
  () => lesson.check({ kind: "view", num: viewNumber, after: draft.bytes.value, profile }),
  { immediate: true },
);
// A lesson can open on the loop and cel its steps speak of.
const opened = lesson.session.value?.lesson.open;
const openedDocument = draft.document.value;
const startLoop = Math.max(
  0,
  Math.min(opened?.studio === "view" ? (opened.loop ?? 0) : 0, openedDocument.loops.length - 1),
);
const startCel = Math.max(
  0,
  Math.min(
    opened?.studio === "view" ? (opened.cel ?? 0) : 0,
    (openedDocument.loops[startLoop]?.cels.length ?? 1) - 1,
  ),
);
const loop = ref(startLoop);
const cel = ref(startCel);
watch(
  () => [location, active] as const,
  ([target, showing]) => {
    if (!showing || target?.resource !== `view:${viewNumber}`) return;
    loop.value = Math.max(0, Math.min(target.loop ?? 0, draft.document.value.loops.length - 1));
    cel.value = Math.max(
      0,
      Math.min(target.cel ?? 0, (draft.document.value.loops[loop.value]?.cels.length ?? 1) - 1),
    );
  },
  { immediate: true },
);
/** The loop whose linked group is edited together (Edit both); null copies on write. */
const linkedEdit = shallowRef<number | null>(null);
const color = ref(11);
const { notice, say, dismiss: dismissNotice } = useStudioNotice();

// A structural edit, undo or a new base can take the selected loop or cel away.
watch(
  () => draft.document.value,
  (document) => {
    loop.value = Math.min(loop.value, document.loops.length - 1);
    cel.value = Math.min(cel.value, (document.loops[loop.value]?.cels.length ?? 1) - 1);
  },
);

// ---- the workspace agent ---------------------------------------------------
watch(
  [loop, cel],
  ([selectedLoop, selectedCel]) => {
    emit("agent-context", {
      label: `${numberedLabel("view", viewNumber, labels.value, "row")} · Loop ${selectedLoop}, cel ${selectedCel}`,
      text: `Selected ${numberedLabel("view", viewNumber, labels.value, "option")}, loop ${selectedLoop}, cel ${selectedCel}.`,
    });
  },
  { immediate: true },
);
/** What the canvas and previews show: the gesture's preview, else the document. */
const shown = draft.shown;
const celPanel = useTemplateRef("celPanel");

const currentCel = computed(() => shown.value.loops[loop.value]?.cels[cel.value]);
const group = computed(() => aliasGroup(draft.document.value, loop.value));
/** Edits of `target` change its whole linked group. */
const propagates = (target: number): boolean =>
  linkedEdit.value !== null &&
  aliasGroup(draft.document.value, linkedEdit.value).length > 1 &&
  aliasGroup(draft.document.value, linkedEdit.value).includes(target);

/**
 * The loops an edit may change (validateViewEdit's `targetLoops`): the
 * edited loop, or its linked group when edits propagate; a loop added or
 * deleted renumbers every loop after it.
 */
function targetsOf(op: ViewEdit): number[] | undefined {
  const count = draft.document.value.loops.length;
  switch (op.type) {
    case "addLoop":
      return Array.from({ length: count + 1 - op.at }, (_, k) => op.at + k);
    case "deleteLoop":
      return Array.from({ length: count - op.loop }, (_, k) => op.loop + k);
    case "recolor":
      return recolorTargets(draft.document.value, op);
    default:
      return propagates(op.loop) ? aliasGroup(draft.document.value, op.loop) : [op.loop];
  }
}

/** Editing is blocked: read-only, or a view with no revision to save against. */
const frozen = (): boolean => readOnly || draft.kept.value.revision === undefined;

/** Say what an edit did: why it was refused, a split-off copy, feet that moved. */
function report(outcome: ViewOutcome, feetFrom?: typeof currentCel.value): void {
  if (!outcome.ok) {
    say({ tone: "warn", text: outcome.refusal.message, detail: outcome.refusal.detail });
    return;
  }
  if (draft.gesturing.value) {
    if (notice.value?.tone === "warn") say(null);
    return;
  }
  const after = draft.document.value.loops[loop.value]?.cels[cel.value];
  const moved = feetFrom && after ? feetWarning(feetFrom, after) : null;
  if (moved) say({ tone: "warn", text: moved });
  else if (outcome.isolated.length > 0)
    say({
      tone: "ok",
      text: `Loop ${outcome.isolated.join(", ")} is now a separate copy; the loop it mirrored kept its pixels.`,
    });
  else if (notice.value?.tone === "warn") say(null);
}

/** An edit, or edits made as one undo step (a cel moved to another loop is two). */
function edit(
  op: ViewEdit | readonly ViewEdit[],
  label: string,
  feetFrom?: typeof currentCel.value,
): void {
  if (frozen()) {
    say({ tone: "warn", text: "This actor is read-only." });
    return;
  }
  const ops = "type" in op ? [op] : op;
  const changes = ops.map((one) => ({ op: one, targets: targetsOf(one) }));
  report(draft.applyAll(changes, label), feetFrom);
}
function celEdit(change: CelEdit): void {
  const where = { loop: loop.value, cel: cel.value, propagate: propagates(loop.value) };
  const before = draft.document.value.loops[loop.value]?.cels[cel.value];
  const label =
    change.type === "resizeCel" ? "Resize" : change.type === "shiftCel" ? "Shift" : "Transparent";
  edit({ ...change, ...where }, label, change.type === "setTransparent" ? undefined : before);
}

const tools = useViewTools({
  draft,
  loop,
  cel,
  propagate: () => propagates(loop.value),
  targets: () => (propagates(loop.value) ? group.value : [loop.value]),
  color,
  report: (outcome) => report(outcome),
  say,
  frozen,
});

function selectCel(nextLoop: number, nextCel: number): void {
  loop.value = nextLoop;
  cel.value = nextCel;
}
function step(what: "cel" | "loop", direction: 1 | -1): void {
  const loops = draft.document.value.loops;
  if (what === "loop") {
    const next = (loop.value + direction + loops.length) % loops.length;
    selectCel(next, Math.min(cel.value, loops[next]!.cels.length - 1));
  } else {
    const count = loops[loop.value]!.cels.length;
    cel.value = (cel.value + direction + count) % count;
  }
}
function setPropagate(target: number, on: boolean): void {
  linkedEdit.value = on ? target : null;
  if (on && target !== loop.value)
    selectCel(
      target,
      Math.min(cel.value, (draft.document.value.loops[target]?.cels.length ?? 1) - 1),
    );
}

// ---- canvas --------------------------------------------------------------

const stage = useTemplateRef("stage");
const onionPrev = ref(true);
const onionNext = ref(true);
const onionCount = ref(1);
const showGrid = ref(true);
const showBaseline = ref(true);
/** What shows behind transparent pixels while drawing: per viewer, never the view's data. */
const BACKGROUND_KEY = "monotio_agi.viewBackground";
const background = shallowRef<CelBackground>(parseBackground(readViewerPref(BACKGROUND_KEY)));
watch(background, (next) => writeViewerPref(BACKGROUND_KEY, backgroundKey(next)));
/** The first room that uses the view: a Room background shows its picture where the cel stands. */
const backgroundRoom = computed(() => rooms[0] ?? null);
const roomPicture = computed<RoomBackground | null>(() => {
  const room = backgroundRoom.value;
  if (background.value.kind !== "room" || !room) return null;
  try {
    const bytes = openContainer(new Map(files), { profile }).getResource("picture", room.picture);
    if (!bytes) return null;
    const surface = createPictureSurface();
    renderPicture(bytes, surface, { profile });
    // Where the in-room preview first stands the cel (ViewRoomPreview.vue).
    return { visual: surface.visual, x: 70, baselineY: 120 };
  } catch {
    return null;
  }
});
/** The contact sheet shows in place of the canvas. */
const sheet = ref(false);
/** Back from the contact sheet to the canvas; false when it was not open. */
function closeSheet(): boolean {
  if (!sheet.value) return false;
  sheet.value = false;
  void nextTick(() => stage.value?.focus({ preventScroll: true }));
  return true;
}
function chooseFromSheet(nextLoop: number, nextCel: number): void {
  selectCel(nextLoop, nextCel);
  closeSheet();
}
const { zoom, dpr, fitted, zoomBy, zoomToFit } = useStudioViewport(stage, 1, {
  size: () => ({
    width: currentCel.value?.width ?? 1,
    height: currentCel.value?.height ?? 1,
    // The baseline label below the canvas.
    below: 56,
  }),
  max: 24,
});
const onion = computed<OnionSkin[]>(() => {
  const cels = shown.value.loops[loop.value]?.cels ?? [];
  const out: OnionSkin[] = [];
  const used = new Set([cel.value]);
  for (let distance = 1; distance <= onionCount.value; distance++)
    for (const side of ["prev", "next"] as const) {
      if (!(side === "prev" ? onionPrev.value : onionNext.value)) continue;
      const index =
        (cel.value + (side === "prev" ? -distance : distance) + cels.length * 4) % cels.length;
      if (used.has(index)) continue;
      used.add(index);
      out.push({ cel: cels[index]!, side, distance });
    }
  return out;
});
const CANVAS_LABEL =
  "Canvas. Arrow keys move the cursor 1 pixel (Shift: 8), or the selection; Space or Enter clicks at the cursor; Escape cancels; question mark lists every key.";
const PEN_DOWN = "Pen down: Space lifts it";
const spoken = computed(() => {
  const point = tools.cursor.value;
  const at = tools.keyboard.value && point ? `x ${point.x} y ${point.y}` : "";
  return tools.penDown.value ? (at ? `${PEN_DOWN} · ${at}` : PEN_DOWN) : at;
});
function history(which: "undo" | "redo"): void {
  if (frozen()) return;
  tools.cancel();
  if (workspaceEditor) {
    void workspaceEditor.step(which);
    return;
  }
  if (which === "undo" ? draft.undo() : draft.redo()) say(null);
}

const keepFocus = useStudioFocus(useTemplateRef("root"));
const calm = useStudioCalm();
/** The frame's editor when the studio mounts in the workspace (the harness has none). */
const workspaceEditor = useMaybeWorkspaceEditor();
const inWorkspace = workspaceEditor !== null;
/** The workspace's one Keys sheet: `?` opens it at this editor's section. */
const sheetOpen = workspaceEditor?.keysOpen ?? calm.sheetOpen;
const keySheet = viewKeySheet();
if (workspaceEditor) {
  onBeforeUnmount(
    workspaceEditor.registerKeySheet(`view:${viewNumber}`, () => ({
      name: "VIEW editor",
      sections: keySheet,
    })),
  );
  onBeforeUnmount(
    workspaceEditor.registerStatusMeta(
      `view:${viewNumber}`,
      () => `${draft.bytes.value.length.toLocaleString("en")} bytes`,
    ),
  );
}
/**
 * The options bar folds what it cannot fit, least used first: the background,
 * the grid and the baseline into More, then the "1 px" note, then the contact
 * sheet into More. The tool's own options never run under the view's.
 */
const optionsBar = useTemplateRef("optionsBar");
const optionsFold = useFold(optionsBar, 3, (bar) => {
  const options = bar.querySelector<HTMLElement>(".view-options");
  return (
    !options ||
    (options.scrollWidth <= options.clientWidth && options.scrollHeight <= bar.clientHeight)
  );
});
const viewFold = computed(() => [0, 1, 1, 2][optionsFold.level.value] ?? 2);
watch(
  () => [tools.tool.value, color.value, sheet.value],
  () => void optionsFold.refit(),
  { flush: "post" },
);

/** The options bar's paint colour, for the tools that paint with it. */
const paints = computed(() => ["pencil", "fill", "line", "rect"].includes(tools.tool.value));
exposeViewDraft(draft);

const keys: ViewKeyActions = {
  onCanvas: (target) => target === stage.value,
  dismiss: () => tools.cancel() || closeSheet() || tools.closeRecolor(),
  arrow: tools.arrow,
  click: tools.click,
  remove: () => void tools.clearSelection(),
  step,
  zoom: (to) => (to === "fit" ? zoomToFit() : zoomBy(to)),
  undo: () => history("undo"),
  redo: () => history("redo"),
  tool: (key) => {
    const next = VIEW_TOOL_KEYS[key];
    if (next === "flip") tools.flip();
    else if (next) tools.setTool(next);
    return next !== undefined;
  },
  keySheet: () => (sheetOpen.value = true),
};
/** Every key stops here so the game never sees it. */
function onKeydown(event: KeyboardEvent): void {
  event.stopPropagation();
  if (sheetOpen.value) return;
  if (viewKey(event, keys)) event.preventDefault();
  keepFocus();
}

/** A tool change hands the status line back to the tool's hint (before anything it says). */
watch(tools.tool, () => say(null), { flush: "sync" });
const status = computed(() => {
  const point = tools.cursor.value;
  const at = currentCel.value;
  if (!point || !at) return `Loop ${loop.value} · cel ${cel.value}`;
  const value = at.pixels[point.y * at.width + point.x];
  const colour =
    value === undefined || value === at.transparent
      ? "transparent"
      : `colour ${value} ${EGA_COLOUR_NAMES[value]}`;
  return `x ${point.x} y ${point.y} · ${colour}`;
});
</script>

<template>
  <div
    ref="root"
    class="view-studio"
    :class="{
      'is-workspace-focus': workspaceFocus,
      'is-context-open': contextOpen,
    }"
    data-testid="view-studio"
    tabindex="-1"
    role="region"
    :aria-label="`VIEW editor: ${viewNumber}`"
    @keydown="onKeydown"
    @keyup.stop
    @keypress.stop
    @click="keepFocus"
  >
    <div
      ref="optionsBar"
      class="view-studio__options"
      role="group"
      aria-label="Tool and view options"
      data-testid="view-options-bar"
    >
      <div
        class="view-options"
        role="group"
        :aria-label="`${VIEW_TOOL_NAMES[tools.tool.value]} options`"
        data-testid="view-tool-options"
        :data-tool="tools.tool.value"
      >
        <b class="view-options__name">{{ VIEW_TOOL_NAMES[tools.tool.value] }}</b>
        <span v-if="paints" class="view-options__colour" :title="`Colour ${color}`">
          <i :style="{ background: `var(--agi-${color})` }" aria-hidden="true"></i>
          {{ color }} {{ EGA_COLOUR_NAMES[color] }}
        </span>
        <span
          v-else-if="tools.tool.value === 'eraser'"
          class="view-options__note view-options__erase"
          >Paints the transparent colour <UiExplain v-bind="explain('transparent')"
        /></span>
        <span
          v-if="tools.tool.value !== 'recolor' && optionsFold.level.value < 2"
          class="view-options__note"
          >1 px</span
        >
      </div>
      <span class="view-studio__spacer"></span>
      <UiButton v-if="stagedReference" size="sm" @click="emit('use-staged', draft.bytes.value)"
        >Use VIEW</UiButton
      >
      <UiButton
        v-if="workspaceFocus"
        size="sm"
        variant="ghost"
        :aria-pressed="contextOpen"
        @click="contextOpen = !contextOpen"
        >Preview</UiButton
      >
      <UiChip data-testid="view-usage" :title="usageText(usage)">{{ usageChip(usage) }}</UiChip>
      <ViewLoopBar
        v-model:sheet="sheet"
        v-model:prev="onionPrev"
        v-model:next="onionNext"
        v-model:count="onionCount"
        v-model:grid="showGrid"
        v-model:baseline="showBaseline"
        v-model:background="background"
        :room-background="backgroundRoom?.room ?? null"
        :fold="viewFold"
      />
    </div>

    <ViewToolRail
      :tool="tools.tool.value"
      class="view-studio__rail"
      :frozen="frozen()"
      :color
      @update:tool="tools.setTool"
      @flip="tools.flip()"
    />

    <main class="view-studio__frame">
      <div
        ref="stage"
        class="view-studio__stage"
        tabindex="0"
        role="group"
        :aria-label="CANVAS_LABEL"
        :inert="sheet"
        data-testid="view-stage"
      >
        <ViewCanvas
          v-if="currentCel"
          class="view-studio__canvas"
          :cel="tools.previewCel.value ?? currentCel"
          :onion
          :zoom
          :dpr
          :grid="showGrid"
          :baseline="showBaseline"
          :overlay="tools.overlay.value"
          :background
          :room="roomPicture"
          :label="`Loop ${loop}, cel ${cel}: ${currentCel.width} by ${currentCel.height} pixels`"
          @hover="tools.hover"
          @press="(press) => tools.pressAt(press.point, press.alt)"
          @drag="tools.dragTo"
          @release="tools.release"
          @abort="tools.cancel()"
        />
      </div>
      <ViewContactSheet v-if="sheet" :document="shown" :loop :cel @select="chooseFromSheet" />
      <ViewRecolor
        v-else-if="tools.tool.value === 'recolor'"
        v-model:from="tools.recolorFrom.value"
        :document="draft.document.value"
        :loop
        :cel
        :propagate="propagates(loop)"
        :frozen="frozen()"
        @apply="(op) => edit(op, 'Recolour')"
        @close="tools.closeRecolor()"
      />
    </main>

    <PaletteStrip
      v-if="workspaceFocus"
      :value="color"
      @choose="color = $event"
      class="view-workspace-palette"
      data-testid="view-palette"
    />
    <ViewTimeline
      class="view-studio__timeline"
      :document="shown"
      :loop
      :cel
      :frozen="frozen()"
      @select="selectCel"
      @edit="edit"
      @edits="edit"
    />

    <aside class="view-studio__panel" aria-label="Cel, previews and linked loops">
      <!-- The lesson's card docks at the top of the side panel, never over the stage. -->
      <LessonCard
        v-if="lesson.session.value"
        :session="lesson.session.value"
        :outcome="lesson.outcome.value"
      />
      <ViewPalette
        v-model="color"
        data-testid="view-palette"
        :transparent="currentCel?.transparent ?? 0"
        @erase="
          tools.setTool('eraser');
          say({ tone: 'ok', text: 'The eraser is on: it paints the transparent colour.' });
        "
        @choose="celPanel?.chooseTransparent()"
      />
      <ViewCelPanel
        v-if="currentCel"
        ref="celPanel"
        :cel="currentCel"
        :loop
        :index="cel"
        :frozen="frozen()"
        @edit="celEdit"
      >
        <ViewMirrorNote
          :document="draft.document.value"
          :loop
          :propagate="propagates(loop)"
          :isolated="draft.isolated.value"
          @propagate="setPropagate"
        />
      </ViewCelPanel>
      <ViewPreview
        :document="shown"
        :loop
        :partner="previewPartner(shown, loop)"
        :speed
        :view="viewNumber"
        :cyclers
      />
      <ViewRoomPreview
        v-if="currentCel && rooms.length > 0"
        :rooms
        :files
        :profile
        :cel="currentCel"
        :priority-base="priorityBase"
      />
    </aside>

    <Teleport :disabled="!active || !inWorkspace" defer to="#workspace-status-left">
      <footer class="view-studio__status" aria-label="Status bar">
        <span data-role="status">{{ status }}</span>
        <span
          v-if="tools.penDown.value"
          class="view-studio__hint is-pen"
          data-testid="view-pen-down"
          >{{ PEN_DOWN }}</span
        >
        <!-- A notice takes the hint's place, off the cel. -->
        <StudioStatusNotice v-else-if="notice" :banner="null" :notice @dismiss="dismissNotice" />
        <span
          v-else-if="VIEW_TOOL_HINTS[tools.tool.value]"
          class="view-studio__hint"
          data-testid="view-hint"
          >{{ VIEW_TOOL_HINTS[tools.tool.value] }}</span
        >
        <span class="view-studio__spacer"></span>
        <StudioZoom :zoom :fitted @zoom="(to) => (to === 'fit' ? zoomToFit() : zoomBy(to))" />
      </footer>
    </Teleport>
    <p class="view-studio__sr" aria-live="polite">{{ spoken }}</p>
  </div>
</template>

<style scoped>
.view-studio {
  position: relative;
  display: grid;
  grid-template-rows: 0 40px minmax(0, 1fr) 120px 28px;
  grid-template-columns: 44px minmax(0, 1fr) 300px;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: var(--ink);
  background: var(--surface-1);
  font: var(--text-sm) / var(--leading) var(--font-sans);
  outline: 0;
}
/* The rail runs down beside the timeline too: every tool has room at 1024×600. */
.view-studio__rail {
  grid-row: 3 / 5;
  grid-column: 1;
}
/* The options bar docks over the rail and the canvas: nothing floats on the cel. */
.view-studio__options {
  grid-row: 2;
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface-1);
}
.view-options {
  display: flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
  row-gap: 0;
  min-width: 0;
  overflow: hidden;
  color: var(--ink-2);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.view-options__name {
  min-width: 0;
  color: var(--ink);
  font-weight: var(--weight-bold);
}
.view-options > * {
  flex-shrink: 0;
}
.view-options__colour {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink);
  font-weight: var(--weight-bold);
}
.view-options__colour i {
  width: var(--space-5);
  height: var(--space-5);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
}
.view-options__note {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.view-options__erase {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--ink-2);
  font-size: var(--text-sm);
}
.view-studio__frame {
  position: relative;
  grid-row: 3;
  grid-column: 2;
  min-width: 0;
  min-height: 0;
  background-color: var(--surface-sunken);
  background-image: radial-gradient(var(--surface-3) 1px, transparent 1px);
  background-size: 16px 16px;
}
.view-studio__stage {
  position: absolute;
  inset: 0;
  display: flex;
  overflow: auto;
  outline: 0;
}
.view-studio__stage:focus-visible {
  box-shadow: inset 0 0 0 2px var(--focus);
}
/* The inset matches STAGE_INSET in useStudioViewport.ts. */
.view-studio__canvas {
  margin: auto;
  padding: var(--space-7);
}
.view-studio__timeline {
  grid-row: 4;
  grid-column: 2;
}
.view-studio__panel {
  grid-row: 3 / 5;
  grid-column: 3;
  overflow-y: auto;
  border-left: 1px solid var(--hairline);
}
.view-studio__status {
  grid-row: 5;
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
  padding: 0 var(--space-1) 0 var(--space-4);
  overflow: hidden;
  border-top: 1px solid var(--hairline);
  color: var(--ink-3);
  background: var(--surface-0);
  font: var(--text-2xs) var(--font-mono);
  white-space: nowrap;
}
.view-studio__status [data-role="status"] {
  color: var(--ink-2);
}
/* The tool's help wraps onto a second line when the bar is short. */
.view-studio__hint {
  min-width: 16ch;
  color: var(--ink-3);
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  line-height: 1.2;
  white-space: normal;
}
.view-studio__spacer {
  flex: 1;
}
.view-studio__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.view-studio.is-workspace-focus {
  grid-template-columns: 44px minmax(0, 1fr) 0;
  grid-template-rows: 0 40px minmax(0, 1fr) 52px 120px 28px;
}
.view-studio.is-workspace-focus .view-studio__panel {
  display: none;
}
.view-studio.is-context-open.is-workspace-focus .view-studio__panel {
  display: block;
  grid-column: 1 / -1;
  grid-row: 1 / -1;
  position: absolute;
  z-index: 3;
  right: 0;
  top: 40px;
  bottom: 28px;
  width: min(300px, calc(100% - 44px));
  background: var(--surface-1);
  border-left: 1px solid var(--hairline);
  box-shadow: var(--shadow-pop);
}
.view-workspace-palette {
  grid-column: 2;
  grid-row: 4;
}
.view-studio.is-workspace-focus .view-studio__timeline {
  grid-row: 5;
}
.view-studio.is-workspace-focus .view-studio__status {
  grid-row: 6;
}
</style>
