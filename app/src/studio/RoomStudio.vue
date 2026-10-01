<script setup lang="ts">
import { VOCABULARY } from "../../../src/vocabulary.ts";
import { computed, inject, onMounted, ref, shallowRef, useTemplateRef, watch } from "vue";
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
import {
  compileEditDocument,
  footprintMask,
  unionMask,
} from "../../../src/studio/editValidation.ts";
import {
  groupPart,
  parsePictureDocument,
  pictureItemAtLine,
} from "../../../src/studio/pictureDocument.ts";
import { itemsInside } from "../../../src/studio/pictureQuery.ts";
import type { ViewportPoint } from "../../../src/studio/viewport.ts";
import type { PlayHereTarget } from "../../../src/runtime/playHere.ts";
import { followedItem } from "../../../src/studio/rules/ruleBinding.ts";
import type { RuleSession } from "../../../src/studio/rules/ruleEdit.ts";
import type { Point } from "../../../src/studio/shapes.ts";
import { engineKey } from "../engine/engineContext.ts";
import { aiSettingsKey } from "../settings/useAiSettings.ts";
import { ResourceCommitError } from "../project/projectTransaction.ts";
import type { ResourceCommitResult } from "../project/resourceCommit.ts";
import type { AuthoringFingerprint } from "../project/gameStorage.ts";
import type { StudioRoomSource } from "../world/studioSource.ts";
import LessonCard from "../lessons/LessonCard.vue";
import { useStudioLesson } from "../lessons/useStudioLesson.ts";
import UiSegmented from "../ui/UiSegmented.vue";
import PaletteStrip from "./workspace/PaletteStrip.vue";
import DrawOrderScrubber from "./DrawOrderScrubber.vue";
import GhostProbe from "./GhostProbe.vue";
import GhostReadout from "./GhostReadout.vue";
import PixelInspector from "./PixelInspector.vue";
import SceneList from "./SceneList.vue";
import StudioAssistCompare from "./StudioAssistCompare.vue";
import StudioAssistPanel from "./StudioAssistPanel.vue";
import StudioCanvas, { type MaskPaths } from "./StudioCanvas.vue";
import StudioCanvasMenu, { type CanvasMenuItem } from "./StudioCanvasMenu.vue";
import StudioCombineDialog from "./StudioCombineDialog.vue";
import StudioGroupEditor from "./StudioGroupEditor.vue";
import StudioItemEditor from "./StudioItemEditor.vue";
import StudioItemPoints from "./StudioItemPoints.vue";
import StudioLockChip from "./StudioLockChip.vue";
import StudioKeepDialog from "./StudioKeepDialog.vue";
import StudioKeySheet from "./StudioKeySheet.vue";
import StudioLogicText from "./StudioLogicText.vue";
import StudioSelectionBar from "./StudioSelectionBar.vue";
import StudioSmallScreen from "./StudioSmallScreen.vue";
import StudioStatusNotice from "./StudioStatusNotice.vue";
import StudioToolOptions from "./StudioToolOptions.vue";
import StudioToolOverlay from "./StudioToolOverlay.vue";
import StudioToolRail from "./StudioToolRail.vue";
import StudioValuePicker from "./StudioValuePicker.vue";
import StudioTopBar from "./StudioTopBar.vue";
import StudioTour from "./StudioTour.vue";
import SharePictureMenu from "./share/SharePictureMenu.vue";
import { shareFileBase, shareRoomName } from "./share/shareFrame.ts";
import StudioViewBar from "./StudioViewBar.vue";
import StudioWalkOverlay from "./StudioWalkOverlay.vue";
import StudioWalkPanel from "./StudioWalkPanel.vue";
import StudioZoom from "./StudioZoom.vue";
import UiButton from "../ui/UiButton.vue";
import UiExplain from "../ui/UiExplain.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import { fillFix, fillNotice } from "./fillAdvice.ts";
import {
  ROOM_EDIT_HINT,
  ROOM_GROUP_HINT,
  ROOM_PATH_HINT,
  ROOM_TOOL_HINTS,
  roomKeySheet,
} from "./studioHelp.ts";
import { explain } from "./studioTerms.ts";
import { useStudioCalm } from "./useStudioCalm.ts";
import { useStudioTour } from "./useStudioTour.ts";
import { isWalkTool, TOOL_KEYS, type StudioTool } from "./studioTools.ts";
import { studioKey, type StudioKeyActions } from "./studioKeys.ts";
import { lensItemLocks, lockedPlanes, NO_UNLOCKS, type LensUnlocks } from "./studioLocks.ts";
import {
  alsoChanges,
  changedCells,
  labelList,
  pictureChangeSummary,
  pictureScopeChips,
} from "./studioAssistText.ts";
import { HOLD_TEXT, useStudioAssist, type StudioAssistHost } from "./useStudioAssist.ts";
import {
  bandGuides,
  controlLabels,
  maskFillPath,
  maskOutlinePath,
  PANE_LABELS,
  panesFor,
  pictureSize,
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
import { useStudioKeep, type KeepFn } from "./useStudioKeep.ts";
import { useStudioExit } from "./useStudioExit.ts";
import { useFold } from "./useFold.ts";
import { useStudioReadout } from "./useStudioReadout.ts";
import { useStudioSelection } from "./useStudioSelection.ts";
import { useStudioTools } from "./useStudioTools.ts";
import { useStudioViewport } from "./useStudioViewport.ts";
import { unfollowedText, useRoomLogicDraft, type Unfollowed } from "./useRoomLogicDraft.ts";
import { DEFAULT_EGO, useStudioWalk, type EgoShape } from "./useStudioWalk.ts";
import { useUndoOrder } from "./useUndoOrder.ts";
import { keyLabel } from "../ui/keyLabel.ts";

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
 * whose logic edits keep together with the picture in one transaction. Ask
 * (useStudioAssist) has the game's AI propose a change
 * to the selected items, previewed on the canvas and accepted as one undo step.
 * Several items can be selected (useStudioSelection) and moved, copied,
 * deleted or grouped together (and a group ungrouped); the selection's actions dock in the
 * options bar above the canvas, so nothing covers the picture.
 */
const {
  pictureNumber,
  bytes,
  authoredSource = undefined,
  profile,
  title,
  subtitle = undefined,
  baseRevision = undefined,
  baseAuthoring = undefined,
  keep: keepFn = undefined,
  files = undefined,
  walk = undefined,
  underlay = null,
  creativeLaunch = undefined,
  embedded = false,
  liveGame = false,
  workspaceFocus = false,
} = defineProps<{
  embedded?: boolean;
  liveGame?: boolean;
  workspaceFocus?: boolean;
  pictureNumber: number;
  bytes: Uint8Array;
  authoredSource?: string | undefined;
  profile: AgiProfile;
  title: string;
  subtitle?: string | undefined;
  /** The game revision the bytes were read at; without one the picture is view only. */
  baseRevision?: ResourceRevision | undefined;
  /** The authoring content the draft opens on; each Keep carries it (resourceCommit.ts). */
  baseAuthoring?: AuthoringFingerprint | undefined;
  /** The Keep transaction; the engine's when omitted. */
  keep?: KeepFn | undefined;
  /** The game's container files, read at the same revision: the actor probe's VIEWs. */
  files?: ReadonlyMap<string, Uint8Array> | undefined;
  /** The room framing the picture: its logic (doors), bindings, plan and tests. */
  walk?: StudioRoomSource | null | undefined;
  /**
   * A prepared reference underlay (160x168 RGBA) from the creative workspace,
   * blended over the art pane as a tracing guide — never a runtime bitmap.
   */
  underlay?: { pixels: Uint8Array; opacity: number } | null;
  /**
   * Opens the project's creative workspace (import, prepare, board) docked
   * beside this studio. Undefined where no project authority serves it.
   */
  creativeLaunch?: (() => void) | undefined;
}>();
/**
 * `reopen` asks for Studio again; `fromStorage` reloads the game from storage
 * first. `play-here` asks the shell to leave Studio and play from a spot.
 */
const emit = defineEmits<{
  close: [];
  edit: [source: string];
  "game-host": [host: HTMLElement];
  "agent-context": [context: { label: string; text: string } | null];
  "agent-ask": [];
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
  items: () => model.value.document.items.map((item) => item.id),
});
const { hoveredId, selectedId, selectedRow, pinnedCell } = selection;
const readout = useStudioReadout({ doc, selection });
const { ticks, current, drawn, single, pixel, fill, labelOf, status } = readout;
/** The engine, when Studio runs in the app (the harness supplies its own Keep). */
const engineApi = inject(engineKey, null);
const commitPicture =
  keepFn ??
  engineApi?.commitPictureEdit ??
  (() => Promise.reject(new Error("Nothing can be kept here.")));
const commitRoom =
  engineApi?.commitRoomEdit ??
  (() => Promise.reject(new Error("Door changes can't be kept here.")));
/**
 * Share's caption and file name: the game, and the room by its title in the
 * world plan or on the map (Studio's title, unless it only names the
 * picture), else its number.
 */
const shareRoom = computed(() =>
  shareRoomName(
    [
      walk?.authoring.world.rooms[String(walk.room)]?.title,
      title === `PIC ${pictureNumber}` ? undefined : title,
    ],
    walk?.room ?? null,
    title,
  ),
);
const shareGame = computed(() => engineApi?.currentGame()?.title);
const shareCaption = computed(() => ({
  game: shareGame.value,
  room: shareRoom.value,
  commands: total.value,
  bytes: draft.compiled.value.bytes.length,
}));
const shareFile = computed(() => shareFileBase(shareGame.value, shareRoom.value));
/** A Help guide lesson Studio opened from: every successful Keep runs its challenge. */
const lesson = useStudioLesson();

/** The room's logic, editable while its annotated text is trusted (useRoomLogicDraft). */
const ruleSession = computed<RuleSession | null>(() => {
  if (!walk || !files) return null;
  const state = createAgentSessionState(openContainer(new Map(files), { profile }), profile);
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
/** Doors that follow picture art: Group and Ungroup keep them following. */
const followingDoors = computed(() =>
  logic.rules.value.flatMap(({ rule }) =>
    rule.item === null ? [] : [{ item: rule.item, label: rule.label }],
  ),
);
/** The art a door follows, by name: an item, or a member inside a group. */
const followLabel = (id: string): string =>
  followedItem(draft.document.value, id)?.label ?? labelOf(id);
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
/** The authoring content the draft was opened or last kept on. */
let keptAuthoring = baseAuthoring;
/** Doors the last Keep stopped following art that is gone: its notice names them. */
let unfollowed: readonly Unfollowed[] = [];
watch(
  () => baseAuthoring,
  (next) => (keptAuthoring = next),
);
const keeper = useStudioKeep({
  draft: room,
  keep: async (baseRevision) => {
    const edit = {
      ...draftPictureEdit(draft, pictureNumber, baseRevision),
      baseAuthoring: keptAuthoring,
    };
    const pictureChanged = draft.dirty.value;
    /** The picture this Keep goes from and to: door boxes and their history move between them. */
    const frames = { before: keptDocument.value, after: draft.document.value };
    unfollowed = [];
    let result: ResourceCommitResult;
    if (!logicInKeep() || !walk) {
      result = await commitPicture(edit);
      const logicKept = logic.kept.value;
      if (logic.editable.value && logicKept) logic.markKept(logicKept, frames);
    } else {
      // Doors that follow moved art move with it, in the same transaction.
      const followed = logic.forKeep(frames.before, frames.after);
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
        baseAuthoring: keptAuthoring,
        reason: edit.reason,
      });
      logic.markKept({ source: followed.source, bytes: followed.bytes }, frames);
      unfollowed = followed.unfollowed;
    }
    keptAuthoring = result.authoring;
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
watch([draft.source, draft.gesturing], ([source, gesturing]) => {
  if (embedded && !gesturing && source !== resolved.value.source) emit("edit", source);
});
/** Editing is blocked: view only, or a Keep that needs a reload first. */
const frozen = (): boolean => draft.kept.value.revision === undefined || keeper.needsReload.value;

// ---- Ask -------------------------------------------------------------------
const aiSettings = inject(aiSettingsKey, null);
const assistHost: StudioAssistHost | null =
  engineApi && aiSettings
    ? {
        run: (request) => engineApi.runStudioAssist(request, aiSettings.llmConfig()),
        cancel: () => engineApi.discardAgent(),
        resume: (requestLimit) => engineApi.continueAgent(requestLimit),
        task: () => engineApi.state.agentTask,
        log: () => engineApi.state.agentLog,
      }
    : null;
/** The selected items an Ask is about: the item, a group's members, or several items. */
const askTargets = computed<string[]>(() => {
  const items = new Set(draft.document.value.items.map((item) => item.id));
  return selection.itemIds.value.filter((id) => items.has(id));
});
const itemLabel = (id: string): string =>
  draft.document.value.items.find((item) => item.id === id)?.label ?? id;
watch(
  [askTargets, lens],
  ([ids, currentLens]) => {
    if (embedded)
      emit(
        "agent-context",
        ids.length
          ? {
              label: `PICTURE ${pictureNumber} · ${ids.map(itemLabel).join(", ")}`,
              text: `Selected item ids: ${ids.join(", ")}. Lens: ${currentLens}.`,
            }
          : null,
      );
  },
  { immediate: true },
);
function askAgent(): boolean {
  if (embedded) {
    emit("agent-ask");
    return true;
  }
  return assistPanel.value?.focus() ?? false;
}
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
      return { ok: false, message: "That change is not for this picture." };
    const outcome = draft.adopt(candidate.draft.source, "AI edit", focus.scope);
    editing.report(outcome);
    return outcome.ok ? outcome : { ok: false, message: outcome.refusal.message };
  },
});
/** Edits wait while a request runs or its proposal awaits a verdict. */
const editsBlocked = (): boolean => frozen() || assist.holds.value;
const editing = useStudioEditing({
  draft,
  selectedId,
  itemIds: () => selection.itemIds.value,
  selectItems: selection.selectItems,
  frozen,
  paused: () => assist.holds.value,
  doors: () => followingDoors.value,
  lens: () => lens.value,
  offer: (check) => {
    const rules = check.violations.map((violation) => violation.rule);
    const [plane] = lockedPlanes(lens.value, unlocks.value);
    if (rules.includes("locked-plane") && plane)
      return { label: "Unlock", run: () => unlockNow({ [plane]: true }) };
    if (rules.includes("walk-depth"))
      return { label: "Allow depth", run: () => unlockNow({ depthInWalk: true }) };
    return undefined;
  },
});
/** A lock refusal's step: the lock opens for this session and the notice says so. */
function unlockNow(patch: Partial<LensUnlocks>): void {
  if (assist.holds.value) return;
  unlocks.value = { ...unlocks.value, ...patch };
  editing.say({ tone: "ok", text: "Unlocked until you close Studio. Try it again." });
  keepFocus();
}
/** The selected items the creator may edit now, when there are several. */
const editableIds = computed(() =>
  editing.several.value ? editing.editableItems.value.map((item) => item.id) : [],
);
/** Cmd+Z undoes the newest change of the picture or the doors. */
const undoOrder = useUndoOrder([
  {
    past: () => draft.history.value.past.length,
    future: () => draft.history.value.future.length,
    dropped: () => draft.dropped.value,
    undo: editing.undo,
    redo: editing.redo,
  },
  {
    past: () => logic.past.value,
    future: () => logic.future.value,
    dropped: () => logic.dropped.value,
    undo: () => !frozen() && logic.undo(),
    redo: () => !frozen() && logic.redo(),
  },
]);

const stage = useTemplateRef("stage");
const gameHost = useTemplateRef("gameHost");
watch(gameHost, (host) => {
  if (host) emit("game-host", host);
});
const panes = computed(() =>
  embedded ? panesFor(lens.value, "blend").slice(0, 1) : panesFor(lens.value, mode.value),
);
const { viewport, zoom, dpr, fitted, zoomBy, zoomToFit } = useStudioViewport(
  stage,
  () => panes.value.length,
);
const size = computed(() => pictureSize(draft.compiled.value.bytes.length, total.value));

/**
 * An AI proposal awaiting a verdict: compiled, with the cells it changes and
 * its side effects (other items' cells it changes, outside the selection).
 */
const proposal = computed(() => {
  const candidate = assist.candidate.value;
  if (assist.phase.value !== "candidate" || candidate?.kind !== "picture") return null;
  try {
    const compiled = compileEditDocument(
      parsePictureDocument(candidate.draft.source).document,
      profile,
    );
    return {
      compiled,
      changed: changedCells(draft.compiled.value, compiled),
      sideEffects: candidate.check.sideEffects ?? null,
    };
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
    next.sideEffects?.mask ?? null,
  );
});
/** What the request is held to: the asked scope while it is open, else the selection's. */
const assistChips = computed(() => {
  const scope = assist.holds.value ? assist.asked.value?.scope : undefined;
  return pictureScopeChips(
    (scope?.kind === "picture" ? scope.targetIds : askTargets.value).map(itemLabel),
  );
});
const assistPanel = useTemplateRef("assistPanel");
const editableId = computed(() => editing.editable.value?.id);
/**
 * The selection's cells on the canvas, on both planes in every lens (a move
 * takes an item's art, depth and walk lines along); while a drag previews,
 * the moving items' footprints. Unassigned lines show under the lens.
 */
const selectionMask = computed(() => {
  const ids = selection.selectedIds.value;
  if (ids.length === 0) return null;
  const preview = draft.preview.value;
  const moving = editableId.value !== undefined ? [editableId.value] : editableIds.value;
  if (preview && moving.length > 0)
    return unionMask(...moving.map((id) => footprintMask(preview.compiled, id, "both")));
  const items = selection.itemIds.value;
  if (items.length === 0) return doc.rowMask(ids[0]!, lens.value);
  return unionMask(
    ...items.flatMap((id) => [doc.maskFor(id, "visual"), doc.maskFor(id, "priority")]),
  );
});
/** Whether `cell` shows the selection. */
const onSelection = ({ x, y }: ViewportPoint): boolean => selectionMask.value?.[y * 160 + x] === 1;
const pathsOf = (mask: Uint8Array | null): MaskPaths | null =>
  mask && { fill: maskFillPath(mask), outline: maskOutlinePath(mask) };
/** Where an Alt+click at `cell` adds a point to item `id`'s line: within reach of it only. */
function insertionNear(id: string, cell: Point): PointInsertion | undefined {
  const insertion = nearestInsertion(draft.document.value, id, cell, viewport.value.pixelAspect);
  return insertion && insertion.distance * viewport.value.zoom <= INSERT_REACH
    ? insertion
    : undefined;
}
/**
 * A selection box let go: the items wholly inside it, on every plane they
 * draw, become the selection, or with Shift join it. A box that catches
 * nothing clears a plain selection and says so.
 */
function selectInside(box: { x1: number; y1: number; x2: number; y2: number }, add: boolean): void {
  const caught = itemsInside(doc.view.value, model.value.document, box);
  selection.selectItems(add ? [...selection.itemIds.value, ...caught] : caught);
  const count = selection.itemIds.value.length;
  if (caught.length === 0) editing.say({ tone: "ok", text: "No item lies wholly inside the box." });
  input.spoken.value =
    caught.length === 0
      ? "No item lies wholly inside the box"
      : `${count} ${count === 1 ? "item" : "items"} selected`;
}
const drag = useStudioDrag({
  draft,
  editableId: () => editableId.value,
  editableIds: () => editableIds.value,
  extend: (cell) => selection.pick(cell, true),
  marquee: selectInside,
  pick: selection.pick,
  clear: () => selection.selectItems([]),
  onSelection,
  labelOf: (id) => editing.item.value?.label ?? id,
  report: editing.report,
  moved: editing.carried,
  movesItems: () => tools.tool.value !== "point",
  insertAt: insertionNear,
});
/** The canvas cursor is a crosshair for the tools that place points; Select and Point show the arrow. */
const drawsOnCanvas = computed(() => !["select", "point", "hand"].includes(tools.tool.value));
/** The move cursor: over the selection's pixels with Select, and while it is dragged. */
const movable = computed(() => {
  if (tools.tool.value !== "select" || editing.editableItems.value.length === 0) return false;
  const cell = selection.canvasCell.value;
  return drag.dragging.value || (cell !== undefined && onSelection(cell));
});
/**
 * The margin around the picture is empty canvas: with Select, a click there
 * clears the selection and a drag draws a selection box (useStudioDrag.ts);
 * Space or the Hand pans from it too. Cells are measured from the first
 * pane, so they lie off the picture.
 */
const margin = (() => {
  let pointer: number | null = null;
  const cellOf = (event: PointerEvent): ViewportPoint | undefined => {
    const pane = stage.value?.querySelector(".studio-pane");
    if (!pane) return undefined;
    const rect = pane.getBoundingClientRect();
    const { pixelAspect, zoom } = viewport.value;
    return {
      x: Math.floor((event.clientX - rect.left) / (pixelAspect * zoom)),
      y: Math.floor((event.clientY - rect.top) / zoom),
    };
  };
  const pressOf = (event: PointerEvent, cell: ViewportPoint) => ({
    event,
    cell,
    handle: undefined,
  });
  return {
    down(event: PointerEvent): void {
      if (event.button !== 0 || pointer !== null) return;
      if ((event.target as Element | null)?.closest(".studio-pane")) return;
      if (tools.tool.value !== "select" && !tools.panning.value) return;
      const target = event.currentTarget as HTMLElement;
      const box = target.getBoundingClientRect();
      // A press on the stage's own scrollbars scrolls it.
      if (
        event.clientX - box.left >= target.clientLeft + target.clientWidth ||
        event.clientY - box.top >= target.clientTop + target.clientHeight
      )
        return;
      const cell = cellOf(event);
      if (!cell) return;
      pointer = event.pointerId;
      target.setPointerCapture(event.pointerId);
      input.pointer.press(pressOf(event, cell));
    },
    move(event: PointerEvent): void {
      input.altHeld.value = event.altKey;
      if (event.pointerId !== pointer) return;
      const cell = cellOf(event);
      if (cell) input.pointer.drag(pressOf(event, cell));
    },
    up(event: PointerEvent): void {
      if (event.pointerId !== pointer) return;
      pointer = null;
      const cell = cellOf(event);
      if (cell) input.pointer.release(pressOf(event, cell));
      else input.pointer.abort();
    },
    lost(event: PointerEvent): void {
      if (event.pointerId !== pointer) return;
      pointer = null;
      input.pointer.abort();
    },
  };
})();
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
  itemLabel: (id) => followedItem(draft.document.value, id)?.label ?? id,
  ego: () => ego.value,
  say: (notice) => editing.say(notice),
  frozen,
  paused: () => assist.holds.value,
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
const spilledPaths = computed(() => pathsOf(proposal.value?.sideEffects?.mask ?? null));
/** "Also changes: Grass, 17,802 cells.": the proposal's side effects, by the items' names. */
const assistAlso = computed(() => {
  const effects = proposal.value?.sideEffects;
  return effects ? alsoChanges(effects) : null;
});
const flashPaths = computed(() => pathsOf(editing.flash.value));
const handleList = computed(() => {
  const id = editableId.value;
  return id === undefined
    ? []
    : itemHandles(draft.preview.value?.document ?? draft.document.value, id);
});
/** The selected item's point handles: the Point tool's alone, as Select moves whole items. */
const handles = computed(() =>
  tools.tool.value === "point" &&
  handleList.value.length > 0 &&
  handleList.value.length <= MAX_HANDLES
    ? handleList.value
    : null,
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

/** The selection's priority picker in the options bar is open. */
const priorityOpen = ref(false);
/** The Select tool has something to act on: the selection's actions dock in the options bar. */
const selectionBar = computed(
  () =>
    tools.tool.value === "select" &&
    selectedRow.value !== undefined &&
    editing.editableItems.value.length > 0,
);
watch(selectionBar, (shown) => {
  if (!shown) priorityOpen.value = false;
});
const itemLocks = computed(() => lensItemLocks(lens.value, unlocks.value));
/** How many parts the selected item was grouped from here, when it was. */
const groupParts = computed(() => {
  const target = editing.item.value;
  if (!target || !editing.grouped.value) return undefined;
  return draft.document.value.lines.slice(target.openLine, target.closeLine - 1).filter((line) => {
    const part = groupPart(line);
    return part !== undefined && part !== "end";
  }).length;
});
/** What Details adds for the selection: an item's points, or depth for several. */
const detailsMore = computed(() => {
  if (editing.several.value) return editing.editableItems.value.length > 1 ? "Depth" : "";
  return editing.editable.value && handleList.value.length > 0 ? "Points" : "";
});
/** Renames the one selected item, while it can be edited. */
const rename = computed(() =>
  editing.editable.value && !editing.several.value
    ? (label: string) => editing.setMeta({ label })
    : undefined,
);

/** Group: the dialog, and what lies between the selected items. */
const combineOpen = ref(false);
const combineGap = computed(() => editing.between.value);
function groupSelection(name: string): void {
  if (editing.combine(name)) combineOpen.value = false;
}
/** The dialog's offer: select the items drawn between the chosen ones too. */
function includeBetween(): void {
  const gap = combineGap.value;
  selection.selectItems([...selection.itemIds.value, ...gap.between.map((item) => item.id)]);
}
function openCombine(): void {
  if (editing.editableItems.value.length > 1) combineOpen.value = true;
  else if (editing.editableItems.value.length === 1)
    editing.say({ tone: "warn", text: "Select two items or more to group them." });
}

/** The fill tool's notice: what the spot holds, why, and the step where it is still white. */
const fillAdvice = computed(() => {
  const why = tools.fillWhy.value;
  if (!why) return null;
  const { document, compiled } = model.value;
  const fix = fillFix(
    why,
    tools.insertion.value.index,
    { document, spans: compiled.spans },
    doc.compiledAt,
  );
  const owner = why.line === null ? null : (pictureItemAtLine(document, why.line)?.label ?? null);
  return { notice: fillNotice(why, owner, fix), fix };
});
/**
 * "Draw before …": the scrubber goes where the spot is still white, and
 * Filled goes on: an outline alone there would keep the later fill out of
 * its inside (another item's art, which the checks refuse), while a filled
 * rectangle or polygon paints its inside itself.
 */
function applyFillFix(): void {
  const fix = fillAdvice.value?.fix;
  if (!fix) return;
  seek(fix.step);
  tools.filled.value = true;
  editing.say({
    tone: "ok",
    text: `New shapes now go before ${fix.before}. Filled is on: draw a rectangle or polygon there.`,
  });
  keepFocus();
}

/** The options bar folds what it cannot fit: see StudioSelectionBar and StudioToolOptions. */
const optionsBar = useTemplateRef("optionsBar");
const optionsFold = useFold(optionsBar, 4, (bar) =>
  [bar, ...bar.children].every((element) => element.scrollWidth <= element.clientWidth + 1),
);
watch(
  () => [
    tools.tool.value,
    selectionBar.value,
    selectedRow.value?.label,
    editing.several.value,
    fillAdvice.value?.notice.summary,
    lens.value,
    proposal.value !== null,
    tools.insertion.value.index,
  ],
  () => void optionsFold.refit(),
  { flush: "post" },
);

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
watch(
  () => selection.selectedIds.value.length,
  (count) => {
    if (count > 0) walker.selectedDoorId.value = null;
  },
);
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
const pictureItems = computed(() => {
  const document = draft.document.value;
  const items = document.items.map((item) => ({ id: item.id, label: item.label }));
  // A door following a member inside a group still names it.
  for (const { item } of followingDoors.value) {
    if (items.some((entry) => entry.id === item)) continue;
    const member = followedItem(document, item);
    if (member) items.push({ id: item, label: member.label });
  }
  return items;
});
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

const RELOAD_FIRST = "Reload the game to play your saved version.";
/**
 * Play here: settle unkept changes, then the shell plays from the spot, in
 * this room or, from a walk that went through a door, the room it ended in.
 */
async function playHere(at: Point | PlayHereTarget): Promise<void> {
  if (keeper.needsReload.value) return editing.say({ tone: "warn", text: RELOAD_FIRST });
  const room = "room" in at ? at.room : (walk?.room ?? 0);
  if (room < 1) {
    editing.say({ tone: "warn", text: "This picture isn't shown by a room the game can enter." });
    return;
  }
  if (!(await leave.confirm())) return;
  emit("play-here", { room, x: at.x, y: at.y });
}

/** The canvas menu: at a cell, from a right-click or the Menu key. */
const menu = shallowRef<{ at: { x: number; y: number }; cell: Point } | null>(null);
/** The selection's actions, at the pointer: the same ones the options bar docks. */
const selectionMenu = computed<CanvasMenuItem[]>(() =>
  editing.editableItems.value.length === 0
    ? []
    : [
        { id: "duplicate", label: "Duplicate" },
        ...(editing.several.value ? [] : [{ id: "priority", label: "Depth…" }]),
        { id: "delete", label: "Delete" },
        ...(editing.several.value
          ? [{ id: "combine", label: "Group…" }]
          : [{ id: "ungroup", label: "Ungroup" }]),
        {
          id: "ask",
          label: "Tell the agent about the selection",
          ...(assistHost
            ? {}
            : { disabled: true, title: "An AI model is required. Choose a model in Settings." }),
        },
      ],
);
const menuItems = computed<CanvasMenuItem[]>(() => [
  ...selectionMenu.value,
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
/** A right-click off the selection selects what is under it first, as a click would. */
function openMenu(cell: Point, at: { x: number; y: number }): void {
  if (selectionMask.value?.[cell.y * 160 + cell.x] !== 1 && tools.tool.value === "select")
    selection.pick(cell);
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
  if (id === "duplicate") editing.duplicate();
  else if (id === "delete") editing.remove();
  else if (id === "priority") priorityOpen.value = true;
  else if (id === "combine") openCombine();
  else if (id === "ungroup") editing.ungroup();
  else if (id === "ask") askAgent();
  else if (id === "play") void playHere(cell);
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

/** Every way out of Studio, here or in the shell: Keep / Discard / Cancel first. */
const exit = useStudioExit({
  embedded,
  draft: room,
  keeper,
  say: (notice) => editing.say(notice),
  keptNotice: () => {
    const notice = lesson.keptNotice(subject.value);
    return unfollowed.length === 0
      ? notice
      : { tone: "warn", text: `${notice.text} ${unfollowedText(unfollowed)}` };
  },
  keepFocus: () => keepFocus(),
  close: () => emit("close"),
  reopen: (fromStorage) => emit("reopen", fromStorage),
});
const { leave, dialog, requestClose, discardChanges, keepChanges, recover, reopen } = exit;

const keepFocus = useStudioFocus(useTemplateRef("root"));
exposeStudioDraft(draft, () => logic.source.value);
/** What a Keep writes, as the top bar and the dialogs name it. */
const subject = computed(() =>
  logic.dirty.value && walk
    ? `PIC ${pictureNumber} and room ${walk.room}'s doors`
    : `PIC ${pictureNumber}`,
);
const changeTotal = room.changes;

// ---- The calm canvas: help in the status bar, the side panels on ⌘\ ----------
const calm = useStudioCalm();
/** The first-run tour: once per viewer, silent while a lesson's card is open. */
const tour = useStudioTour("room", { lesson: () => lesson.session.value !== null });
onMounted(() => void tour.offer());
function toggleFocus(): void {
  calm.toggleFocus();
  input.spoken.value = calm.focus.value ? "Side panels hidden" : "Side panels shown";
}
/**
 * The status bar's Keys button. Safari leaves a clicked button unfocused, so
 * activation takes its focus first: the sheet (and a tour its Tour button
 * relaunches) returns focus to what had it when the sheet opened.
 */
function openKeySheet(event: MouseEvent): void {
  if (event.currentTarget instanceof HTMLElement)
    event.currentTarget.focus({ preventScroll: true });
  calm.sheetOpen.value = true;
}
const keySheet = computed(() => roomKeySheet(tools.tool.value));
/** The status bar's line for the active tool (the editing keys while an item is selected). */
const toolHint = computed(() => {
  const tool = tools.tool.value;
  if ((tool === "line" || tool === "polygon") && (tools.path.value?.points.length ?? 0) > 0)
    return ROOM_PATH_HINT;
  if (tool === "select" && editing.editableItems.value.length > 0) return ROOM_EDIT_HINT;
  return ROOM_TOOL_HINTS[tool];
});
const notesOnly = computed(() => draft.notesOnly.value && !logic.dirty.value);
/** A tool change hands the status line back to the tool's hint (before anything it says). */
watch(tools.tool, () => editing.say(null), { flush: "sync" });

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
    else if (priorityOpen.value) priorityOpen.value = false;
    else if (drag.abort()) return true;
    // Last: a test walk left on the picture.
    else if (walker.start.value !== null) walker.clearWalk();
    else return false;
    return true;
  },
  // The lens and the unlocks wait with the request: Accept applies the terms it was asked under.
  lens: (next) => {
    if (!assist.holds.value) lens.value = next;
  },
  seek: (to) => seek(to === "first" ? 0 : to === "last" ? total.value : playhead.value + to),
  zoom: (step) => (step === "fit" ? zoomToFit() : zoomBy(step)),
  step: (direction) => selection.step(direction),
  extend: (direction) => void selection.extend(direction),
  nudge: editing.nudge,
  cursor: input.move,
  click: input.click,
  remove: () => tools.backspace() || editing.remove(),
  duplicate: editing.duplicate,
  group: openCombine,
  ungroup: () => void editing.ungroup(),
  reorder: editing.reorder,
  undo: undoOrder.undo,
  redo: undoOrder.redo,
  tool: toolKey,
  finish: tools.finish,
  ask: askAgent,
  insertPoint: insertPointAtCursor,
  focusMode: toggleFocus,
  keySheet: () => (calm.sheetOpen.value = true),
};
/** Every key stops here so the game never sees it. */
function onKeydown(event: KeyboardEvent): void {
  if (embedded && (event.target as HTMLElement).closest(".play-area")) return;
  event.stopPropagation();
  // An open confirmation, the logic text or the key sheet takes the keys it needs (Esc closes it) and nothing else runs.
  if (
    dialog.value !== undefined ||
    logicText.value !== undefined ||
    calm.sheetOpen.value ||
    combineOpen.value
  )
    return;
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
  if (embedded && (event.target as HTMLElement).closest(".play-area")) return;
  event.stopPropagation();
  input.spaceKey(event, false);
}
</script>

<template>
  <div
    ref="root"
    class="studio"
    :class="{
      'is-focus': calm.focus.value,
      'is-embedded': embedded,
      'is-live-game': liveGame,
      'is-workspace-focus': workspaceFocus,
      'is-art-idle': lens === 'art' && !draft.gesturing.value,
    }"
    :style="embedded ? { '--picture-zoom': zoom } : undefined"
    data-testid="room-studio"
    tabindex="-1"
    role="region"
    :aria-label="`Room Studio: ${title}`"
    @keydown="onKeydown"
    @keyup="onKeyup"
    @keypress.stop
    @click="
      (event) => {
        if (!(embedded && (event.target as HTMLElement).closest('.play-area'))) keepFocus();
      }
    "
  >
    <StudioTopBar
      v-if="!embedded"
      v-model:lens="lens"
      v-model:unlocks="unlocks"
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
    >
      <template #share
        ><UiButton
          v-if="creativeLaunch"
          size="sm"
          variant="ghost"
          data-testid="creative-entry"
          @click="creativeLaunch()"
          >Import image…</UiButton
        ><SharePictureMenu
          :picture="model.compiled"
          :timeline="model.timeline"
          :profile
          :caption="shareCaption"
          :file-base="shareFile"
      /></template>
    </StudioTopBar>

    <PaletteStrip
      v-if="embedded"
      class="studio__scrubber"
      :value="
        lens === 'art'
          ? (tools.current.value.visual ?? 0)
          : typeof tools.current.value.priority === 'number'
            ? tools.current.value.priority
            : 4
      "
      @choose="tools.setValues(lens === 'art' ? { visual: $event } : { priority: $event })"
    />
    <SceneList
      v-model:filter="filter"
      class="studio__scene"
      data-testid="studio-scene"
      :branches="model.branches"
      :sections="model.sections"
      :matches="scene.matches"
      :loose="scene.loose"
      :hovered-id="hoveredId"
      :selected-ids="selection.selectedIds.value"
      :quiet-tag="lens === 'art' ? 'art' : undefined"
      :groupable="editing.editableItems.value.length > 1"
      @hover="selection.listHover.value = $event"
      @select="(id, extend) => (extend ? selection.toggle(id) : (selectedId = id))"
      @group="openCombine"
    />

    <div
      ref="optionsBar"
      class="studio__options"
      role="group"
      aria-label="Tool and view options"
      data-testid="studio-options-bar"
    >
      <StudioSelectionBar
        v-if="selectionBar && selectedRow"
        v-model:open="priorityOpen"
        :label="selectedRow.label"
        :several="editing.several.value"
        :priority="single('priority')"
        :priority-locked="itemLocks.priority"
        :depth-values-locked="itemLocks.depthValues"
        :edit="editing"
        :askable="assistHost !== null"
        :grouped="editing.grouped.value"
        :fold="optionsFold.level.value"
        @ask="askAgent"
        @combine="openCombine"
        @ungroup="editing.ungroup()"
      />
      <StudioToolOptions
        v-else
        v-model:filled="tools.filled.value"
        v-model:radius="tools.radius.value"
        v-model:stipple="tools.stipple.value"
        v-model:seed="tools.seed.value"
        :tool="tools.tool.value"
        :insertion="tools.insertion.value"
        :commands="total"
        :notice="fillAdvice?.notice ?? null"
        :fold="optionsFold.level.value"
        @end="seek(total)"
        @fix="applyFillFix"
      />
      <StudioAssistCompare
        v-if="proposal"
        v-model="compare"
        :stale="assist.stale.value"
        :spilled="proposal.sideEffects !== null"
      />
      <span class="studio__spacer"></span>
      <UiSegmented
        v-if="embedded"
        v-model="lens"
        size="sm"
        :label="VOCABULARY.lens.label"
        :options="[
          { value: 'art', label: VOCABULARY.art.label, title: VOCABULARY.art.help },
          { value: 'depth', label: VOCABULARY.depth.label, title: VOCABULARY.depth.help },
          { value: 'walk', label: VOCABULARY.walk.label, title: VOCABULARY.walk.help },
        ]"
      />
      <StudioViewBar
        v-else
        v-model:mode="mode"
        v-model:bands="showBands"
        :lens
        :fold="optionsFold.level.value"
      />
    </div>

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
      @unlocks="(next) => !assist.holds.value && (unlocks = next)"
    />
    <main class="studio__frame">
      <div v-if="embedded" ref="gameHost" class="studio__live-game"></div>
      <div
        ref="stage"
        class="studio__stage"
        :class="{ 'is-panning': tools.panning.value, 'is-drawing': drawsOnCanvas }"
        tabindex="0"
        role="group"
        :aria-label="input.label.value"
        @focus="input.focus"
        @blur="input.blur"
        @pointerdown="margin.down"
        @pointermove="margin.move"
        @pointerup="margin.up"
        @pointercancel="margin.lost"
        @lostpointercapture="margin.lost"
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
            :spilled="spilledPaths"
            :movable="movable"
            :marquee="drag.marqueeBox.value ?? null"
            :underlay="layer === 'art' ? underlay : null"
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
              :item-label="followLabel"
              @hover-item="(id) => (selection.listHover.value = id)"
            />
            <StudioToolOverlay v-if="tools.tool.value !== 'select'" v-bind="input.overlay.value" />
            <!-- The probe's own presses never reach the pane below. -->
            <GhostProbe
              v-if="index === 0"
              :probe="ghost"
              :viewport
              @pointerdown.stop
              @pointermove.stop
            />
          </StudioCanvas>
        </div>
      </div>
    </main>

    <DrawOrderScrubber
      v-if="!embedded"
      v-model="playhead"
      class="studio__scrubber"
      data-testid="studio-scrubber"
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
      :editing="!!editing.editable.value && !editing.several.value"
      :more="detailsMore"
      :playhead
      :label-of="labelOf"
      :rename
      :parts="groupParts"
      :foot="editing.several.value && editing.editableItems.value.length > 1 ? ROOM_GROUP_HINT : ''"
      @seek="seek"
      @select="selectedId = $event"
    >
      <template #lead>
        <!-- The lesson's card docks at the top of the inspector, off the stage. -->
        <LessonCard
          v-if="lesson.session.value"
          :session="lesson.session.value"
          :outcome="lesson.outcome.value"
          @tour="tour.start()"
        />
        <!-- The probe's readout docks here too: on the art, only the ghost and its handle. -->
        <GhostReadout v-if="ghost.active.value" :probe="ghost" :describe-cell="describeCell" />
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
        <StudioGroupEditor
          v-if="editing.several.value && editing.editableItems.value.length > 1"
          :edit="editing"
          @combine="openCombine"
        />
        <StudioItemEditor
          v-else-if="editing.editable.value"
          :item="editing.editable.value"
          :visual="single('visual')"
          :priority="single('priority')"
          :locks="itemLocks"
          :edit="editing"
          :grouped="editing.grouped.value"
          @ungroup="editing.ungroup()"
        />
      </template>
      <template #more>
        <StudioItemPoints
          v-if="editing.editable.value && !editing.several.value"
          :handles="handleList"
          :edit="editing"
          :locked="editing.editable.value.locked"
        />
        <section
          v-else-if="editing.several.value && editing.editableItems.value.length > 1"
          class="studio__depth-all"
          data-role="depth-all"
        >
          <h3>Depth for all <UiExplain v-bind="explain('depth')" /></h3>
          <StudioValuePicker
            plane="priority"
            label="Depth for all"
            :value="single('priority')"
            :disabled="itemLocks.priority !== null"
            :title="itemLocks.priority ?? undefined"
            :allowed="(v) => !itemLocks.depthValues || v < 4"
            @pick="editing.setColour('priority', $event)"
          />
        </section>
      </template>
      <template #assist>
        <StudioAssistPanel
          v-if="assistHost && !embedded"
          ref="assistPanel"
          :assist
          :chips="assistChips"
          :changes="assistChanges"
          :also="assistAlso"
          :reference-target="walk && walk.room > 0 ? { kind: 'room', num: walk.room } : null"
          @reload="reopen(true)"
          noun="picture"
          empty="Select an item to ask about it."
        >
          <template #scope>
            <StudioLockChip
              v-model:unlocks="unlocks"
              :lens
              :held="assist.holds.value ? HOLD_TEXT : null"
            />
          </template>
        </StudioAssistPanel>
      </template>
    </PixelInspector>

    <footer class="studio__status" aria-label="Status bar">
      <span data-role="status" data-testid="studio-status">{{ status }}</span>
      <!-- A notice or a failed Keep takes the hint's place, off the picture. -->
      <StudioStatusNotice
        v-if="keeper.banner.value || editing.notice.value"
        :banner="keeper.banner.value"
        :notice="editing.notice.value"
        @recover="recover"
        @dismiss="editing.dismiss"
        @close="keeper.dismiss"
      />
      <span
        v-else
        class="studio__hint"
        :class="{ 'is-tip': calm.tip.value }"
        data-testid="studio-hint"
        :data-tool="tools.tool.value"
        >{{ calm.tip.value ?? toolHint }}</span
      >
      <span class="studio__spacer"></span>
      <span class="studio__meta" data-testid="studio-size">{{ size.full }}</span>
      <span class="studio__meta">AGI {{ profile.id }}</span>
      <span
        v-if="!model.trusted"
        class="studio__meta studio__source"
        data-testid="studio-source-kind"
        >Rebuilt <UiExplain v-bind="explain('rebuilt')"
      /></span>
      <StudioZoom :zoom :fitted @zoom="(step) => (step === 'fit' ? zoomToFit() : zoomBy(step))" />
      <span class="studio__status-sep" aria-hidden="true"></span>
      <UiIconButton
        icon="panel-left"
        label="Focus mode"
        :shortcut="keyLabel('Mod+\\')"
        aria-keyshortcuts="Meta+Backslash Control+Backslash"
        :pressed="calm.focus.value"
        @click="toggleFocus"
      />
      <UiIconButton
        icon="help"
        label="Keys"
        title="Keys · ?"
        shortcut="?"
        aria-keyshortcuts="?"
        aria-haspopup="dialog"
        data-testid="studio-keys-button"
        @click="openKeySheet"
      />
    </footer>
    <p class="studio__sr" aria-live="polite" data-role="announce">{{ input.spoken.value }}</p>
    <StudioTour v-if="!embedded" :tour :stage name="Room Studio" />

    <StudioKeySheet
      v-model:open="calm.sheetOpen.value"
      name="Room Studio"
      :sections="keySheet"
      @tour="tour.start()"
    />
    <StudioKeepDialog
      v-if="!embedded"
      v-model:ask="dialog"
      :subject="subject"
      noun="picture"
      :changes="changeTotal"
      :notes-only="notesOnly"
      :can-keep="keeper.canKeep.value"
      @keep="leave.answer('keep')"
      @discard="(answer) => (answer ? leave.answer('discard') : discardChanges())"
    />
    <StudioSmallScreen
      v-if="!embedded"
      name="Room Studio"
      :draft="room"
      :keeper
      @close="emit('close')"
    />
    <StudioCombineDialog
      v-model:open="combineOpen"
      :count="editing.targets.value.length"
      :between="combineGap.between.map((item) => item.label)"
      :loose="combineGap.looseCommands.length > 0"
      @make="groupSelection"
      @include="includeBetween"
    />
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
  --studio-bar: var(--control-h);
  /* The status bar grows a line when its readout and hint wrap. */
  grid-template-rows:
    52px calc(var(--studio-bar) + var(--space-1)) minmax(0, 1fr) 92px
    minmax(var(--studio-bar), auto);
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
/* Focus mode: the Scene list and the inspector step aside for the canvas. */
.studio.is-focus {
  grid-template-columns: 0 48px minmax(0, 1fr) 0;
}
.studio.is-focus .studio__scene,
.studio.is-focus .studio__inspector {
  display: none;
}
@media (pointer: coarse) {
  .studio {
    --studio-bar: var(--control-h-touch);
  }
}
.studio__scene {
  grid-row: 2 / 5;
  grid-column: 1;
  border-right: 1px solid var(--hairline);
}
/* The rail stops above the scrubber, which keeps the full width under it. */
.studio__rail {
  grid-row: 3;
  grid-column: 2;
}
/* The options bar docks over the rail and the canvas: nothing floats on the picture. */
.studio__options {
  position: relative;
  z-index: var(--z-dock);
  grid-row: 2;
  grid-column: 2 / 4;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface-1);
}
.studio__frame {
  position: relative;
  grid-row: 3;
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
  grid-row: 4;
  grid-column: 2 / 4;
}
.studio__inspector {
  grid-row: 2 / 5;
  grid-column: 4;
}
.studio__status {
  grid-row: 5;
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-0) var(--space-1) var(--space-0) var(--space-4);
  border-top: 1px solid var(--hairline);
  color: var(--ink-3);
  background: var(--surface-0);
  font: var(--text-2xs) var(--font-mono);
  white-space: nowrap;
}
/* The readout and the tool's help share what the bar leaves, wrapping onto a
   second line when short of room; the readout gives way first. */
.studio__status [data-role="status"] {
  flex: 0 3 auto;
  min-width: 22ch;
  color: var(--ink-2);
  line-height: 1.2;
  white-space: normal;
}
.studio__hint {
  flex: 0 1 auto;
  min-width: 28ch;
  color: var(--ink-3);
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  line-height: 1.2;
  white-space: normal;
}
.studio__hint.is-tip {
  flex-shrink: 0;
  color: var(--action);
  font-weight: var(--weight-bold);
}
.studio__meta {
  flex: none;
}
.studio__depth-all {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.studio__depth-all h3 {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.studio__source {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
/* The size the top bar folded away: it wraps before the readout and hint must. */
.studio__meta[data-testid="studio-size"] {
  flex: 0 1 auto;
  min-width: 12ch;
  line-height: 1.2;
  text-align: right;
  white-space: normal;
}
.studio__status-sep {
  width: 1px;
  height: var(--space-6);
  background: var(--hairline);
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
/* Embedded drawing surrounds the same MAIN stage. The transparent art pane
   takes editor gestures; only an unfinished gesture paints a preview over MAIN. */
.studio.is-embedded {
  grid-template-columns: 0 44px minmax(0, 1fr) 236px;
  grid-template-rows: 0 40px minmax(0, 1fr) 52px 28px;
}
.studio.is-embedded .studio__scene {
  grid-column: 4;
  grid-row: 2 / 5;
  border-right: 0;
  border-left: 1px solid var(--hairline);
}
.studio.is-embedded .studio__inspector {
  display: none;
}
.studio.is-embedded .studio__status {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.studio.is-embedded .studio__meta,
.studio.is-embedded .studio__status-sep {
  display: none;
}
.studio.is-workspace-focus {
  grid-template-columns: 0 44px minmax(0, 1fr) 0;
}
.studio.is-workspace-focus .studio__scene {
  display: none;
}
.studio__live-game {
  position: absolute;
  inset: 0;
}
.studio.is-live-game .studio__panes {
  padding: 0;
  transform: translateY(calc(-8px * var(--picture-zoom)));
}
.studio.is-live-game.is-art-idle :deep(.studio-pane canvas) {
  opacity: 0;
}
.studio.is-live-game .studio__frame {
  background: var(--agi-0);
}
.studio__live-game :deep(.play-area) {
  position: absolute;
  inset: 0;
  overflow: hidden;
  height: 100%;
  --game-aspect: 8 / 5;
  --game-ratio: 1.6;
}
.studio__live-game :deep(.play-strip) {
  display: none;
}
.studio.is-live-game .studio__live-game :deep(.play-area .screen) {
  --game-width: calc(320px * var(--picture-zoom));
  width: calc(320px * var(--picture-zoom));
  height: calc(200px * var(--picture-zoom));
  max-width: none;
  box-sizing: content-box;
}
.studio__live-game :deep(.stage) {
  min-height: 0;
  padding: 0;
}
@media (max-height: 800px) {
  .studio.is-embedded :deep(.tool-rail__tool .ui-icon-btn) {
    width: var(--control-h-sm);
    height: var(--control-h-sm);
  }
}
</style>
