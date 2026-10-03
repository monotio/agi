import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSoundDocument,
  readSoundDocumentEnvelope,
  SoundDocumentError,
} from "../src/sound/document.ts";

test("a restored exhausted sound identity allocator refuses insertion without creating an unreadable document", () => {
  const envelope = { ...createSoundDocument().serialize(), nextEventId: Number.MAX_SAFE_INTEGER };
  const restored = readSoundDocumentEnvelope(envelope);
  const before = restored.serialize();
  assert.throws(() => restored.insertEvent(0, 0), SoundDocumentError);
  assert.deepEqual(restored.serialize(), before);
});

test("the final representable sound identity survives persistence and then refuses duplication", () => {
  const restored = readSoundDocumentEnvelope({
    ...createSoundDocument().serialize(),
    nextEventId: Number.MAX_SAFE_INTEGER - 1,
  });
  const last = restored.insertEvent(0, 0);
  const saved = last.serialize();
  assert.equal(saved.nextEventId, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(saved.eventIds, [[`e${Number.MAX_SAFE_INTEGER - 1}`], [], [], []]);
  const reopened = readSoundDocumentEnvelope(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(reopened.encode(), last.encode());
  assert.throws(
    () => reopened.duplicateEvent(`e${Number.MAX_SAFE_INTEGER - 1}`),
    SoundDocumentError,
  );
  assert.deepEqual(reopened.serialize(), saved);
});
