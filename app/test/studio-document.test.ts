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
  UNASSIGNED,
  useStudioDocument,
} from "../src/studio/useStudioDocument.ts";

const text = (...lines: string[]): string => `${lines.join("\n")}\n`;
const bytesOf = (source: string): Uint8Array => compilePictureSource(source, { profile }).bytes;
const at = (x: number, y: number): number => y * SCREEN_WIDTH + x;

/** Timeline: 0 vis 4, 1 line, 2 vis off, 3 pri 10, 4 line, 5 vis 2, 6 line, 7 end. */
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

test("rows: items in draw order, then loose lines as Unassigned", () => {
  const model = buildStudioModel({ bytes: bytesOf(SMALL), authoredSource: SMALL, profile });
  const summary = model.rows.map(({ id, kind, entries, swatch, tag }) => ({
    id,
    kind,
    entries,
    swatch,
    tag,
  }));
  assert.deepEqual(summary, [
    { id: "a", kind: "art", entries: [0, 1], swatch: 4, tag: "art" },
    { id: "d", kind: "depth", entries: [2, 3, 4], swatch: 10, tag: "pri 10" },
    { id: UNASSIGNED, kind: "loose", entries: [5, 6, 7], swatch: 2, tag: "loose" },
  ]);
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
      `${UNASSIGNED}:loose`,
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
  assert.equal(doc.total.value, 8);
  assert.equal(doc.playhead.value, 8);

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
