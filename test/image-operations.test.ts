import { writeProjectWorkspace, readProjectWorkspace } from "../src/authoring/projectWorkspace.ts";
import { ProjectHistory } from "../src/authoring/projectHistory.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../src/crypto.ts";
import {
  traceImageChanges,
  makeCelsChanges,
  suggestImageFrames,
  readImageReferences,
  readProjectImage,
  imageTraceUnderlay,
} from "../src/creative/imageOperations.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { buildView, parseView } from "../src/view/view.ts";
const image = {
  title: "Walk",
  mime: "image/png",
  encoded: new Uint8Array([1, 2, 3]),
  width: 8,
  height: 2,
  rgba: Uint8Array.from(Array.from({ length: 16 }, (_, i) => [i % 2 ? 255 : 0, 0, 0, 255]).flat()),
};
test("trace stores immutable hash-addressed originals and pixels with an editable reference", () => {
  const changes = traceImageChanges({}, "picture:1", image, 0.4);
  const documents = Object.fromEntries(changes.map((c) => [c.key, c.content!]));
  assert.deepEqual(documents[`attachment:${sha256Hex(image.encoded)}`], image.encoded);
  image.encoded[0] = 9;
  assert.equal(
    (documents[`attachment:${sha256Hex(new Uint8Array([1, 2, 3]))}`] as Uint8Array)[0],
    1,
  );
  const references = readImageReferences(documents);
  assert.equal(references.traces["picture:1"]?.opacity, 0.4);
  assert.throws(() => traceImageChanges({}, "picture:1", image, 2), /opacity/i);
});
test("four suggested frames become four appended cels in one detached operation", () => {
  const existing = buildView({
    loops: [{ cels: [{ width: 1, height: 1, pixels: [2], transparentColor: 15 }] }],
  });
  const frames = suggestImageFrames(image, 4);
  assert.deepEqual(
    frames.map((f) => f.region),
    [0, 2, 4, 6].map((x) => ({ x, y: 0, width: 2, height: 2 })),
  );
  const documents = { "view:0": existing };
  const changes = makeCelsChanges(
    documents,
    "view:0",
    image,
    frames.map((f) => ({ ...f, loop: 0 })),
    PROFILES["2.936"],
  );
  const next = changes.find((c) => c.key === "view:0")!.content as Uint8Array;
  const view = parseView(next);
  assert.equal(view.loops[0]!.cels.length, 5);
  assert.deepEqual([...view.loops[0]!.cels[0]!.pixels], [2]);
  assert.deepEqual([...view.loops[0]!.cels[1]!.pixels], [0, 4, 0, 4]);
  assert.equal(parseView(existing).loops[0]!.cels.length, 1);
});

test("saved image references restore detached pixels and refuse unknown metadata", () => {
  const changes = traceImageChanges({}, "picture:1", image, 0.7);
  const documents = Object.fromEntries(changes.map((c) => [c.key, c.content!]));
  const restored = readProjectImage(documents, sha256Hex(image.encoded));
  assert.deepEqual(restored, image);
  restored.rgba[0] = 99;
  assert.notEqual((documents[`attachment:${sha256Hex(image.rgba)}`] as Uint8Array)[0], 99);
  assert.equal(imageTraceUnderlay(documents, "picture:1")!.opacity, 0.7);
  const metadata = JSON.parse(documents["images"] as string);
  assert.throws(
    () =>
      readImageReferences({ ...documents, images: JSON.stringify({ ...metadata, future: true }) }),
    /fields/,
  );
  assert.throws(
    () =>
      readImageReferences({ ...documents, images: JSON.stringify({ ...metadata, version: 2 }) }),
    /version/,
  );
  assert.throws(
    () =>
      readImageReferences({
        ...documents,
        [`attachment:${sha256Hex(image.rgba)}`]: new Uint8Array(1),
      }),
    /hash/,
  );
});

test("large decoded attachments use image bounds while native documents retain their bounds", () => {
  const pixels = new Uint8Array(1536 * 1536 * 4);
  const documents = { [`attachment:${sha256Hex(pixels)}`]: pixels };
  assert.throws(() => writeProjectWorkspace({ "view:0": pixels }), /per-document/);
  assert.equal(
    Object.values(readProjectWorkspace(writeProjectWorkspace(documents)))[0]!.length,
    pixels.length,
  );
  const history = new ProjectHistory(sha256Hex);
  history.record(documents, { label: "Image", origin: "picture", author: "creator", time: 1 });
  assert.equal(Object.values(history.capture().blobs)[0]!.length, pixels.length);
});
