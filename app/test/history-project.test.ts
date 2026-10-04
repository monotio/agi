import assert from "node:assert/strict";
import { test } from "node:test";
import { historyProjectDocuments } from "../src/history/historyProject.ts";

test("rewind restores native source while retaining project attachments and authoring documents", () => {
  const attachment = Uint8Array.of(1, 2, 3);
  const saved = {
    "logic:1": "future",
    "picture:99": Uint8Array.of(255),
    images: "image metadata",
    "attachment:hash": attachment,
    notes: "My notes",
    world: "My rooms",
    tests: "My tests",
    music: "My score",
    references: "My references",
  };
  const recorded = { "logic:1": "original", inventory: "[]" };
  assert.deepEqual(historyProjectDocuments(recorded, saved), {
    "logic:1": "original",
    inventory: "[]",
    images: "image metadata",
    "attachment:hash": attachment,
    notes: "My notes",
    world: "My rooms",
    tests: "My tests",
    music: "My score",
    references: "My references",
  });
});
test("legacy recorded authoring documents keep their recorded values", () => {
  assert.equal(
    historyProjectDocuments({ images: "recorded" }, { images: "saved" })["images"],
    "recorded",
  );
});
