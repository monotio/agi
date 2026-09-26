import assert from "node:assert/strict";
import { test } from "node:test";
import { roomPictureLabels } from "../src/world/roomPictureLabels.ts";

test("a shared picture names the rooms it is shared with and opens in Studio", () => {
  const labels = roomPictureLabels(
    { built: true, runtime: false, pictures: [{ picture: 5, exists: true, sharedWith: [6] }] },
    false,
  );
  assert.equal(labels.chip, "PIC 5 · shared");
  assert.equal(labels.detail, "PIC 5 · shared with room 6");
  assert.equal(labels.studioPicture, 5);
  assert.equal(labels.studioBlocked, undefined);
  assert.equal(
    roomPictureLabels(
      {
        built: true,
        runtime: false,
        pictures: [{ picture: 5, exists: true, sharedWith: [2, 6, 9] }],
      },
      false,
    ).detail,
    "PIC 5 · shared with rooms 2, 6 and 9",
  );
});

test("runtime, missing, unbuilt and pictureless rooms explain why Studio cannot open", () => {
  const runtime = roomPictureLabels({ built: true, runtime: true, pictures: [] }, false);
  assert.equal(runtime.detail, "picture chosen at runtime");
  assert.equal(runtime.studioPicture, undefined);
  assert.match(runtime.studioBlocked ?? "", /chosen at runtime/);

  const missing = roomPictureLabels(
    { built: true, runtime: true, pictures: [{ picture: 7, exists: false, sharedWith: [] }] },
    false,
  );
  assert.equal(missing.chip, "PIC 7");
  assert.equal(
    missing.detail,
    "PIC 7 · not in this game's resources, plus a picture chosen at runtime",
  );
  assert.match(missing.studioBlocked ?? "", /PIC 7 is not in this game's resources/);

  const planned = roomPictureLabels({ built: false, runtime: false, pictures: [] }, true);
  assert.deepEqual([planned.chip, planned.tone], ["plan", "warn"]);
  assert.match(planned.studioBlocked ?? "", /not built/);

  const none = roomPictureLabels({ built: true, runtime: false, pictures: [] }, false);
  assert.equal(none.chip, "no picture");
  assert.match(none.studioBlocked ?? "", /draws no picture/);
});
