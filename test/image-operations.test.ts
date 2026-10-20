import { writeProjectWorkspace, readProjectWorkspace } from "../src/authoring/projectWorkspace.ts";
import { ProjectHistory } from "../src/authoring/projectHistory.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../src/crypto.ts";
import {
  traceImageChanges,
  traceOptionsChanges,
  makeCelsChanges,
  prepareImageCels,
  suggestImageCels,
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
test("cel background transparency can be switched off for alpha and colour keys", () => {
  const source = {
    ...image,
    width: 3,
    height: 1,
    rgba: Uint8Array.of(0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 255),
  };
  const frames = [{ region: { x: 0, y: 0, width: 3, height: 1 }, width: 3, height: 1, loop: 0 }];
  const transparent = prepareImageCels(source, frames, PROFILES["2.936"], [255, 255, 255]).input
    .loops[0]!.cels![0]!;
  assert.deepEqual([...transparent.pixels], [15, 15, 4]);
  const opaque = prepareImageCels(source, frames, PROFILES["2.936"], [255, 255, 255], false).input
    .loops[0]!.cels![0]!;
  assert.deepEqual([...opaque.pixels], [0, 15, 4]);
  assert.equal(opaque.transparentColor, 1);
  const changes = makeCelsChanges(
    {},
    "view:0",
    source,
    frames,
    PROFILES["2.936"],
    [255, 255, 255],
    false,
  );
  const content = changes.find((change) => change.key === "view:0")!.content!;
  const parsed = parseView(content as Uint8Array).loops[0]!.cels[0]!;
  assert.deepEqual([...parsed.pixels], [0, 15, 4]);
  assert.equal(parsed.transparentColor, 1);
});

test("four suggested frames become four appended cels in one detached operation", () => {
  const existing = buildView({
    loops: [{ cels: [{ width: 1, height: 1, pixels: [2], transparentColor: 15 }] }],
  });
  const frames = suggestImageCels(image, 4);
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

test("saved PNG image references restore detached pixels and refuse unknown metadata", () => {
  const changes = traceImageChanges({}, "picture:1", image, 0.7);
  const documents = Object.fromEntries(changes.map((c) => [c.key, c.content!]));
  const restored = readProjectImage(documents, sha256Hex(image.encoded));
  assert.deepEqual(restored, image);
  restored.rgba[0] = 99;
  assert.deepEqual(readProjectImage(documents, sha256Hex(image.encoded)).rgba, image.rgba);
  assert.equal(imageTraceUnderlay(documents, "picture:1")!.opacity, 0.7);
  const metadata = JSON.parse(documents["images"] as string);
  const raster = readImageReferences(documents).images[sha256Hex(image.encoded)]!.raster;
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
        [`attachment:${raster}`]: new Uint8Array(1),
      }),
    /hash/,
  );
});

test("adding to a mirror loop gives it independent cels and keeps both displayed loops", () => {
  const input = {
    loops: [
      { cels: [{ width: 2, height: 1, pixels: [2, 4], transparentColor: 0 }] },
      { mirrorLoop: 0 },
    ],
  };
  const changes = makeCelsChanges(
    { "view:0": JSON.stringify(input) },
    "view:0",
    image,
    [{ region: { x: 0, y: 0, width: 2, height: 2 }, width: 2, height: 2, loop: 1 }],
    PROFILES["2.936"],
  );
  const next = changes.find((c) => c.key === "view:0")!.content as Uint8Array;
  const view = parseView(next);
  assert.deepEqual([...view.loops[0]!.cels[0]!.pixels], [2, 4]);
  assert.deepEqual([...view.loops[1]!.cels[0]!.pixels], [4, 2]);
  assert.deepEqual([...view.loops[1]!.cels[1]!.pixels], [0, 4, 0, 4]);
  assert.equal(view.loops[0]!.cels.length, 1);
  assert.equal(view.loops[1]!.cels.length, 2);
});

test("trace placement is optional for older references and validates Behind art", () => {
  const changes = traceImageChanges({}, "picture:1", image, 0.5, true);
  const documents = Object.fromEntries(changes.map((c) => [c.key, c.content!]));
  assert.equal(imageTraceUnderlay(documents, "picture:1")!.behindArt, true);
  const metadata = JSON.parse(documents["images"] as string);
  delete metadata.traces["picture:1"].behindArt;
  assert.equal(
    imageTraceUnderlay({ ...documents, images: JSON.stringify(metadata) }, "picture:1")!.behindArt,
    false,
  );
  metadata.traces["picture:1"].behindArt = "yes";
  assert.throws(
    () => readImageReferences({ ...documents, images: JSON.stringify(metadata) }),
    /placement/i,
  );
  metadata.traces["picture:1"].behindArt = false;
  metadata.traces["picture:1"].future = true;
  assert.throws(
    () => readImageReferences({ ...documents, images: JSON.stringify(metadata) }),
    /fields/,
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

test("assigning loop 7 fills new intervening loops with a transparent cel", () => {
  const existing = buildView({
    loops: [{ cels: [{ width: 1, height: 1, pixels: [2], transparentColor: 0 }] }],
  });
  const changes = makeCelsChanges(
    { "view:0": existing },
    "view:0",
    image,
    [{ region: { x: 0, y: 0, width: 2, height: 2 }, width: 2, height: 2, loop: 7 }],
    PROFILES["2.936"],
  );
  const view = parseView(changes.find((c) => c.key === "view:0")!.content as Uint8Array);
  assert.equal(view.loops.length, 8);
  assert.deepEqual([...view.loops[0]!.cels[0]!.pixels], [2]);
  for (const loop of view.loops.slice(1, 7)) {
    assert.equal(loop.cels.length, 1);
    assert.equal(loop.cels[0]!.transparentColor, 0);
    assert.deepEqual([...loop.cels[0]!.pixels], [0]);
  }
  assert.deepEqual([...view.loops[7]!.cels[0]!.pixels], [0, 4, 0, 4]);
});

test("trace covers the frame with centred aspect-preserving samples", () => {
  const square = {
    ...image,
    width: 8,
    height: 8,
    rgba: Uint8Array.from(
      Array.from({ length: 64 }, (_, i) => [i < 8 ? 255 : 0, 0, 0, 255]).flat(),
    ),
  };
  const documents = Object.fromEntries(
    traceImageChanges({}, "picture:1", square).map((c) => [c.key, c.content!]),
  );
  const pixels = imageTraceUnderlay(documents, "picture:1")!.pixels;
  assert.equal(pixels[3], 255, "cover reaches the top left corner");
  assert.equal(pixels[(160 * 168 - 1) * 4 + 3], 255, "cover reaches the bottom right corner");
  assert.equal(pixels[0], 0, "centred square cover crops the red top band");
});
test("trace transform options reuse attachments and old references centre by default", () => {
  const documents = Object.fromEntries(
    traceImageChanges({}, "picture:1", image).map((c) => [c.key, c.content!]),
  );
  const transform = { x: 12, y: -8, scale: 1.5 };
  const changes = traceOptionsChanges(documents, "picture:1", 0.6, false, transform);
  assert.equal(changes.length, 1);
  const next = { ...documents, images: changes[0]!.content! };
  assert.deepEqual(readImageReferences(next).traces["picture:1"]!.transform, transform);
  assert.deepEqual(imageTraceUnderlay(documents, "picture:1")!.transform, { x: 0, y: 0, scale: 1 });
  assert.deepEqual(imageTraceUnderlay(next, "picture:1")!.transform, transform);
  // At native (90,84), cover samples source x=4; the moved, enlarged trace samples x=3.
  const offset = (84 * 160 + 90) * 4;
  assert.deepEqual(
    [...imageTraceUnderlay(documents, "picture:1")!.pixels.slice(offset, offset + 4)],
    [0, 0, 0, 255],
  );
  assert.deepEqual(
    [...imageTraceUnderlay(next, "picture:1")!.pixels.slice(offset, offset + 4)],
    [170, 0, 0, 255],
  );
  for (const invalid of [
    { ...transform, scale: 0 },
    { ...transform, x: Infinity },
    { ...transform, y: 169 },
  ])
    assert.throws(
      () => traceOptionsChanges(documents, "picture:1", 0.6, false, invalid),
      /transform/i,
    );
});

test("released traces without a transform retain contain placement", () => {
  const square = { ...image, width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4).fill(255) };
  const documents = Object.fromEntries(
    traceImageChanges({}, "picture:1", square).map((c) => [c.key, c.content!]),
  );
  const references = JSON.parse(documents["images"] as string);
  delete references.traces["picture:1"].transform;
  documents["images"] = JSON.stringify(references);
  const pixels = imageTraceUnderlay(documents, "picture:1")!.pixels;
  assert.equal(pixels[3], 0, "contain leaves the side margin clear");
  assert.equal(pixels[(84 * 160 + 80) * 4 + 3], 255);
});

test("preparation identifies the current pixels after an in-place image edit", () => {
  const source = { ...image, rgba: image.rgba.slice() };
  const frames = suggestImageCels(source, 4);
  const first = prepareImageCels(source, frames, PROFILES["2.936"]);
  source.rgba[0] = 170;
  const next = prepareImageCels(source, frames, PROFILES["2.936"]);
  assert.notDeepEqual(next.frames[0]!.source, first.frames[0]!.source);
  assert.equal(next.frames[0]!.source.id, sha256Hex(source.rgba));
});

// An imported picture is matched to the colours the game shows, because those
// are what a player sees for each index. Hand-computed with the weighted
// 2,4,3 distance: (221, 0, 255) is nearest EGA 5 (170, 0, 170) but Amiga 13
// (d0f = 221, 0, 255); (0, 187, 255) is nearest EGA 3 (0, 170, 170) but Amiga 9 (0bf).
test("view import quantises to the running game's palette and records which", async () => {
  const { colourIdForProfile, colourTableForProfile } =
    await import("../src/runtime/colourTables.ts");
  const source = {
    ...image,
    width: 3,
    height: 1,
    rgba: Uint8Array.of(221, 0, 255, 255, 0, 187, 255, 255, 255, 255, 255, 255),
  };
  const frames = [{ region: { x: 0, y: 0, width: 3, height: 1 }, width: 3, height: 1, loop: 0 }];
  const amiga = PROFILES["amiga-2.202"];
  const look = { id: colourIdForProfile(amiga), table: colourTableForProfile(amiga) };
  assert.equal(look.id, "amiga");
  const ega = prepareImageCels(source, frames, amiga, null, false).input.loops[0]!.cels![0]!;
  assert.deepEqual([...ega.pixels], [5, 3, 15]);
  const prepared = prepareImageCels(source, frames, amiga, null, false, { look });
  assert.deepEqual([...prepared.input.loops[0]!.cels![0]!.pixels], [13, 9, 15]);
});

test("an EGA look and no look build the same view bytes", async () => {
  const source = {
    ...image,
    width: 3,
    height: 1,
    rgba: Uint8Array.of(0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 255),
  };
  const frames = [{ region: { x: 0, y: 0, width: 3, height: 1 }, width: 3, height: 1, loop: 0 }];
  const { EGA_TABLE } = await import("../src/runtime/colourTables.ts");
  const plain = prepareImageCels(source, frames, PROFILES["2.936"], [255, 255, 255]);
  const withEga = prepareImageCels(source, frames, PROFILES["2.936"], [255, 255, 255], true, {
    look: { id: "ega", table: EGA_TABLE },
  });
  assert.deepEqual([...withEga.payload], [...plain.payload]);
});

test("a recipe naming a palette needs its table, and one without a name is EGA", async () => {
  const { prepareView } = await import("../src/view/preparation.ts");
  const { readCreativePreparation } = await import("../src/creative/catalog.ts");
  const { AMIGA_TABLE } = await import("../src/runtime/colourTables.ts");
  const identity = { id: "px", incarnation: "image", revision: 0 };
  const recipe = {
    format: "agi.preparation",
    version: 1,
    kind: "view",
    algorithm: "manual-view-preparation-v1",
    sources: [identity],
    palette: "ega-weighted-243-v1",
    mask: { alphaThreshold: 128, key: null },
    frames: [
      {
        id: "f",
        source: identity,
        region: { x: 0, y: 0, width: 1, height: 1 },
        outputWidth: 1,
        outputHeight: 1,
        sourceAnchor: { x: 0, baselineEdgeY: 1 },
        outputAnchorX: 0,
        sample: "nearest-centre-v1",
        allowCropBelowBaseline: false,
        allowCropOutsideCanvas: false,
      },
    ],
    loops: [{ id: "l", frameIds: ["f"] }],
  };
  const raster = [{ identity, width: 1, height: 1, rgba: Uint8Array.of(221, 0, 255, 255) }];
  const profile = PROFILES["amiga-2.202"];
  // Stored form: the field is optional, and a recipe without it still reads exactly as before.
  assert.equal("paletteId" in readCreativePreparation(recipe), false);
  const named = readCreativePreparation({ ...recipe, paletteId: "amiga" });
  assert.equal((named as { paletteId?: string }).paletteId, "amiga");
  assert.throws(() => readCreativePreparation({ ...recipe, paletteId: "" }), /paletteId/);
  // Replay: the named palette decides the index; without its table the recipe is refused.
  const replay = prepareView(raster, { ...recipe, paletteId: "amiga" } as never, profile, {
    amiga: AMIGA_TABLE,
  });
  assert.equal(replay.frames[0]!.pixels[0], 13);
  assert.throws(
    () => prepareView(raster, { ...recipe, paletteId: "amiga" } as never, profile),
    /paletteId/,
  );
  assert.equal(prepareView(raster, recipe as never, profile).frames[0]!.pixels[0], 5);
});
