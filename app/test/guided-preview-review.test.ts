import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resourceOptions,
  roomOptions,
  roomPictureNumber,
} from "../src/studio/logic/guided/guidedPreview.ts";

test("guided room pickers stay usable while world rooms is being edited", () => {
  assert.deepEqual(roomOptions({ "logic:1": "return();" }, '{"rooms":null}'), [
    { value: 1, label: "Room 1" },
  ]);
});

test("guided resource pickers tolerate incomplete binding entries", () => {
  assert.deepEqual(resourceOptions({ "view:1": new Uint8Array() }, '{"hero":null}', "view"), [
    { value: 1, label: "VIEW 1" },
  ]);
});

test("guided room preview tolerates an incomplete picture binding", () => {
  assert.equal(
    roomPictureNumber("assignn(v20, room_picture);\ndraw.pic(v20);", '{"room_picture":null}'),
    null,
  );
});
