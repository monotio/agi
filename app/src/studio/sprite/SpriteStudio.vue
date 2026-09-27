<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onScopeDispose,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import type { StudioFocus } from "../../../../src/agent/studioAssistTools.ts";
import { viewAssistScope } from "../../../../src/studio/assistScope.ts";
import { openSprite, type SpriteDocument } from "../../../../src/studio/sprite/spriteDocument.ts";
import type { ResourceRevision } from "../../../../src/gameIdentity.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
import type { SpriteEdit } from "../../../../src/studio/sprite/spriteOperations.ts";
import type { ViewUsage } from "../../../../src/studio/sprite/spriteUsage.ts";
import { engineKey, useEngineApi } from "../../engineContext.ts";
import { aiSettingsKey } from "../../useAiSettings.ts";
import UiSegmented from "../../ui/UiSegmented.vue";
import LessonCard from "../../lessons/LessonCard.vue";
import { useStudioLesson } from "../../lessons/useStudioLesson.ts";
import type { ResourceCommitResult, ViewEdit } from "../../resourceCommit.ts";
import { useOptionalCreateCenter, type SpriteRoom } from "../../shell/useCreateWorkspace.ts";
import StudioAssistCompare from "../StudioAssistCompare.vue";
import StudioAssistPanel from "../StudioAssistPanel.vue";
import StudioKeepDialog from "../StudioKeepDialog.vue";
import StudioSmallScreen from "../StudioSmallScreen.vue";
import StudioStageNotes from "../StudioStageNotes.vue";
import StudioZoom from "../StudioZoom.vue";
import { useStudioFocus } from "../useStudioFocus.ts";
import { useStudioKeep, type KeepRecovery } from "../useStudioKeep.ts";
import { useStudioLeave } from "../useStudioLeave.ts";
import { useStudioNotice } from "../useStudioNotice.ts";
import { useStudioViewport } from "../useStudioViewport.ts";
import { useStudioAssist, type StudioAssistHost } from "../useStudioAssist.ts";
import { changedPixels, viewChangeSummary, viewScopeChips } from "../studioAssistText.ts";
import SpriteCanvas, { type OnionSkin } from "./SpriteCanvas.vue";
import SpriteCelPanel, { type CelEdit } from "./SpriteCelPanel.vue";
import SpriteContactSheet from "./SpriteContactSheet.vue";
import SpriteMirrorNote from "./SpriteMirrorNote.vue";
import SpritePalette from "./SpritePalette.vue";
import SpritePreview from "./SpritePreview.vue";
import SpriteRecolor from "./SpriteRecolor.vue";
import SpriteRoomPreview from "./SpriteRoomPreview.vue";
import SpriteTimeline from "./SpriteTimeline.vue";
import SpriteToolRail from "./SpriteToolRail.vue";
import SpriteTopBar from "./SpriteTopBar.vue";
import SpriteViewBar from "./SpriteViewBar.vue";
import { spriteKey, type SpriteKeyActions } from "./spriteKeys.ts";
import { recolorTargets } from "./spriteRecolor.ts";
import { aliasGroup, celCount, feetWarning, previewPartner, usageText } from "./spriteView.ts";
import { exposeSpriteDraft, useSpriteDraft, type SpriteOutcome } from "./useSpriteDraft.ts";
import { SPRITE_TOOL_KEYS, useSpriteTools } from "./useSpriteTools.ts";

/** A Keep transaction for the harness: the edit, and the staged reference it keeps, if any. */
export type SpriteKeepFn = (
  edit: ViewEdit,
  stagedReference: string | undefined,
) => Promise<ResourceCommitResult>;

/**
 * Sprite Studio: one VIEW's loops and cels, edited as a draft
 * (useSpriteDraft) through the sprite kernel and kept through the resource
 * transaction (useStudioKeep). It takes the VIEW bytes and the revision they
 * were read at. Copy-on-write is the default: editing a loop that shares its
 * data block makes it a separate copy, and every edit is validated against
 * the loops it targets, so no other loop changes by accident. The recolour
 * tool swaps a colour over a cel, a loop or the view (SpriteRecolor.vue),
 * and the contact sheet shows every cel in place of the canvas
 * (SpriteContactSheet.vue). Keys are handled at the root and stopped
 * (spriteKeys.ts), so none reach the game, and focus never falls out of the
 * studio while it is open; every way out settles unkept changes first
 * (useStudioLeave), as in Room Studio. "Ask about this selection"
 * (useStudioAssist) has the game's AI propose a change to the selected cel
 * or loop, previewed on the canvas and accepted as one undo step.
 */
const {
  viewNumber,
  bytes,
  profile,
  title = undefined,
  baseRevision = undefined,
  keep: keepFn = undefined,
  files = new Map(),
  usage = { rooms: [], logics: [], dynamic: false },
  rooms = [],
  speed = 1,
  priorityBase = undefined,
  stagedReference = undefined,
} = defineProps<{
  viewNumber: number;
  bytes: Uint8Array;
  profile: AgiProfile;
  /** A name when the VIEW carries no description. */
  title?: string | undefined;
  /** The game revision the bytes were read at; without one the view is view only. */
  baseRevision?: ResourceRevision | undefined;
  /** The Keep transaction; the engine's when omitted. */
  keep?: SpriteKeepFn | undefined;
  /** The game's container files, read at the same revision: the rooms' pictures. */
  files?: ReadonlyMap<string, Uint8Array>;
  usage?: ViewUsage;
  rooms?: readonly SpriteRoom[];
  /** The game's cycle delay (v10): the loop preview's pace. */
  speed?: number;
  priorityBase?: number | undefined;
  /** The staged character-sheet candidate these bytes are: its Keep spends the offer. */
  stagedReference?: string | undefined;
}>();
/** `reopen` asks for Studio again; `fromStorage` reloads the game from storage first. */
const emit = defineEmits<{ close: []; reopen: [fromStorage: boolean] }>();

const draft = useSpriteDraft({
  base: () => ({ bytes, revision: baseRevision }),
  profile: () => profile,
});
/** A Help guide lesson Studio opened from: every successful Keep runs its challenge. */
const lesson = useStudioLesson();
// A lesson can open on the loop and cel its steps speak of.
const opened = lesson.session.value?.lesson.open;
const openedDocument = draft.document.value;
const startLoop = Math.max(
  0,
  Math.min(opened?.studio === "sprite" ? (opened.loop ?? 0) : 0, openedDocument.loops.length - 1),
);
const startCel = Math.max(
  0,
  Math.min(
    opened?.studio === "sprite" ? (opened.cel ?? 0) : 0,
    (openedDocument.loops[startLoop]?.cels.length ?? 1) - 1,
  ),
);
const loop = ref(startLoop);
const cel = ref(startCel);
/** The loop whose linked group is edited together ("Edit loop N instead"); null copies on write. */
const linkedEdit = shallowRef<number | null>(null);
const color = ref(11);
const { notice, say, hold } = useStudioNotice();

// A structural edit, undo or a new base can take the selected loop or cel away.
watch(
  () => draft.document.value,
  (document) => {
    loop.value = Math.min(loop.value, document.loops.length - 1);
    cel.value = Math.min(cel.value, (document.loops[loop.value]?.cels.length ?? 1) - 1);
  },
);

// ---- Ask about this selection ----------------------------------------------
const engineApi = inject(engineKey, null);
const aiSettings = inject(aiSettingsKey, null);
const assistHost: StudioAssistHost | null =
  engineApi && aiSettings
    ? {
        run: (request) => engineApi.runStudioAssist(request, aiSettings.llmConfig()),
        cancel: () => engineApi.discardAgent(),
        resume: () => engineApi.continueAgent(),
        task: () => engineApi.state.agentTask,
        log: () => engineApi.state.agentLog,
      }
    : null;
/** What an Ask is about: the selected cel, or every cel of its loop. */
const askScope = ref<"cel" | "loop">("loop");
const ASK_SCOPES = [
  { value: "cel", label: "This cel" },
  { value: "loop", label: "Whole loop" },
] as const;
const askCels = computed(() => {
  const cels = draft.document.value.loops[loop.value]?.cels ?? [];
  if (askScope.value === "cel")
    return cels[cel.value] ? [{ loop: loop.value, cel: cel.value }] : [];
  return cels.map((_, index) => ({ loop: loop.value, cel: index }));
});
/** Every loop the request leaves alone: pixels and metadata. */
const askProtected = computed(() =>
  draft.document.value.loops.flatMap((_, index) => (index === loop.value ? [] : [index])),
);
const currentView = () => ({ kind: "view" as const, payload: draft.bytes.value });
const assist = useStudioAssist({
  host: () => assistHost,
  configured: () => aiSettings?.aiConfigured.value ?? false,
  frozen: () => frozen(),
  selected: () => askCels.value.length > 0,
  focus: (): StudioFocus | null =>
    askCels.value.length === 0
      ? null
      : {
          scope: viewAssistScope({
            num: viewNumber,
            document: draft.document.value,
            targetCels: askCels.value,
            protectedLoops: askProtected.value,
          }),
          draft: currentView,
          profile,
        },
  current: currentView,
  apply: (candidate, focus) => {
    if (candidate.kind !== "view" || focus.scope.kind !== "view")
      return { ok: false, message: "That proposal is not for this view." };
    const outcome = draft.adopt(candidate.draft.payload, "AI edit", focus.scope);
    report(outcome);
    return outcome.ok ? outcome : { ok: false, message: outcome.refusal.message };
  },
});
/** An AI proposal awaiting a verdict, decoded. */
const proposal = computed<SpriteDocument | null>(() => {
  const candidate = assist.candidate.value;
  if (assist.phase.value !== "candidate" || candidate?.kind !== "view") return null;
  try {
    return openSprite(candidate.draft.payload, profile);
  } catch {
    return null;
  }
});
/** The canvas and previews show the draft (before) or the proposal applied (after). */
const compare = ref<"before" | "after">("after");
watch(proposal, (next, previous) => {
  if (next && !previous) compare.value = "after";
});
/** What the canvas and previews show: a proposal's side, the gesture's preview, else the document. */
const shown = computed(() =>
  proposal.value
    ? compare.value === "after"
      ? proposal.value
      : draft.document.value
    : draft.shown.value,
);
/** The current cel's pixels the proposal changes. */
const changedHere = computed(() =>
  proposal.value
    ? changedPixels(
        draft.document.value.loops[loop.value]?.cels[cel.value],
        proposal.value.loops[loop.value]?.cels[cel.value],
      )
    : null,
);
const assistChanges = computed(() =>
  proposal.value ? viewChangeSummary(draft.document.value, proposal.value) : null,
);
const assistChips = computed(() => {
  const scope = assist.holds.value ? assist.asked.value?.scope : undefined;
  return scope?.kind === "view"
    ? viewScopeChips({ targetCels: scope.targetCels, protectedLoops: scope.protectedLoops ?? [] })
    : viewScopeChips({ targetCels: askCels.value, protectedLoops: askProtected.value });
});
const assistPanel = useTemplateRef("assistPanel");

const currentCel = computed(() => shown.value.loops[loop.value]?.cels[cel.value]);
const group = computed(() => aliasGroup(draft.document.value, loop.value));
/** Edits of `target` change its whole linked group. */
const propagates = (target: number): boolean =>
  linkedEdit.value !== null &&
  aliasGroup(draft.document.value, linkedEdit.value).length > 1 &&
  aliasGroup(draft.document.value, linkedEdit.value).includes(target);

/**
 * The loops an edit may change (validateSpriteEdit's `targetLoops`): the
 * edited loop, or its linked group when edits propagate; a loop added or
 * deleted renumbers every loop after it.
 */
function targetsOf(op: SpriteEdit): number[] | undefined {
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

const keeper = useStudioKeep({ draft, keep: keepView });
const engine = keepFn ? null : useEngineApi();
/** The staged offer the next Keep spends; once kept, the view is the game's own. */
let stagedPending = stagedReference;
async function keepView(revision: ResourceRevision): Promise<ResourceCommitResult> {
  const edit: ViewEdit = {
    viewNumber,
    bytes: draft.bytes.value,
    baseRevision: revision,
    reason: draft.reason(),
  };
  const result = keepFn
    ? await keepFn(edit, stagedPending)
    : stagedPending
      ? await engine!.keepStagedView(stagedPending, { bytes: edit.bytes, baseRevision: revision })
      : await engine!.commitViewEdit(edit);
  stagedPending = undefined;
  lesson.check({ kind: "view", num: viewNumber, after: edit.bytes, profile });
  return result;
}
/** Editing is blocked: view only, or a Keep that needs a reload first. */
const frozen = (): boolean => draft.kept.value.revision === undefined || keeper.needsReload.value;
/** Edits wait while an AI request runs or its proposal awaits a verdict; undo still runs. */
const editsBlocked = (): boolean => frozen() || assist.holds.value;

/** Say what an edit did: why it was refused, a split-off copy, feet that moved. */
function report(outcome: SpriteOutcome, feetFrom?: typeof currentCel.value): void {
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
  op: SpriteEdit | readonly SpriteEdit[],
  label: string,
  feetFrom?: typeof currentCel.value,
): void {
  if (frozen()) {
    say({ tone: "warn", text: "This view is view only: nothing can be changed." });
    return;
  }
  if (assist.holds.value) {
    say({ tone: "warn", text: "Accept or reject the AI's proposal first." });
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

const tools = useSpriteTools({
  draft,
  loop,
  cel,
  propagate: () => propagates(loop.value),
  targets: () => (propagates(loop.value) ? group.value : [loop.value]),
  color,
  report: (outcome) => report(outcome),
  say,
  frozen,
  paused: () => assist.holds.value,
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
const onionDepth = ref(1);
const showGrid = ref(true);
const showBaseline = ref(true);
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
    // The view bar above the canvas and the baseline label below it.
    below: 96,
  }),
  max: 24,
});
const onion = computed<OnionSkin[]>(() => {
  const cels = shown.value.loops[loop.value]?.cels ?? [];
  const out: OnionSkin[] = [];
  const used = new Set([cel.value]);
  for (let distance = 1; distance <= onionDepth.value; distance++)
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
  "Canvas. Arrow keys move the cursor 1 pixel (Shift: 8), or the selection; Space or Enter clicks at the cursor; Escape cancels.";
const PEN_DOWN = "Pen down — Space to lift";
const spoken = computed(() => {
  const point = tools.cursor.value;
  const at = tools.keyboard.value && point ? `x ${point.x} y ${point.y}` : "";
  return tools.penDown.value ? (at ? `${PEN_DOWN} · ${at}` : PEN_DOWN) : at;
});
/** Why Keep is disabled right now, on its button: an open gesture finishes first. */
const keepTitle = computed(() =>
  draft.gesturing.value
    ? tools.penDown.value
      ? "The pen is down: Space lifts it, then the changes can be kept."
      : "A drawing gesture is open: finish or cancel it, then the changes can be kept."
    : undefined,
);

// ---- the way out ---------------------------------------------------------

const leave = useStudioLeave({
  unkept: () => draft.dirty.value && !keeper.needsReload.value,
  keep: () => keepChanges(),
  discard: () => draft.discard(),
});
const center = useOptionalCreateCenter();
if (center) onScopeDispose(center.guardStudio(leave));
const opening = () => center?.studio.value?.notice;
watch(opening, (text) => text && say({ tone: "ok", text }), { immediate: true });
const dialog = leave.ask;
async function requestClose(): Promise<void> {
  if (await leave.confirm()) emit("close");
}
function discardChanges(): void {
  leave.discarding.value = false;
  tools.cancel();
  draft.discard();
  say({ tone: "ok", text: "Changes discarded." });
}
async function keepChanges(): Promise<boolean> {
  tools.cancel();
  const kept = await keeper.keep();
  keepFocus();
  if (!kept) return false;
  say(lesson.keptNotice(`VIEW ${viewNumber}`));
  return true;
}
async function recover(recovery: KeepRecovery): Promise<void> {
  if (recovery === "retry") return void keepChanges();
  await reopen(keeper.banner.value?.fromStorage === true);
}
/** Reopen Studio on the running game, or on the game reloaded from storage; the draft stays behind. */
async function reopen(fromStorage: boolean): Promise<void> {
  if (fromStorage && !(await leave.confirmReload())) return;
  keeper.dismiss();
  draft.discard();
  emit("reopen", fromStorage);
}
function history(which: "undo" | "redo"): void {
  if (frozen()) return;
  tools.cancel();
  if (which === "undo" ? draft.undo() : draft.redo()) say(null);
}

const keepFocus = useStudioFocus(useTemplateRef("root"));
exposeSpriteDraft(draft);

const keys: SpriteKeyActions = {
  onCanvas: (target) => target === stage.value,
  dismiss: () => tools.cancel() || closeSheet() || tools.closeRecolor(),
  close: () => void requestClose(),
  arrow: tools.arrow,
  click: tools.click,
  remove: () => void tools.clearSelection(),
  step,
  zoom: (to) => (to === "fit" ? zoomToFit() : zoomBy(to)),
  undo: () => history("undo"),
  redo: () => history("redo"),
  tool: (key) => {
    const next = SPRITE_TOOL_KEYS[key];
    if (next === "flip") tools.flip();
    else if (next) tools.setTool(next);
    return next !== undefined;
  },
  ask: () => assistPanel.value?.focus() ?? false,
};
/** Every key stops here so the game never sees it. */
function onKeydown(event: KeyboardEvent): void {
  event.stopPropagation();
  if (dialog.value !== undefined) return;
  if (spriteKey(event, keys)) event.preventDefault();
  keepFocus();
}

const description = computed(() => draft.document.value.description ?? title ?? "");
const status = computed(() => {
  const point = tools.cursor.value;
  const at = currentCel.value;
  if (!point || !at) return `loop ${loop.value} · cel ${cel.value}`;
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
    class="sprite-studio"
    data-testid="sprite-studio"
    tabindex="-1"
    role="region"
    :aria-label="`Sprite Studio: VIEW ${viewNumber}`"
    @keydown="onKeydown"
    @keyup.stop
    @keypress.stop
    @click="keepFocus"
  >
    <SpriteTopBar
      class="sprite-studio__top"
      :view-number="viewNumber"
      :description
      :usage="usageText(usage)"
      :dynamic="usage.dynamic"
      :loops="shown.loops.length"
      :cels="celCount(shown)"
      :status="keeper.status.value"
      :changes="draft.changes.value"
      :can-undo="draft.canUndo.value && !keeper.needsReload.value"
      :can-redo="draft.canRedo.value && !keeper.needsReload.value"
      :can-keep="keeper.canKeep.value"
      :keep-title="keepTitle"
      @back="requestClose"
      @close="requestClose"
      @undo="history('undo')"
      @redo="history('redo')"
      @keep="keepChanges()"
      @discard="leave.discarding.value = true"
    />

    <SpriteToolRail
      :tool="tools.tool.value"
      class="sprite-studio__rail"
      :frozen="editsBlocked()"
      :color
      @update:tool="tools.setTool"
      @flip="tools.flip()"
    />

    <main
      class="sprite-studio__frame"
      :class="{ 'sprite-studio__frame--recolor': tools.tool.value === 'recolor' && !sheet }"
    >
      <SpriteViewBar
        v-model:sheet="sheet"
        v-model:prev="onionPrev"
        v-model:next="onionNext"
        v-model:depth="onionDepth"
        v-model:grid="showGrid"
        v-model:baseline="showBaseline"
      />
      <div
        ref="stage"
        class="sprite-studio__stage"
        tabindex="0"
        role="group"
        :aria-label="CANVAS_LABEL"
        :inert="sheet"
        data-testid="sprite-stage"
      >
        <SpriteCanvas
          v-if="currentCel"
          class="sprite-studio__canvas"
          :cel="currentCel"
          :onion
          :zoom
          :dpr
          :grid="showGrid"
          :baseline="showBaseline"
          :overlay="tools.overlay.value"
          :changed="changedHere"
          :label="`Loop ${loop}, cel ${cel}: ${currentCel.width} by ${currentCel.height} pixels`"
          @hover="tools.hover"
          @press="(press) => tools.pressAt(press.point, press.alt)"
          @drag="tools.dragTo"
          @release="tools.release"
          @abort="tools.cancel()"
        />
      </div>
      <SpriteContactSheet v-if="sheet" :document="shown" :loop :cel @select="chooseFromSheet" />
      <SpriteRecolor
        v-else-if="tools.tool.value === 'recolor'"
        v-model:from="tools.recolorFrom.value"
        :document="draft.document.value"
        :loop
        :cel
        :propagate="propagates(loop)"
        :frozen="editsBlocked()"
        @apply="(op) => edit(op, 'Recolour')"
        @close="tools.closeRecolor()"
      />
      <StudioAssistCompare
        v-if="proposal"
        v-model="compare"
        below-bar
        :stale="assist.stale.value"
      />
      <StudioStageNotes
        :banner="keeper.banner.value"
        :notice
        :editing="false"
        @recover="recover"
        @hold="hold"
      />
      <StudioZoom :zoom :fitted @zoom="(to) => (to === 'fit' ? zoomToFit() : zoomBy(to))" />
      <p v-if="tools.penDown.value" class="sprite-studio__pen" data-testid="sprite-pen-down">
        {{ PEN_DOWN }}
      </p>
    </main>

    <SpriteTimeline
      class="sprite-studio__timeline"
      :document="shown"
      :loop
      :cel
      :frozen="editsBlocked()"
      @select="selectCel"
      @edit="edit"
      @edits="edit"
    />

    <aside class="sprite-studio__panel" aria-label="Cel, previews and linked loops">
      <!-- The lesson's card docks at the top of the side panel, never over the stage. -->
      <LessonCard
        v-if="lesson.session.value"
        :session="lesson.session.value"
        :outcome="lesson.outcome.value"
      />
      <SpritePalette
        v-model="color"
        :transparent="currentCel?.transparent ?? 0"
        @erase="
          tools.setTool('eraser');
          say({ tone: 'ok', text: 'The transparent colour cannot be painted: the eraser is on.' });
        "
      />
      <SpriteCelPanel
        v-if="currentCel"
        :cel="currentCel"
        :loop
        :index="cel"
        :frozen="editsBlocked()"
        @edit="celEdit"
      />
      <SpriteMirrorNote
        :document="draft.document.value"
        :loop
        :propagate="propagates(loop)"
        :isolated="draft.isolated.value"
        :rooms="usage.rooms"
        @propagate="setPropagate"
      />
      <SpritePreview :document="shown" :loop :partner="previewPartner(shown, loop)" :speed />
      <SpriteRoomPreview
        v-if="currentCel && rooms.length > 0"
        :rooms
        :files
        :profile
        :cel="currentCel"
        :priority-base="priorityBase"
      />
      <StudioAssistPanel
        v-if="assistHost"
        ref="assistPanel"
        :assist
        :chips="assistChips"
        hint="To change the scope, pick another cel or loop on the timeline."
        :changes="assistChanges"
        @reload="reopen(true)"
        noun="view"
        empty="Select a cel on the timeline to ask the AI about it."
        collapsible
      >
        <template #scope>
          <UiSegmented
            v-if="!assist.holds.value"
            v-model="askScope"
            size="sm"
            label="Ask about"
            :options="ASK_SCOPES"
            data-testid="assist-scope"
          />
        </template>
      </StudioAssistPanel>
    </aside>

    <footer class="sprite-studio__status">
      <span data-role="status">{{ status }}</span>
      <span>{{ tools.tool.value }} · 1 px</span>
      <span class="sprite-studio__spacer"></span>
      <span data-testid="sprite-bytes"
        >VIEW {{ viewNumber }} · {{ draft.bytes.value.length.toLocaleString("en") }} B</span
      >
      <span>AGI {{ profile.id }} profile</span>
    </footer>
    <p class="sprite-studio__sr" aria-live="polite">{{ spoken }}</p>

    <StudioKeepDialog
      v-model:ask="dialog"
      :subject="`VIEW ${viewNumber}`"
      noun="view"
      :changes="draft.changes.value"
      :can-keep="keeper.canKeep.value"
      @keep="leave.answer('keep')"
      @discard="(answer) => (answer ? leave.answer('discard') : discardChanges())"
    />
    <StudioSmallScreen name="Sprite Studio" :draft :keeper @close="emit('close')" />
  </div>
</template>

<style scoped>
.sprite-studio {
  position: relative;
  display: grid;
  grid-template-rows: 52px minmax(0, 1fr) minmax(150px, 30%) 28px;
  grid-template-columns: 48px minmax(0, 1fr) 300px;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: var(--ink);
  background: var(--surface-1);
  font: var(--text-sm) / var(--leading) var(--font-sans);
  outline: 0;
}
.sprite-studio__top {
  grid-column: 1 / -1;
}
.sprite-studio__rail {
  grid-row: 2;
  grid-column: 1;
}
.sprite-studio__frame {
  position: relative;
  grid-row: 2;
  grid-column: 2;
  min-width: 0;
  min-height: 0;
  background-color: var(--surface-sunken);
  background-image: radial-gradient(var(--surface-3) 1px, transparent 1px);
  background-size: 16px 16px;
}
.sprite-studio__stage {
  position: absolute;
  inset: 0;
  display: flex;
  overflow: auto;
  outline: 0;
}
.sprite-studio__stage:focus-visible {
  box-shadow: inset 0 0 0 2px var(--focus);
}
/* The recolour popover owns the stage's left column (12px + 256px); the
   notice recentres in what remains so the two never overlap. */
.sprite-studio__frame--recolor :deep(.stage-note) {
  left: calc(50% + 134px);
}
/* Ask floats at the frame's upper right, under the view bar: the side panel
   keeps its previews in view without scrolling. */
/* The held pen's cue, at the stage's lower left like the editing keys' hint. */
.sprite-studio__pen {
  position: absolute;
  bottom: var(--space-4);
  left: var(--space-4);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  color: var(--ink-2);
  background: var(--surface-overlay);
  font-size: var(--text-2xs);
  white-space: nowrap;
  pointer-events: none;
}
/* The inset matches STAGE_INSET in useStudioViewport.ts; the top clears the view bar. */
.sprite-studio__canvas {
  margin: auto;
  padding: calc(var(--space-7) + var(--control-h)) var(--space-7) var(--space-7);
}
.sprite-studio__timeline {
  grid-row: 3;
  grid-column: 1 / 3;
}
.sprite-studio__panel {
  grid-row: 2 / 4;
  grid-column: 3;
  overflow-y: auto;
  border-left: 1px solid var(--hairline);
}
.sprite-studio__status {
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
.sprite-studio__status [data-role="status"] {
  color: var(--ink-2);
}
.sprite-studio__spacer {
  flex: 1;
}
.sprite-studio__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
