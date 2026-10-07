import assert from "node:assert/strict";
import { test } from "node:test";
import { createSoundDocument, importSoundDocument } from "../src/sound/document.ts";

test("native sound note entry rejects fractional and trailing-junk pitch input", () => {
  const blank = createSoundDocument();
  for (const note of [69.25, "69.25", "69junk", "1e2"]) {
    assert.throws(
      () => blank.insertEvent(0, 0, { data: { kind: "tone", note } }),
      /note|pitch|integer|invalid/i,
      `reject ambiguous note input ${note}`,
    );
  }
  assert.deepEqual(
    [...blank.encode()],
    [8, 0, 10, 0, 12, 0, 14, 0, 255, 255, 255, 255, 255, 255, 255, 255],
  );
});

test("native sound note input cannot silently clamp an unrepresentable pitch", () => {
  const blank = createSoundDocument();
  // A0 = 27.5 Hz requires a divisor above the 10-bit ceiling. Silently
  // clamping to 1023 would encode an entirely different note.
  assert.throws(
    () => blank.insertEvent(0, 0, { data: { kind: "tone", note: "A0" } }),
    /range|represent|divisor|pitch/i,
  );
});

test("a duration edit preserves all raw bytes in the other sound lanes", () => {
  const payload = new Uint8Array([
    8, 0, 15, 0, 22, 0, 24, 0, 6, 0, 14, 130, 148, 255, 255, 0, 0, 254, 199, 183, 255, 255, 255,
    255, 255, 255,
  ]);
  const doc = importSoundDocument(payload, { profileId: "2.936" });
  const id = doc.tracks()![0]![0]!.id;
  const edited = doc.updateEvent(id, { ticks: 65536 });
  const expected = payload.slice();
  expected[8] = 0;
  assert.deepEqual(edited.encode(), expected);
  assert.deepEqual(doc.encode(), payload);
  assert.equal(edited.extentTicks(), 65536);
});
