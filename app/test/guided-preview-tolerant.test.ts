import assert from "node:assert/strict";
import { test } from "node:test";
import { roomPictureNumber } from "../src/studio/logic/guided/guidedPreview.ts";

/**
 * The preview helper reads JSON documents while an author is still editing
 * them. Every shape JSON.parse can produce — null, arrays, primitives, and
 * entries whose fields are missing or mistyped — must resolve to no preview
 * instead of throwing or inventing a picture.
 */

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
