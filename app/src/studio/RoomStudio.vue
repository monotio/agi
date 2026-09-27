<script setup lang="ts">
import {
  computed,
  inject,
  onMounted,
  onScopeDispose,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import type { ResourceRevision } from "../../../src/gameIdentity.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { createAgentSessionState } from "../../../src/agent/agentState.ts";
import { openContainer } from "../../../src/container/container.ts";
import {
  itemHandles,
  nearestInsertion,
  type PointInsertion,
} from "../../../src/studio/editPoints.ts";
import type { StudioFocus } from "../../../src/agent/studioAssistTools.ts";
import { pictureAssistScope, selectionArea } from "../../../src/studio/assistScope.ts";
import { compileEditDocument, footprintMask } from "../../../src/studio/editValidation.ts";
import { parsePictureDocument } from "../../../src/studio/pictureDocument.ts";
import type { PlayHereTarget } from "../../../src/studio/playHere.ts";
import type { RuleSession } from "../../../src/studio/rules/ruleEdit.ts";
import type { Point } from "../../../src/studio/shapes.ts";
import { engineKey } from "../engineContext.ts";
import { aiSettingsKey } from "../useAiSettings.ts";
import {
  ResourceCommitError,
  type ResourceCommitResult,
  type RoomEdit,
} from "../resourceCommit.ts";
import type { StudioRoomSource } from "../world/studioSource.ts";
import LessonCard from "../lessons/LessonCard.vue";
import { useStudioLesson } from "../lessons/useStudioLesson.ts";
import { useOptionalCreateCenter } from "../shell/useCreateWorkspace.ts";
import DrawOrderScrubber from "./DrawOrderScrubber.vue";
import GhostProbe from "./GhostProbe.vue";
import PixelInspector from "./PixelInspector.vue";
import SceneList from "./SceneList.vue";
import StudioAssistCompare from "./StudioAssistCompare.vue";
import StudioAssistPanel from "./StudioAssistPanel.vue";
import StudioCanvas, { type MaskPaths } from "./StudioCanvas.vue";
import StudioCanvasMenu, { type CanvasMenuItem } from "./StudioCanvasMenu.vue";
import StudioContextBar from "./StudioContextBar.vue";
import StudioItemEditor from "./StudioItemEditor.vue";
import StudioKeepDialog from "./StudioKeepDialog.vue";
import StudioLockNote from "./StudioLockNote.vue";
import StudioLogicText from "./StudioLogicText.vue";
import StudioSmallScreen from "./StudioSmallScreen.vue";
import StudioStageNotes from "./StudioStageNotes.vue";
import StudioToolOptions from "./StudioToolOptions.vue";
import StudioToolOverlay from "./StudioToolOverlay.vue";
import StudioToolRail from "./StudioToolRail.vue";
import StudioTopBar from "./StudioTopBar.vue";
import StudioViewBar from "./StudioViewBar.vue";
import StudioWalkOverlay from "./StudioWalkOverlay.vue";
import StudioWalkPanel from "./StudioWalkPanel.vue";
import StudioZoom from "./StudioZoom.vue";
import type { RouteRunner } from "./routeRunner.ts";
import { isWalkTool, TOOL_KEYS, type StudioTool } from "./studioTools.ts";
import { studioKey, type StudioKeyActions } from "./studioKeys.ts";
import {
  depthValuesLocked,
  lensItemLocks,
  lockedPlanes,
  NO_UNLOCKS,
  type LensUnlocks,
} from "./studioLocks.ts";
import {
  changedCells,
  labelList,
  pictureChangeSummary,
  pictureScopeChips,
} from "./studioAssistText.ts";
import { HOLD_TEXT, useStudioAssist, type StudioAssistHost } from "./useStudioAssist.ts";
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
import { draftPictureEdit, exposeStudioDraft, useStudioDraft } from "./useStudioDraft.ts";
import { useStudioFocus } from "./useStudioFocus.ts";
import { useStudioInput } from "./useStudioInput.ts";
import { useStudioDrag } from "./useStudioDrag.ts";
import { useStudioEditing } from "./useStudioEditing.ts";
import { useStudioKeep, type KeepFn, type KeepRecovery } from "./useStudioKeep.ts";
import { useStudioLeave } from "./useStudioLeave.ts";
import { useStudioReadout } from "./useStudioReadout.ts";
import { useStudioSelection } from "./useStudioSelection.ts";
import { useStudioTools } from "./useStudioTools.ts";
import { useStudioViewport } from "./useStudioViewport.ts";
import { useRoomLogicDraft } from "./useRoomLogicDraft.ts";
import { DEFAULT_EGO, useStudioWalk, type EgoShape } from "./useStudioWalk.ts";
import { useUndoOrder } from "./useUndoOrder.ts";

/**
 * Room Studio: one picture's items, draw order and planes, edited as a draft
 * (useStudioDraft) and kept through the resource transaction (useStudioKeep).
 * It takes the picture bytes (and authored text, trusted only while it
 * compiles to those bytes) and the revision they were read at. Keys are
 * handled at the root and stopped (studioKeys.ts), so none reach the game,
 * and focus never falls out of the studio while it is open. The tool rail
 * (useStudioTools, by pointer or keys: useStudioInput) inserts new items at
 * the playhead; the actor probe stands a VIEW from the game's `files` on the
 * draft; every way out settles unkept changes first (useStudioLeave). The
 * Walk view (useStudioWalk) adds test walks, Play here and the room's doors,
 * whose logic edits keep together with the picture in one transaction. "Ask
 * about this selection" (useStudioAssist) has the game's AI propose a change
 * to the selected items, previewed on the canvas and accepted as one undo step.
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
  keepRoom = undefined,
  files = undefined,
  walk = undefined,
  runRoute = undefined,
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
  /** The combined picture + room logic Keep; the engine's when omitted. */
  keepRoom?: ((edit: RoomEdit) => Promise<ResourceCommitResult>) | undefined;
  /** The game's container files, read at the same revision: the actor probe's VIEWs. */
  files?: ReadonlyMap<string, Uint8Array> | undefined;
  /** The room framing the picture: its logic (doors), bindings, plan and tests. */
  walk?: StudioRoomSource | null | undefined;
  /** Runs a test walk; a worker by default. */
  runRoute?: RouteRunner | undefined;
}>();
/**
 * `reopen` asks for Studio again; `fromStorage` reloads the game from storage
 * first. `play-here` asks the shell to leave Studio and play from a spot.
 */
const emit = defineEmits<{
  close: [];
  reopen: [fromStorage: boolean];
  "play-here": [target: PlayHereTarget];
}>();

const lens = ref<StudioLens>("art");
const mode = ref<StudioViewMode>("blend");
const showBands = ref(true);
const filter = ref("");
const unlocks = ref<LensUnlocks>(NO_UNLOCKS);
/** More points than this and the item shows no handles (the inspector still lists them). */
const MAX_HANDLES = 160;
/** How near its line, in CSS pixels, an Alt+click adds a point. */
const INSERT_REACH = 12;

const resolved = computed(() => resolveStudioSource({ bytes, authoredSource, profile }));
const draft = useStudioDraft({
  base: () => ({ source: resolved.value.source, revision: baseRevision }),
  profile: () => profile,
  lens,
  unlocks,
});
const doc = useStudioDocument(() => ({
  source: draft.source.value,
  // A Keep stores the draft's annotated text beside the bytes: from then on
  // it is the picture's authored source, not a disassembly.
  trusted: resolved.value.trusted || draft.kept.value.revision !== baseRevision,
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
const { hoveredId, selectedId, selectedRow, pinnedCell } = selection;
const readout = useStudioReadout({ doc, selection, lens });
const { ticks, current, drawn, single, pixel, fill, labelOf, status } = readout;
/** The engine, when Studio runs in the app (the harness supplies its own Keep). */
const engineApi = inject(engineKey, null);
const commitPicture =
  keepFn ??
  engineApi?.commitPictureEdit ??
  (() => Promise.reject(new Error("Nothing can be kept here.")));
const commitRoom =
  keepRoom ??
  engineApi?.commitRoomEdit ??
  (() => Promise.reject(new Error("Door changes can't be kept here.")));
/** A Help guide lesson Studio opened from: every successful Keep runs its challenge. */
const lesson = useStudioLesson();

/** The room's logic, editable while its annotated text is trusted (useRoomLogicDraft). */
const ruleSession = computed<RuleSession | null>(() => {
  if (!walk || !files) return null;
  const state = createAgentSessionState(openContainer(new Map(files)), profile);
  state.authoring = structuredClone(walk.authoring);
  state.sources.words.clear();
  for (const [word, id] of walk.words) state.sources.words.set(word, id);
  return state;
});
const logic = useRoomLogicDraft({
  base: () =>
    walk?.logicSource !== undefined && walk.logicBytes
      ? { source: walk.logicSource, bytes: walk.logicBytes }
      : null,
  session: () => ruleSession.value,
});
/** The picture as last kept: door boxes are stored in its frame. */
const keptDocument = computed(() => parsePictureDocument(draft.kept.value.source).document);
/** The logic takes part in a Keep: it changed, or a door follows the art. */
const logicInKeep = (): boolean =>
  logic.editable.value &&
  (logic.dirty.value || logic.rules.value.some((entry) => entry.rule.item !== null));
/** The picture and the doors, as one draft for the Keep and the way out. */
const room = {
  dirty: computed(() => draft.dirty.value || logic.dirty.value),
  changes: computed(() => draft.changes.value + logic.changes.value),
  gesturing: draft.gesturing,
  kept: draft.kept,
  markKept: (revision: ResourceRevision) => draft.markKept(revision),
  discard: () => {
    draft.discard();
    logic.discard();
  },
};
const keeper = useStudioKeep({
  draft: room,
  keep: async (baseRevision) => {
    const edit = draftPictureEdit(draft, pictureNumber, baseRevision);
    const pictureChanged = draft.dirty.value;
    let result: ResourceCommitResult;
    if (!logicInKeep() || !walk) result = await commitPicture(edit);
    else {
      // Doors that follow moved art move with it, in the same transaction.
      const followed = logic.forKeep(keptDocument.value, draft.document.value);
      if (!followed.ok || !("bytes" in followed))
        throw new ResourceCommitError(
          "invalid",
          `The doors can't follow this picture edit: ${"error" in followed ? followed.error : ""}`,
        );
      result = await commitRoom({
        room: walk.room,
        picture: pictureChanged
          ? { pictureNumber, bytes: edit.bytes, source: edit.source }
          : undefined,
        logic: {
          bytes: followed.bytes,
          source: followed.source,
          newBindings: followed.newBindings,
        },
        baseRevision,
        reason: edit.reason,
      });
      logic.markKept({ source: followed.source, bytes: followed.bytes });
    }
    if (pictureChanged)
      lesson.check({
        kind: "picture",
        num: pictureNumber,
        after: edit.bytes,
        afterSource: edit.source,
        profile,
      });
    return result;
  },
});
/** Editing is blocked: view only, or a Keep that needs a reload first. */
const frozen = (): boolean => draft.kept.value.revision === undefined || keeper.needsReload.value;

// ---- Ask about this selection ----------------------------------------------
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
/** The selected items an Ask is about: the item, or a group's members. */
const askTargets = computed<string[]>(() => {
  const id = selectedId.value;
  if (id === undefined) return [];
  const items = new Set(draft.document.value.items.map((item) => item.id));
  if (items.has(id)) return [id];
  const members = model.value.folds.find((fold) => fold.id === id)?.members ?? [];
  return members.filter((member) => items.has(member));
});
const itemLabel = (id: string): string =>
  draft.document.value.items.find((item) => item.id === id)?.label ?? id;
const currentPicture = () => ({ kind: "picture" as const, source: draft.source.value });
const assist = useStudioAssist({
  host: () => assistHost,
  configured: () => aiSettings?.aiConfigured.value ?? false,
  frozen,
  selected: () => askTargets.value.length > 0,
  focus: (): StudioFocus | null => {
    const targetIds = askTargets.value;
    if (targetIds.length === 0) return null;
    return {
      scope: pictureAssistScope({
        num: pictureNumber,
        compiled: draft.compiled.value,
        targetIds,
        lens: lens.value,
        unlocks: unlocks.value,
      }),
      draft: currentPicture,
      lens: lens.value,
      room: walk && walk.room > 0 ? walk.room : undefined,
      // Under ignore.horizon nothing stops ego; the estimate's 0 says the same.
      horizon: ego.value.horizon ?? 0,
      profile,
    };
  },
  current: currentPicture,
  apply: (candidate, focus) => {
    if (candidate.kind !== "picture" || focus.scope.kind !== "picture")
      return { ok: false, message: "That proposal is not for this picture." };
    const outcome = draft.adopt(candidate.draft.source, "AI edit", focus.scope);
    editing.report(outcome);
    return outcome.ok ? outcome : { ok: false, message: outcome.refusal.message };
  },
});
/** Edits wait while a request runs or its proposal awaits a verdict. */
const editsBlocked = (): boolean => frozen() || assist.holds.value;
const editing = useStudioEditing({ draft, selectedId, frozen, paused: () => assist.holds.value });
/** Cmd+Z undoes the newest change of the picture or the doors. */
const undoOrder = useUndoOrder([
  {
    past: () => draft.history.value.past.length,
    future: () => draft.history.value.future.length,
    undo: editing.undo,
    redo: editing.redo,
  },
  {
    past: () => logic.past.value,
    future: () => logic.future.value,
    undo: () => !frozen() && logic.undo(),
    redo: () => !frozen() && logic.redo(),
  },
]);

const stage = useTemplateRef("stage");
const panes = computed(() => panesFor(lens.value, mode.value));
const { viewport, zoom, dpr, fitted, stageWidth, zoomBy, zoomToFit } = useStudioViewport(
  stage,
  () => panes.value.length,
);
/**
 * A stage too narrow for the Walk legend beside the centred view bar (and,
 * from the same widths, a top bar without room for the size chip): the
 * legend folds into the bar and the footer carries the size.
 */
const narrow = computed(() => stageWidth.value > 0 && stageWidth.value < 640);

/** An AI proposal awaiting a verdict: compiled, with the cells it changes. */
const proposal = computed(() => {
  const candidate = assist.candidate.value;
  if (assist.phase.value !== "candidate" || candidate?.kind !== "picture") return null;
  try {
    const compiled = compileEditDocument(
      parsePictureDocument(candidate.draft.source).document,
      profile,
    );
    return { compiled, changed: changedCells(draft.compiled.value, compiled) };
  } catch {
    return null;
  }
});
/** The canvas shows the draft (before) or the proposal applied (after). */
const compare = ref<"before" | "after">("after");
watch(proposal, (next, previous) => {
  if (next && !previous) compare.value = "after";
});
/** The planes on screen: a proposal's side, the drag's preview while one runs, else the scrubbed draft. */
const shown = computed(() =>
  proposal.value
    ? compare.value === "after"
      ? proposal.value.compiled
      : draft.compiled.value
    : (draft.preview.value?.compiled ?? surface.value),
);
const assistChanges = computed(() => {
  const next = proposal.value;
  const scope = assist.asked.value?.scope;
  if (!next || scope?.kind !== "picture") return null;
  return pictureChangeSummary(
    draft.compiled.value,
    next.compiled,
    labelList(scope.targetIds.map(itemLabel)),
    selectionArea(draft.compiled.value, scope.targetIds),
  );
});
/** What the request is held to: the asked scope while it is open, else the selection's. */
const assistChips = computed(() => {
  const scope = assist.holds.value ? assist.asked.value?.scope : undefined;
  if (scope?.kind === "picture")
    return pictureScopeChips({
      labels: scope.targetIds.map(itemLabel),
      lockedPlanes: scope.lockedPlanes,
      depthValuesLocked: depthValuesLocked(scope.lens, scope.unlocks),
    });
  return pictureScopeChips({
    labels: askTargets.value.map(itemLabel),
    lockedPlanes: lockedPlanes(lens.value, unlocks.value),
    depthValuesLocked: depthValuesLocked(lens.value, unlocks.value),
  });
});
const assistPanel = useTemplateRef("assistPanel");
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
/** Where an Alt+click at `cell` adds a point to item `id`'s line: within reach of it only. */
function insertionNear(id: string, cell: Point): PointInsertion | undefined {
  const insertion = nearestInsertion(draft.document.value, id, cell, viewport.value.pixelAspect);
  return insertion && insertion.distance * viewport.value.zoom <= INSERT_REACH
    ? insertion
    : undefined;
}
const drag = useStudioDrag({
  draft,
  editableId: () => editableId.value,
  pick: selection.pick,
  onSelection: ({ x, y }) => selectionMask.value?.[y * 160 + x] === 1,
  labelOf: (id) => editing.item.value?.label ?? id,
  report: editing.report,
  movesItems: () => tools.tool.value !== "point",
  insertAt: insertionNear,
});
/** Ego's size and rules as the live game holds them (the estimate's actor). */
const ego = shallowRef<EgoShape>(DEFAULT_EGO);
onMounted(async () => {
  if (!engineApi) return;
  try {
    const [objects, state] = await Promise.all([
      engineApi.readObjects(),
      engineApi.readEngineState(),
    ]);
    const actor = objects.find((object) => object.num === 0);
    if (!actor || actor.width < 1) return;
    ego.value = {
      ...DEFAULT_EGO,
      width: actor.width,
      height: actor.height,
      bypassControl: actor.fixedPriority && actor.priority === 15,
      horizon: state && state.room === walk?.room ? state.horizon : DEFAULT_EGO.horizon,
    };
  } catch {
    // The estimate keeps its default actor.
  }
});
const walker = useStudioWalk({
  walk: () => walk,
  files: () => files,
  profile: () => profile,
  pictureNumber: () => pictureNumber,
  keptPicture: () => keptDocument.value,
  shownPicture: () => draft.preview.value?.document ?? draft.document.value,
  pictureBytes: () => draft.compiled.value.bytes,
  priority: () => shown.value.priority,
  logic,
  labelAt: (x, y) => describeCell(x, y),
  itemLabel: (id) => draft.document.value.items.find((item) => item.id === id)?.label ?? id,
  ego: () => ego.value,
  say: (notice) => editing.say(notice),
  frozen,
  paused: () => assist.holds.value,
  runner: runRoute,
  liveState: engineApi
    ? async () => {
        const state = await engineApi.readEngineState();
        return state && { flags: state.flags, vars: state.vars };
      }
    : undefined,
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
  paused: () => assist.holds.value,
  stage: () => stage.value,
  walk: {
    press: (tool, cell) => walker.press(tool, cell),
    dragTo: (cell) => walker.dragTo(cell),
    release: () => walker.release(),
    cancel: () => walker.cancel(),
    busy: () => walker.busy(),
  },
});
const input = useStudioInput({
  tools,
  selection,
  fallback: drag,
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
const changedPaths = computed(() => (proposal.value ? pathsOf(proposal.value.changed) : null));
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
/** Alt held over the selected line with Select or Point: the "+" where a click adds a point. */
const insertGhost = computed(() => {
  const id = editableId.value;
  const cell = selection.canvasCell.value;
  if (!input.altHeld.value || id === undefined || cell === undefined || drag.dragging.value)
    return null;
  if (tools.tool.value !== "select" && tools.tool.value !== "point") return null;
  return insertionNear(id, cell) ?? null;
});
/** Insert: add a point to the selected line where the cursor is nearest it. */
function insertPointAtCursor(): boolean {
  const id = editableId.value;
  if (id === undefined || (tools.tool.value !== "select" && tools.tool.value !== "point"))
    return false;
  const at = nearestInsertion(draft.document.value, id, input.cell.value);
  if (!at) {
    editing.say({ tone: "warn", text: "This item has no line to add a point to." });
    return true;
  }
  if (editing.insertPoint(at.line, at.pointIndex, at.x, at.y))
    input.spoken.value = `Point added at x ${at.x} y ${at.y}`;
  return true;
}
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

// ---- The Walk view ----------------------------------------------------------
const walkTint = ref(true);
/** A walk tool in another lens hands back to Select. */
watch(lens, (next) => {
  if (next !== "walk" && isWalkTool(tools.tool.value)) tools.setTool("select");
});
/** While the goal is chosen, the estimate follows the pointer or the keyboard cursor. */
watch(tools.cursor, (cell) => {
  if (tools.tool.value === "walk" && walker.start.value && !walker.goal.value)
    walker.aim.value = cell ?? null;
});
/** Picking a picture item leaves the door editor, and picking a door leaves the item. */
watch(selectedId, (id) => {
  if (id !== undefined) walker.selectedDoorId.value = null;
});
watch(walker.selectedDoorId, (id) => {
  if (id !== null) selectedId.value = undefined;
});
/** A walk tool opens the Walk view first; false while the AI holds the lens elsewhere. */
function walkView(next: StudioTool): boolean {
  if (!isWalkTool(next) || lens.value === "walk") return true;
  if (assist.holds.value) return false;
  lens.value = "walk";
  return true;
}
function pickTool(next: StudioTool): void {
  if (walkView(next)) tools.setTool(next);
  keepFocus();
}
/** A rail letter: T, D and E open the Walk view first. */
function toolKey(key: string): boolean {
  const next = TOOL_KEYS[key];
  if (next && next !== "probe" && !walkView(next)) return true;
  return input.shortcut(key);
}
const flagNames = computed(() =>
  Object.entries({ ...walk?.authoring.bindings, ...logic.reserved.value })
    .filter(([, binding]) => binding.kind === "flag")
    .map(([name]) => name)
    .sort(),
);
const pictureItems = computed(() =>
  draft.document.value.items.map((item) => ({ id: item.id, label: item.label })),
);
/** The picture item at a cell (its art, else its depth or walk lines): what a door can follow. */
function itemAt(x: number, y: number): string | undefined {
  const id = doc.rowAt(x, y, "visual") ?? doc.rowAt(x, y, "priority");
  return draft.document.value.items.some((item) => item.id === id) ? id : undefined;
}

/** The room's logic as text ("Edit as text…"). */
const logicText = ref<{ line: number | null }>();
const logicTextOpen = computed({
  get: () => logicText.value !== undefined,
  set: (open) => {
    if (!open) logicText.value = undefined;
  },
});

const RELOAD_FIRST = "Reload game first: the running game isn't the one you saved.";
/** Play here: settle unkept changes, then the shell plays from the spot. */
async function playHere(at: Point): Promise<void> {
  if (keeper.needsReload.value) return editing.say({ tone: "warn", text: RELOAD_FIRST });
  if (!walk || walk.room < 1) {
    editing.say({ tone: "warn", text: "This picture isn't shown by a room the game can enter." });
    return;
  }
  if (!(await leave.confirm())) return;
  emit("play-here", { room: walk.room, x: at.x, y: at.y });
}

/** The canvas menu: at a cell, from a right-click or the Menu key. */
const menu = shallowRef<{ at: { x: number; y: number }; cell: Point } | null>(null);
const menuItems = computed<CanvasMenuItem[]>(() => [
  {
    id: "play",
    label: "Play here",
    // The running game differs from the saved one until it reloads (useStudioKeep).
    ...(keeper.needsReload.value
      ? { disabled: true, title: RELOAD_FIRST }
      : { disabled: !walk || walk.room < 1 }),
  },
  ...(lens.value === "walk"
    ? [
        { id: "walk-from", label: "Start a test walk here" },
        { id: "walk-to", label: "Test walk to here", disabled: !walker.start.value },
      ]
    : []),
]);
function openMenu(cell: Point, at: { x: number; y: number }): void {
  menu.value = { cell, at };
}
/** The Menu key or Shift+F10 on the canvas: the menu at the keyboard cursor. */
function openMenuAtCursor(): void {
  const pane = stage.value?.querySelector(".studio-pane:last-child");
  if (!pane) return;
  const box = pane.getBoundingClientRect();
  const cell = input.cell.value;
  const { zoom: z, pixelAspect } = viewport.value;
  openMenu(cell, {
    x: box.left + (cell.x + 1) * pixelAspect * z,
    y: box.top + (cell.y + 1) * z,
  });
}
function pickMenu(id: string): void {
  const cell = menu.value?.cell;
  menu.value = null;
  keepFocus();
  if (!cell) return;
  if (id === "play") void playHere(cell);
  else if (id === "walk-from") {
    pickTool("walk");
    walker.setStart(cell);
  } else if (id === "walk-to") {
    pickTool("walk");
    walker.walkTo(cell);
  }
}

function seek(k: number): void {
  playhead.value = Math.min(total.value, Math.max(0, k));
}

/** Keep / Discard / Cancel before any way out of Studio, here or in the shell. */
const leave = useStudioLeave({
  unkept: () => room.dirty.value && !keeper.needsReload.value,
  keep: () => keepChanges(),
  discard: room.discard,
});
const center = useOptionalCreateCenter();
if (center) onScopeDispose(center.guardStudio(leave));
// The line the centre opened Studio with (the game was just reloaded from storage).
const opening = () => center?.studio.value?.notice;
watch(opening, (text) => text && editing.say({ tone: "ok", text }), { immediate: true });
const dialog = leave.ask;
async function requestClose(): Promise<void> {
  if (await leave.confirm()) emit("close");
}
function discardChanges(): void {
  leave.discarding.value = false;
  draft.discard();
  logic.discard();
  editing.say({ tone: "ok", text: "Changes discarded." });
}
/** Keep the draft and say so; resolves whether it was kept. */
async function keepChanges(): Promise<boolean> {
  const kept = await keeper.keep();
  // Keep disables itself once the draft is kept: the keys must not fall out of Studio.
  keepFocus();
  if (!kept) return false;
  editing.say(lesson.keptNotice(subject.value));
  return true;
}
async function recover(recovery: KeepRecovery): Promise<void> {
  if (recovery === "retry") return void keepChanges();
  // The draft was made on a game that moved on. Storage moved past the
  // running game (a Keep elsewhere, or a saved edit the game never loaded):
  // the game reloads from storage first, and the draft cannot come along.
  await reopen(keeper.banner.value?.fromStorage === true);
}
/** Reopen Studio on the running game, or on the game reloaded from storage; the draft stays behind. */
async function reopen(fromStorage: boolean): Promise<void> {
  if (fromStorage && !(await leave.confirmReload())) return;
  keeper.dismiss();
  draft.discard();
  logic.discard();
  emit("reopen", fromStorage);
}

const keepFocus = useStudioFocus(useTemplateRef("root"));
exposeStudioDraft(draft, () => logic.source.value);
/** What a Keep writes, as the top bar and the dialogs name it. */
const subject = computed(() =>
  logic.dirty.value && walk
    ? `PIC ${pictureNumber} and room ${walk.room}'s doors`
    : `PIC ${pictureNumber}`,
);
const changeTotal = room.changes;
const notesOnly = computed(() => draft.notesOnly.value && !logic.dirty.value);

const keys: StudioKeyActions = {
  onCanvas: (target) => target === stage.value,
  dismiss: () => {
    if (menu.value) {
      menu.value = null;
      return true;
    }
    if (tools.cancel()) return true;
    // A selected door lets go first, outline and panel together.
    if (walker.selectedDoorId.value !== null) walker.selectDoor(null);
    else if (tools.tool.value !== "select") tools.setTool("select");
    else if (ctxOpen.value) ctxOpen.value = false;
    else if (!drag.abort()) return false;
    return true;
  },
  close: () => void requestClose(),
  // The lens and the unlocks wait with the request: Accept applies the terms it was asked under.
  lens: (next) => {
    if (!assist.holds.value) lens.value = next;
  },
  seek: (to) => seek(to === "first" ? 0 : to === "last" ? total.value : playhead.value + to),
  zoom: (step) => (step === "fit" ? zoomToFit() : zoomBy(step)),
  step: (direction) => selection.step(direction),
  nudge: editing.nudge,
  cursor: input.move,
  click: input.click,
  remove: () => tools.backspace() || editing.remove(),
  duplicate: editing.duplicate,
  reorder: editing.reorder,
  undo: undoOrder.undo,
  redo: undoOrder.redo,
  tool: toolKey,
  finish: tools.finish,
  ask: () => assistPanel.value?.focus() ?? false,
  insertPoint: insertPointAtCursor,
};
/** Every key stops here so the game never sees it. */
function onKeydown(event: KeyboardEvent): void {
  event.stopPropagation();
  // An open confirmation or the logic text takes the keys it needs (Esc closes it) and nothing else runs.
  if (dialog.value !== undefined || logicText.value !== undefined) return;
  if (
    (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) &&
    event.target === stage.value
  ) {
    event.preventDefault();
    openMenuAtCursor();
    return;
  }
  if (input.spaceKey(event, true) || studioKey(event, keys)) event.preventDefault();
  keepFocus();
}
function onKeyup(event: KeyboardEvent): void {
  event.stopPropagation();
  input.spaceKey(event, false);
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
      :changes="changeTotal"
      :notes-only="notesOnly"
      :can-undo="(draft.canUndo.value || logic.canUndo.value) && !keeper.needsReload.value"
      :can-redo="(draft.canRedo.value || logic.canRedo.value) && !keeper.needsReload.value"
      :can-keep="keeper.canKeep.value"
      :lens-held="assist.holds.value ? HOLD_TEXT : null"
      @back="requestClose"
      @close="requestClose"
      @undo="undoOrder.undo"
      @redo="undoOrder.redo"
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
      <template #notice
        ><StudioLockNote
          v-model:unlocks="unlocks"
          :lens
          :held="assist.holds.value ? HOLD_TEXT : null"
      /></template>
    </SceneList>

    <StudioToolRail
      :tool="tools.tool.value"
      class="studio__rail"
      :frozen="editsBlocked()"
      :probe-active="ghost.active.value"
      :probe-available="views.length > 0"
      :lens
      :unlocks
      :values="tools.current.value"
      :cursor-y="tools.cursor.value?.y"
      :doors-editable="logic.editable.value"
      @update:tool="pickTool"
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
        :aria-label="input.label.value"
        @focus="input.focus"
        @blur="input.blur"
        @pointermove="input.altHeld.value = $event.altKey"
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
            :ghost="insertGhost"
            :flash="flashPaths"
            :changed="changedPaths"
            :movable="editableId !== undefined && tools.tool.value === 'select'"
            @hover="input.pointer.hover"
            @press="input.pointer.press"
            @drag="input.pointer.drag"
            @release="input.pointer.release"
            @abort="input.pointer.abort"
            @dblclick="tools.finish()"
            @menu="openMenu"
          >
            <StudioWalkOverlay
              v-if="lens === 'walk' && index === panes.length - 1"
              :walk="walker"
              :viewport
              :tool="tools.tool.value"
              :tint="walkTint"
              :item-at="itemAt"
              :item-label="labelOf"
              @hover-item="(id) => (selection.listHover.value = id)"
            />
            <StudioToolOverlay v-if="tools.tool.value !== 'select'" v-bind="input.overlay.value" />
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
              :askable="assistHost !== null"
              @ask="assistPanel?.focus()"
            />
          </StudioCanvas>
        </div>
      </div>
      <StudioAssistCompare
        v-if="proposal"
        v-model="compare"
        below-bar
        :stale="assist.stale.value"
      />
      <StudioViewBar v-model:mode="mode" v-model:bands="showBands" :lens :fold-legend="narrow" />
      <StudioStageNotes
        :banner="keeper.banner.value"
        :notice="editing.notice.value"
        :editing="editableId !== undefined && tools.tool.value === 'select'"
        @recover="recover"
        @hold="editing.hold"
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
      <template #lead>
        <!-- The lesson's card docks at the top of the inspector, never over the stage. -->
        <LessonCard
          v-if="lesson.session.value"
          :session="lesson.session.value"
          :outcome="lesson.outcome.value"
        />
        <StudioWalkPanel
          v-if="lens === 'walk'"
          v-model:tint="walkTint"
          :walk="walker"
          :tool="tools.tool.value"
          :flags="flagNames"
          :items="pictureItems"
          @tool="pickTool"
          @play-here="playHere"
          @text="(line) => (logicText = { line })"
        />
      </template>
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
      <template #assist>
        <StudioAssistPanel
          v-if="assistHost"
          ref="assistPanel"
          :assist
          :chips="assistChips"
          hint="To change the scope, select another item or group, or unlock a plane in the Scene footer."
          :changes="assistChanges"
          @reload="reopen(true)"
          noun="picture"
          empty="Select an item on the canvas or in the Scene list to ask the AI about it."
        />
      </template>
    </PixelInspector>

    <footer class="studio__status">
      <span data-role="status">{{ status }}</span>
      <span class="studio__spacer"></span>
      <span v-if="narrow" data-testid="studio-size"
        >{{ draft.compiled.value.bytes.length }} B · {{ total }} cmds</span
      >
      <span>AGI {{ profile.id }} profile</span>
      <span>{{ model.trusted ? "authored source" : "disassembled" }}</span>
    </footer>
    <p class="studio__sr" aria-live="polite" data-role="announce">{{ input.spoken.value }}</p>

    <StudioKeepDialog
      v-model:ask="dialog"
      :subject="subject"
      noun="picture"
      :changes="changeTotal"
      :notes-only="notesOnly"
      :can-keep="keeper.canKeep.value"
      @keep="leave.answer('keep')"
      @discard="(answer) => (answer ? leave.answer('discard') : discardChanges())"
    />
    <StudioSmallScreen name="Room Studio" :draft="room" :keeper @close="emit('close')" />
    <StudioCanvasMenu
      v-if="menu"
      :at="menu.at"
      :cell="menu.cell"
      :items="menuItems"
      @pick="pickMenu"
      @close="((menu = null), keepFocus())"
    />
    <StudioLogicText
      v-if="walk"
      v-model:open="logicTextOpen"
      :room="walk.room"
      :text="logic.editable.value ? logic.source.value : walk.logicText"
      :line="logicText?.line ?? null"
    />
  </div>
</template>

<style scoped>
.studio {
  position: relative;
  display: grid;
  grid-template-rows: 52px minmax(0, 1fr) 92px 28px;
  /* The Scene list takes what the canvas can spare: at 1280 wide what still
     leaves it 200% zoom (640 + 2 × STAGE_INSET), more when wider. */
  grid-template-columns: clamp(208px, max(18vw, 100vw - 1040px), 300px) 48px minmax(0, 1fr) 300px;
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
