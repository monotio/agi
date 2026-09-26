/**
 * Room Studio's tool rail at work on the canvas. Drawing tools insert a new
 * item where the draw-order playhead stands (studioTools.ts
 * `insertionPoint`), with the current values of the active lens, as ONE undo
 * step through the draft's kernel edit and lens locks: a rect or brush drag
 * and a clicked-out line or polygon are each one gesture whose preview
 * compiles at most once per animation frame. The fill tool checks the AGI
 * fill rule at the insertion point before it inserts, and previews the
 * flooded cells with a trial edit. The pipette picks values; the hand, or
 * Space held with any tool, pans. `pressAt`, `dragTo` and `settleDrag` are
 * the same gestures without a pointer (useStudioInput.ts's keyboard cursor).
 */

import { computed, reactive, shallowRef, watch, type Ref } from "vue";
import type { EditOperation } from "../../../src/studio/editOperations.ts";
import { whyNotFilled, type FillExplanation } from "../../../src/studio/pictureQuery.ts";
import type { Point } from "../../../src/studio/shapes.ts";
import { SCREEN_WIDTH } from "../../../src/types.ts";
import type { PanePress } from "./StudioCanvas.vue";
import type { LensUnlocks } from "./studioLocks.ts";
import {
  clickPath,
  defaultValues,
  dropLastPoint,
  extendStroke,
  finishPath,
  insertionPoint,
  isDrawingTool,
  newItemNames,
  pipetteValues,
  rectFrom,
  resolvePriority,
  startStroke,
  TOOL_NOUNS,
  type BrushStroke,
  type CurrentValues,
  type InsertionPoint,
  type PathDraft,
  type RectCorners,
  type StudioTool,
} from "./studioTools.ts";
import { maskFillPath, type StudioLens } from "./studioView.ts";
import type { StudioDocument } from "./useStudioDocument.ts";
import type { DraftOutcome, StudioDraft } from "./useStudioDraft.ts";
import type { StudioNotice } from "./useStudioEditing.ts";

export interface StudioToolsOptions {
  readonly draft: StudioDraft;
  readonly doc: StudioDocument;
  readonly lens: Ref<StudioLens>;
  readonly unlocks: Ref<LensUnlocks>;
  readonly selectedId: Ref<string | undefined>;
  /** The planes on screen, for the pipette. */
  readonly surface: () => { readonly visual: Uint8Array; readonly priority: Uint8Array };
  readonly report: (outcome: DraftOutcome) => void;
  readonly say: (notice: StudioNotice | null) => void;
  /** Editing is blocked: drawing tools do nothing. */
  readonly frozen: () => boolean;
  /** The scrolling stage the hand pans. */
  readonly stage: () => HTMLElement | null;
  readonly frame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

/** A shape's noun for the draw tools that make one. */
type DrawTool = keyof typeof TOOL_NOUNS;

export function useStudioTools(options: StudioToolsOptions) {
  const { draft, doc, lens, unlocks } = options;
  const frame = options.frame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));

  const tool = shallowRef<StudioTool>("select");
  /** Space is held: any tool pans. */
  const spaceHeld = shallowRef(false);
  /** Current values per lens, so each lens keeps its own. */
  const values = reactive<Record<StudioLens, CurrentValues>>({
    art: defaultValues("art"),
    depth: defaultValues("depth"),
    walk: defaultValues("walk"),
  });
  const current = computed(() => values[lens.value]);
  const filled = shallowRef(false);
  /** The brush pen: radius 0–7, and a stipple pattern from a seed 0–239. */
  const radius = shallowRef(0);
  const stipple = shallowRef(false);
  const seed = shallowRef(0);
  /** The logical cell under the pointer, while it is over a pane. */
  const cursor = shallowRef<Point | undefined>();

  const path = shallowRef<PathDraft | null>(null);
  const rect = shallowRef<{ start: Point; end: Point; square: boolean; moved: boolean } | null>(
    null,
  );
  const stroke = shallowRef<BrushStroke | null>(null);
  /** Bumped when the stroke grows, so views of it update. */
  const strokeSize = shallowRef(0);
  let pan: { x: number; y: number; left: number; top: number } | null = null;
  /** Why the last fill seed would flood nothing, shown inline until the next seed or tool. */
  const fillWhy = shallowRef<FillExplanation | null>(null);
  /** The cells a fill seeded under the cursor would change. */
  const fillPreview = shallowRef<Uint8Array | null>(null);

  /** Where the gesture in progress inserts; fixed for its life. */
  let at: InsertionPoint | null = null;
  let pending: number | null = null;
  let pendingOp: (() => EditOperation | null) | null = null;

  const insertion = computed(() => {
    const { model, total, playhead } = doc;
    return insertionPoint(
      model.value.document,
      model.value.compiled.spans,
      total.value,
      playhead.value,
    );
  });
  const drawing = computed(() => isDrawingTool(tool.value));
  /** Something is being drawn right now. */
  const busy = computed(() => path.value !== null || rect.value !== null || stroke.value !== null);

  /** The planes an insert draws with, the band taken at row `y` (the cursor's). */
  function planes(y: number | undefined): { visual: number | null; priority: number | null } {
    return { visual: current.value.visual, priority: resolvePriority(current.value, y) };
  }

  function names(noun: string, y: number | undefined) {
    const { visual, priority } = planes(y);
    return { visual, priority, ...newItemNames(draft.document.value, noun, visual, priority) };
  }

  function shapeOp(
    noun: DrawTool,
    y: number | undefined,
    shape:
      | ({ kind: "rect"; filled: boolean } & RectCorners)
      | { kind: "line" | "polygon"; filled: boolean; points: readonly Point[] },
  ): EditOperation {
    const { visual, priority, id, label, kind } = names(TOOL_NOUNS[noun], y);
    return {
      type: "insertShape",
      atLine: at!.atLine,
      shape: { ...shape, color: visual, priority },
      id,
      label,
      kind,
    };
  }

  function pathOp(draftPath: PathDraft, final: boolean): EditOperation | null {
    const points = final ? finishPath(draftPath) : draftPath.points;
    const min = draftPath.tool === "line" ? 2 : 3;
    if (!points || points.length < min) return null;
    return shapeOp(draftPath.tool, points.at(-1)!.y, {
      kind: draftPath.tool,
      filled: draftPath.tool === "polygon" && filled.value,
      points,
    });
  }

  function rectOp(): EditOperation | null {
    const r = rect.value;
    if (!r?.moved) return null;
    return shapeOp("rect", r.end.y, {
      kind: "rect",
      filled: filled.value,
      ...rectFrom(r.start, r.end, r.square),
    });
  }

  function brushOp(): EditOperation | null {
    const s = stroke.value;
    if (!s) return null;
    const { visual, priority, id, label } = names(TOOL_NOUNS.brush, s.points.at(-1)!.y);
    return {
      type: "insertPlot",
      atLine: at!.atLine,
      pen: { radius: radius.value, stipple: stipple.value },
      points: s.points.slice(),
      ...(stipple.value ? { seed: seed.value } : {}),
      visual,
      priority,
      id,
      label,
    };
  }

  function stopFrame(): void {
    if (pending !== null) cancelFrame(pending);
    pending = null;
    pendingOp = null;
  }

  /** Preview the gesture's candidate on the next frame; a burst of calls costs one kernel run. */
  function preview(op: () => EditOperation | null): void {
    pendingOp = op;
    pending ??= frame(() => {
      pending = null;
      const next = pendingOp?.();
      pendingOp = null;
      if (next && draft.gesturing.value) options.report(draft.moveGesture(next));
    });
  }

  /** Drawing is blocked (view only, or a Keep that needs a reload): say so. */
  function blocked(): boolean {
    if (!options.frozen()) return false;
    options.say({ tone: "warn", text: "This picture is view only: nothing can be drawn." });
    return true;
  }

  function begin(noun: string): boolean {
    if (blocked()) return false;
    if (!draft.gesturing.value) {
      at = insertion.value;
      draft.beginGesture(`Draw ${noun}`);
    }
    return true;
  }

  /** Close the gesture with `op`; on success the new item is selected where it was drawn. */
  function end(op: EditOperation | null, noun: string): boolean {
    stopFrame();
    const inserted = op && "id" in op ? op.id : undefined;
    const drawnAt = at;
    const before = doc.total.value;
    const outcome = draft.endGesture(op, `Draw ${noun}`);
    at = null;
    options.report(outcome);
    if (!outcome.ok || inserted === undefined || drawnAt === null) return false;
    settle(inserted, drawnAt, before);
    return true;
  }

  /**
   * After an insert: select the new item, and when it went in the middle of
   * the draw order keep the playhead just after it, so the next one follows.
   */
  function settle(id: string, drawnAt: InsertionPoint, commandsBefore: number): void {
    options.selectedId.value = id;
    if (drawnAt.index >= commandsBefore) return;
    const item = draft.document.value.items.find((candidate) => candidate.id === id);
    if (!item) return;
    const upTo = draft.compiled.value.spans.filter((span) => span.line < item.closeLine);
    doc.holdPlayhead(upTo.length);
  }

  /** Esc: abandon what is being drawn. Returns whether anything was. */
  function cancel(): boolean {
    // Only the tools' own gesture: a Select drag is the drag composable's to abort.
    const was = busy.value || at !== null;
    stopFrame();
    if (at !== null && draft.gesturing.value) draft.cancelGesture();
    at = null;
    path.value = null;
    rect.value = null;
    stroke.value = null;
    pan = null;
    return was;
  }

  function finish(): boolean {
    const p = path.value;
    if (!p) return false;
    if (!finishPath(p)) {
      options.say({
        tone: "warn",
        text:
          p.tool === "line"
            ? "A line needs two points or more."
            : "A polygon needs three points or more.",
      });
      return true;
    }
    if (!draft.gesturing.value && !begin(TOOL_NOUNS[p.tool])) return true;
    // A refused path stays on the canvas to be fixed (Backspace) or abandoned (Esc).
    if (end(pathOp(p, true), TOOL_NOUNS[p.tool])) path.value = null;
    return true;
  }

  function backspace(): boolean {
    const p = path.value;
    if (!p) return false;
    const next = dropLastPoint(p);
    path.value = next.points.length === 0 ? null : next;
    if (!path.value) cancel();
    else if (draft.gesturing.value) {
      const op = pathOp(next, false);
      if (op) preview(() => op);
      else draft.preview.value = null;
    }
    return true;
  }

  function setTool(next: StudioTool): void {
    if (next === tool.value) return;
    cancel();
    fillWhy.value = null;
    fillPreview.value = null;
    tool.value = next;
  }

  function pickAt({ x, y }: Point): void {
    const planesNow = options.surface();
    const i = y * SCREEN_WIDTH + x;
    const picked = { visual: planesNow.visual[i]!, priority: planesNow.priority[i]! };
    values[lens.value] = pipetteValues(current.value, picked, lens.value, unlocks.value);
    options.say({
      tone: "ok",
      text: `Picked colour ${picked.visual} and priority ${picked.priority} at ${x},${y}.`,
    });
  }

  /** The fill tool's op for a seed, and why it would flood nothing there (at the insertion point). */
  function fillAt(seed: Point): {
    op: Extract<EditOperation, { type: "insertFill" }>;
    where: InsertionPoint;
    why: FillExplanation | undefined;
  } {
    const where = insertion.value;
    const { visual, priority, id, label } = names(TOOL_NOUNS.fill, seed.y);
    const plane = visual !== null ? "visual" : "priority";
    const why = whyNotFilled(doc.compiledAt(where.index), seed.x, seed.y, plane);
    return {
      op: {
        type: "insertFill",
        atLine: where.atLine,
        x: seed.x,
        y: seed.y,
        visual,
        priority,
        id,
        label,
      },
      where,
      why: why && !why.fillable ? why : undefined,
    };
  }

  /** Seed a fill: nothing is inserted where AGI's fill rule says it would flood nothing. */
  function fill(seed: Point): void {
    fillPreview.value = null;
    if (blocked()) return;
    const { op, where, why } = fillAt(seed);
    fillWhy.value = why ?? null;
    if (why) return;
    const before = doc.total.value;
    const outcome = draft.apply(op, `Draw ${TOOL_NOUNS.fill}`);
    options.report(outcome);
    if (outcome.ok) settle(op.id, where, before);
  }

  /** The trial fill under the cursor: the cells it would change, computed once per frame. */
  let fillFrame: number | null = null;
  let fillKey = "";
  function previewFill(cell: Point | undefined): void {
    if (tool.value !== "fill" || !cell || options.frozen()) {
      fillPreview.value = null;
      return;
    }
    const key = `${cell.x},${cell.y}:${current.value.visual}:${current.value.priority}:${insertion.value.atLine}:${draft.source.value.length}`;
    if (key === fillKey) return;
    fillKey = key;
    if (fillFrame !== null) cancelFrame(fillFrame);
    fillFrame = frame(() => {
      fillFrame = null;
      const { op, why } = fillAt(cell);
      if (why) return void (fillPreview.value = null);
      const candidate = draft.evaluate(op);
      if ("kind" in candidate) return void (fillPreview.value = null);
      const before = draft.compiled.value;
      const after = candidate.compiled;
      const mask = new Uint8Array(before.visual.length);
      for (let i = 0; i < mask.length; i++)
        if (before.visual[i] !== after.visual[i] || before.priority[i] !== after.priority[i])
          mask[i] = 1;
      fillPreview.value = mask;
    });
  }

  function hover(cell: Point | undefined): void {
    cursor.value = cell;
    previewFill(cell);
  }

  const panning = computed(() => spaceHeld.value || tool.value === "hand");

  /** A press the tools take; false leaves it to selection and dragging. */
  function press({ event, cell }: PanePress): boolean {
    if (!panning.value) return pressAt(cell, event.shiftKey);
    const stage = options.stage();
    if (stage)
      pan = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    return true;
  }

  /** The active tool's press at `cell` (a rect from it is `square`); false for Select and Point. */
  function pressAt(cell: Point, square: boolean): boolean {
    switch (tool.value) {
      case "select":
      case "point":
        return false;
      case "pipette":
        pickAt(cell);
        return true;
      case "fill":
        fill(cell);
        return true;
      case "rect":
        if (!begin(TOOL_NOUNS.rect)) return true;
        rect.value = { start: cell, end: cell, square, moved: false };
        return true;
      case "brush":
        if (!begin(TOOL_NOUNS.brush)) return true;
        stroke.value = startStroke(cell);
        strokeSize.value = 1;
        preview(brushOp);
        return true;
      case "line":
      case "polygon": {
        const draftPath = path.value?.tool === tool.value ? path.value : null;
        const click = clickPath(draftPath ?? { tool: tool.value, points: [] }, cell);
        if (click.closed) {
          finish();
          return true;
        }
        if (!begin(TOOL_NOUNS[tool.value])) return true;
        path.value = click.draft;
        const op = pathOp(click.draft, false);
        if (op) preview(() => op);
        return true;
      }
      case "hand":
        return true;
    }
  }

  function drag({ event, cell }: PanePress): void {
    if (pan) {
      const stage = options.stage();
      if (!stage) return;
      stage.scrollLeft = pan.left - (event.clientX - pan.x);
      stage.scrollTop = pan.top - (event.clientY - pan.y);
      return;
    }
    dragTo(cell, event.shiftKey);
  }

  /** A rect's corner or the brush's pen moves to `cell`. */
  function dragTo(cell: Point, square: boolean): void {
    const r = rect.value;
    if (r) {
      const moved = r.moved || cell.x !== r.start.x || cell.y !== r.start.y;
      rect.value = { ...r, end: cell, square, moved };
      if (moved) preview(rectOp);
      return;
    }
    const s = stroke.value;
    if (s && extendStroke(s, cell)) {
      strokeSize.value = s.points.length;
      preview(brushOp);
    }
  }

  function release(pressed: PanePress): void {
    if (pan) {
      pan = null;
      return;
    }
    if (rect.value) drag(pressed);
    settleDrag();
  }

  /** The rect or brush stroke in progress is done: insert it. */
  function settleDrag(): void {
    if (rect.value) {
      const op = rectOp();
      rect.value = null;
      end(op, TOOL_NOUNS.rect);
      return;
    }
    if (stroke.value) {
      const op = brushOp();
      stroke.value = null;
      end(op, TOOL_NOUNS.brush);
    }
  }

  /** The pointer was taken away mid-drag: a rect or stroke is abandoned; a path waits. */
  function abort(): void {
    pan = null;
    if (rect.value || stroke.value) cancel();
  }

  // A lens change or a frozen draft ends what was being drawn with the old values.
  watch([lens, options.frozen], () => cancel());
  // The picture changed under the fill tool's explanation (undo, Keep): it no longer holds.
  watch(
    () => draft.source.value,
    () => (fillWhy.value = null),
  );

  function setValues(patch: Partial<CurrentValues>): void {
    values[lens.value] = { ...current.value, ...patch };
  }

  /** StudioToolOverlay's props: the path, the dragged rect and the fill's flood. */
  const overlay = computed(() => {
    const r = rect.value;
    const p = path.value;
    return {
      points: p?.points ?? [],
      polygon: p?.tool === "polygon",
      cursor: cursor.value,
      rect: r?.moved ? rectFrom(r.start, r.end, r.square) : null,
      flood: fillPreview.value ? maskFillPath(fillPreview.value) : "",
    };
  });

  return {
    tool,
    setTool,
    spaceHeld,
    panning,
    values,
    current,
    setValues,
    filled,
    radius,
    stipple,
    seed,
    cursor,
    path,
    rect,
    stroke,
    strokeSize,
    fillWhy,
    fillPreview,
    overlay,
    insertion,
    drawing,
    busy,
    press,
    pressAt,
    drag,
    dragTo,
    release,
    settleDrag,
    abort,
    hover,
    finish,
    cancel,
    backspace,
  };
}

export type StudioTools = ReturnType<typeof useStudioTools>;
