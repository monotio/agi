import { scheduler as testScheduler } from "node:timers/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  versionRefKey,
  type CreativeBoardEntry,
  type CreativeSource,
  type VersionRef,
} from "../../src/creative/catalog.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import {
  createOpenAiImageProvider,
  OpenAiImageError,
  type OpenAiImageOffer,
  type OpenAiImageProvider,
  type OpenAiImageRequest,
  type PreparedOpenAiImage,
} from "../src/studio/creative/openaiImageProvider.ts";
import {
  createCreativeGeneration,
  GenerationRefusal,
  savedOpenAiCredential,
  type CreativeGenerationContext,
  type CreativeGenerationController,
  type CreativeGenerationHost,
  type CreativeGenerationInput,
} from "../src/studio/creative/creativeGeneration.ts";
import { buildSelectionMaskPng } from "../src/studio/creative/creativeSelectionComposite.ts";
import type { CreativeImageIntake } from "../src/references/creativeImageDecode.ts";

const REAL = createOpenAiImageProvider({ credentials: () => "sk-unused" });

/** A staged source: real PNG bytes plus its canonical raster. */
function source(id: string, w = 4, h = 4, shade = 30) {
  const rgb = new Uint8Array(w * h * 3);
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 3;
      rgb[q] = shade;
      rgb[q + 1] = (x * 17 + shade) % 256;
      rgb[q + 2] = (y * 17 + shade) % 256;
      const p = (y * w + x) * 4;
      pixels[p] = rgb[q]!;
      pixels[p + 1] = rgb[q + 1]!;
      pixels[p + 2] = rgb[q + 2]!;
      pixels[p + 3] = 255;
    }
  }
  const encoded = encodePngRgb(w, h, rgb);
  const record: CreativeSource = {
    format: "agi.creative-source",
    version: 1,
    identity: { id, incarnation: `inc-${id}`, revision: 0 },
    encoded: { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" },
    availability: "original",
    normalized: {
      blob: {
        hash: sha256Hex(pixels),
        byteLength: pixels.length,
        mime: "application/x-rgba8",
      },
      format: "rgba8-srgb-unpremultiplied-v1",
      width: w,
      height: h,
    },
    origin: { kind: "import", title: `Source ${id}` },
  };
  return { record, encoded, pixels };
}

function boardEntry(
  id: string,
  source: VersionRef,
  roles: readonly ("style" | "composition" | "character-identity" | "exact-source")[],
): CreativeBoardEntry {
  return {
    identity: { id, incarnation: `inc-${id}`, revision: 0 },
    source,
    roles,
    approval: "approved",
    notes: `Note ${id}`,
  };
}

function context(overrides: Partial<CreativeGenerationContext> = {}): CreativeGenerationContext {
  return {
    workspaceId: "ws-1",
    closed: false,
    busy: false,
    lifetime: "life-1",
    generation: 3,
    revision: "rev-7",
    authoring: "auth-fp",
    draftRevision: 11,
    workspaceVersion: 5,
    ...overrides,
  };
}

type Answer = (
  prepared: PreparedOpenAiImage,
  options?: { readonly signal?: AbortSignal },
) => Promise<OpenAiImageOffer>;

function offer(prepared: PreparedOpenAiImage, w = 4, h = 4): OpenAiImageOffer {
  const rgb = new Uint8Array(w * h * 3).fill(99);
  const encoded = encodePngRgb(w, h, rgb);
  return {
    summary: prepared.summary,
    encoded: { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" },
    encodedBytes: encoded,
    width: w,
    height: h,
    format: "png",
    transparent: false,
    usage: { totalTokens: 12, outputImageTokens: 9 },
    requestId: "req-test",
    created: 1_700_000_000,
  };
}

/** Real capability-checked prepare, fully scripted submit. No transport exists. */
function makeProvider() {
  const sent: PreparedOpenAiImage[] = [];
  let answer: Answer = () => Promise.reject(new Error("unscripted submit"));
  const provider: OpenAiImageProvider = {
    models: REAL.models,
    get busy() {
      return false;
    },
    prepare: (request: OpenAiImageRequest) => REAL.prepare(request),
    // Like the real adapter, abort settles the submit even when the
    // scripted transport would never answer on its own.
    submit: (prepared, options) => {
      sent.push(prepared);
      return new Promise<OpenAiImageOffer>((resolve, reject) => {
        const signal = options?.signal;
        const onAbort = () =>
          reject(new OpenAiImageError("cancelled", "The request was cancelled."));
        signal?.addEventListener("abort", onAbort, { once: true });
        answer(prepared, options).then(
          (o) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(o);
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

function intakeOf(w: number, h: number, pixels: Uint8Array): CreativeImageIntake {
  const encoded = encodePngRgb(w, h, new Uint8Array(w * h * 3).fill(7));
  return {
    format: "png",
    sourceWidth: w,
    sourceHeight: h,
    orientation: 1,
    encoded: { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" },
    encodedBytes: encoded,
    normalized: {
      blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
      format: "rgba8-srgb-unpremultiplied-v1",
      width: w,
      height: h,
    },
    pixels,
  };
}

function makeHost(overrides: {
  sources?: readonly CreativeSource[];
  board?: readonly CreativeBoardEntry[];
  material?: (
    identity: VersionRef,
  ) =>
    | { record: CreativeSource; encoded: Uint8Array }
    | null
    | Promise<{ record: CreativeSource; encoded: Uint8Array } | null>;
  raster?: (
    identity: VersionRef,
  ) =>
    | { record: CreativeSource; pixels: Uint8Array }
    | null
    | Promise<{ record: CreativeSource; pixels: Uint8Array } | null>;
  context?: () => CreativeGenerationContext | Promise<CreativeGenerationContext>;
  credential?: boolean;
  intake?: (offer: OpenAiImageOffer) => Promise<CreativeImageIntake>;
  stageGenerated?: (use: never) => Promise<CreativeSource>;
  stageComposite?: (use: never) => Promise<CreativeSource>;
}) {
  const calls = {
    context: 0,
    material: 0,
    raster: 0,
    credential: 0,
    intake: 0,
    openSettings: 0,
  };
  const staged: { generated: unknown[]; composite: unknown[] } = { generated: [], composite: [] };
  const host: CreativeGenerationHost = {
    context: async () => {
      calls.context++;
      return overrides.context?.() ?? context();
    },
    sources: () => overrides.sources ?? [],
    board: () => overrides.board ?? [],
    material: async (identity) => {
      calls.material++;
      return overrides.material?.(identity) ?? null;
    },
    raster: async (identity) => {
      calls.raster++;
      return overrides.raster?.(identity) ?? null;
    },
    hasCredential: () => {
      calls.credential++;
      return overrides.credential !== false;
    },
    openSettings: () => {
      calls.openSettings++;
    },
    intakeOffer: async (ofr) => {
      calls.intake++;
      if (overrides.intake) return overrides.intake(ofr);
      return intakeOf(ofr.width, ofr.height, new Uint8Array(ofr.width * ofr.height * 4).fill(5));
    },
    stageGenerated: async (use) => {
      staged.generated.push(use);
      return (
        (overrides.stageGenerated as ((u: unknown) => Promise<CreativeSource>) | undefined)?.(
          use,
        ) ?? source("staged").record
      );
    },
  };
  if (overrides.stageComposite !== undefined)
    host.stageComposite = async (use) => {
      staged.composite.push(use);
      return (overrides.stageComposite as (u: unknown) => Promise<CreativeSource>)(use);
    };
  return { host, calls, staged };
}

const BASE_INPUT: CreativeGenerationInput = {
  kind: "generate",
  role: "room",
  model: "gpt-image-2",
  prompt: "a quiet lighthouse",
  size: "1024x1024",
  quality: "low",
  background: "opaque",
};

async function reviewed(
  controller: CreativeGenerationController,
  input: CreativeGenerationInput = BASE_INPUT,
): Promise<void> {
  await controller.prepareReview(input);
  assert.equal(controller.phase, "review", `review refused: ${controller.notice}`);
  assert.equal(controller.failure, null);
}

test("review freezes the detached summary, titles and consulted context; inputs stay copied", async () => {
  const asset = source("hero");
  const ref = source("style-ref");
  const entry = boardEntry("board-1", ref.record.identity, ["style"]);
  const { host, calls } = makeHost({
    sources: [asset.record, ref.record],
    board: [entry],
    material: (identity) =>
      [asset, ref].find((s) => versionRefKey(s.record.identity) === versionRefKey(identity)) ??
      null,
  });
  const { provider } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });

  const refs: VersionRef[] = [entry.identity];
  const input: CreativeGenerationInput = {
    ...BASE_INPUT,
    kind: "variation",
    role: "character",
    model: "gpt-image-2.5-flare",
    asset: asset.record.identity,
    references: refs,
  };
  await reviewed(controller, input);

  // Caller-side mutation after review cannot widen the frozen request.
  refs.push(boardEntry("board-2", ref.record.identity, ["exact-source"]).identity);

  const review = controller.review!;
  assert.equal(review.summary.kind, "variation");
  assert.equal(review.summary.count, 1);
  assert.equal(review.summary.images.length, 2);
  assert.equal(review.summary.images[0]!.roles[0], "exact-source");
  assert.deepEqual([...review.summary.images[1]!.roles], ["style"]);
  assert.equal(review.images[0]!.title, "Source hero");
  assert.equal(review.images[1]!.title, "Source style-ref");
  assert.equal(review.summary.images[0]!.hash, sha256Hex(asset.encoded));
  assert.equal(review.context.workspaceId, "ws-1");
  // No credential was consulted while composing or reviewing.
  assert.equal(calls.credential, 0);
  controller.dispose();
});

test("generated image titles retain the user's words separately from the style prompt", async () => {
  const { host } = makeHost({});
  const { provider } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller, {
    ...BASE_INPUT,
    title: "A friendly fox",
    prompt: "Style instructions. Draw a friendly fox.",
  });
  assert.equal(controller.review?.title, "A friendly fox");
  assert.equal(controller.review?.summary.prompt, "Style instructions. Draw a friendly fox.");
  controller.dispose();
});

test("a saved OpenAI profile supplies the key even when another provider is selected", () => {
  const settings = {
    profiles: {
      openai: { model: "gpt-x", apiKey: "  sk-openai  ", effort: "low" as const },
      anthropic: { model: "claude-x", apiKey: "sk-anthropic", effort: "low" as const },
      stub: { model: "stub", apiKey: "", effort: "low" as const },
    },
  };
  assert.equal(savedOpenAiCredential(() => settings)(), "sk-openai");
  const foreignOnly = {
    profiles: {
      openai: { model: "gpt-x", apiKey: "", effort: "low" as const },
      anthropic: { model: "claude-x", apiKey: "sk-anthropic", effort: "low" as const },
      stub: { model: "stub", apiKey: "stub-key", effort: "low" as const },
    },
  };
  assert.equal(
    savedOpenAiCredential(() => foreignOnly)(),
    null,
    "another provider's key is never offered",
  );
});

test("without a saved key submit refuses locally and sends nothing", async () => {
  const { host } = makeHost({ credential: false });
  const { provider, sent } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  await controller.submit();
  assert.equal(controller.failure?.reason, "no-key");
  assert.equal(sent.length, 0, "no request may leave without the saved OpenAI profile key");
  // The same reviewed request stays live for an explicit resubmit after
  // the user saves a key.
  assert.equal(controller.phase, "review");
  controller.dispose();
});

test("submit sends exactly one request and lands a detached offer", async () => {
  const { host } = makeHost({});
  const { provider, sent, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  answer(async (prepared) => offer(prepared));
  await controller.submit();
  assert.equal(sent.length, 1);
  assert.equal(controller.phase, "offer");
  const held = controller.offer!;
  assert.equal(held.summary, controller.review!.summary, "the offer names the reviewed request");
  assert.equal(held.requestId, "req-test");
  assert.equal(controller.offerStale, false);
  assert.equal(controller.failure, null);
  controller.dispose();
});

test("a second submit while one is in flight refuses busy and sends once", async () => {
  const { host } = makeHost({});
  const { provider, sent, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  let release!: (o: OpenAiImageOffer) => void;
  answer(
    (prepared) =>
      new Promise<OpenAiImageOffer>((resolve) => {
        release = () => resolve(offer(prepared));
      }),
  );
  const first = controller.submit();
  await testScheduler.yield();
  const second = controller.submit();
  await second;
  assert.equal(controller.failure?.reason, "busy");
  release(offer(sent[0]!));
  await first;
  assert.equal(sent.length, 1);
  assert.equal(controller.phase, "offer");
  controller.dispose();
});

test("cancel returns to composing; a late-settling transport result is dropped", async () => {
  const { host } = makeHost({});
  const { provider, sent, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  let late: (() => void) | undefined;
  answer(
    (prepared) =>
      new Promise<OpenAiImageOffer>((resolve) => {
        late = () => resolve(offer(prepared));
      }),
  );
  const pending = controller.submit();
  await testScheduler.yield();
  controller.cancel();
  await pending;
  assert.equal(controller.phase, "compose");
  assert.equal(controller.offer, null);
  // The transport answers after the local cancel: consumed, never surfaced.
  late!();
  await testScheduler.yield();
  assert.equal(controller.phase, "compose");
  assert.equal(controller.offer, null);
  assert.equal(sent.length, 1, "the request did leave; cancel is a local abort");
  controller.dispose();
});

test("a moved base revokes the review: submit refuses superseded and sends nothing", async () => {
  let current = context();
  const asset = source("hero");
  const { host } = makeHost({
    context: () => current,
    material: (identity) =>
      versionRefKey(identity) === versionRefKey(asset.record.identity)
        ? { record: asset.record, encoded: asset.encoded }
        : null,
  });
  const { provider, sent } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller, { ...BASE_INPUT, kind: "variation", asset: asset.record.identity });
  current = context({ workspaceVersion: 6 });
  await controller.submit();
  assert.equal(controller.failure?.reason, "superseded");
  assert.equal(sent.length, 0);
  assert.equal(controller.phase, "compose");
  controller.dispose();
});

test("a consulted source that moved refuses the submit", async () => {
  const asset = source("hero");
  const swapped = source("hero", 4, 4, 200);
  let offerVersion = asset;
  const { host } = makeHost({
    material: (identity) =>
      versionRefKey(identity) === versionRefKey(asset.record.identity)
        ? { record: offerVersion.record, encoded: offerVersion.encoded }
        : null,
  });
  const { provider, sent } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller, { ...BASE_INPUT, kind: "variation", asset: asset.record.identity });
  // Same identity, different bytes than the review froze.
  offerVersion = swapped;
  await controller.submit();
  assert.equal(controller.failure?.reason, "superseded");
  assert.equal(sent.length, 0);
  controller.dispose();
});

test("a result landing after the workspace moved is dropped entirely", async () => {
  let current = context();
  const { host } = makeHost({ context: () => current });
  const { provider, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  let release!: () => void;
  answer(
    (prepared) =>
      new Promise<OpenAiImageOffer>((resolve) => {
        release = () => resolve(offer(prepared));
      }),
  );
  const pending = controller.submit();
  await testScheduler.yield();
  current = context({ workspaceId: "ws-2" });
  release();
  await pending;
  assert.equal(controller.phase, "compose");
  assert.equal(controller.offer, null);
  assert.equal(controller.failure?.reason, "closed");
  controller.dispose();
});

test("a same-workspace change during flight keeps the result as a labelled comparison", async () => {
  let current = context();
  const { host, staged } = makeHost({ context: () => current });
  const { provider, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  let release!: () => void;
  answer(
    (prepared) =>
      new Promise<OpenAiImageOffer>((resolve) => {
        release = () => resolve(offer(prepared));
      }),
  );
  const pending = controller.submit();
  await testScheduler.yield();
  current = context({ draftRevision: 12 });
  release();
  await pending;
  assert.equal(controller.phase, "offer");
  assert.equal(controller.offerStale, true, "the late result is a comparison only");
  await controller.useImage();
  assert.equal(staged.generated.length, 0, "a stale offer cannot stage");
  assert.equal(controller.failure?.reason, "superseded");
  controller.dispose();
});

test("explicit Use stages the decoded offer through the host exactly once", async () => {
  const { host, calls, staged } = makeHost({});
  const { provider, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  answer(async (prepared) => offer(prepared));
  await controller.submit();
  const held = controller.offer!;
  await controller.useImage();
  assert.equal(calls.intake, 1);
  assert.equal(staged.generated.length, 1);
  const use = staged.generated[0] as { offer: OpenAiImageOffer; intake: CreativeImageIntake };
  assert.equal(use.offer, held, "the staged offer is the exact detached result");
  assert.equal(controller.phase, "compose");
  assert.equal(controller.offer, null);
  controller.dispose();
});

test("a workspace change during Use decode stops the staging", async () => {
  let current = context();
  const { host, staged } = makeHost({
    context: () => current,
    intake: async (ofr) => {
      current = context({ workspaceVersion: 9 });
      return intakeOf(ofr.width, ofr.height, new Uint8Array(ofr.width * ofr.height * 4));
    },
  });
  const { provider, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  answer(async (prepared) => offer(prepared));
  await controller.submit();
  await controller.useImage();
  assert.equal(staged.generated.length, 0);
  assert.equal(controller.offerStale, true);
  assert.equal(controller.phase, "offer");
  controller.dispose();
});

test("a provider refusal needs a fresh review before any retry", async () => {
  const { host } = makeHost({});
  const { provider, sent, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  answer(() => Promise.reject(new OpenAiImageError("rate-limit", "slow down")));
  await controller.submit();
  assert.equal(controller.failure?.reason, "rate-limit");
  assert.equal(controller.phase, "compose");
  await controller.submit();
  assert.equal(sent.length, 1, "no hidden resend: an explicit new review is required");
  assert.equal(controller.failure?.reason, "invalid-request");
  controller.dispose();
});

test("edit selection freezes the base raster and mask; use refuses without the derivative seam", async () => {
  const asset = source("hero");
  const { host, calls } = makeHost({
    material: (identity) =>
      versionRefKey(identity) === versionRefKey(asset.record.identity)
        ? { record: asset.record, encoded: asset.encoded }
        : null,
    raster: (identity) =>
      versionRefKey(identity) === versionRefKey(asset.record.identity)
        ? { record: asset.record, pixels: asset.pixels }
        : null,
  });
  const { provider, sent, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  const selection = { x: 1, y: 1, width: 2, height: 2 };
  await reviewed(controller, {
    ...BASE_INPUT,
    kind: "edit",
    asset: asset.record.identity,
    selection,
  });
  assert.equal(calls.raster >= 1, true, "the canonical base was captured at review");
  const review = controller.review!;
  const expectedMask = buildSelectionMaskPng(4, 4, selection);
  assert.equal(review.selection!.mask.hash, sha256Hex(expectedMask));
  assert.equal(review.selection!.mask.width, 4);
  assert.equal(review.summary.mask!.byteLength, expectedMask.length);
  assert.deepEqual(review.selection!.rect, selection);

  answer(async (prepared) => offer(prepared, 4, 4));
  await controller.submit();
  assert.equal(sent.length, 1);
  await controller.useImage();
  assert.equal(controller.failure?.reason, "unavailable");
  assert.equal(
    controller.failure!.message,
    "Selection edits are unavailable in this workspace. Choose Generate or Variation.",
    "the refusal names the available actions",
  );
  controller.dispose();
});

test("edit Use composites inside the authorized rect and stages through the injected seam", async () => {
  const asset = source("hero");
  // The decoded provider raster the fake intake returns.
  const providerPixels = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    providerPixels[i * 4] = i;
    providerPixels[i * 4 + 1] = i;
    providerPixels[i * 4 + 2] = i;
    providerPixels[i * 4 + 3] = 255;
  }
  const { host, staged } = makeHost({
    material: (identity) =>
      versionRefKey(identity) === versionRefKey(asset.record.identity)
        ? { record: asset.record, encoded: asset.encoded }
        : null,
    raster: (identity) =>
      versionRefKey(identity) === versionRefKey(asset.record.identity)
        ? { record: asset.record, pixels: asset.pixels }
        : null,
    intake: async () => intakeOf(4, 4, providerPixels),
    stageComposite: (async (_use: { composite: { pixels: Uint8Array } }) => {
      return source("derived").record;
    }) as never,
  });
  const { provider, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  const selection = { x: 1, y: 0, width: 2, height: 4 };
  await reviewed(controller, {
    ...BASE_INPUT,
    kind: "edit",
    asset: asset.record.identity,
    selection,
  });
  answer(async (prepared) => offer(prepared, 4, 4));
  await controller.submit();
  await controller.useImage();
  assert.equal(staged.composite.length, 1);
  const use = staged.composite[0] as {
    composite: { pixels: Uint8Array; selection: { x: number } };
    base: VersionRef;
    selection: { x: number; y: number; width: number; height: number };
  };
  assert.deepEqual(use.base, asset.record.identity);
  assert.deepEqual(use.selection, selection);
  // Column 0 (outside the rect) is the base; columns 1..2 carry the provider pixels.
  const at = (x: number, y: number) => [
    ...use.composite.pixels.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4),
  ];
  assert.deepEqual(at(0, 2), [...asset.pixels.subarray((2 * 4 + 0) * 4, (2 * 4 + 0) * 4 + 4)]);
  assert.deepEqual(at(1, 1), [4 * 1 + 1, 4 * 1 + 1, 4 * 1 + 1, 255]);
  assert.equal(controller.phase, "compose");
  controller.dispose();
});

test("a busy workspace refuses to prepare a review", async () => {
  const { host } = makeHost({ context: () => context({ busy: true }) });
  const { provider, sent } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await controller.prepareReview(BASE_INPUT);
  assert.equal(controller.phase, "compose");
  assert.equal(controller.failure?.reason, "busy");
  assert.equal(sent.length, 0);
  controller.dispose();
});

test("a context change during the consulted check refuses before the request leaves", async () => {
  let current = context();
  const asset = source("hero");
  let release!: (value: { record: CreativeSource; encoded: Uint8Array }) => void;
  let reads = 0;
  const { host } = makeHost({
    context: () => current,
    material: (identity) => {
      if (versionRefKey(identity) !== versionRefKey(asset.record.identity)) return null;
      reads++;
      // The consulted re-read inside submit() is the deferred one.
      if (reads === 1) return { record: asset.record, encoded: asset.encoded };
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const { provider, sent } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller, {
    ...BASE_INPUT,
    kind: "variation",
    asset: asset.record.identity,
  });
  const pending = controller.submit();
  await testScheduler.yield();
  // The workspace moves while the consulted material read is in flight.
  current = { ...current, workspaceVersion: current.workspaceVersion + 1 };
  release({ record: asset.record, encoded: asset.encoded });
  await pending;
  assert.equal(controller.failure?.reason, "superseded");
  assert.equal(sent.length, 0, "the paid request must refuse before leaving");
  assert.equal(controller.phase, "compose");
  controller.dispose();
});

test("an earlier preparation that resolves late cannot replace the newer review", async () => {
  const asset = source("hero");
  let release!: (value: { record: CreativeSource; encoded: Uint8Array }) => void;
  let reads = 0;
  const { host } = makeHost({
    material: (identity) => {
      reads++;
      if (reads === 1)
        return new Promise((resolve) => {
          release = resolve;
        });
      return versionRefKey(identity) === versionRefKey(asset.record.identity)
        ? { record: asset.record, encoded: asset.encoded }
        : null;
    },
  });
  const { provider } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  const earlier = controller.prepareReview({
    ...BASE_INPUT,
    kind: "variation",
    asset: asset.record.identity,
    prompt: "Earlier request",
  });
  // The earlier job parks on its deferred material read first.
  await testScheduler.yield();
  await controller.prepareReview({ ...BASE_INPUT, prompt: "Newer request" });
  release({ record: asset.record, encoded: asset.encoded });
  await earlier;
  assert.equal(controller.phase, "review");
  assert.equal(
    controller.review?.summary.prompt,
    "Newer request",
    "the latest admitted review owns the panel",
  );
  controller.dispose();
});

test("dispose during a pending material read publishes no late review", async () => {
  const asset = source("hero");
  let release!: (value: { record: CreativeSource; encoded: Uint8Array }) => void;
  const { host } = makeHost({
    material: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const { provider } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  const pending = controller.prepareReview({
    ...BASE_INPUT,
    kind: "variation",
    asset: asset.record.identity,
  });
  await testScheduler.yield();
  assert.equal(controller.phase, "preparing");
  controller.dispose();
  release({ record: asset.record, encoded: asset.encoded });
  await pending;
  assert.equal(controller.disposed, true);
  assert.equal(controller.review, null, "a closed panel keeps no late review");
  assert.equal(controller.phase, "compose");
});

test("discarding while a review still prepares cannot publish it", async () => {
  const asset = source("hero");
  let release!: (value: { record: CreativeSource; encoded: Uint8Array }) => void;
  const { host } = makeHost({
    material: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const { provider } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  const pending = controller.prepareReview({
    ...BASE_INPUT,
    kind: "variation",
    asset: asset.record.identity,
  });
  await testScheduler.yield();
  controller.discardReview();
  assert.equal(controller.phase, "compose");
  release({ record: asset.record, encoded: asset.encoded });
  await pending;
  assert.equal(controller.review, null, "the invalidated preparation stays silent");
  assert.equal(controller.phase, "compose");
  controller.dispose();
});

test("a successful edit stage that advances the workspace version is consumed", async () => {
  let current = context();
  const asset = source("hero");
  const { host, staged } = makeHost({
    context: () => current,
    material: (identity) =>
      versionRefKey(identity) === versionRefKey(asset.record.identity)
        ? { record: asset.record, encoded: asset.encoded }
        : null,
    raster: (identity) =>
      versionRefKey(identity) === versionRefKey(asset.record.identity)
        ? { record: asset.record, pixels: asset.pixels }
        : null,
    stageComposite: (async () => {
      // The admitted write's own bookkeeping advance.
      current = { ...current, workspaceVersion: current.workspaceVersion + 1 };
      return source("derived").record;
    }) as never,
  });
  const { provider, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller, {
    ...BASE_INPUT,
    kind: "edit",
    asset: asset.record.identity,
    selection: { x: 0, y: 0, width: 2, height: 2 },
  });
  answer(async (prepared) => offer(prepared, 4, 4));
  await controller.submit();
  await controller.useImage();
  assert.equal(staged.composite.length, 1);
  assert.equal(controller.failure, null, "the admitted write is consumed, not superseded");
  assert.equal(controller.offer, null, "a staged image leaves no reusable offer");
  assert.equal(controller.phase, "compose");
  controller.dispose();
});

test("a workspace close during its own stage still consumes the offer once", async () => {
  let current = context();
  const { host, staged } = makeHost({
    context: () => current,
    stageGenerated: (async () => {
      current = { ...current, closed: true };
      return source("staged").record;
    }) as never,
  });
  const { provider, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  answer(async (prepared) => offer(prepared));
  await controller.submit();
  await controller.useImage();
  assert.equal(staged.generated.length, 1);
  assert.equal(controller.offer, null, "the consumed write never stays reusable");
  assert.equal(controller.phase, "compose");
  assert.equal(controller.failure?.reason, "closed");
  // Using again cannot land twice.
  await controller.useImage();
  assert.equal(staged.generated.length, 1);
  assert.equal(controller.failure?.reason, "invalid-request");
  controller.dispose();
});

test("a rejected context read after a successful composite stage still consumes the offer", async () => {
  const current = context();
  let contextFails = false;
  const asset = source("hero");
  const { host, staged } = makeHost({
    context: () => {
      if (contextFails) return Promise.reject(new Error("context read down"));
      return current;
    },
    material: (identity) =>
      versionRefKey(identity) === versionRefKey(asset.record.identity)
        ? { record: asset.record, encoded: asset.encoded }
        : null,
    raster: (identity) =>
      versionRefKey(identity) === versionRefKey(asset.record.identity)
        ? { record: asset.record, pixels: asset.pixels }
        : null,
    stageComposite: (async () => {
      contextFails = true;
      return source("derived").record;
    }) as never,
  });
  const { provider, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller, {
    ...BASE_INPUT,
    kind: "edit",
    asset: asset.record.identity,
    selection: { x: 0, y: 0, width: 2, height: 2 },
  });
  answer(async (prepared) => offer(prepared, 4, 4));
  await controller.submit();
  await controller.useImage();
  assert.equal(staged.composite.length, 1);
  assert.equal(controller.offer, null, "the receipt consumes the offer before observation");
  assert.equal(controller.review, null);
  assert.equal(controller.phase, "compose");
  controller.dispose();
});

test("dispose while the post-stage status read is pending keeps the write consumed", async () => {
  const current = context();
  let stagedWrite = false;
  let release!: (value: CreativeGenerationContext) => void;
  const { host, staged } = makeHost({
    context: () => {
      if (stagedWrite)
        return new Promise<CreativeGenerationContext>((resolve) => {
          release = resolve;
        });
      return current;
    },
    stageGenerated: (async () => {
      stagedWrite = true;
      return source("staged").record;
    }) as never,
  });
  const { provider, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  answer(async (prepared) => offer(prepared));
  await controller.submit();
  const pending = controller.useImage();
  await testScheduler.yield();
  assert.equal(staged.generated.length, 1, "the write already landed");
  assert.equal(controller.offer, null, "the receipt consumed the offer synchronously");
  controller.dispose();
  release({ ...current, workspaceVersion: current.workspaceVersion + 1 });
  await pending;
  assert.equal(controller.offer, null);
  assert.equal(controller.phase, "compose");
});

test("the review is detached and frozen against host token objects", async () => {
  const shared = context();
  const asset = source("hero");
  const entry = boardEntry("ref-1", asset.record.identity, ["style"]);
  const { host } = makeHost({
    context: () => shared,
    sources: [asset.record],
    board: [entry],
    material: (identity) =>
      versionRefKey(identity) === versionRefKey(asset.record.identity)
        ? { record: asset.record, encoded: asset.encoded }
        : null,
  });
  const { provider } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller, {
    ...BASE_INPUT,
    kind: "variation",
    asset: asset.record.identity,
    references: [entry.identity],
  });
  const review = controller.review!;
  assert.equal(Object.isFrozen(review), true);
  assert.equal(Object.isFrozen(review.context), true);
  assert.equal(Object.isFrozen(review.images), true);
  // Mutating the host-owned objects afterwards cannot move the review.
  (shared as { draftRevision: number }).draftRevision = 99;
  (entry.source as { revision: number }).revision = 42;
  (entry.roles as string[]).push("bogus");
  assert.equal(review.context.draftRevision, 11, "the pinned token, not the moved one");
  const refImage = review.images.find((image) => image.roles.includes("style"))!;
  assert.equal(refImage.identity.revision, 0);
  assert.deepEqual([...refImage.roles], ["style"]);
  controller.dispose();
});

test("dispose aborts the flight and refuses later work", async () => {
  const { host } = makeHost({});
  const { provider, answer } = makeProvider();
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  let release!: () => void;
  answer(
    (prepared) =>
      new Promise<OpenAiImageOffer>((resolve) => {
        release = () => resolve(offer(prepared));
      }),
  );
  const pending = controller.submit();
  await testScheduler.yield();
  controller.dispose();
  release();
  await pending;
  assert.equal(controller.offer, null);
  await controller.prepareReview(BASE_INPUT);
  assert.equal(controller.phase, "compose");
  assert.equal(controller.failure?.reason, "closed");
  controller.dispose();
});

test("a budget pause keeps the request and approval sends it once", async () => {
  const { host } = makeHost({});
  const { provider, sent, answer } = makeProvider();
  const settled: (OpenAiImageOffer | null)[] = [];
  host.reserveRequest = (_summary, approved) => {
    if (!approved)
      throw new GenerationRefusal("budget", "This request may pass your budget. Continue?");
    return (result) => {
      settled.push(result);
    };
  };
  const controller = createCreativeGeneration({ provider, host });
  await reviewed(controller);
  answer(async (prepared) => offer(prepared));
  await controller.submit();
  assert.equal(sent.length, 0);
  assert.equal(controller.failure!.reason, "budget");
  assert.equal(controller.phase, "review");
  await controller.submit(true);
  assert.equal(sent.length, 1);
  assert.equal(settled[0], controller.offer);
  controller.dispose();
});

for (const outcome of ["completed", "cancelled", "interrupted"] as const) {
  test(`generation receipt reports ${outcome} usage after sending`, async () => {
    const { host } = makeHost({});
    const { provider, answer } = makeProvider();
    const controller = createCreativeGeneration({ provider, host });
    await reviewed(controller);
    const beforeSending = controller.spend;
    assert.equal(beforeSending, null);
    let started!: () => void;
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    answer(
      (prepared) =>
        new Promise<OpenAiImageOffer>((resolve, reject) => {
          finish = () =>
            outcome === "interrupted"
              ? reject(new Error("connection lost"))
              : resolve({
                  ...offer(prepared),
                  usage: { inputTextTokens: 2000, inputImageTokens: 3000, outputTokens: 1200 },
                });
          started();
        }),
    );
    const pending = controller.submit();
    await sent;
    const whileSending = controller.spend;
    assert.equal(whileSending, null);
    if (outcome === "cancelled") controller.cancel();
    else finish();
    await pending;
    assert.equal(controller.spend?.amount, outcome === "completed" ? 0.07 : 0);
    assert.equal(controller.spend?.incomplete, outcome !== "completed");
    controller.dispose();
  });
}
