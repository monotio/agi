import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resourceOptions,
  roomOptions,
  roomPictureNumber,
} from "../src/studio/logic/guided/guidedPreview.ts";

/**
 * The picker helpers read JSON documents while an author is still editing
 * them. Every shape JSON.parse can produce — null, arrays, primitives, and
 * entries whose fields are missing or mistyped — must leave the lists useful
 * and truthful instead of throwing or inventing labels.
 */

test("world rooms that are not a record leave plain room labels", () => {
  const docs = { "logic:1": "return();", "logic:2": "return();" };
  for (const world of [
    '{"rooms":null}',
    '{"rooms":[]}',
    '{"rooms":"two"}',
    '{"rooms":4}',
    "null",
    "[]",
    '"rooms"',
    "{",
    "{}",
  ]) {
    assert.deepEqual(roomOptions(docs, world), [
      { value: 1, label: "Room 1" },
      { value: 2, label: "Room 2" },
    ]);
  }
});

test("a world room entry of the wrong shape never invents a title", () => {
  const docs = { "logic:1": "return();" };
  for (const world of [
    '{"rooms":{"1":null}}',
    '{"rooms":{"1":"Grove"}}',
    '{"rooms":{"1":7}}',
    '{"rooms":{"1":true}}',
    '{"rooms":{"1":{"title":5}}}',
    '{"rooms":{"1":{"title":null}}}',
    '{"rooms":{"1":{}}}',
  ]) {
    assert.deepEqual(roomOptions(docs, world), [{ value: 1, label: "Room 1" }]);
  }
});

test("valid world titles still label their rooms beside malformed siblings", () => {
  const docs = { "logic:1": "return();", "logic:2": "return();" };
  assert.deepEqual(roomOptions(docs, '{"rooms":{"1":{"title":"Grove"},"2":null}}'), [
    { value: 1, label: "Room 1 · Grove" },
    { value: 2, label: "Room 2" },
  ]);
});

test("binding entries that are not objects of kind + integer num are skipped", () => {
  const docs = { "view:1": new Uint8Array(), "view:2": new Uint8Array() };
  const bindings =
    '{"ego_view":{"kind":"view","num":1},"hero":null,"odd":4,"arr":[],"mis":{"kind":"view"},"str":{"kind":"view","num":"2"},"flt":{"kind":"view","num":2.5}}';
  assert.deepEqual(resourceOptions(docs, bindings, "view"), [
    { value: 1, label: "VIEW 1 · ego_view" },
    { value: 2, label: "VIEW 2" },
  ]);
});

test("a picture binding of the wrong shape resolves to no preview", () => {
  const source = "assignn(v20, room_picture);\ndraw.pic(v20);";
  for (const bindings of [
    '{"room_picture":null}',
    '{"room_picture":"pic"}',
    '{"room_picture":{"kind":"picture"}}',
    '{"room_picture":{"kind":"picture","num":"2"}}',
    '{"room_picture":{"kind":"sound","num":2}}',
    '{"room_picture":[]}',
  ]) {
    assert.equal(roomPictureNumber(source, bindings), null);
  }
});

test("a complete picture binding still resolves its number", () => {
  const source = "assignn(v20, room_picture);\ndraw.pic(v20);";
  assert.equal(roomPictureNumber(source, '{"room_picture":{"kind":"picture","num":3}}'), 3);
  assert.equal(roomPictureNumber("assignn(v20, 4);\ndraw.pic(v20);", undefined), 4);
  assert.equal(
    roomPictureNumber(
      "assignn(pic_num, 2);\nload.pic(pic_num);\ndraw.pic(pic_num);",
      '{"pic_num":{"kind":"variable","num":32}}',
    ),
    2,
  );
  assert.equal(
    roomPictureNumber(
      "assignn(pic_num, forest_pic);\nload.pic(pic_num);\ndraw.pic(pic_num);",
      '{"pic_num":{"kind":"variable","num":32},"forest_pic":{"kind":"picture","num":5}}',
    ),
    5,
  );
});
