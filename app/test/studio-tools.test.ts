import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextTick, ref } from "vue";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { parsePictureDocument } from "../../src/studio/pictureDocument.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { testRevision } from "./identity.ts";
import type { PanePress } from "../src/studio/StudioCanvas.vue";
import { NO_UNLOCKS, type LensUnlocks } from "../src/studio/studioLocks.ts";
import {
  clickPath,
  defaultValues,
  dropLastPoint,
  extendStroke,
  finishPath,
  insertionPoint,
  newItemNames,
  pipetteValues,
  rectFrom,
  resolvePriority,
  startStroke,
  type PathDraft,
} from "../src/studio/studioTools.ts";
import type { StudioLens } from "../src/studio/studioView.ts";
import { useStudioDocument } from "../src/studio/useStudioDocument.ts";
import { useStudioDraft, type DraftOutcome } from "../src/studio/useStudioDraft.ts";
import { useStudioTools } from "../src/studio/useStudioTools.ts";

const p = (x: number, y: number) => ({ x, y });

describe("tool state machines", () => {
  it("clicks out a line: repeated clicks add nothing, two points finish it, Backspace drops one", () => {
    let line: PathDraft = { tool: "line", points: [] };
    line = clickPath(line, p(10, 10)).draft;
    assert.equal(finishPath(line), null, "one point is not a line yet");
    // A double-click's second press lands on the last point: nothing is added.
    line = clickPath(line, p(10, 10)).draft;
    assert.deepEqual(line.points, [p(10, 10)]);
    line = clickPath(line, p(40, 10)).draft;
    line = clickPath(line, p(40, 30)).draft;
    assert.deepEqual(finishPath(line), [p(10, 10), p(40, 10), p(40, 30)]);
    // A line never closes, even on its first point.
    const back = clickPath(line, p(10, 10));
    assert.equal(back.closed, false);
    assert.equal(back.draft.points.length, 4);
    assert.deepEqual(dropLastPoint(line).points, [p(10, 10), p(40, 10)]);
  });

  it("closes a polygon on its first point only once it has three", () => {
    let polygon: PathDraft = { tool: "polygon", points: [] };
    for (const point of [p(10, 10), p(40, 10)]) polygon = clickPath(polygon, point).draft;
    const early = clickPath(polygon, p(10, 10));
    assert.equal(early.closed, false);
    assert.equal(finishPath(polygon), null, "two points are not a polygon");
    polygon = clickPath(polygon, p(25, 30)).draft;
    const close = clickPath(polygon, p(10, 10));
    assert.equal(close.closed, true);
    assert.deepEqual(close.draft.points, [p(10, 10), p(40, 10), p(25, 30)], "no repeat of 10,10");
    assert.deepEqual(finishPath(close.draft), close.draft.points);
  });

  it("drags a rect with ordered, clamped corners; Shift makes it square on screen", () => {
    assert.deepEqual(rectFrom(p(30, 40), p(10, 20), false), { x1: 10, y1: 20, x2: 30, y2: 40 });
    assert.deepEqual(rectFrom(p(150, 160), p(170, 200), false), {
      x1: 150,
      y1: 160,
      x2: 159,
      y2: 167,
    });
    // 2:1 pixels: 10 columns span as much screen as 20 rows.
    assert.deepEqual(rectFrom(p(20, 20), p(30, 25), true), { x1: 20, y1: 20, x2: 30, y2: 40 });
    assert.deepEqual(rectFrom(p(50, 50), p(48, 20), true), { x1: 35, y1: 20, x2: 50, y2: 50 });
  });

  it("keeps one brush point per logical pixel and fills the gaps of a fast drag", () => {
    const stroke = startStroke(p(10, 10));
    assert.equal(extendStroke(stroke, p(13, 10)), true);
    assert.deepEqual(stroke.points, [p(10, 10), p(11, 10), p(12, 10), p(13, 10)]);
    // Back over the same pixels: nothing new.
    assert.equal(extendStroke(stroke, p(10, 10)), false);
    assert.equal(stroke.points.length, 4);
    assert.equal(extendStroke(stroke, p(10, 12)), true);
    assert.deepEqual(stroke.points.slice(4), [p(10, 11), p(10, 12)]);
    // Off the surface is skipped, not clamped.
    const edge = startStroke(p(159, 0));
    extendStroke(edge, p(162, 0));
    assert.deepEqual(edge.points, [p(159, 0)]);
  });

  it("picks values into the planes the lens leaves open", () => {
    const picked = { visual: 6, priority: 11 };
    assert.deepEqual(pipetteValues(defaultValues("art"), picked, "art", NO_UNLOCKS), {
      visual: 6,
      priority: null,
    });
    assert.deepEqual(pipetteValues(defaultValues("depth"), picked, "depth", NO_UNLOCKS), {
      visual: null,
      priority: 11,
    });
    // Walk keeps its control line while depth values are locked there.
    assert.deepEqual(pipetteValues(defaultValues("walk"), picked, "walk", NO_UNLOCKS), {
      visual: null,
      priority: 0,
    });
    assert.deepEqual(
      pipetteValues(defaultValues("walk"), { visual: 6, priority: 2 }, "walk", NO_UNLOCKS),
      { visual: null, priority: 2 },
    );
    const open: LensUnlocks = { visual: true, priority: true, depthInWalk: true };
    assert.deepEqual(pipetteValues(defaultValues("walk"), picked, "walk", open), picked);
    assert.deepEqual(pipetteValues(defaultValues("art"), picked, "art", open), picked);
  });

  it("follows the band under the cursor in the Depth lens, 10 without one", () => {
    const depth = defaultValues("depth");
    assert.equal(resolvePriority(depth, undefined), 10);
    assert.equal(resolvePriority(depth, 20), 4);
    assert.equal(resolvePriority(depth, 167), 14);
    assert.equal(resolvePriority(defaultValues("walk"), 100), 0);
    assert.equal(resolvePriority(defaultValues("art"), 100), null);
  });

  it("names new items by what they draw, numbered from the first free label", () => {
    const { document } = parsePictureDocument(
      ['# @item rect-1 "Rect 1" art', "vis 1", "rect 1,1 4,4", "# @end", "end"].join("\n"),
    );
    assert.deepEqual(newItemNames(document, "Rect", 4, null), {
      id: "rect-2",
      label: "Rect 2",
      kind: "art",
    });
    assert.deepEqual(newItemNames(document, "Line", null, 0), {
      id: "barrier-line-1",
      label: "Barrier line 1",
      kind: "walk",
    });
    assert.deepEqual(newItemNames(document, "Polygon", null, 10), {
      id: "depth-polygon-1",
      label: "Depth polygon 1",
      kind: "depth",
    });
    assert.equal(newItemNames(document, "Fill", 2, 9).kind, "mixed");
  });
});

/** A grey wall over a white floor, then a bench outline with its occluder: 8 commands and `end`. */
const SOURCE = [
  '# @item wall "Wall" art', //         1
  "vis 7", //                           2  command 0
  "rect 0,0 159,111", //                3  command 1
  "fill 80,40", //                      4  command 2
  "# @end", //                          5
  '# @item bench "Bench" art', //       6
  "vis 6", //                           7  command 3
  "rect 44,92 116,104", //              8  command 4
  "# @end", //                          9
  '# @item occ "Occluder" depth', //    10
  "vis off", //                         11 command 5
  "pri 10", //                          12 command 6
  "rect 40,90 119,105", //              13 command 7
  "# @end", //                          14
  "end", //                             15 end
].join("\n");

describe("insertionPoint", () => {
  const { document } = parsePictureDocument(SOURCE);
  const { spans } = compilePictureSource(SOURCE);
  const commands = spans.length - 1;

  it("inserts before the next command, before `end` at the end", () => {
    assert.deepEqual(insertionPoint(document, spans, commands, commands), {
      atLine: 15,
      index: 8,
    });
    assert.deepEqual(insertionPoint(document, spans, commands, 0), { atLine: 1, index: 0 });
    // At an item's first command: before its @item.
    assert.deepEqual(insertionPoint(document, spans, commands, 3), { atLine: 6, index: 3 });
  });

  it("never splits an item: inside one it goes after the item", () => {
    assert.deepEqual(insertionPoint(document, spans, commands, 4), { atLine: 10, index: 5 });
    assert.deepEqual(insertionPoint(document, spans, commands, 6), { atLine: 15, index: 8 });
  });
});

function setup(lens: StudioLens) {
  const lensRef = ref(lens);
  const unlocks = ref<LensUnlocks>(NO_UNLOCKS);
  const draft = useStudioDraft({
    base: { source: SOURCE, revision: testRevision("tools") },
    profile: DEFAULT_V2_PROFILE,
    lens: lensRef,
    unlocks,
  });
  const doc = useStudioDocument(() => ({
    source: draft.source.value,
    trusted: true,
    profile: DEFAULT_V2_PROFILE,
  }));
  const selectedId = ref<string>();
  const reports: DraftOutcome[] = [];
  const frames: (() => void)[] = [];
  const tools = useStudioTools({
    draft,
    doc,
    lens: lensRef,
    unlocks,
    selectedId,
    surface: () => doc.surface.value,
    report: (outcome) => reports.push(outcome),
    say: () => {},
    frozen: () => false,
    stage: () => null,
    frame: (callback) => frames.push(callback),
    cancelFrame: () => {},
  });
  const flush = () => frames.splice(0).forEach((callback) => callback());
  const press = (x: number, y: number, shiftKey = false): PanePress => ({
    event: { shiftKey, clientX: 0, clientY: 0 } as PointerEvent,
    cell: p(x, y),
    handle: undefined,
  });
  return { draft, doc, tools, selectedId, reports, flush, press, lens: lensRef };
}

const at = (x: number, y: number) => y * 160 + x;

describe("useStudioTools", () => {
  it("draws a filled rect in the Art lens as one undo step that leaves priority alone", () => {
    const { draft, tools, selectedId, flush, press } = setup("art");
    const before = draft.compiled.value;
    tools.setTool("rect");
    tools.filled.value = true;
    tools.setValues({ visual: 4 });
    tools.press(press(10, 120));
    tools.drag(press(12, 122));
    tools.drag(press(20, 130));
    flush();
    assert.equal(draft.gesturing.value, true);
    assert.ok(draft.preview.value, "the drag previews the real pixels");
    tools.release(press(20, 130));
    assert.equal(draft.history.value.past.length, 1, "one undo step");
    assert.equal(selectedId.value, "rect-1");
    const item = draft.document.value.items.find((i) => i.id === "rect-1");
    assert.deepEqual([item?.label, item?.kind], ["Rect 1", "art"]);
    const after = draft.compiled.value;
    assert.deepEqual(after.priority, before.priority);
    assert.equal(after.visual[at(15, 125)], 4);
    assert.equal(after.visual[at(20, 130)], 4);
    assert.equal(after.visual[at(21, 125)], before.visual[at(21, 125)]);
    assert.equal(draft.undo(), true);
    assert.equal(draft.source.value, SOURCE);
  });

  it("clicks out a barrier line in the Walk lens that never touches art", () => {
    const { draft, tools, flush, press } = setup("walk");
    const before = draft.compiled.value;
    tools.setTool("line");
    tools.press(press(10, 140));
    tools.press(press(60, 140));
    flush();
    assert.equal(draft.gesturing.value, true);
    tools.press(press(60, 140)); // the double-click's second press
    assert.equal(tools.finish(), true);
    assert.equal(draft.gesturing.value, false);
    assert.equal(draft.history.value.past.length, 1);
    const item = draft.document.value.items.at(-1)!;
    assert.deepEqual([item.label, item.kind], ["Barrier line 1", "walk"]);
    const after = draft.compiled.value;
    assert.deepEqual(after.visual, before.visual, "art is byte for byte the same");
    for (let x = 10; x <= 60; x++) assert.equal(after.priority[at(x, 140)], 0);
    assert.equal(after.priority[at(10, 141)], before.priority[at(10, 141)]);
  });

  it("draws a Depth rect on the priority plane only", () => {
    const { draft, tools, press } = setup("depth");
    const before = draft.compiled.value;
    tools.setTool("rect");
    tools.filled.value = true;
    tools.press(press(10, 150));
    tools.drag(press(30, 160));
    tools.release(press(30, 160));
    const after = draft.compiled.value;
    assert.deepEqual(after.visual, before.visual);
    // The band under the cursor at row 160 is 14.
    assert.equal(after.priority[at(20, 155)], 14);
    assert.equal(draft.document.value.items.at(-1)!.label, "Depth rect 1");
  });

  it("explains a fill that would flood nothing and inserts nothing; a white seed fills", () => {
    const { draft, tools, press } = setup("art");
    tools.setTool("fill");
    tools.setValues({ visual: 2 });
    tools.press(press(80, 50));
    assert.equal(draft.source.value, SOURCE, "grey (7) wall: nothing inserted");
    assert.equal(tools.fillWhy.value?.value, 7);
    assert.equal(tools.fillWhy.value?.plane, "visual");
    assert.equal(tools.fillWhy.value?.line, 4);
    tools.press(press(80, 140));
    assert.equal(tools.fillWhy.value, null);
    assert.equal(draft.compiled.value.visual[at(80, 140)], 2);
    assert.equal(draft.history.value.past.length, 1);
  });

  it("previews a fill's flood with a trial edit that changes nothing", () => {
    const { draft, tools, flush } = setup("art");
    tools.setTool("fill");
    tools.hover(p(80, 140));
    flush();
    const flood = tools.fillPreview.value!;
    assert.equal(flood[at(80, 140)], 1);
    assert.equal(flood[at(80, 50)], 0);
    assert.equal(draft.source.value, SOURCE);
    tools.hover(p(80, 50));
    flush();
    assert.equal(tools.fillPreview.value, null, "a grey seed floods nothing");
  });

  it("refuses a self-intersecting polygon and keeps its points to fix", () => {
    const { draft, tools, reports, press } = setup("art");
    tools.setTool("polygon");
    for (const [x, y] of [
      [10, 120],
      [40, 140],
      [40, 120],
      [10, 130],
    ] as const)
      tools.press(press(x, y));
    assert.equal(tools.finish(), true);
    const refusal = reports.at(-1);
    assert.equal(refusal?.ok, false);
    assert.ok(refusal && !refusal.ok);
    assert.equal(
      refusal.refusal.message,
      "A polygon's edges can't cross. Remove the last point or start again.",
    );
    assert.match(refusal.refusal.detail ?? "", /self-intersects/);
    assert.equal(draft.source.value, SOURCE);
    assert.equal(tools.path.value?.points.length, 4);
    // Backspace drops the crossing point; the first point closes the triangle.
    assert.equal(tools.backspace(), true);
    tools.press(press(10, 120));
    assert.equal(tools.path.value, null);
    assert.equal(draft.document.value.items.at(-1)!.label, "Polygon 1");
  });

  it("inserts at a mid playhead, at that draw-order position, and later commands still draw over it", async () => {
    const { draft, doc, tools, press, selectedId } = setup("art");
    doc.playhead.value = 3;
    tools.setTool("rect");
    tools.filled.value = true;
    tools.setValues({ visual: 1 });
    tools.press(press(50, 90));
    tools.drag(press(60, 100));
    tools.release(press(60, 100));
    assert.deepEqual(
      draft.document.value.items.map((item) => item.id),
      ["wall", "rect-1", "bench", "occ"],
    );
    assert.equal(selectedId.value, "rect-1");
    // The bench outline (colour 6) drawn later still shows over it.
    assert.equal(draft.compiled.value.visual[at(55, 92)], 6);
    assert.equal(draft.compiled.value.visual[at(55, 97)], 1);
    // The playhead stays just after the new item: the next insert follows it.
    await nextTick();
    const rect = draft.document.value.items[1]!;
    const commandsUpTo = draft.compiled.value.spans.filter((s) => s.line < rect.closeLine).length;
    assert.equal(doc.playhead.value, commandsUpTo);
  });

  it("picks the colour and priority under the cursor into the lens's values", () => {
    const { tools, press, lens } = setup("art");
    tools.setTool("pipette");
    tools.press(press(80, 92));
    assert.deepEqual(tools.current.value, { visual: 6, priority: null });
    lens.value = "depth";
    tools.press(press(80, 90));
    assert.deepEqual(tools.current.value, { visual: null, priority: 10 });
  });

  it("paints a brush stroke as one de-duplicated plot", () => {
    const { draft, tools, flush, press } = setup("art");
    tools.setTool("brush");
    tools.setValues({ visual: 12 });
    tools.press(press(10, 150));
    tools.drag(press(14, 150));
    tools.drag(press(10, 150));
    flush();
    tools.release(press(10, 150));
    const plot = draft.source.value.split("\n").find((line) => line.startsWith("plot"));
    assert.equal(plot, "plot 10,150 11,150 12,150 13,150 14,150");
    assert.equal(draft.history.value.past.length, 1);
  });
});
