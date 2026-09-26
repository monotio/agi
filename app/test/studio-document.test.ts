import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePictureSource } from "../../src/picture/source.ts";
import { DEFAULT_V2_PROFILE as profile } from "../../src/runtime/profile.ts";
import { itemMask, renderUpTo } from "../../src/studio/pictureQuery.ts";
import { SCREEN_WIDTH } from "../../src/types.ts";
import { DEMO_OCCLUDER, DEMO_PICTURE_SOURCE } from "../src/studio/demoPicture.ts";
import { maskBox } from "../src/studio/studioView.ts";
import {
  buildStudioModel,
  filterScene,
  groupLabel,
  UNASSIGNED,
  useStudioDocument,
} from "../src/studio/useStudioDocument.ts";

const text = (...lines: string[]): string => `${lines.join("\n")}\n`;
const bytesOf = (source: string): Uint8Array => compilePictureSource(source, { profile }).bytes;
const at = (x: number, y: number): number => y * SCREEN_WIDTH + x;

/** Timeline: 0 vis 4, 1 line, 2 vis off, 3 pri 10, 4 line, 5 vis 2, 6 line, 7 end (draws nothing). */
const SMALL = text(
  '# @item a "Red line" art',
  "vis 4",
  "line 0,0 3,0",
  "# @end",
  '# @item d "Occluder" depth',
  "vis off",
  "pri 10",
  "line 0,1 3,1",
  "# @end",
  "vis 2",
  "line 0,2 1,2",
  "end",
);

test("authored text is used only while it compiles to the exact bytes", () => {
  const bytes = bytesOf(SMALL);
  const trusted = buildStudioModel({ bytes, authoredSource: SMALL, profile });
  assert.equal(trusted.trusted, true);
  assert.equal(trusted.source, SMALL);

  const stale = SMALL.replace("line 0,2 1,2", "line 0,2 2,2");
  const fallback = buildStudioModel({ bytes, authoredSource: stale, profile });
  assert.equal(fallback.trusted, false);
  // The disassembly's lines all touch, so native grouping makes one mixed element.
  assert.match(fallback.source, /^# @item el-1 "Element 1" mixed$/m);
  assert.doesNotMatch(fallback.source, /Red line/);
  assert.deepEqual(fallback.compiled.bytes, bytes);

  const broken = buildStudioModel({ bytes, authoredSource: "vis 99\n", profile });
  assert.equal(broken.trusted, false);
});

test("rows: items in draw order, then loose lines as Unassigned, without the closing end", () => {
  const model = buildStudioModel({ bytes: bytesOf(SMALL), authoredSource: SMALL, profile });
  assert.equal(model.timeline.length, 8);
  assert.equal(model.commands, 7);
  const summary = model.rows.map(({ id, kind, entries, swatch, value, tag }) => ({
    id,
    kind,
    entries,
    swatch,
    value,
    tag,
  }));
  assert.deepEqual(summary, [
    { id: "a", kind: "art", entries: [0, 1], swatch: 4, value: 4, tag: "art" },
    { id: "d", kind: "depth", entries: [2, 3, 4], swatch: 10, value: 10, tag: "pri 10" },
    { id: UNASSIGNED, kind: "loose", entries: [5, 6], swatch: 2, value: 2, tag: "loose" },
  ]);
  // Two unlike items: no groups, and Unassigned stays out of the branches.
  assert.deepEqual(
    model.branches.map(({ group, rows }) => [group?.id ?? null, rows.map((row) => row.id)]),
    [
      [null, ["a"]],
      [null, ["d"]],
    ],
  );
});

/**
 * Three brown lines, a black one, two more brown lines and a band-9 depth
 * pair, each its own item. Timeline: 0 vis 6, 1-3 the brown lines, 4 vis 0,
 * 5 ink, 6 vis 6, 7-8 brown, 9 vis off, 10 pri 9, 11-12 steps, 13 end.
 */
const GROUPED = text(
  '# @item b1 "Box 1" art',
  "vis 6",
  "line 10,10 20,10",
  "# @end",
  '# @item b2 "Box 2" art',
  "line 10,20 20,20",
  "# @end",
  '# @item b3 "Box 3" art',
  "line 10,30 20,30",
  "# @end",
  '# @item k "Ink" art',
  "vis 0",
  "line 30,10 30,40",
  "# @end",
  '# @item b4 "Box 4" art',
  "vis 6",
  "line 40,10 50,10",
  "# @end",
  '# @item b5 "Box 5" art',
  "line 40,20 50,20",
  "# @end",
  '# @item p1 "Step 1" depth',
  "vis off",
  "pri 9",
  "line 60,10 70,10",
  "# @end",
  '# @item p2 "Step 2" depth',
  "line 60,20 70,20",
  "# @end",
  "end",
);

test("branches fold consecutive items of one kind and dominant value into groups", () => {
  const model = buildStudioModel({ bytes: bytesOf(GROUPED), authoredSource: GROUPED, profile });
  assert.deepEqual(
    model.branches.map(({ group, rows }) => [group?.label ?? null, rows.map((row) => row.id)]),
    [
      ["Brown art · 3", ["b1", "b2", "b3"]],
      [null, ["k"]],
      ["Brown art · 2", ["b4", "b5"]],
      ["Band 9 depth · 2", ["p1", "p2"]],
    ],
  );
  const [first] = model.groups;
  // Box 1 is vis 6 and a line (entries 0, 1); boxes 2 and 3 a line each.
  assert.deepEqual(first!.entries, [0, 1, 2, 3]);
  assert.deepEqual(first!.members, ["b1", "b2", "b3"]);
  assert.equal(first!.id, "(group)b1");
  assert.deepEqual(
    model.groups.map((group) => group.tag),
    ["art", "art", "pri 9"],
  );
});

test("the filter matches an item's own text or its group's label, flat", () => {
  const model = buildStudioModel({ bytes: bytesOf(GROUPED), authoredSource: GROUPED, profile });
  const ids = (rows: readonly { id: string }[] | null) => rows?.map((row) => row.id) ?? null;
  const all = filterScene(model, "  ");
  assert.equal(all.matches, null);
  assert.deepEqual(ids(all.steps), ["b1", "b2", "b3", "k", "b4", "b5", "p1", "p2"]);
  assert.deepEqual(ids(filterScene(model, "BROWN").matches), ["b1", "b2", "b3", "b4", "b5"]);
  assert.deepEqual(ids(filterScene(model, "ink").matches), ["k"]);
  assert.deepEqual(ids(filterScene(model, "band 9").steps), ["p1", "p2"]);
});

test("a list of more than 60 rows folds into draw-order sections", () => {
  // 70 single-line items alternating blue and green: 70 rows, no groups.
  const source = text(
    ...Array.from({ length: 70 }, (_, k) => [
      `# @item i${k} "Item ${k}" art`,
      `vis ${1 + (k % 2)}`,
      `line ${2 * k},0 ${2 * k},5`,
      "# @end",
    ]).flat(),
    "end",
  );
  const model = buildStudioModel({ bytes: bytesOf(source), authoredSource: source, profile });
  assert.equal(model.branches.length, 70);
  assert.equal(model.groups.length, 0);
  // Each row weighs 2 commands (vis, line): 140 in 36 shares of 3.89, so
  // the first section closes after two rows, at steps 1-4.
  assert.equal(model.sections.length, 36);
  const [first] = model.sections;
  assert.equal(first!.id, "(section)i0");
  assert.equal(first!.label, "Steps 1–4");
  assert.deepEqual(first!.members, ["i0", "i1"]);
  assert.deepEqual(first!.swatches, [1, 2]);
  assert.equal(model.sections.at(-1)!.label.endsWith("–140"), true);
  assert.deepEqual(
    model.sections.flatMap((section) => section.members),
    model.rows.map((row) => row.id),
  );
  // The section's highlight is both lines.
  const doc = useStudioDocument({ bytes: bytesOf(source), authoredSource: source, profile });
  assert.deepEqual(maskBox(doc.rowMask("(section)i0", "art")), { x: 0, y: 0, width: 3, height: 6 });
  // Short lists get none.
  assert.deepEqual(
    buildStudioModel({ bytes: bytesOf(GROUPED), authoredSource: GROUPED, profile }).sections,
    [],
  );
});

test("group labels name the colour, the priority meaning or a covered run", () => {
  assert.equal(groupLabel("art", 6, 12), "Brown art · 12");
  assert.equal(groupLabel("mixed", 7, 2), "Light grey mixed · 2");
  assert.equal(groupLabel("depth", 9, 4), "Band 9 depth · 4");
  assert.equal(groupLabel("walk", 0, 3), "Barrier walk · 3");
  assert.equal(groupLabel("art", null, 2), "Covered art · 2");
});

test("a group's highlight is the union of its members' masks", () => {
  const doc = useStudioDocument({ bytes: bytesOf(GROUPED), authoredSource: GROUPED, profile });
  const union = doc.rowMask("(group)b1", "art");
  const cells: number[] = [];
  union.forEach((bit, i) => bit === 1 && cells.push(i));
  const expected: number[] = [];
  for (const y of [10, 20, 30]) for (let x = 10; x <= 20; x++) expected.push(at(x, y));
  // The ink line at x 30 is not a member.
  assert.deepEqual(cells, expected);
});

test("the demo picture's rows and occluder mask match its hand-placed shapes", () => {
  const model = buildStudioModel({
    bytes: bytesOf(DEMO_PICTURE_SOURCE),
    authoredSource: DEMO_PICTURE_SOURCE,
    profile,
  });
  assert.deepEqual(
    model.rows.map((row) => `${row.id}:${row.tag}`),
    [
      "floor:art",
      "wall:art",
      "bench:art",
      "lamp:art",
      "bench-occluder:pri 10",
      "floor-edge:barrier",
      "gate:conditional",
      "south-exit:signal",
      "pond:mixed",
    ],
  );
  const { x1, y1, x2, y2 } = DEMO_OCCLUDER;
  assert.deepEqual(
    maskBox(itemMask(model.compiled, model.document, "bench-occluder", "priority")),
    { x: x1, y: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 },
  );
});

test("the playhead shows renderUpTo and the pixel owners at that point", () => {
  const doc = useStudioDocument({ bytes: bytesOf(SMALL), authoredSource: SMALL, profile });
  // Seven drawing commands; the closing end is not one.
  assert.equal(doc.total.value, 7);
  assert.equal(doc.playhead.value, 7);

  const done = doc.pixelInfo(1, 1);
  assert.deepEqual(done.priority, {
    value: 10,
    entry: 4,
    line: 8,
    text: "line 0,1 3,1",
    rowId: "d",
  });
  assert.deepEqual(done.visual, {
    value: 15,
    entry: null,
    line: null,
    text: null,
    rowId: undefined,
  });
  assert.equal(doc.rowAt(1, 2, "visual"), UNASSIGNED);
  // The Art lens reads the visual plane first, then falls back to priority.
  assert.equal(doc.rowAtForLens(1, 1, "art"), "d");
  assert.equal(doc.rowAtForLens(1, 0, "depth"), "a");

  doc.playhead.value = 2; // vis 4 and the first line
  const partial = renderUpTo(doc.model.value.compiled, 2, profile);
  assert.deepEqual(doc.surface.value.visual, partial.visual);
  assert.equal(doc.surface.value.visual[at(0, 0)], 4);
  assert.equal(doc.surface.value.priority[at(1, 1)], 4);
  assert.equal(doc.pixelInfo(1, 1).priority.rowId, undefined);
  assert.equal(doc.pixelInfo(1, 0).visual.entry, 1);
});

test("row masks: Unassigned uses the loose lines' pixels", () => {
  const doc = useStudioDocument({ bytes: bytesOf(SMALL), authoredSource: SMALL, profile });
  assert.deepEqual(maskBox(doc.rowMask(UNASSIGNED, "art")), { x: 0, y: 2, width: 2, height: 1 });
  assert.deepEqual(maskBox(doc.rowMask("d", "art")), { x: 0, y: 1, width: 4, height: 1 });
  doc.playhead.value = 3;
  assert.equal(maskBox(doc.rowMask("d", "art")), null);
});

test("a clicked pixel explains the fill at the playhead, and nothing else", () => {
  // Timeline: 0 vis 1, 1 line, 2 vis 6, 3 fill, 4 end. Native grouping wraps
  // the four drawing lines in an item, so the line command is document line 3.
  const source = text("vis 1", "line 0,5 159,5", "vis 6", "fill 0,0", "end");
  const doc = useStudioDocument({ bytes: bytesOf(source), authoredSource: source, profile });
  const onLine = doc.explainFill(3, 10, 5)!;
  assert.equal(onLine.plane, "visual");
  assert.equal(onLine.value, 1);
  assert.equal(onLine.line, 3);
  assert.equal(onLine.fillable, false);
  // Below the line the fill never reached: still white, so fillable.
  assert.equal(doc.explainFill(3, 10, 6)!.fillable, true);
  assert.equal(doc.explainFill(1, 10, 5), undefined);
});
