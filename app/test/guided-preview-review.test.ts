import assert from "node:assert/strict";
import { test } from "node:test";
import { roomPictureNumber } from "../src/studio/logic/guided/guidedPreview.ts";

test("guided room preview tolerates an incomplete picture binding", () => {
  assert.equal(
    roomPictureNumber("assignn(v20, room_picture);\ndraw.pic(v20);", '{"room_picture":null}'),
    null,
  );
});
