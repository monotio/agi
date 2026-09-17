import assert from "node:assert/strict";
import { test } from "node:test";
import { testProjectId, testRevision } from "./identity.ts";
import {
  REFERENCE_COUNT_LIMIT,
  normalizeReferences,
  rebindStagedReferences,
  referenceAgentImages,
  roomReference,
  stageCharacterView,
  stagedRefusal,
  type DecodedImage,
} from "../src/referenceArt.ts";
import { buildProjectZip, buildPublicGameZip } from "../src/projectArchive.ts";
import { readGameZip } from "../src/gameZip.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView, parseView } from "../../src/view/view.ts";
import { openAiToolContent, anthropicToolContent } from "../../src/agent/toolTransport.ts";
import { base64ToBytes } from "../src/bytes.ts";
import type { CachedGameData } from "../src/gameTypes.ts";

const IDENTITY = { project: testProjectId("demo"), revision: testRevision("rev-a") };
const MOVED = { project: testProjectId("demo"), revision: testRevision("rev-b") };

/** A decoded upload without DOM: 64x12, magenta key, one figure per cell. */
function decodedSheet(): DecodedImage {
  const width = 64;
  const height = 12;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = Math.floor(x / 16);
      const lx = x - cell * 16;
      const figure = lx >= 5 && lx < 11 && y >= 2;
      rgba.set(figure ? [0xff, 0, 0, 0xff] : [0xff, 0, 0xff, 0xff], (y * width + x) * 4);
    }
  }
  return { width, height, rgba, mime: "image/png", bytes: Uint8Array.of(1, 2, 3) };
}

test("stageCharacterView stores the manifest, images and a byte-exact staged VIEW", () => {
  const reference = stageCharacterView(
    "ref-1",
    0,
    "red jacket, red hair",
    IDENTITY,
    [{ decoded: decodedSheet(), facing: "right" }],
    { poses: 4, celHeight: 10, symmetric: true },
  );
  assert.equal(reference.kind, "character");
  assert.equal(reference.target, 0);
  assert.equal(reference.attachedAt.project, IDENTITY.project);
  assert.deepEqual(reference.sheet, { poses: 4, celHeight: 10, symmetric: true });
  const staged = reference.staged!;
  assert.ok(staged);
  // The staged payload and the editable spec encode the same resource.
  assert.deepEqual(buildView(staged.input), base64ToBytes(staged.payload));
  const parsed = parseView(base64ToBytes(staged.payload));
  assert.equal(parsed.loops.length, 4);
  assert.equal(parsed.loops[0]!.cels.length, 4);
  assert.equal(parsed.loops[0]!.cels[0]!.width, 3);
  assert.equal(parsed.loops[0]!.cels[0]!.height, 10);
  // Mirrored left loop shares the right cels.
  assert.equal(parsed.loops[1]!.cels[0]!.width, 3);
  assert.ok(staged.substitutions.some((s) => /mirrored/.test(s)));
});

test("stagedRefusal names stale identity and keeps nothing-staged honest", () => {
  const staged = stageCharacterView(
    "ref-2",
    0,
    "",
    IDENTITY,
    [{ decoded: decodedSheet(), facing: "right" }],
    { poses: 4 },
  );
  assert.equal(stagedRefusal(staged, IDENTITY), null);
  assert.match(stagedRefusal(staged, MOVED)!, /changed since this reference was attached/);
  const room = roomReference("ref-3", 7, "a cliff", IDENTITY, decodedSheet());
  assert.equal(stagedRefusal(room, IDENTITY), "Nothing is staged from this reference.");
});

test("rebindStagedReferences rebinds verified candidates and keeps stale refusals", () => {
  const staged = stageCharacterView(
    "ref-c1",
    0,
    "",
    IDENTITY,
    [{ decoded: decodedSheet(), facing: "right" }],
    { poses: 4 },
  );
  const stale = stageCharacterView(
    "ref-c2",
    0,
    "",
    MOVED,
    [{ decoded: decodedSheet(), facing: "right" }],
    { poses: 4 },
  );
  const art = roomReference("ref-c3", 9, "just art", IDENTITY, decodedSheet());
  const COPIED = { project: testProjectId("remix-copy"), revision: IDENTITY.revision };

  const rebound = rebindStagedReferences([staged, stale, art], COPIED)!;
  // The current candidate rebinds to the copy — stagedRefusal now passes —
  // and the original attachment is kept as provenance.
  assert.equal(stagedRefusal(rebound[0]!, COPIED), null);
  assert.deepEqual(rebound[0]!.attachedAt, COPIED);
  assert.deepEqual(rebound[0]!.origin, IDENTITY);
  // The stale candidate keeps its old identity — the refusal survives.
  assert.deepEqual(rebound[1]!.attachedAt, MOVED);
  assert.equal(rebound[1]!.origin, undefined);
  assert.match(stagedRefusal(rebound[1]!, COPIED)!, /changed since this reference/);
  // Unstaged art is pure provenance — untouched.
  assert.deepEqual(rebound[2], art);

  // The rebound record survives storage normalization, origin included.
  const normalized = normalizeReferences(rebound);
  assert.deepEqual(normalized[0]!.origin, IDENTITY);
  assert.equal(stagedRefusal(normalized[0]!, COPIED), null);
});

test("normalizeReferences drops malformed entries and keeps valid ones", () => {
  const valid = roomReference("ref-ok", 3, "a cave", IDENTITY, decodedSheet());
  const normalized = normalizeReferences([
    valid,
    { id: 42 },
    { ...valid, attachedAt: { project: "!!bad!!", revision: "x" } },
    { ...valid, images: "not-an-array" },
    { ...valid, brief: 7 },
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]!.id, "ref-ok");
  // Bounded count.
  const many = normalizeReferences(
    Array.from({ length: REFERENCE_COUNT_LIMIT + 4 }, (_, i) => ({
      ...valid,
      id: `ref-${i}`,
    })),
  );
  assert.equal(many.length, REFERENCE_COUNT_LIMIT);
});

test("normalizeReferences drops a staged view whose spec no longer compiles", () => {
  const staged = stageCharacterView(
    "ref-4",
    0,
    "",
    IDENTITY,
    [{ decoded: decodedSheet(), facing: "right" }],
    { poses: 4 },
  );
  const broken = {
    ...staged,
    staged: { ...staged.staged!, input: { loops: [] } },
  };
  const normalized = normalizeReferences([broken]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]!.staged, undefined);
  // A corrupt image payload drops the image, not the reference.
  const noImage = { ...staged, images: [{ ...staged.images[0]!, png: 5 }] };
  assert.equal(normalizeReferences([noImage]).length, 0);
});

test("referenceAgentImages captions carry the target, facing and brief", () => {
  const room = roomReference("ref-5", 12, "a lighthouse", IDENTITY, decodedSheet());
  const [image] = referenceAgentImages(room);
  assert.match(image!.caption, /room 12/);
  assert.match(image!.caption, /a lighthouse/);
  assert.deepEqual(image!.png, Uint8Array.of(1, 2, 3));
});

function projectFiles(): Record<string, Uint8Array> {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  return { ...Object.fromEntries(container.files), "WORDS.TOK": new Uint8Array(52) };
}

test("project archives carry reference bytes; game exports exclude them", async () => {
  const reference = roomReference("ref-6", 4, "the dock", IDENTITY, decodedSheet());
  const staged = stageCharacterView(
    "ref-7",
    0,
    "the hero",
    IDENTITY,
    [{ decoded: decodedSheet(), facing: "right" }],
    { poses: 4 },
  );
  const data: CachedGameData = {
    projectId: IDENTITY.project,
    title: "Port",
    provider: "stub",
    model: "offline-stub",
    authoredAt: "2026-01-01",
    files: projectFiles(),
    words: [],
    transcript: [],
    references: [reference, staged],
  };
  const projectBytes = await buildProjectZip(data);
  const opened = await readGameZip(projectBytes);
  const restored = opened.project?.references ?? [];
  assert.equal(restored.length, 2);
  assert.equal(restored[0]!.id, "ref-6");
  assert.deepEqual(
    base64ToBytes(restored[0]!.images[0]!.png),
    base64ToBytes(reference.images[0]!.png),
  );
  assert.equal(restored[1]!.id, "ref-7");
  assert.equal(restored[1]!.staged!.num, 0);
  // The staged spec survives the round trip and still compiles.
  parseView(base64ToBytes(restored[1]!.staged!.payload));

  const gameFiles = (await readGameZip(buildPublicGameZip(data))).files;
  const zipText = new TextDecoder().decode(buildPublicGameZip(data));
  assert.ok(!zipText.includes("REFERENCES/"), "game export carries no reference entries");
  assert.ok(Object.keys(gameFiles).every((name) => !name.startsWith("REFERENCES")));
  assert.equal(opened.project?.references?.[0]?.attachedAt.project, IDENTITY.project);
});

test("reference JPEG and WebP bytes retain their MIME in both provider requests", () => {
  for (const mime of ["image/jpeg", "image/webp"] as const) {
    const decoded = { ...decodedSheet(), mime, bytes: Uint8Array.of(0xff, 0xd8, 0xff) };
    const images = referenceAgentImages(roomReference("mime", 1, "harbour", IDENTITY, decoded));
    const content = { text: "reference", images };
    const openai = openAiToolContent(content).find((block) => block.type === "input_image");
    const anthropic = anthropicToolContent(content).find((block) => block.type === "image");
    assert.equal(openai?.image_url, `data:${mime};base64,/9j/`);
    assert.equal(anthropic?.source.media_type, mime);
    assert.equal(anthropic?.source.data, "/9j/");
  }
});
