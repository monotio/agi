/**
 * The real mount seam, driven over a real CreativeMaterialWorkspace with the
 * IndexedDB fixture: context pins come from the live project, pending and
 * kept sources resolve their exact bytes, a Use stages through importIntake
 * as a `generated` original, and drift between review and stage refuses
 * with the typed refusal rather than a transport-shaped retry. The provider
 * is fully scripted — nothing here touches the network — and the offer
 * intake is injected because createImageBitmap does not exist under Node.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { versionRefKey } from "../../src/creative/catalog.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import { readCreativeBlob } from "../src/project/creativeStore.ts";
import { openCreativeWorkspace } from "../src/studio/creative/creativeWorkspace.ts";
import { createCreativeGenerationMount } from "../src/studio/creative/creativeGenerationHost.ts";
import { GenerationRefusal } from "../src/studio/creative/creativeGeneration.ts";
import {
  createOpenAiImageProvider,
  OpenAiImageError,
  type OpenAiImageOffer,
  type OpenAiImageProvider,
  type OpenAiImageRequest,
  type PreparedOpenAiImage,
} from "../src/studio/creative/openaiImageProvider.ts";
import type { CreativeImageIntake } from "../src/references/creativeImageDecode.ts";
import type { AiSettings } from "../src/settings/aiSettings.ts";

installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key),
  },
});

const REAL = createOpenAiImageProvider({ credentials: () => "sk-unused" });
const MODEL = "gpt-image-2.5-sunburst";

/** A real intake shape: an encoded PNG original plus its canonical raster. */
function intake(
  width: number,
  height: number,
  paint: (x: number, y: number) => readonly [number, number, number, number],
): CreativeImageIntake {
  const pixels = new Uint8Array(width * height * 4);
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const p = (y * width + x) * 4;
      pixels[p] = r;
      pixels[p + 1] = g;
      pixels[p + 2] = b;
      pixels[p + 3] = a;
      const q = (y * width + x) * 3;
      rgb[q] = r;
      rgb[q + 1] = g;
      rgb[q + 2] = b;
    }
  }
  const encodedBytes = encodePngRgb(width, height, rgb);
  return {
    format: "png",
    sourceWidth: width,
    sourceHeight: height,
    orientation: 1,
    encoded: { hash: sha256Hex(encodedBytes), byteLength: encodedBytes.length, mime: "image/png" },
    encodedBytes,
    normalized: {
      format: "rgba8-srgb-unpremultiplied-v1",
      width,
      height,
      blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
    },
    pixels,
  };
}

const RED_2X2 = intake(2, 2, () => [255, 0, 0, 255]);
const BLUE_4X4 = intake(4, 4, () => [0, 0, 255, 255]);
const GREEN_4X4 = intake(4, 4, () => [0, 255, 0, 255]);

async function seed(name: string): Promise<EditableProject> {
  const prepared = prepareLocalProject({ title: name, kind: "blank" });
  await prepared.save();
  return openEditableProject(prepared.projectId);
}

type Answer = (
  prepared: PreparedOpenAiImage,
  options?: { readonly signal?: AbortSignal },
) => Promise<OpenAiImageOffer>;

/** A PNG offer at the size the prepared request actually asked for. */
function offer(prepared: PreparedOpenAiImage): OpenAiImageOffer {
  const [w, h] = prepared.summary.size.split("x").map(Number);
  const encoded = encodePngRgb(w!, h!, new Uint8Array(w! * h! * 3).fill(87));
  return {
    summary: prepared.summary,
    encoded: { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" },
    encodedBytes: encoded,
    width: w!,
    height: h!,
    format: "png",
    transparent: false,
    usage: { totalTokens: 11, outputImageTokens: 8 },
    requestId: "req-host-test",
    created: 1_700_000_000,
  };
}

/** Real capability-checked prepare, fully scripted submit. No transport exists. */
function makeProvider() {
  const sent: PreparedOpenAiImage[] = [];
  let answer: Answer = (prepared) => Promise.resolve(offer(prepared));
  const provider: OpenAiImageProvider = {
    models: REAL.models,
    get busy() {
      return false;
    },
    prepare: (request: OpenAiImageRequest) => REAL.prepare(request),
    submit: (prepared, options) => {
      sent.push(prepared);
      return new Promise<OpenAiImageOffer>((resolve, reject) => {
        const signal = options?.signal;
        const onAbort = () =>
          reject(new OpenAiImageError("cancelled", "The request was cancelled."));
        signal?.addEventListener("abort", onAbort, { once: true });
        answer(prepared, options).then(
          (value) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (error) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    },
  };
  return {
    provider,
    sent,
    answer(fn: Answer): void {
      answer = fn;
    },
  };
}

/** The injected offer decode: Node has no createImageBitmap, so the test's intake is synthetic. */
function intakeOf(
  encodedBytes: Uint8Array,
  pixels: Uint8Array,
  w: number,
  h: number,
): CreativeImageIntake {
  return {
    format: "png",
    sourceWidth: w,
    sourceHeight: h,
    orientation: 1,
    encoded: { hash: sha256Hex(encodedBytes), byteLength: encodedBytes.length, mime: "image/png" },
    encodedBytes,
    normalized: {
      blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
      format: "rgba8-srgb-unpremultiplied-v1",
      width: w,
      height: h,
    },
    pixels,
  };
}

function settings(openAiKey: string): Pick<AiSettings, "profiles"> {
  return {
    profiles: {
      openai: { model: "gpt-5", apiKey: openAiKey, effort: "low" },
      anthropic: { model: "claude", apiKey: "sk-ant-other", effort: "low" },
      stub: { model: "stub", apiKey: "stub-key", effort: "none" },
    },
  };
}

function generateInput() {
  return {
    kind: "generate" as const,
    role: "room" as const,
    model: MODEL,
    prompt: "A hand-drawn Sierra-style meadow.",
    size: "1024x1024",
    quality: "low" as const,
    background: "opaque" as const,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("the mount's context pins the live workspace, saved identity and draft", async () => {
  const ws = await seed("gen-host-context");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const mount = createCreativeGenerationMount({
    workspace: cw,
    settings: () => settings("sk-openai"),
    provider: makeProvider().provider,
  });
  try {
    const ctx = await mount.host.context();
    const saved = ws.savedIdentity();
    assert.equal(ctx.workspaceId, cw.leaseId);
    assert.equal(ctx.closed, false);
    assert.equal(ctx.busy, false);
    assert.equal(ctx.lifetime, saved.lifetime);
    assert.equal(ctx.generation, saved.generation);
    assert.equal(ctx.revision, saved.revision);
    assert.equal(ctx.authoring, saved.authoring);
    assert.equal(ctx.draftRevision, ws.draft.capture().revision);
    assert.equal(ctx.workspaceVersion, cw.version);
  } finally {
    mount.dispose();
    await cw.dispose();
  }
});

test("the pickers see pending and kept sources; material and raster resolve exact bytes", async () => {
  const ws = await seed("gen-host-sources");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const mount = createCreativeGenerationMount({
    workspace: cw,
    settings: () => settings("sk-openai"),
    provider: makeProvider().provider,
  });
  try {
    const src = await cw.importIntake(RED_2X2, { title: "Red plate" });
    const keys = () => mount.controller.sourceOptions().map((option) => option.key);
    assert.ok(keys().includes(versionRefKey(src.identity)), "pending source listed");

    // A pending source resolves bytes and pixels from the staged lease.
    const pendingMaterial = await mount.host.material(src.identity);
    assert.deepEqual([...pendingMaterial!.encoded], [...RED_2X2.encodedBytes]);
    const pendingRaster = await mount.host.raster(src.identity);
    assert.deepEqual([...pendingRaster!.pixels], [...RED_2X2.pixels]);

    // An approved board entry feeds the reference picker.
    const entry = cw.addBoardEntry(versionRefKey(src.identity), { roles: ["style"] });
    const refs = mount.controller.referenceOptions();
    assert.equal(refs.length, 1);
    assert.equal(versionRefKey(refs[0]!.identity), versionRefKey(entry.identity));
    assert.deepEqual(refs[0]!.roles, ["style"]);

    // After Keep the pending row is consumed; the kept catalog still feeds
    // the picker and resolves the exact stored original.
    await cw.keep();
    let kept = false;
    for (let i = 0; i < 20 && !kept; i++) {
      await flush();
      kept = keys().includes(versionRefKey(src.identity));
    }
    assert.ok(kept, "kept source listed");
    const keptMaterial = await mount.host.material(src.identity);
    assert.deepEqual([...keptMaterial!.encoded], [...RED_2X2.encodedBytes]);
    const keptRaster = await mount.host.raster(src.identity);
    assert.deepEqual([...keptRaster!.pixels], [...RED_2X2.pixels]);
    const removed = await mount.host.material({
      id: "source-gone",
      incarnation: "gone",
      revision: 0,
    });
    assert.equal(removed, null);
  } finally {
    mount.dispose();
    await cw.dispose();
  }
});

test("an explicit Use stages the generated original through importIntake with its exact bytes", async () => {
  const ws = await seed("gen-host-stage");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const fake = makeProvider();
  let lastOffer: OpenAiImageOffer | null = null;
  fake.answer((prepared) => {
    lastOffer = offer(prepared);
    return Promise.resolve(lastOffer);
  });
  const mount = createCreativeGenerationMount({
    workspace: cw,
    settings: () => settings("sk-openai"),
    provider: fake.provider,
    intakeOffer: async (o) =>
      intakeOf(o.encodedBytes, new Uint8Array(o.width * o.height * 4).fill(255), o.width, o.height),
  });
  try {
    await mount.controller.prepareReview(generateInput());
    assert.equal(mount.controller.phase, "review");
    await mount.controller.submit();
    assert.equal(mount.controller.phase, "offer");
    assert.equal(fake.sent.length, 1);

    await mount.controller.useImage();
    assert.equal(mount.controller.phase, "compose");
    assert.equal(mount.controller.offer, null);
    assert.equal(mount.controller.review, null);

    // The staged source carries generated provenance and the offer's exact
    // bytes under their own hash — the mount's own workspaceVersion advance
    // was consumed, not read as foreign supersession.
    const staged = cw.sources.at(-1)!.record;
    assert.equal(staged.origin.kind, "generated");
    assert.match(staged.origin.title, /Sunburst generation$/);
    assert.equal(staged.encoded.hash, lastOffer!.encoded.hash);
    const held = await readCreativeBlob(ws.projectId, staged.encoded.hash);
    assert.equal(held.mime, "image/png");
    assert.deepEqual([...held.bytes], [...lastOffer!.encodedBytes]);
  } finally {
    mount.dispose();
    await cw.dispose();
  }
});

test("work moving under a held offer refuses Use as superseded; nothing stages", async () => {
  const ws = await seed("gen-host-drift");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const fake = makeProvider();
  const mount = createCreativeGenerationMount({
    workspace: cw,
    settings: () => settings("sk-openai"),
    provider: fake.provider,
    intakeOffer: async (o) =>
      intakeOf(o.encodedBytes, new Uint8Array(o.width * o.height * 4).fill(255), o.width, o.height),
  });
  try {
    await mount.controller.prepareReview(generateInput());
    await mount.controller.submit();
    assert.equal(mount.controller.phase, "offer");

    // An unrelated import bumps the workspace version the review pinned.
    const stagedCount = cw.sources.length;
    await cw.importIntake(GREEN_4X4, { title: "Late import" });
    await mount.controller.useImage();
    assert.equal(mount.controller.failure?.reason, "superseded");
    assert.equal(mount.controller.offerStale, true);
    assert.equal(cw.sources.length, stagedCount + 1, "the offer did not stage");
  } finally {
    mount.dispose();
    await cw.dispose();
  }
});

test("the host's own stage check refuses a stale pin with the typed refusal", async () => {
  const ws = await seed("gen-host-stage-drift");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const mount = createCreativeGenerationMount({
    workspace: cw,
    settings: () => settings("sk-openai"),
    provider: makeProvider().provider,
    intakeOffer: async (o) =>
      intakeOf(o.encodedBytes, new Uint8Array(o.width * o.height * 4).fill(255), o.width, o.height),
  });
  try {
    await mount.controller.prepareReview(generateInput());
    const review = mount.controller.review!;
    const fakeOffer = offer(
      makeProvider().provider.prepare({
        kind: "generate",
        role: "room",
        model: MODEL,
        prompt: "x",
        size: "1024x1024",
        quality: "low",
        background: "opaque",
        references: [],
      }),
    );
    const use = {
      offer: fakeOffer,
      intake: intakeOf(fakeOffer.encodedBytes, new Uint8Array(4), 1, 1),
      review,
    };
    // The pinned context stands: staging would be admitted.
    const before = cw.sources.length;
    await cw.importIntake(GREEN_4X4, { title: "Concurrent import" });
    // Now the pin is stale: the host refuses with GenerationRefusal, not a
    // transport-shaped error that would leave the offer usable.
    await assert.rejects(mount.host.stageGenerated(use), (error: unknown) => {
      assert.ok(error instanceof GenerationRefusal);
      assert.equal((error as GenerationRefusal).reason, "superseded");
      return true;
    });
    assert.equal(cw.sources.length, before + 1);
    mount.controller.discardReview();
  } finally {
    mount.dispose();
    await cw.dispose();
  }
});

test("no saved OpenAI key keeps the review and sends nothing; saving it lets the same request through", async () => {
  const ws = await seed("gen-host-nokey");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const fake = makeProvider();
  let current: Pick<AiSettings, "profiles"> | null = null;
  let opened = 0;
  const mount = createCreativeGenerationMount({
    workspace: cw,
    settings: () => current,
    openSettings: () => {
      opened++;
    },
    provider: fake.provider,
  });
  try {
    assert.equal(mount.host.hasCredential(), false);
    await mount.controller.prepareReview(generateInput());
    await mount.controller.submit();
    assert.equal(mount.controller.failure?.reason, "no-key");
    assert.equal(mount.controller.phase, "review", "the reviewed request survives");
    assert.equal(fake.sent.length, 0);
    mount.controller.openSettings();
    assert.equal(opened, 1);

    // A foreign-provider key alone still reads as no key — the saved OpenAI
    // profile is the only credential this path may send.
    current = settings("");
    assert.equal(mount.host.hasCredential(), false);
    current = settings("sk-openai-live");
    assert.equal(mount.host.hasCredential(), true);
    await mount.controller.submit();
    assert.equal(mount.controller.phase, "offer");
    assert.equal(fake.sent.length, 1);
  } finally {
    mount.dispose();
    await cw.dispose();
  }
});

test("an edit Use stages the provider original and its composite through the material seam", async () => {
  const ws = await seed("gen-host-edit");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const fake = makeProvider();
  const mount = createCreativeGenerationMount({
    workspace: cw,
    settings: () => settings("sk-openai"),
    provider: fake.provider,
    intakeOffer: async (o) =>
      intakeOf(o.encodedBytes, new Uint8Array(o.width * o.height * 4).fill(9), o.width, o.height),
  });
  try {
    const base = await cw.importIntake(BLUE_4X4, { title: "Base" });
    await mount.controller.prepareReview({
      kind: "edit",
      role: "room",
      model: MODEL,
      prompt: "Repaint the upper-left quarter.",
      size: "1024x1024",
      quality: "low",
      background: "opaque",
      asset: base.identity,
      selection: { x: 0, y: 0, width: 2, height: 2 },
    });
    assert.equal(mount.controller.phase, "review");
    assert.ok(mount.controller.review!.selection !== undefined, "the mask was built");
    await mount.controller.submit();
    assert.equal(mount.controller.phase, "offer");
    // The deterministic composite over the frozen base is ready for preview.
    const composite = mount.controller.editComposite();
    assert.ok(composite !== null);
    assert.equal(composite!.width, 4);
    assert.equal(composite!.height, 4);

    await mount.controller.useImage();
    assert.equal(mount.controller.failure, null);
    assert.equal(mount.controller.phase, "compose");
    assert.equal(mount.controller.offer, null);

    // The staged pair: provider original first, then its composite — both
    // pending under the workspace's lease, provider bytes exact.
    const staged = cw.sources.slice(-2).map((entry) => entry.record);
    assert.equal(staged.length, 2);
    const [provider, kept] = staged;
    assert.equal(provider!.origin.kind, "generated");
    assert.equal(kept!.origin.kind, "composite");
    const derivation = kept!.derivation;
    assert.ok(derivation !== undefined);
    assert.equal(derivation.kind, "selection-composite");
    assert.equal(derivation.version, 1);
    assert.equal(derivation.algorithm, "agi.edit-selection-composite-v1");
    assert.deepEqual(derivation.base, base.identity);
    assert.deepEqual(derivation.provider, provider!.identity);
    assert.deepEqual(derivation.selection, { x: 0, y: 0, width: 2, height: 2 });

    // Composite canonical pixels: the 2x2 selection took the provider's
    // (9,9,9,9) and every protected byte stayed the blue base's.
    const compositePixels = await readCreativeBlob(ws.projectId, kept!.normalized.blob.hash);
    const expected = new Uint8Array(BLUE_4X4.pixels);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        const p = (y * 4 + x) * 4;
        expected.set([9, 9, 9, 9], p);
      }
    assert.deepEqual([...compositePixels.bytes], [...expected]);

    // The composite original is the deterministic RGBA PNG of those very
    // pixels; the provider original is the offer's exact encoded bytes.
    const compositePng = encodePngRgba(4, 4, expected);
    assert.equal(kept!.encoded.hash, sha256Hex(compositePng));
    assert.equal(kept!.encoded.mime, "image/png");
    const original = await readCreativeBlob(ws.projectId, kept!.encoded.hash);
    assert.deepEqual([...original.bytes], [...compositePng]);
    const providerOriginal = await readCreativeBlob(ws.projectId, provider!.encoded.hash);
    assert.equal(providerOriginal.mime, "image/png");

    // The pair is one grouped undo step; the base stays pending untouched.
    await flush();
    assert.equal(cw.sources.length, 3, "base + provider + composite");
    assert.equal(cw.undoHistory.at(-1) !== undefined, true);
  } finally {
    mount.dispose();
    await cw.dispose();
  }
});

test("dispose ends reads; a mount made for one workspace never stages into another", async () => {
  const ws = await seed("gen-host-dispose");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const mount = createCreativeGenerationMount({
    workspace: cw,
    settings: () => settings("sk-openai"),
    provider: makeProvider().provider,
    intakeOffer: async (o) =>
      intakeOf(o.encodedBytes, new Uint8Array(o.width * o.height * 4).fill(255), o.width, o.height),
  });
  try {
    await mount.controller.prepareReview(generateInput());
    await mount.controller.submit();
    assert.equal(mount.controller.phase, "offer");
    mount.dispose();
    assert.equal(mount.controller.disposed, true);
    await mount.controller.useImage();
    assert.equal(mount.controller.failure?.reason, "closed");
    assert.equal(cw.sources.length, 0);
  } finally {
    await cw.dispose();
  }
});
