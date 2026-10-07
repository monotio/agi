import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import type { CreativeSource } from "../../src/creative/catalog.ts";
import {
  createOpenAiImageProvider,
  type OpenAiImageProvider,
} from "../src/studio/creative/openaiImageProvider.ts";
import {
  createCreativeGeneration,
  type CreativeGenerationContext,
  type CreativeGenerationHost,
  type CreativeGenerationInput,
} from "../src/studio/creative/creativeGeneration.ts";

const input: CreativeGenerationInput = {
  kind: "generate",
  role: "room",
  model: "gpt-image-2",
  prompt: "A lighthouse",
  size: "1024x1024",
  quality: "low",
  background: "opaque",
};
const encodedBytes = encodePngRgb(1, 1, new Uint8Array([1, 2, 3]));
const pixels = new Uint8Array([1, 2, 3, 255]);
const encoded = {
  hash: sha256Hex(encodedBytes),
  byteLength: encodedBytes.length,
  mime: "image/png",
};
const normalized = {
  blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
  format: "rgba8-srgb-unpremultiplied-v1" as const,
  width: 1,
  height: 1,
};
const source: CreativeSource = {
  format: "agi.creative-source",
  version: 1,
  identity: { id: "generated", incarnation: "instance", revision: 0 },
  encoded,
  normalized,
  availability: "original",
  origin: { kind: "import", title: "Generated" },
};

function setup() {
  const context: CreativeGenerationContext = {
    workspaceId: "ws",
    closed: false,
    busy: false,
    lifetime: "life",
    generation: 1,
    revision: "native",
    authoring: "source",
    draftRevision: 0,
    workspaceVersion: 0,
  };
  let current = context;
  const real = createOpenAiImageProvider({ credentials: () => "never-sent" });
  let staged = 0;
  const provider: OpenAiImageProvider = {
    models: real.models,
    busy: false,
    prepare: (request) => real.prepare(request),
    submit: async (prepared) => ({
      summary: prepared.summary,
      encoded,
      encodedBytes,
      width: 1,
      height: 1,
      format: "png",
      transparent: false,
      usage: {},
      requestId: "scripted",
      created: 0,
    }),
  };
  const host: CreativeGenerationHost = {
    context: async () => ({ ...current }),
    sources: () => [],
    board: () => [],
    material: async () => null,
    raster: async () => null,
    hasCredential: () => true,
    openSettings: () => {},
    intakeOffer: async () => ({
      format: "png",
      sourceWidth: 1,
      sourceHeight: 1,
      orientation: 1,
      encoded,
      encodedBytes,
      normalized,
      pixels,
    }),
    stageGenerated: async () => {
      staged++;
      current = { ...current, workspaceVersion: current.workspaceVersion + 1 };
      return source;
    },
  };
  return {
    host,
    provider,
    get staged() {
      return staged;
    },
    context,
  };
}

test("disposing during asynchronous review cannot restore a live reviewed request", async () => {
  const h = setup();
  let release!: (value: CreativeGenerationContext) => void;
  const waiting = new Promise<CreativeGenerationContext>((resolve) => {
    release = resolve;
  });
  h.host.context = () => waiting;
  const controller = createCreativeGeneration(h);
  const pending = controller.prepareReview(input);
  assert.equal(controller.phase, "preparing");
  controller.dispose();
  release(h.context);
  await pending;
  assert.equal(controller.disposed, true);
  assert.equal(controller.review, null, "closed panel must not retain a late review");
  assert.equal(controller.phase, "compose");
});

test("a late earlier preparation cannot replace the newer request review", async () => {
  const h = setup();
  let release!: (value: CreativeGenerationContext) => void;
  const waiting = new Promise<CreativeGenerationContext>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  h.host.context = async () => (++calls === 1 ? waiting : { ...h.context });
  const controller = createCreativeGeneration(h);
  const earlier = controller.prepareReview({ ...input, prompt: "Earlier request" });
  await controller.prepareReview({ ...input, prompt: "Newer request" });
  release(h.context);
  await earlier;
  assert.equal(
    controller.review?.summary.prompt,
    "Newer request",
    "the latest admitted review owns the panel",
  );
  controller.dispose();
});

test("successful staging consumes the offer when its own write advances the workspace", async () => {
  const h = setup();
  const controller = createCreativeGeneration(h);
  await controller.prepareReview(input);
  await controller.submit();
  assert.equal(controller.phase, "offer");
  await controller.useImage();
  assert.equal(h.staged, 1);
  assert.equal(controller.failure, null, "the admitted write's change is not foreign supersession");
  assert.equal(controller.offer, null, "an already-staged image cannot remain a reusable offer");
  assert.equal(controller.phase, "compose");
  controller.dispose();
});

test("a context read failing after successful staging cannot leave a reusable offer", async () => {
  const h = setup();
  const controller = createCreativeGeneration(h);
  await controller.prepareReview(input);
  await controller.submit();
  const stage = h.host.stageGenerated;
  h.host.stageGenerated = async (use) => {
    const result = await stage(use);
    h.host.context = async () => {
      throw new Error("Workspace context temporarily unavailable");
    };
    return result;
  };
  await controller.useImage();
  assert.equal(h.staged, 1);
  assert.equal(controller.offer, null, "the successful stage receipt consumes the offer");
  assert.equal(controller.review, null);
  assert.equal(controller.phase, "compose");
  controller.dispose();
});
