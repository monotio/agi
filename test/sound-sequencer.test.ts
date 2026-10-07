import assert from "node:assert/strict";
import { test } from "node:test";
import { createSoundDocument, importSoundDocument } from "../src/sound/document.ts";
import {
  beatLengthLabel,
  DRUM_SOUNDS,
  gridTick,
  setSoundInterval,
  silenceSoundEvent,
  timedSoundEvents,
} from "../src/sound/sequencer.ts";

test("grid boundaries round absolute musical time to ticks without cumulative drift", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((step) => gridTick(step, 120, 16)),
    [0, 8, 15, 23, 30],
  );
  assert.equal(gridTick(4, 120, 8), 60);
  assert.equal(gridTick(1, 120, 2), 60);
  assert.equal(beatLengthLabel(8, 120), "¼ beat");
  assert.equal(beatLengthLabel(7, 120), "¼ beat");
  assert.equal(beatLengthLabel(10, 120), "0.333 beat");
});

test("grid insertion, extension and removal preserve later exact positions and other voices", () => {
  let doc = createSoundDocument().insertEvent(1, 0, {
    ticks: 7,
    data: { kind: "tone", divisor: 227, attenuation: 8 },
  });
  const untouched = doc.tracks()![1]!;
  doc = setSoundInterval(doc, 0, 8, 7, { kind: "tone", note: "A4", attenuation: 3 });
  assert.deepEqual(
    [...doc.encode()],
    [
      8, 0, 20, 0, 27, 0, 29, 0, 8, 0, 0, 128, 159, 7, 0, 15, 142, 147, 255, 255, 7, 0, 14, 163,
      184, 255, 255, 255, 255, 255, 255,
    ],
  );
  doc = setSoundInterval(doc, 0, 23, 4, { kind: "tone", divisor: 190, attenuation: 4 });
  doc = setSoundInterval(doc, 0, 8, 12, { kind: "tone", divisor: 226, attenuation: 3 });
  assert.deepEqual(
    timedSoundEvents(doc)
      .filter((n) => n.event.lane === 0)
      .map((n) => [n.start, n.end, n.event.data.kind]),
    [
      [0, 8, "rest"],
      [8, 20, "tone"],
      [20, 23, "rest"],
      [23, 27, "tone"],
    ],
  );
  doc = silenceSoundEvent(doc, doc.tracks()![0]![1]!.id);
  assert.deepEqual([...doc.encode().slice(13, 18)], [12, 0, 0, 128, 159]);
  assert.deepEqual(doc.tracks()![1], untouched);
});

test("grid edits retain noncanonical bytes outside the edited interval", () => {
  const bytes = Uint8Array.from([
    8, 0, 15, 0, 17, 0, 19, 0, 3, 0, 78, 130, 147, 255, 255, 255, 255, 255, 255, 255, 255,
  ]);
  const doc = setSoundInterval(importSoundDocument(bytes, { profileId: "2.936" }), 0, 8, 2, {
    kind: "tone",
    note: "C5",
    attenuation: 4,
  });
  assert.deepEqual([...doc.encode().slice(8, 13)], [3, 0, 78, 130, 147]);
  assert.deepEqual(
    timedSoundEvents(doc).map((n) => n.start),
    [0, 3, 8],
  );
});

test("named drums encode exact authentic noise registers", () => {
  assert.deepEqual(
    DRUM_SOUNDS.slice(0, 3).map((d) => [d.name, d.control]),
    [
      ["Kick", 2],
      ["Snare", 5],
      ["Hat", 4],
    ],
  );
  let doc = createSoundDocument();
  for (const drum of DRUM_SOUNDS.slice(0, 3))
    doc = setSoundInterval(doc, 3, doc.tracks()![3]!.length * 6, 6, {
      kind: "noise",
      control: drum.control,
      attenuation: 3,
    });
  assert.deepEqual(
    [...doc.encode().slice(14)],
    [6, 0, 2, 226, 243, 6, 0, 5, 229, 243, 6, 0, 4, 228, 243, 255, 255],
  );
});

test("long grid gaps split into legal duration words before the inserted note", () => {
  const doc = setSoundInterval(createSoundDocument(), 0, 65535, 1, {
    kind: "tone",
    note: "A4",
    attenuation: 3,
  });
  assert.deepEqual(
    timedSoundEvents(doc).map((n) => [n.start, n.end, n.event.data.kind]),
    [
      [0, 65534, "rest"],
      [65534, 65535, "rest"],
      [65535, 65536, "tone"],
    ],
  );
});

test("drawing into a zero-duration-word event keeps both resulting native spans legal", () => {
  const original = createSoundDocument().insertEvent(0, 0, {
    ticks: 65536,
    data: { kind: "tone", divisor: 226, attenuation: 3 },
  });
  const doc = setSoundInterval(original, 0, 65535, 1, {
    kind: "tone",
    divisor: 190,
    attenuation: 3,
  });
  assert.deepEqual(
    timedSoundEvents(doc).map((n) => [n.start, n.end]),
    [
      [0, 65534],
      [65534, 65535],
      [65535, 65536],
    ],
  );
});
