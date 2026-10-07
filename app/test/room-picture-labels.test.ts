import assert from "node:assert/strict";
import { test } from "node:test";
import { roomPictureLabels } from "../src/world/roomPictureLabels.ts";

test("a shared picture names the rooms it is shared with and opens in Studio", () => {
  const labels = roomPictureLabels(
    { built: true, runtime: false, pictures: [{ picture: 5, exists: true, sharedWith: [6] }] },
    false,
  );
  assert.equal(labels.chip, "PICTURE 5 · shared");
  assert.equal(labels.detail, "PICTURE 5 · shared with Room 6");
  assert.deepEqual(labels.studioPictures, [5]);
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
    "PICTURE 5 · shared with Room 2, Room 6 and Room 9",
  );
});

test("runtime, missing, unbuilt and pictureless rooms explain why Studio cannot open", () => {
  const runtime = roomPictureLabels({ built: true, runtime: true, pictures: [] }, false);
  assert.equal(runtime.detail, "picture chosen at runtime");
  assert.deepEqual(runtime.studioPictures, []);
  assert.match(runtime.studioBlocked ?? "", /chosen at runtime/);

  const missing = roomPictureLabels(
    { built: true, runtime: true, pictures: [{ picture: 7, exists: false, sharedWith: [] }] },
    false,
  );
  assert.equal(missing.chip, "PICTURE 7");
  assert.equal(
    missing.detail,
    "PICTURE 7 · not in this game's resources, plus a picture chosen at runtime",
  );
  assert.match(missing.studioBlocked ?? "", /PICTURE 7 is not in this game's resources/);
  assert.deepEqual(missing.studioPictures, []);

  const planned = roomPictureLabels({ built: false, runtime: false, pictures: [] }, true);
  assert.deepEqual([planned.chip, planned.tone], ["plan", "warn"]);
  assert.match(planned.studioBlocked ?? "", /not built/);

  const none = roomPictureLabels({ built: true, runtime: false, pictures: [] }, false);
  assert.equal(none.chip, "no picture");
  assert.match(none.studioBlocked ?? "", /draws no picture/);
});

test("a room that draws several pictures offers each existing one to Studio, in order", () => {
  const labels = roomPictureLabels(
    {
      built: true,
      runtime: false,
      pictures: [
        { picture: 1, exists: true, sharedWith: [] },
        { picture: 9, exists: false, sharedWith: [] },
        { picture: 4, exists: true, sharedWith: [] },
      ],
    },
    false,
  );
  assert.equal(labels.chip, "PICTURE 1, PICTURE 9, PICTURE 4");
  assert.deepEqual(labels.studioPictures, [1, 4]);
  assert.equal(labels.studioBlocked, undefined);
});

test("picture chips and shared-room references resolve creator names", () => {
  const labels = roomPictureLabels(
    { built: true, runtime: false, pictures: [{ picture: 5, exists: true, sharedWith: [6] }] },
    false,
    {
      bindings: { garden_picture: { kind: "picture", num: 5 } },
      rooms: [{ room: 6, title: "Garden" }],
    },
  );
  assert.equal(labels.chip, "garden_picture (PICTURE 5) · shared");
  assert.equal(labels.detail, "garden_picture (PICTURE 5) · shared with Garden (Room 6)");
});
