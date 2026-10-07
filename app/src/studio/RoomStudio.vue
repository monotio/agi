<script setup lang="ts">
import UiIcon from "../ui/UiIcon.vue";
import { VOCABULARY } from "../../../src/vocabulary.ts";
import {
  computed,
  inject,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import type { ResourceRevision } from "../../../src/gameIdentity.ts";
import type { PlacementLine, RoomPlacement } from "../../../src/authoring/roomPlacements.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { createAgentSessionState } from "../../../src/agent/agentState.ts";
import { openContainer } from "../../../src/container/container.ts";
import {
  itemHandles,
  nearestInsertion,
  type LineHandle,
  type PointInsertion,
} from "../../../src/studio/editPoints.ts";
import { footprintMask, unionMask } from "../../../src/studio/editValidation.ts";
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
import { useMaybeWorkspaceEditor } from "../shell/workspaceEditor.ts";
import type { StudioRoomSource } from "../world/studioSource.ts";
import type { LessonSession } from "../lessons/lessonCheck.ts";
import LessonCard from "../lessons/LessonCard.vue";
import { useStudioLesson } from "../lessons/useStudioLesson.ts";
import UiSegmented from "../ui/UiSegmented.vue";
import PaletteStrip from "./workspace/PaletteStrip.vue";
import { useStudioPalette } from "./useStudioPalette.ts";
import DrawOrderScrubber from "./DrawOrderScrubber.vue";
import GhostProbe from "./GhostProbe.vue";
import GhostReadout from "./GhostReadout.vue";
import PixelInspector from "./PixelInspector.vue";
import SceneList from "./SceneList.vue";
import StudioCanvas, { type MaskPaths } from "./StudioCanvas.vue";
import StudioCanvasMenu, { type CanvasMenuItem } from "./StudioCanvasMenu.vue";
import StudioCombineDialog from "./StudioCombineDialog.vue";
import StudioGroupEditor from "./StudioGroupEditor.vue";
import StudioItemEditor from "./StudioItemEditor.vue";
import StudioItemPoints from "./StudioItemPoints.vue";
import StudioLogicText from "./StudioLogicText.vue";
import StudioSelectionBar from "./StudioSelectionBar.vue";
import StudioStatusNotice from "./StudioStatusNotice.vue";
import StudioToolOptions from "./StudioToolOptions.vue";
import StudioDrawingAt from "./StudioDrawingAt.vue";
import StudioPathBar from "./StudioPathBar.vue";
import StudioToolOverlay from "./StudioToolOverlay.vue";
import StudioToolRail from "./StudioToolRail.vue";
import StudioValuePicker from "./StudioValuePicker.vue";
import SharePictureMenu from "./share/SharePictureMenu.vue";
import { shareFileBase, shareRoomName } from "./share/shareFrame.ts";
import StudioViewBar from "./StudioViewBar.vue";
import RoomViewsOverlay from "./RoomViewsOverlay.vue";
import StudioViewsPanel from "./StudioViewsPanel.vue";
import { pictureViewsOpacity as viewsOpacity } from "./pictureViews.ts";
import StudioWalkOverlay from "./StudioWalkOverlay.vue";
import StudioWalkPanel from "./StudioWalkPanel.vue";
import StudioZoom from "./StudioZoom.vue";
import UiExplain from "../ui/UiExplain.vue";
import { fillNotice } from "./fillAdvice.ts";
import {
  ROOM_EDIT_HINT,
  ROOM_GROUP_HINT,
  ROOM_PATH_HINT,
  ROOM_TOOL_HINTS,
  ROOM_TOOL_NAMES,
  roomKeySheet,
} from "./studioHelp.ts";
import { explain } from "./studioTerms.ts";
import { isWalkTool, TOOL_KEYS, type StudioTool } from "./studioTools.ts";
import { studioKey, type StudioKeyActions } from "./studioKeys.ts";
import { lensItemLocks, lockedPlanes, NO_UNLOCKS, type LensUnlocks } from "./studioLocks.ts";
import {
  bandGuides,
  maskFillPath,
  maskOutlinePath,
  PANE_LABELS,
  panesFor,
  pictureSize,
  type StudioLens,
  type StudioViewMode,
  type PriorityFilter,
  filterPriority,
  LENS_NAMES,
  tickFor,
} from "./studioView.ts";
import { listGameViews, useGhostProbe } from "./useGhostProbe.ts";
import { filterScene, resolveStudioSource, useStudioDocument } from "./useStudioDocument.ts";
import { exposeStudioDraft, useStudioDraft } from "./useStudioDraft.ts";
import { useStudioFocus } from "./useStudioFocus.ts";
import { useStudioInput } from "./useStudioInput.ts";
import { useStudioDrag } from "./useStudioDrag.ts";
import { useStudioEditing } from "./useStudioEditing.ts";
import { useFold } from "./useFold.ts";
import { useStudioReadout } from "./useStudioReadout.ts";
import { useStudioSelection } from "./useStudioSelection.ts";
import { useStudioTools } from "./useStudioTools.ts";
import { useStudioViewport } from "./useStudioViewport.ts";
import { useRoomLogicDraft } from "./useRoomLogicDraft.ts";
import { DEFAULT_EGO, useStudioWalk, type EgoShape } from "./useStudioWalk.ts";
import { useUndoOrder } from "./useUndoOrder.ts";

/**
 * Room Studio: one picture's items, draw order and planes, edited as a draft
 * (useStudioDraft); the workspace owns saving and the agent. It takes the
 * picture bytes (and authored text, trusted only while it compiles to those
 * bytes) and the revision they were read at. Keys are handled at the root
 * and stopped (studioKeys.ts), so none reach the game, and focus never falls
 * out of the studio while it is open. The tool rail (useStudioTools, by
 * pointer or keys: useStudioInput) inserts new items at the playhead; the
 * actor probe stands a VIEW from the game's `files` on the draft. The Walk
 * view (useStudioWalk) adds test walks, Play here and the room's doors,
 * whose logic edits emit room-edit for the workspace to keep with the
 * picture. The selected items follow the workspace agent's context chip
 * (agent-context). Several items can be selected
 * (useStudioSelection) and moved, copied, deleted or grouped together (and a
 * group ungrouped); the selection's actions dock in the options bar above
 * the canvas, so nothing covers the picture.
 */
const {
  pictureNumber,
  bytes,
  authoredSource = undefined,
  profile,
  title,
  baseRevision = undefined,
  files = undefined,
  walk = undefined,
  currentRoomSource = undefined,
  underlay = null,
  readOnly = false,
  active = true,
  lessonSession = undefined,
  priorityBase = undefined,
  figures = [],
} = defineProps<{
  readOnly?: boolean;
  /** Whether this tab is showing: its status bar and keys join the frame's. */
  active?: boolean;
  lessonSession?: LessonSession | undefined;
  priorityBase?: number | undefined;
  figures?: readonly RoomPlacement[];
  pictureNumber: number;
  bytes: Uint8Array;
  authoredSource?: string | undefined;
  profile: AgiProfile;
  title: string;
  /** The game revision the bytes were read at; without one the picture is view only. */
  baseRevision?: ResourceRevision | undefined;
  /** The game's container files, read at the same revision: the actor probe's VIEWs. */
  files?: ReadonlyMap<string, Uint8Array> | undefined;
  /** The room framing the picture: its logic (doors), bindings, plan and tests. */
  walk?: StudioRoomSource | null | undefined;
  currentRoomSource?: (() => string | undefined) | undefined;
  /**
   * A prepared reference underlay (160x168 RGBA) from its project attachment,
   * blended over the art pane as a tracing guide — never a runtime bitmap.
   */
  underlay?: {
    pixels: Uint8Array;
    opacity: number;
    behindArt?: boolean;
    transform?: import("../../../src/creative/imageAttachments.ts").TraceTransform;
    adjust?:
      | ((
          transform: import("../../../src/creative/imageAttachments.ts").TraceTransform,
          release: boolean,
        ) => void)
      | undefined;
  } | null;
}>();
/** `play-here` asks the shell to play from a spot on this picture's room. */
const emit = defineEmits<{
  edit: [source: string];
  "room-edit": [
    room: number,
    source: string,
    bindings: Readonly<
      Record<
        string,
        { kind: import("../../../src/agent/authoringState.ts").BindingKind; num: number }
      >
    >,
    pictureSource: string | undefined,
  ];
  "place-figure": [figure: RoomPlacement, x: number, y: number];
  "reveal-figure": [line: PlacementLine];
  "agent-context": [context: { label: string; text: string } | null];
  "play-here": [target: PlayHereTarget];
}>();

const lens = ref<StudioLens>("art");
const mode = ref<StudioViewMode>("blend");
const BANDS_KEY = "monotio_agi.studioBands";
/** Band lines start off so the picture stays clear; the choice is remembered. */
function storedBands(): boolean {
  try {
    return localStorage.getItem(BANDS_KEY) === "1";
  } catch {
    return false;
  }
}
const showBands = ref(storedBands());
watch(showBands, (on) => {
  try {
    localStorage.setItem(BANDS_KEY, on ? "1" : "0");
  } catch {
    /* This page keeps the choice. */
  }
});
const priorityFilter = ref<PriorityFilter>("all");
const filter = ref("");
const side = ref("items");
/** The Items list shows every item flat in draw order instead of grouped. */
const listOrder = ref(false);
const unlocks = ref<LensUnlocks>(NO_UNLOCKS);
/** More points than this and the item shows no handles (the inspector still lists them). */
const MAX_HANDLES = 160;
/** How near its line, in CSS pixels, an Alt+click adds a point. */
const INSERT_REACH = 12;
/** The tools whose hover on the picture lights up the item under the pointer. */
const HOVER_TOOLS: readonly StudioTool[] = ["select", "point", "fill"];

let localPictureSource: string | undefined;
const resolved = computed(() =>
  // The keyed write queue can publish older bytes while our newer text is pending.
  authoredSource !== undefined && authoredSource === localPictureSource
    ? { source: authoredSource, trusted: true, profile }
    : resolveStudioSource({ bytes, authoredSource, profile }),
);
const draft = useStudioDraft({
  base: () => ({ source: resolved.value.source, revision: baseRevision }),
  profile: () => profile,
  priorityBase: () => priorityBase,
  lens,
  unlocks,
});
const doc = useStudioDocument(() => ({
  source: draft.source.value,
  // A write-back stores the draft's annotated text beside the bytes: from
  // then on it is the picture's authored source, not a disassembly.
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
const { stops, drawn, single, pixel, fill, labelOf, status, position } = readout;
/** The engine, when Studio runs in the app (the harness has none). */
const engineApi = inject(engineKey, null);
const workspaceEditor = useMaybeWorkspaceEditor();
/** In the frame this tab reports its sheet and shares to the frame's bars. */
const inWorkspace = workspaceEditor !== null;
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
/** The picture's technical facts, for Inspector → Details only. */
const pictureMeta = computed(
  () =>
    `PICTURE ${pictureNumber} · ${pictureSize(draft.compiled.value.bytes.length, total.value).full} · AGI ${profile.id}`,
);
const shareFile = computed(() => shareFileBase(shareGame.value, shareRoom.value));
/** A Help guide lesson Studio opened from: every successful edit runs its challenge. */
const lesson = useStudioLesson(() => lessonSession);
watch(
  () => lessonSession,
  (session) => {
    if (session && window.innerWidth <= 600) side.value = "inspector";
  },
  { immediate: true },
);
watch(
  () => lessonSession,
  () =>
    lesson.check({
      kind: "picture",
      num: pictureNumber,
      after: draft.compiled.value.bytes,
      afterSource: draft.source.value,
      profile,
    }),
  { immediate: true },
);

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
  currentSource: () => currentRoomSource?.(),
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
watch([draft.source, draft.gesturing], ([source, gesturing]) => {
  if (readOnly || gesturing) return;
  // Receiving native bytes resets an untouched draft; it is not a drawing edit.
  // Undo back to saved text still has a future step and must reach the queue.
  if (!draft.dirty.value && !draft.canUndo.value && !draft.canRedo.value) return;
  // The saved source can still match an Undo while a newer write is pending.
  localPictureSource = source;
  emit("edit", source);
  lesson.check({
    kind: "picture",
    num: pictureNumber,
    after: draft.compiled.value.bytes,
    afterSource: source,
    profile,
  });
});
/** Editing is blocked while the picture is view only (no revision to write to). */
const frozen = (): boolean => readOnly || draft.kept.value.revision === undefined;

watch(logic.source, () => {
  if (readOnly) return;
  if (walk && logic.editable.value && logic.dirty.value) {
    const followed = logic.forKeep(keptDocument.value, draft.document.value);
    if (!followed.ok) {
      editing.say({ tone: "warn", text: followed.error });
      return;
    }
    if ("source" in followed)
      emit("room-edit", walk.room, followed.source, followed.newBindings, undefined);
  }
});
/** The selected items the agent's context chip follows: an item, a group's members, or several items. */
const askTargets = computed<string[]>(() => {
  const items = new Set(draft.document.value.items.map((item) => item.id));
  return selection.itemIds.value.filter((id) => items.has(id));
});
const itemLabel = (id: string): string =>
  draft.document.value.items.find((item) => item.id === id)?.label ?? id;
watch(
  [askTargets, lens, unlocks],
  ([ids, currentLens, currentUnlocks]) => {
    emit(
      "agent-context",
      ids.length
        ? {
            label: `PICTURE ${pictureNumber} · ${ids.map(itemLabel).join(", ")}`,
            text: `Selected item ids: ${ids.join(", ")}. Lens: ${currentLens}. Unlocks: ${JSON.stringify(currentUnlocks)}.`,
          }
        : null,
    );
  },
  { immediate: true },
);
const editing = useStudioEditing({
  draft,
  selectedId,
  itemIds: () => selection.itemIds.value,
  selectItems: selection.selectItems,
  frozen,
  doors: () => followingDoors.value,
  lens: () => lens.value,
  labelOf: (itemId) => model.value.rows.find((row) => row.id === itemId)?.display,
  offer: (check) => {
    const rules = check.violations.map((violation) => violation.rule);
    const [plane] = lockedPlanes(lens.value, unlocks.value);
    if (rules.includes("locked-plane") && plane)
      return { label: "Unlock", run: () => unlockNow({ [plane]: true }) };
    return undefined;
  },
});
/** A lock refusal's step: the lock opens for this session and the notice says so. */
function unlockNow(patch: Partial<LensUnlocks>): void {
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
const panes = computed(() => panesFor(lens.value, mode.value));
const { viewport, zoom, dpr, fitted, zoomBy, zoomToFit } = useStudioViewport(
  stage,
  () => panes.value.length,
  undefined,
  true,
);

/** The planes on screen: the drag's preview while one runs, else the scrubbed draft. */
const shown = computed(() => draft.preview.value?.compiled ?? surface.value);
/** The priority plane as the view filter leaves it (Visual panes read the visual plane only). */
const filteredPriority = computed(() => filterPriority(shown.value.priority, priorityFilter.value));
/** The playhead stands inside the order: the canvas shows the picture only up to there. */
const midOrder = computed(() => playhead.value < total.value);
const editableId = computed(() => editing.editable.value?.id);
/**
 * While new shapes draw earlier, the canvas shows the picture only up to the
 * marker: a row drawn after it is not on the canvas, so it wears no marks.
 */
const onCanvas = (id: string): boolean =>
  !midOrder.value ||
  ([...model.value.rows, ...model.value.folds]
    .find((row) => row.id === id)
    ?.entries.every((k) => k < playhead.value) ??
    false);
/**
 * The selection's cells on the canvas, on both planes in every lens (a move
 * takes an item's art, depth and walk lines along); while a drag previews,
 * the moving items' footprints. Unassigned lines show under the lens.
 */
const selectionMask = computed(() => {
  const ids = selection.selectedIds.value.filter(onCanvas);
  if (ids.length === 0) return null;
  const preview = draft.preview.value;
  const moving = editableId.value !== undefined ? [editableId.value] : editableIds.value;
  if (preview && moving.length > 0)
    return unionMask(...moving.map((id) => footprintMask(preview.compiled, id, "both")));
  const items = selection.itemIds.value.filter(onCanvas);
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
const selectedPoint = shallowRef<LineHandle | null>(null);
watch(selectedId, () => {
  selectedPoint.value = null;
});
function pressCanvas(press: import("./StudioCanvas.vue").PanePress): void {
  selectedPoint.value = press.handle ?? null;
  input.pointer.press(press);
}
function removePoint(): boolean {
  const point = selectedPoint.value;
  if (!point) return false;
  const done = editing.removePoint(point.line, point.index);
  if (done) {
    selectedPoint.value = null;
    editing.say({
      tone: "ok",
      text: editing.editable.value ? "Point deleted." : "Line deleted: it needed two points.",
    });
  }
  return true;
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
watch(
  () => readOnly,
  (paused) => {
    if (paused) drag.abort();
  },
  { flush: "sync" },
);
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
  itemLabel: (id) =>
    model.value.rows.find((row) => row.id === id)?.display ??
    followedItem(draft.document.value, id)?.label ??
    id,
  ego: () => ego.value,
  say: (notice) => editing.say(notice),
  frozen,
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
  undo: () => editing.undo(),
  nameOf: (line) => {
    const item = pictureItemAtLine(model.value.document, line);
    return item
      ? (model.value.rows.find((row) => row.id === item.id)?.display ?? item.label)
      : null;
  },
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
/** Spots the Views list previews for computed or conditional placements, by object. */
const viewPreviews = ref<Record<number, { x: number; y: number }>>({});
function previewFigure(figure: RoomPlacement, x: number, y: number): void {
  viewPreviews.value = { ...viewPreviews.value, [figure.object]: { x, y } };
}
function resetFigure(figure: RoomPlacement): void {
  const next = { ...viewPreviews.value };
  delete next[figure.object];
  viewPreviews.value = next;
}
function copyFigureSpot(figure: RoomPlacement, x: number, y: number): void {
  const line = `position(o${figure.object}, ${x}, ${y});`;
  void navigator.clipboard?.writeText(line).then(
    () => editing.say({ tone: "ok", text: `Copied ${line}` }),
    () => editing.say({ tone: "warn", text: `The position is ${line}` }),
  );
}
const ghost = useGhostProbe({
  views,
  picture: () => shown.value,
  profile: () => profile,
  priorityBase: () => priorityBase,
});
/** The priority-plane item under a cell, named for the probe's verdict. */
const describeCell = (x: number, y: number): string | undefined => {
  const id = doc.rowAt(x, y, "priority");
  return id === undefined ? undefined : labelOf(id);
};

/**
 * The hovered item's pixels: an Items row's always, the picture's own only
 * under the tools that act on a whole item (Select, Points, and Fill, which
 * recolours what painted a coloured spot). A drawing tool lights nothing up.
 */
const hoverPaths = computed(() => {
  const id = hoveredId.value;
  if (drag.dragging.value || id === undefined || midOrder.value) return null;
  if (selection.listHover.value === undefined && !HOVER_TOOLS.includes(tools.tool.value))
    return null;
  return pathsOf(doc.rowMask(id, lens.value));
});
/**
 * The selection's drawing is fills only: the canvas tints the flooded area
 * and shows its fill point, not an outline that reads as a drawn line.
 */
const selectedFill = computed(() => {
  const row = selectedRow.value;
  if (!row || selection.selectedIds.value.length !== 1) return false;
  const drawing = row.entries
    .map((k) => model.value.timeline[k]!)
    .filter((entry) => tickFor(entry).kind !== "state");
  return drawing.length > 0 && drawing.every((entry) => tickFor(entry).kind === "fill");
});
const selectionPaths = computed(() => {
  const paths = pathsOf(selectionMask.value);
  return paths && selectedFill.value ? { fill: paths.fill, outline: "" } : paths;
});
const flashPaths = computed(() => pathsOf(editing.flash.value));
const handleList = computed(() => {
  const id = editableId.value;
  return id === undefined
    ? []
    : itemHandles(draft.preview.value?.document ?? draft.document.value, id);
});
/** The selected item's point handles: the Point tool's alone, as Select moves whole items. */
const handles = computed(() => {
  if (handleList.value.length === 0 || handleList.value.length > MAX_HANDLES) return null;
  if (editableId.value === undefined || !onCanvas(editableId.value)) return null;
  if (tools.tool.value === "point") return handleList.value;
  // A fill's seed drags under Select too; a mixed item's handles are the Point tool's.
  if (tools.tool.value === "select" && handleList.value.every((handle) => handle.kind === "seed"))
    return handleList.value;
  return null;
});
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
const guides = computed(() =>
  showBands.value && lens.value !== "art" && !midOrder.value ? bandGuides() : null,
);

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
/** What Details adds for the selection: an item's points, or priority for several. */
const detailsMore = computed(() => {
  if (editing.several.value) return editing.editableItems.value.length > 1 ? "Priority" : "";
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

/** The fill tool's notice: what the spot holds and why a fill cannot reach it. */
const fillAdvice = computed(() => {
  const why = tools.fillWhy.value;
  if (!why) return null;
  const { document } = model.value;
  const item = why.line === null ? null : pictureItemAtLine(document, why.line);
  const owner =
    item === null || item === undefined
      ? null
      : (model.value.rows.find((row) => row.id === item.id)?.display ?? item.label);
  return { notice: fillNotice(why, owner) };
});

/** The options bar folds what it cannot fit: see StudioSelectionBar and StudioToolOptions. */
const optionsBar = useTemplateRef("optionsBar");
const optionsFold = useFold(
  optionsBar,
  4,
  (bar) =>
    // A wrapped second row roughly doubles the bar; a child a few pixels
    // taller than the row still counts as fitting.
    bar.scrollHeight <= bar.clientHeight * 1.5 &&
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
    tools.insertion.value.index,
  ],
  () => void optionsFold.refit(),
  { flush: "post" },
);

// ---- The room tools (test walks and doors, in the Priority lens) ------------
/** The floor estimate's tint over the picture: off until the panel turns it on. */
const walkTint = ref(false);
const palette = useStudioPalette({
  tool: tools.tool,
  lens,
  selected: () => selection.selectedIds.value.length > 0,
  timeline: () => model.value.timeline,
  editing,
  current: tools.current,
  setValues: tools.setValues,
  frozen,
});

/** A walk tool in the Visual lens hands back to Select. */
watch(lens, (next) => {
  if (next === "art" && isWalkTool(tools.tool.value)) tools.setTool("select");
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
/** A walk tool opens the Priority lens first, and the Inspector where its panel is. */
function walkView(next: StudioTool): boolean {
  if (!isWalkTool(next)) return true;
  lens.value = "depth";
  side.value = "inspector";
  return true;
}
function pickTool(next: StudioTool): void {
  if (walkView(next)) tools.setTool(next);
  keepFocus();
}
/** A rail letter: T, D and E open the Priority lens first. */
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
  const named = (item: (typeof document.items)[number]) => ({
    id: item.id,
    label: model.value.rows.find((row) => row.id === item.id)?.display ?? item.label,
  });
  const items = document.items.map(named);
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

/**
 * Play here: the shell plays from the spot, in this room or, from a walk that
 * went through a door, the room it ended in.
 */
function playHere(at: Point | PlayHereTarget): void {
  const room = "room" in at ? at.room : (walk?.room ?? 0);
  if (room < 1) {
    editing.say({ tone: "warn", text: "This picture isn't shown by a room the game can enter." });
    return;
  }
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
        ...(editing.several.value ? [] : [{ id: "priority", label: "Priority…" }]),
        ...(selectedPoint.value ? [{ id: "delete-point", label: "Delete point" }] : []),
        {
          id: "delete",
          label:
            tools.tool.value === "line" ||
            (editing.editable.value?.commandLines.some((line) =>
              /^line|^polyline|^rel/.test(model.value.document.lines[line - 1] ?? ""),
            ) ??
              false)
              ? "Delete line"
              : "Delete shape",
        },
      ],
);
const menuItems = computed<CanvasMenuItem[]>(() => [
  ...selectionMenu.value,
  {
    id: "play",
    label: "Play here",
    disabled: !walk || walk.room < 1,
  },
  ...(lens.value === "depth"
    ? [
        { id: "walk-from", label: "Start a test walk here" },
        { id: "walk-to", label: "Test walk to here", disabled: !walker.start.value },
      ]
    : []),
]);
/** A right-click off the selection selects what is under it first, as a click would. */
function openMenu(cell: Point, at: { x: number; y: number }): void {
  selectedPoint.value =
    handles.value?.find(
      (handle) =>
        Math.abs(handle.x - cell.x) * 2 <= 6 / zoom.value &&
        Math.abs(handle.y - cell.y) <= 6 / zoom.value,
    ) ?? null;
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
  else if (id === "priority") priorityOpen.value = true;
  else if (id === "combine") openCombine();
  else if (id === "ungroup") editing.ungroup();
  else if (id === "delete-point") removePoint();
  else if (id === "play") playHere(cell);
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

/** "insert here" on a row: new shapes draw before it, and the canvas shows the picture up to there. */
function insertBefore(id: string): void {
  const row = [...model.value.rows, ...model.value.folds].find((entry) => entry.id === id);
  if (row && row.entries.length > 0) seek(row.entries[0]!);
  keepFocus();
}

/** A list drag: `id` lands before or after `target` in the draw order. */
function moveRow(id: string, target: string, edge: "before" | "after"): void {
  if (frozen()) return;
  const items = draft.document.value.items;
  const rest = items.filter((item) => item.id !== id);
  const at = rest.findIndex((item) => item.id === target);
  if (!items.some((item) => item.id === id) || at < 0) return;
  editing.moveTo(id, Math.min(edge === "before" ? at : at + 1, items.length - 1));
}

const keepFocus = useStudioFocus(useTemplateRef("root"));
exposeStudioDraft(draft, () => logic.source.value);

/** The workspace's one Keys sheet: `?` opens it at this editor's section. */
const sheetOpen = workspaceEditor?.keysOpen ?? ref(false);
const keySheet = computed(() => roomKeySheet(tools.tool.value));
if (workspaceEditor)
  onBeforeUnmount(
    workspaceEditor.registerKeySheet(`picture:${pictureNumber}`, () => ({
      name: "PICTURE",
      sections: keySheet.value,
    })),
  );

/** Share sits behind the frame's ⋯ menu; the menu asks the menu component to run. */
const shareMenu = useTemplateRef("shareMenu");
if (workspaceEditor)
  onBeforeUnmount(
    workspaceEditor.registerFrameActions(`picture:${pictureNumber}`, () => [
      {
        id: "share-clip",
        label: "Share a clip…",
        testId: "studio-share-clip",
        disabled: !(shareMenu.value?.clipAvailable() ?? true),
        title:
          (shareMenu.value?.clipAvailable() ?? true)
            ? undefined
            : "Video recording is unavailable in this browser",
        run: () => shareMenu.value?.start("clip"),
      },
      {
        id: "share-still",
        label: "Share a still…",
        testId: "studio-share-still",
        run: () => shareMenu.value?.start("still"),
      },
    ]),
  );
/** A door's link handle on the move: the item it is over lights up, and the status bar names it. */
const doorLink = shallowRef<{ item: string | undefined } | null>(null);
function linkDoor(target: { item: string | undefined } | null): void {
  doorLink.value = target;
  selection.listHover.value = target?.item;
}
/** The status bar's line for the active tool (the editing keys while an item is selected). */
const toolHint = computed(() => {
  const link = doorLink.value;
  if (link)
    return link.item ? `Drop to follow ${followLabel(link.item)}` : "Drop on the art to follow it";
  const tool = tools.tool.value;
  if ((tool === "line" || tool === "polygon") && (tools.path.value?.points.length ?? 0) > 0)
    return ROOM_PATH_HINT;
  if (tool === "select" && editing.editableItems.value.length > 0) return ROOM_EDIT_HINT;
  return ROOM_TOOL_HINTS[tool];
});
type TraceTransform = import("../../../src/creative/imageAttachments.ts").TraceTransform;
let traceDrag: {
  pointer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  from: TraceTransform;
  kind: "move" | "scale";
} | null = null;
let traceKeyTimer: ReturnType<typeof setTimeout> | undefined;
let traceKeyCommit: (() => void) | undefined;
function flushTraceKeys(): void {
  clearTimeout(traceKeyTimer);
  const commit = traceKeyCommit;
  traceKeyCommit = undefined;
  commit?.();
}
onBeforeUnmount(flushTraceKeys);
function grabTrace(event: PointerEvent, kind: "move" | "scale") {
  flushTraceKeys();
  const button = event.currentTarget as HTMLButtonElement;
  const bounds = button.parentElement!.getBoundingClientRect();
  traceDrag = {
    pointer: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    width: bounds.width,
    height: bounds.height,
    from: { ...(underlay?.transform ?? { x: 0, y: 0, scale: 1 }) },
    kind,
  };
  button.setPointerCapture(event.pointerId);
}
function moveTrace(event: PointerEvent) {
  if (!traceDrag || traceDrag.pointer !== event.pointerId) return;
  const { x, y, width, height, from, kind } = traceDrag;
  const dx = (event.clientX - x) / width;
  const dy = (event.clientY - y) / height;
  const next =
    kind === "move"
      ? {
          ...from,
          x: Math.max(-160, Math.min(160, from.x + dx * 160)),
          y: Math.max(-168, Math.min(168, from.y + dy * 168)),
        }
      : { ...from, scale: Math.max(0.25, Math.min(4, from.scale + (dx + dy) * 2)) };
  underlay?.adjust?.(next, false);
}
function releaseTrace(event: PointerEvent, cancel = false) {
  if (!traceDrag || traceDrag.pointer !== event.pointerId) return;
  if (cancel) underlay?.adjust?.(traceDrag.from, false);
  else {
    moveTrace(event);
    underlay?.adjust?.(underlay.transform ?? traceDrag.from, true);
  }
  traceDrag = null;
}
function traceKey(event: KeyboardEvent, kind: "move" | "scale") {
  const direction: Record<string, readonly [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const step = direction[event.key];
  if (!step) return;
  event.preventDefault();
  event.stopPropagation();
  const from = underlay?.transform ?? { x: 0, y: 0, scale: 1 };
  const next =
    kind === "move"
      ? {
          ...from,
          x: Math.max(-160, Math.min(160, from.x + step[0])),
          y: Math.max(-168, Math.min(168, from.y + step[1])),
        }
      : { ...from, scale: Math.max(0.25, Math.min(4, from.scale + (step[0] - step[1]) * 0.05)) };
  const adjust = underlay?.adjust;
  adjust?.(next, false);
  clearTimeout(traceKeyTimer);
  traceKeyCommit = () => adjust?.(next, true);
  traceKeyTimer = setTimeout(flushTraceKeys, 250);
}
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
  lens: (next) => {
    lens.value = next;
  },
  seek: (to) => seek(to === "first" ? 0 : to === "last" ? total.value : playhead.value + to),
  zoom: (step) => (step === "fit" ? zoomToFit() : zoomBy(step)),
  step: (direction) => selection.step(direction),
  extend: (direction) => void selection.extend(direction),
  nudge: editing.nudge,
  cursor: input.move,
  click: input.click,
  remove: () => tools.backspace() || removePoint() || editing.remove(),
  duplicate: editing.duplicate,
  group: openCombine,
  ungroup: () => void editing.ungroup(),
  reorder: editing.reorder,
  undo: () => (workspaceEditor ? void workspaceEditor.step("undo") : undoOrder.undo()),
  redo: () => (workspaceEditor ? void workspaceEditor.step("redo") : undoOrder.redo()),
  tool: toolKey,
  finish: tools.finish,
  insertPoint: insertPointAtCursor,
  keySheet: () => (sheetOpen.value = true),
};
/** Every key stops here so the game never sees it. */
function onKeydown(event: KeyboardEvent): void {
  if ((event.target as HTMLElement).closest(".play-area")) return;
  event.stopPropagation();
  // The logic text or the key sheet takes the keys it needs (Esc closes it) and nothing else runs.
  if (logicText.value !== undefined || sheetOpen.value || combineOpen.value) return;
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
  if ((event.target as HTMLElement).closest(".play-area")) return;
  event.stopPropagation();
  input.spaceKey(event, false);
}
</script>

<template>
  <div
    ref="root"
    class="studio"
    :class="{
      'has-reference': !!underlay,
      'is-art-idle': lens === 'art' && !draft.gesturing.value,
    }"
    data-testid="room-studio"
    tabindex="-1"
    role="region"
    :aria-label="`PICTURE: ${title}`"
    @keydown="onKeydown"
    @keyup="onKeyup"
    @keypress.stop
    @click="
      (event) => {
        if (!(event.target as HTMLElement).closest('.play-area')) keepFocus();
      }
    "
  >
    <div class="studio__scrubber studio__palette-row">
      <PaletteStrip
        :context="palette.context.value"
        :value="lens === 'art' ? palette.values.value.visual : palette.values.value.priority"
        :disabled="frozen()"
        @choose="palette.choose(lens === 'art' ? { visual: $event } : { priority: $event })"
      />
      <DrawOrderScrubber
        v-model="playhead"
        data-testid="studio-scrubber"
        :stops
        :total
        :marked="selection.selectedIds.value"
        :position="position.text"
      />
    </div>

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
        :label="selectedRow.display"
        :several="editing.several.value"
        :priority="single('priority')"
        :priority-locked="itemLocks.priority"
        :edit="editing"
        :grouped="editing.grouped.value"
        :fold="optionsFold.level.value"
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
        :notice="fillAdvice?.notice ?? null"
        :fold="optionsFold.level.value"
      />
      <!-- In the frame, where new shapes draw and an open path ride the context row above. -->
      <Teleport :disabled="!active || !inWorkspace" defer to="#workspace-context-editor">
        <StudioDrawingAt :at="position" @end="seek(total)" />
        <StudioPathBar
          v-if="tools.path.value"
          :name="ROOM_TOOL_NAMES[tools.path.value.tool]"
          :points="tools.path.value.points.length"
          @undo="
            tools.backspace();
            keepFocus();
          "
          @done="
            tools.finish();
            keepFocus();
          "
        />
      </Teleport>
      <span class="studio__spacer"></span>
      <label class="studio__views-slider"
        >Views
        <input v-model.number="viewsOpacity" type="range" min="0" max="100" aria-label="Views" />
        <output>{{ viewsOpacity }}%</output>
      </label>
      <UiSegmented
        v-model="lens"
        size="sm"
        :label="VOCABULARY.lens.label"
        :options="[
          { value: 'art', label: LENS_NAMES.art.label, title: LENS_NAMES.art.help },
          { value: 'depth', label: LENS_NAMES.depth.label, title: LENS_NAMES.depth.help },
        ]"
      />
      <StudioViewBar
        v-model:mode="mode"
        v-model:bands="showBands"
        v-model:filter="priorityFilter"
        :lens
        :fold="optionsFold.level.value"
      />
    </div>

    <StudioToolRail
      :tool="tools.tool.value"
      class="studio__rail"
      :frozen="frozen()"
      :probe-active="ghost.active.value"
      :probe-available="views.length > 0"
      :lens
      :unlocks
      :values="palette.values.value"
      :palette-action="palette.context.value.action"
      :cursor-y="tools.cursor.value?.y"
      :doors-editable="logic.editable.value"
      @update:tool="pickTool"
      @probe="ghost.toggle()"
      @values="palette.choose"
      @unlocks="(next) => (unlocks = next)"
    />
    <main class="studio__frame">
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
            :priority="filteredPriority"
            :viewport
            :dpr
            :highlight="hoverPaths"
            :selection="selectionPaths"
            :guides="layer === 'art' ? null : guides"
            :handles
            :ghost="insertGhost"
            :flash="flashPaths"
            :movable="movable"
            :marquee="drag.marqueeBox.value ?? null"
            :underlay="layer === 'art' ? underlay : null"
            @hover="input.pointer.hover"
            @press="pressCanvas"
            @drag="input.pointer.drag"
            @release="input.pointer.release"
            @abort="input.pointer.abort"
            @dblclick="tools.finish()"
            @menu="openMenu"
          >
            <RoomViewsOverlay
              v-if="viewsOpacity > 0 && !midOrder && (layer === 'art' || panes.length === 1)"
              :figures
              :views
              :viewport
              :opacity="viewsOpacity / 100"
              :picture="shown"
              :profile
              :priority-base="priorityBase"
              :previews="viewPreviews"
              :read-only="readOnly"
              @place="(figure, x, y) => emit('place-figure', figure, x, y)"
              @preview="previewFigure"
              @pointerdown.stop
              @pointermove.stop
              @pointerup.stop
              @keydown.stop
              @click.stop
            />
            <template v-if="layer === 'art' && underlay?.adjust && lens === 'art'">
              <button
                v-for="kind in ['move', 'scale'] as const"
                :key="kind"
                type="button"
                class="studio__trace-handle"
                :class="`studio__trace-handle--${kind}`"
                :aria-label="kind === 'move' ? 'Move trace' : 'Scale trace'"
                aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
                @pointerdown.stop.prevent="grabTrace($event, kind)"
                @pointermove.stop="moveTrace"
                @pointerup.stop="releaseTrace($event)"
                @pointercancel.stop="releaseTrace($event, true)"
                @lostpointercapture="releaseTrace($event, true)"
                @keydown="traceKey($event, kind)"
                @blur="flushTraceKeys"
                @click.stop
              >
                <UiIcon :name="kind === 'move' ? 'move' : 'expand'" :size="18" />
              </button>
            </template>
            <StudioWalkOverlay
              v-if="lens === 'depth' && !midOrder && index === panes.length - 1"
              :walk="walker"
              :viewport
              :tool="tools.tool.value"
              :tint="walkTint"
              :item-at="itemAt"
              @link="linkDoor"
            />
            <StudioToolOverlay v-if="tools.tool.value !== 'select'" v-bind="input.overlay.value" />
            <!-- The probe's own presses never reach the pane below. -->
            <GhostProbe
              v-if="index === 0 && !midOrder"
              :probe="ghost"
              :viewport
              @pointerdown.stop
              @pointermove.stop
            />
          </StudioCanvas>
        </div>
      </div>
    </main>

    <aside class="studio__side">
      <UiSegmented
        v-model="side"
        size="sm"
        label="Side panel"
        :options="[
          { value: 'items', label: 'Items' },
          { value: 'inspector', label: 'Inspector' },
          ...(figures.length > 0 ? [{ value: 'views', label: 'Views' }] : []),
        ]"
      />
      <StudioViewsPanel
        v-if="figures.length > 0"
        v-show="side === 'views'"
        class="studio__views"
        :figures
        :previews="viewPreviews"
        :read-only="readOnly"
        @preview="previewFigure"
        @reset="resetFigure"
        @copy="copyFigureSpot"
        @reveal="(line) => emit('reveal-figure', line)"
      />
      <SceneList
        v-show="side === 'items'"
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
        @select="
          (id, extend) => {
            extend ? selection.toggle(id) : (selectedId = id);
          }
        "
        v-model:draw-order="listOrder"
        :insert-at="position.index"
        @insert="insertBefore"
        :movable="(id) => draft.document.value.items.some((item) => item.id === id)"
        @move="moveRow"
        @group="openCombine"
      />
      <PixelInspector
        class="studio__inspector"
        :class="{ 'is-compact': !selectedRow && lens !== 'depth' && !lesson.session.value }"
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
        :foot="
          editing.several.value && editing.editableItems.value.length > 1 ? ROOM_GROUP_HINT : ''
        "
        @seek="seek"
        @select="selectedId = $event"
      >
        <template #lead>
          <!-- The lesson's card docks at the top of the inspector, off the stage. -->
          <LessonCard
            v-if="lesson.session.value"
            :session="lesson.session.value"
            :outcome="lesson.outcome.value"
          />
          <!-- The probe's readout docks here too: on the art, only the ghost and its handle. -->
          <GhostReadout v-if="ghost.active.value" :probe="ghost" :describe-cell="describeCell" />
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
          <!-- The room tools' panel follows the selection's own editor. -->
          <StudioWalkPanel
            v-if="lens === 'depth'"
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
            <h3>Priority for all <UiExplain v-bind="explain('depth')" /></h3>
            <StudioValuePicker
              plane="priority"
              label="Priority for all"
              :value="single('priority')"
              :disabled="itemLocks.priority !== null"
              :title="itemLocks.priority ?? undefined"
              @pick="editing.setColour('priority', $event)"
            />
          </section>
          <section class="inspector__sec" data-role="picture-meta">
            <h3>Picture</h3>
            <p class="inspector__note" data-testid="picture-meta">{{ pictureMeta }}</p>
          </section>
        </template>
      </PixelInspector>
    </aside>

    <Teleport :disabled="!active || !inWorkspace" defer to="#workspace-status-left">
      <footer
        class="studio__status"
        aria-label="Status bar"
        @keydown="onKeydown"
        @keyup="onKeyup"
        @keypress.stop
        @click="keepFocus"
      >
        <span data-role="status" data-testid="studio-status">{{ status }}</span>
        <!-- A notice takes the hint's place, off the picture. -->
        <StudioStatusNotice
          v-if="editing.notice.value"
          :notice="editing.notice.value"
          @dismiss="editing.dismiss"
        />
        <span v-else class="studio__hint" data-testid="studio-hint" :data-tool="tools.tool.value">{{
          toolHint
        }}</span>
        <span class="studio__spacer"></span>
        <span v-if="!model.trusted" data-testid="studio-source-kind"
          >Rebuilt <UiExplain v-bind="explain('rebuilt')"
        /></span>
        <StudioZoom :zoom :fitted @zoom="(step) => (step === 'fit' ? zoomToFit() : zoomBy(step))" />
      </footer>
    </Teleport>
    <p class="studio__sr" aria-live="polite" data-role="announce">{{ input.spoken.value }}</p>

    <SharePictureMenu
      ref="shareMenu"
      bare
      :picture="model.compiled"
      :timeline="model.timeline"
      :profile
      :caption="shareCaption"
      :file-base="shareFile"
    />
    <StudioCombineDialog
      v-model:open="combineOpen"
      :count="editing.targets.value.length"
      :between="
        combineGap.between.map(
          (item) => model.rows.find((row) => row.id === item.id)?.display ?? item.label,
        )
      "
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
  container-type: inline-size;
  /* Rows: the meta strip, the tool and view options, the canvas (which takes
     what's left), the palette and draw order, then the status bar, which is
     28px and grows to fit its controls. The canvas keeps a floor because the
     side panel rides its row: below it the studio scrolls, like the phone
     layout, instead of squeezing the panel's list under a row. */
  grid-template-rows: minmax(40px, max-content) minmax(160px, 1fr) auto;
  grid-template-columns: 0 44px minmax(0, 1fr) clamp(140px, 30%, 260px);
  width: 100%;
  height: 100%;
  /* A window shorter than the fixed rows scrolls the studio; the sticky
     status bar stays in view and no control is clipped away. */
  overflow-x: hidden;
  overflow-y: auto;
  color: var(--ink);
  background: var(--surface-1);
  font: var(--text-sm) / var(--leading) var(--font-sans);
  outline: 0;
}
/* The rail stops above the palette row, which keeps the full width under it. */
.studio__rail {
  grid-row: 2;
  grid-column: 2;
}
/* The options bar docks over the rail and the canvas: nothing floats on the picture. */
.studio__options {
  position: relative;
  z-index: var(--z-dock);
  grid-row: 1;
  grid-column: 2 / 5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface-1);
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
.studio__status {
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
  overflow: hidden;
  /* Below a scrolled studio the status bar rides the bottom edge. */
  position: sticky;
  bottom: 0;
  z-index: 3;
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
.studio__trace-handle {
  display: grid;
  place-items: center;
  padding: 0;
  position: absolute;
  z-index: 2;
  width: 28px;
  height: 28px;
  border: 1px solid var(--action);
  border-radius: var(--radius);
  background: var(--surface-1);
  color: var(--action);
  touch-action: none;
}
.studio__trace-handle--move {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  cursor: move;
}
.studio__trace-handle--scale {
  right: 4px;
  bottom: 4px;
  cursor: nwse-resize;
}
.studio__palette-row {
  display: grid;
  min-width: 0;
}
.studio__side {
  container-type: inline-size;
  grid-column: 4;
  grid-row: 2 / 4;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border-left: 1px solid var(--hairline);
}
.studio__side > .ui-seg {
  flex-shrink: 0;
  margin: var(--space-2);
}
.studio__side > .scene-list,
.studio__side > .inspector {
  flex: 1;
  min-height: 0;
  height: 0;
}
.studio__side > .scene-list {
  flex: 2;
  min-height: 0;
  min-width: 0;
}
.studio__side > .scene-list :deep(.ui-panel__foot) {
  padding-block: var(--space-1);
}
.studio__side:has(.scene-list:not([style*="display: none"])) > .inspector.is-compact {
  display: none;
}
/* The Views list has the column to itself. */
.studio__side:has(.studio__views:not([style*="display: none"])) > .inspector {
  display: none;
}
@media (min-width: 601px) {
  @container (max-width: 760px) {
    .studio__palette-row :deep(.scrubber) {
      grid-template-columns: auto minmax(96px, 1fr);
    }
    .studio__palette-row :deep(.scrubber__label) {
      grid-column: 2;
      grid-row: 1;
    }
    .studio__palette-row :deep(.scrubber__track) {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }
}
@media (max-width: 600px) {
  .studio {
    grid-template-columns: 0 44px minmax(0, 1fr) 0;
    grid-template-rows: auto minmax(180px, 1fr) auto minmax(240px, 0.8fr);
  }
  .studio .studio__palette-row {
    grid-column: 1 / 4;
  }
  .studio .studio__palette-row :deep(.scrubber) {
    grid-template-columns: auto minmax(0, 1fr) minmax(64px, 100px);
    gap: var(--space-2);
    padding-inline: var(--space-2);
  }
  .studio .studio__side {
    grid-column: 2 / 4;
    grid-row: 4;
    border-top: 1px solid var(--hairline);
  }
  .studio .studio__side > .scene-list {
    flex: 1;
    height: 0;
    min-height: 0;
  }
  .studio .studio__side:has(.scene-list:not([style*="display: none"])) > .inspector {
    display: none;
  }
  .studio .studio__panes {
    padding: var(--space-1);
  }
}
@container (max-width: 232px) {
  .studio .studio__side :deep(.walk-panel__sec h3),
  .studio .studio__side :deep(.walk-panel__check) {
    flex-wrap: wrap;
  }
  .studio .studio__side :deep(.ui-seg) {
    max-width: 100%;
    box-sizing: border-box;
    flex-wrap: wrap;
  }
  .studio .studio__side :deep(.ui-panel__head) {
    flex-wrap: wrap;
    gap: var(--space-1);
    padding: var(--space-2);
  }
}
@container (max-width: 760px) {
  .studio .studio__status [data-role="status"] {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .studio .studio__status .studio__hint {
    display: none;
  }
}

.studio__views-slider {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.studio__views-slider input {
  width: 76px;
}
.studio__views-slider output {
  min-width: 3ch;
}
@media (max-height: 800px) {
  .studio :deep(.tool-rail__tool .ui-icon-btn) {
    width: var(--control-h-sm);
    height: var(--control-h-sm);
  }
}
</style>
