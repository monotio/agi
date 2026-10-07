import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdit } from "../src/studio/editOperations.ts";
import { parsePictureDocument } from "../src/studio/pictureDocument.ts";
import { linePoints } from "../src/studio/editPoints.ts";
const document = (command: string) =>
  parsePictureDocument(`# @item path "Path" art\nvis 3\n${command}\n# @end\nend`).document;
const remove = (command: string, pointIndex: number) =>
  applyEdit(document(command), { type: "removePoint", itemId: "path", line: 3, pointIndex });
test("removing a middle vertex joins its neighbours and preserves other vertices", () => {
  const result = remove("line 10,10 20,20 30,10", 1);
  assert.ok(!("error" in result));
  assert.deepEqual(linePoints(result.document.lines[2]!), [
    { x: 10, y: 10 },
    { x: 30, y: 10 },
  ]);
});
test("removing from a two-point line deletes the item", () => {
  const result = remove("line 10,10 20,20", 0);
  assert.ok(!("error" in result));
  assert.equal(result.document.items.length, 0);
});
test("relative lines retain absolute positions after removing a vertex", () => {
  const result = remove("rel 10,10 2,2 3,3", 1);
  assert.ok(!("error" in result));
  assert.deepEqual(linePoints(result.document.lines[2]!), [
    { x: 10, y: 10 },
    { x: 15, y: 15 },
  ]);
});
test("removing a locked point or an unknown point is refused", () => {
  assert.ok("error" in remove("line 10,10 20,20", 4));
  const locked = parsePictureDocument(
    '# @item path "Path" art locked\nvis 3\nline 10,10 20,20\n# @end\nend',
  ).document;
  assert.ok(
    "error" in applyEdit(locked, { type: "removePoint", itemId: "path", line: 3, pointIndex: 0 }),
  );
});
test("removing a short line keeps the item's other lines", () => {
  const doc = document("line 10,10 20,20\nline 30,30 40,40");
  const result = applyEdit(doc, { type: "removePoint", itemId: "path", line: 3, pointIndex: 0 });
  assert.ok(!("error" in result));
  assert.equal(result.document.items.length, 1);
  assert.ok(result.document.lines.includes("line 30,30 40,40"));
});
test("point removal keeps indentation and inline notes", () => {
  const result = remove("  line 10,10 20,20 30,10 # ridge", 1);
  assert.ok(!("error" in result));
  assert.equal(result.document.lines[2], "  line 10,10 30,10 # ridge");
});
