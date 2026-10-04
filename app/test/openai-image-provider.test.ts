import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import {
  createOpenAiImageProvider,
  OpenAiImageError,
  OPENAI_IMAGE_LIMITS,
  OPENAI_IMAGE_MODELS,
  type OpenAiImageMaterial,
  type OpenAiImageModel,
  type OpenAiImageProviderOptions,
  type OpenAiImageRequest,
  type PreparedOpenAiImage,
} from "../src/studio/creative/openaiImageProvider.ts";

/**
 * Offline transport mechanics for the optional BYOK image provider: a
 * scripted fetch stands in for api.openai.com. These tests prove request
 * selection, exact wire shapes, bounds, handle discipline and refusal
 * typing only — nothing here says anything about live CORS, account access,
 * model quality or cost.
 */

const TINY: OpenAiImageModel = {
  id: "test-image-tiny",
  label: "Test Tiny",
  edits: true,
  mask: true,
  inputFidelity: true,
  qualities: ["low", "medium"],
  sizes: ["1x1", "2x2", "4x4", "16x16"],
  backgrounds: ["opaque", "transparent"],
};

const NO_EDIT: OpenAiImageModel = {
  ...TINY,
  id: "test-image-prompt-only",
  label: "Test Prompt Only",
  edits: false,
  mask: false,
  inputFidelity: false,
};

const NO_MASK: OpenAiImageModel = {
  ...TINY,
  id: "test-image-nomask",
  label: "Test No Mask",
  mask: false,
};

const MODELS: Record<string, OpenAiImageModel> = {
  ...OPENAI_IMAGE_MODELS,
  [TINY.id]: TINY,
  [NO_EDIT.id]: NO_EDIT,
  [NO_MASK.id]: NO_MASK,
};

const PNG_1x1 = encodePngRgb(1, 1, Uint8Array.of(200, 30, 40));
const PNG_2x2 = encodePngRgb(2, 2, new Uint8Array(2 * 2 * 3).fill(9));
const PNG_4x4 = encodePngRgb(4, 4, new Uint8Array(4 * 4 * 3).fill(60));
const PNG_16x16 = encodePngRgb(16, 16, new Uint8Array(16 * 16 * 3).fill(120));

function pngChunkChecked(type: string, data: Uint8Array): Uint8Array {
  const body = Uint8Array.of(...[...type].map((c) => c.charCodeAt(0)), ...data);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body) >>> 0);
  return out;
}

/** RGBA PNG (colour type 6) encoded with real deflate, for alpha masks. */
function encodePngRgba(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Uint8Array.of(
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...pngChunkChecked("IHDR", ihdr),
    ...pngChunkChecked("IDAT", deflateSync(raw)),
    ...pngChunkChecked("IEND", new Uint8Array(0)),
  );
}

const MASK_16x16 = encodePngRgba(16, 16, new Uint8Array(16 * 16 * 4).fill(255));
const MASK_2x2 = encodePngRgba(2, 2, new Uint8Array(2 * 2 * 4).fill(255));

/** A header-valid JPEG frame declaring 2x2, for format-mismatch masks. */
const JPEG_2x2 = Uint8Array.of(
  0xff,
  0xd8, // SOI
  0xff,
  0xe0,
  0x00,
  0x10,
  0x4a,
  0x46,
  0x49,
  0x46,
  0x00,
  0x01,
  0x01,
  0x00,
  0x00,
  0x01,
  0x00,
  0x01,
  0x00,
  0x00, // APP0 JFIF
  0xff,
  0xc0,
  0x00,
  0x11,
  0x08,
  0x00,
  0x02,
  0x00,
  0x02,
  0x03,
  0x01,
  0x11,
  0x00,
  0x02,
  0x11,
  0x00,
  0x03,
  0x11,
  0x00, // SOF0: 8-bit, 2x2, 3 components
  0xff,
  0xd9, // EOI
);

/** A still PNG made animated by an acTL chunk before its IDAT. */
function withActl(png: Uint8Array): Uint8Array {
  const ihdrEnd = 8 + 25;
  const out = new Uint8Array(png.length + 20);
  out.set(png.subarray(0, ihdrEnd), 0);
  const actl = new Uint8Array(8);
  new DataView(actl.buffer).setUint32(0, 3);
  out.set(pngChunkChecked("acTL", actl), ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + 20);
  return out;
}

const IDENTITY = { id: "source-one", incarnation: "ws", revision: 0 };

function material(
  bytes: Uint8Array,
  roles: readonly string[] = ["exact-source"],
  identity = IDENTITY,
): OpenAiImageMaterial {
  return { identity, roles, bytes };
}

function request(overrides?: Partial<OpenAiImageRequest>): OpenAiImageRequest {
  return {
    kind: "generate",
    role: "room",
    model: TINY.id,
    prompt: "a lighthouse at dusk",
    size: "1x1",
    quality: "low",
    background: "opaque",
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
  signal: AbortSignal | null;
}

function jsonResponse(payload: unknown, init?: { status?: number; requestId?: string }): Response {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init?.requestId ? { "x-request-id": init.requestId } : {}),
    },
  });
}

function imageBody(png: Uint8Array, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    created: 1_700_000_000,
    data: [{ b64_json: Buffer.from(png).toString("base64") }],
    output_format: "png",
    ...extra,
  };
}

interface Harness {
  provider: ReturnType<typeof createOpenAiImageProvider>;
  calls: RecordedCall[];
  keys: string[];
}

function harness(
  responder?: (call: RecordedCall) => Response | Promise<Response>,
  overrides?: Partial<OpenAiImageProviderOptions>,
): Harness {
  const calls: RecordedCall[] = [];
  const keys: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ?? null,
      signal: init?.signal ?? null,
    };
    calls.push(call);
    return responder ? responder(call) : jsonResponse(imageBody(PNG_1x1));
  };
  const provider = createOpenAiImageProvider({
    credentials: () => {
      keys.push("sk-test-secret");
      return "sk-test-secret";
    },
    fetch: fetchImpl as typeof fetch,
    models: MODELS,
    baseUrl: "https://provider.test",
    ...overrides,
  });
  return { provider, calls, keys };
}

async function errorOf(promise: Promise<unknown>): Promise<OpenAiImageError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OpenAiImageError, `expected OpenAiImageError, got ${error}`);
    return error;
  }
  assert.fail("expected the call to throw");
}

function prepareError(
  provider: Harness["provider"],
  request: OpenAiImageRequest,
): OpenAiImageError {
  try {
    provider.prepare(request);
  } catch (error) {
    assert.ok(error instanceof OpenAiImageError, `expected OpenAiImageError, got ${error}`);
    return error;
  }
  assert.fail("expected prepare to throw");
}

test("prompt-only generation posts exact JSON and returns exact bytes with usage", async () => {
  const usage = {
    input_tokens: 42,
    input_tokens_details: { image_tokens: 0, text_tokens: 42 },
    output_tokens: 1290,
    total_tokens: 1332,
    output_tokens_details: { image_tokens: 1290, text_tokens: 0 },
  };
  const { provider, calls, keys } = harness((call) =>
    call.url.endsWith("/images/generations")
      ? jsonResponse(imageBody(PNG_1x1, { usage }), { requestId: "req_abc" })
      : jsonResponse({}, { status: 500 }),
  );

  const prepared = provider.prepare(request());
  assert.deepEqual(prepared.summary.endpoint, "/v1/images/generations");
  assert.deepEqual(prepared.summary.transport, "json");
  assert.deepEqual(prepared.summary.count, 1);
  assert.deepEqual(prepared.summary.images, []);
  assert.deepEqual(calls.length, 0);
  assert.deepEqual(keys.length, 0);

  const offer = await provider.submit(prepared);
  assert.equal(calls.length, 1);
  assert.equal(keys.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "https://provider.test/v1/images/generations");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["authorization"], "Bearer sk-test-secret");
  assert.equal(call.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(call.body as string), {
    model: TINY.id,
    prompt: "a lighthouse at dusk",
    n: 1,
    size: "1x1",
    quality: "low",
    background: "opaque",
    output_format: "png",
  });

  assert.deepEqual(offer.encodedBytes, PNG_1x1);
  assert.equal(offer.encoded.hash, sha256Hex(PNG_1x1));
  assert.equal(offer.encoded.byteLength, PNG_1x1.length);
  assert.equal(offer.encoded.mime, "image/png");
  assert.equal(offer.width, 1);
  assert.equal(offer.height, 1);
  assert.equal(offer.format, "png");
  assert.equal(offer.transparent, false);
  assert.equal(offer.requestId, "req_abc");
  assert.equal(offer.created, 1_700_000_000);
  assert.deepEqual(offer.usage, {
    inputTokens: 42,
    outputTokens: 1290,
    totalTokens: 1332,
    inputTextTokens: 42,
    inputImageTokens: 0,
    outputImageTokens: 1290,
  });
  assert.equal(offer.summary, prepared.summary);
  assert.equal(provider.busy, false);
});

test("an edit posts multipart with the asset first, references, mask and exact fields", async () => {
  const { provider, calls } = harness((call) => {
    assert.ok(call.url.endsWith("/images/edits"));
    return jsonResponse(imageBody(PNG_16x16));
  });
  const edit = request({
    kind: "edit",
    role: "object",
    size: "16x16",
    background: "transparent",
    inputFidelity: "high",
    asset: material(PNG_16x16, ["exact-source"], { id: "asset-1", incarnation: "ws", revision: 3 }),
    references: [
      material(PNG_2x2, ["style"], { id: "ref-1", incarnation: "ws", revision: 1 }),
      material(PNG_4x4, ["character-identity", "composition"], {
        id: "ref-2",
        incarnation: "ws",
        revision: 7,
      }),
    ],
    mask: { bytes: MASK_16x16 },
  });
  const prepared = provider.prepare(edit);
  assert.equal(prepared.summary.endpoint, "/v1/images/edits");
  assert.equal(prepared.summary.transport, "multipart");
  assert.equal(prepared.summary.images.length, 3);
  assert.equal(prepared.summary.images[0]!.identity.id, "asset-1");
  assert.equal(prepared.summary.mask?.byteLength, MASK_16x16.length);
  assert.equal(
    prepared.summary.totalInputBytes,
    PNG_16x16.length + PNG_2x2.length + PNG_4x4.length + MASK_16x16.length,
  );

  const offer = await provider.submit(prepared);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.headers["authorization"], "Bearer sk-test-secret");
  // The adapter sets no content-type: the runtime supplies the boundary.
  assert.equal(call.headers["content-type"], undefined);
  const form = call.body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("model"), TINY.id);
  assert.equal(form.get("prompt"), "a lighthouse at dusk");
  assert.equal(form.get("n"), "1");
  assert.equal(form.get("size"), "16x16");
  assert.equal(form.get("quality"), "low");
  assert.equal(form.get("background"), "transparent");
  assert.equal(form.get("output_format"), "png");
  assert.equal(form.get("input_fidelity"), "high");

  const images = form.getAll("image[]") as File[];
  assert.equal(images.length, 3);
  const expected = [PNG_16x16, PNG_2x2, PNG_4x4];
  for (let i = 0; i < 3; i++) {
    assert.equal(images[i]!.name, `image-${i}.png`);
    assert.equal(images[i]!.type, "image/png");
    assert.deepEqual(new Uint8Array(await images[i]!.arrayBuffer()), expected[i]);
  }
  const mask = form.get("mask") as File;
  assert.equal(mask.name, "mask.png");
  assert.equal(mask.type, "image/png");
  assert.deepEqual(new Uint8Array(await mask.arrayBuffer()), MASK_16x16);
  assert.equal(offer.transparent, true);
});

test("mask, asset and kind rules refuse locally before any request", async () => {
  const { provider, calls } = harness();
  // Variation and edit need the asset they depart from.
  assert.equal(prepareError(provider, request({ kind: "variation" })).reason, "invalid-request");
  assert.equal(prepareError(provider, request({ kind: "edit" })).reason, "invalid-request");
  // A mask belongs to an edit of a present asset.
  assert.equal(
    prepareError(provider, request({ mask: { bytes: MASK_2x2 } })).reason,
    "invalid-request",
  );
  // Mask dimensions must equal its asset's.
  const dims = prepareError(
    provider,
    request({
      kind: "edit",
      size: "16x16",
      asset: material(PNG_16x16),
      mask: { bytes: MASK_2x2 },
    }),
  );
  assert.equal(dims.reason, "invalid-request");
  assert.equal(dims.code, "mask-dimensions");
  // Mask and asset share the PNG format.
  const format = prepareError(
    provider,
    request({ kind: "edit", size: "16x16", asset: material(JPEG_2x2), mask: { bytes: MASK_2x2 } }),
  );
  assert.equal(format.code, "mask-format");
  const jpegMask = prepareError(
    provider,
    request({ kind: "edit", size: "16x16", asset: material(PNG_16x16), mask: { bytes: JPEG_2x2 } }),
  );
  assert.equal(jpegMask.code, "mask-format");
  // A mask without alpha cannot mark the editable area.
  const alpha = prepareError(
    provider,
    request({
      kind: "edit",
      size: "16x16",
      asset: material(PNG_16x16),
      mask: { bytes: PNG_16x16 },
    }),
  );
  assert.equal(alpha.code, "mask-alpha");
  assert.equal(calls.length, 0);
});

test("capability refusals are typed unsupported and never reach the wire", async () => {
  const { provider, calls } = harness();
  const cases: [Partial<OpenAiImageRequest>, string][] = [
    [{ model: "not-a-model" }, "unsupported"],
    // gpt-image-2 tops out at high and keeps transparent output in preview;
    // the record admits neither "max" nor "transparent".
    [{ model: "gpt-image-2", size: "1024x1024", quality: "max" }, "unsupported"],
    [{ model: "gpt-image-2", size: "4x4" }, "unsupported"],
    [{ model: "gpt-image-2", size: "1024x1024", background: "transparent" }, "unsupported"],
    [
      {
        model: "gpt-image-2",
        kind: "edit",
        size: "1024x1024",
        inputFidelity: "low",
        asset: material(PNG_16x16),
      },
      "unsupported",
    ],
    [{ model: NO_EDIT.id, kind: "edit", asset: material(PNG_1x1) }, "unsupported"],
    [
      {
        model: NO_MASK.id,
        kind: "edit",
        size: "16x16",
        asset: material(PNG_16x16),
        mask: { bytes: MASK_16x16 },
      },
      "unsupported",
    ],
  ];
  for (const [overrides, reason] of cases) {
    assert.equal(
      prepareError(provider, request(overrides)).reason,
      reason,
      JSON.stringify(overrides),
    );
  }
  assert.equal(calls.length, 0);
});

test("byte, count and prompt bounds refuse locally", async () => {
  const { provider, calls } = harness();
  // Seventeen selected images exceed the documented sixteen-image bound.
  const many = prepareError(
    provider,
    request({
      kind: "edit",
      size: "16x16",
      asset: material(PNG_16x16),
      references: Array.from({ length: 16 }, () => material(PNG_1x1)),
    }),
  );
  assert.equal(many.code, "count");
  // One encoded input over the per-file bound.
  const big = prepareError(
    provider,
    request({
      kind: "edit",
      size: "16x16",
      asset: material(new Uint8Array(OPENAI_IMAGE_LIMITS.maxEncodedBytes + 1)),
    }),
  );
  assert.equal(big.code, "oversize");
  // The set over the total bound even though each fits.
  const part = new Uint8Array(6 * 1024 * 1024);
  const total = prepareError(
    provider,
    request({
      kind: "edit",
      size: "16x16",
      asset: material(part),
      references: [material(part), material(part)],
    }),
  );
  assert.equal(total.code, "oversize");
  // The prompt has its own explicit bound.
  const prompt = prepareError(
    provider,
    request({ prompt: "x".repeat(OPENAI_IMAGE_LIMITS.maxPromptLength + 1) }),
  );
  assert.equal(prompt.code, "prompt");
  assert.equal(calls.length, 0);
});

test("the opaque handle rejects forgeries, replay and post-prepare widening", async () => {
  const bodies: string[] = [];
  const { provider, calls } = harness((call) => {
    bodies.push(call.body as string);
    return jsonResponse(imageBody(PNG_1x1));
  });
  // A forged handle is not a prepared request.
  const forged = await errorOf(provider.submit({ summary: {} } as PreparedOpenAiImage));
  assert.equal(forged.reason, "stale");

  const edit = request();
  const prepared = provider.prepare(edit);
  // Caller-side mutation after capture cannot widen what leaves.
  (edit as { prompt: string }).prompt = "a completely different picture";
  const offer = await provider.submit(prepared);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(bodies[0]!).prompt, "a lighthouse at dusk");
  // Replay of a consumed handle refuses stale.
  const replay = await errorOf(provider.submit(prepared));
  assert.equal(replay.reason, "stale");
  assert.equal(calls.length, 1);
  assert.deepEqual(offer.encodedBytes, PNG_1x1);
});

test("mutating offered byte arrays after prepare cannot change the wire", async () => {
  let sent: Uint8Array | undefined;
  const { provider } = harness(async (call) => {
    const form = call.body as FormData;
    const file = form.getAll("image[]")[0] as File;
    sent = new Uint8Array(await file.arrayBuffer());
    return jsonResponse(imageBody(PNG_16x16));
  });
  const editable = PNG_16x16.slice();
  const prepared = provider.prepare(
    request({ kind: "edit", size: "16x16", asset: material(editable) }),
  );
  editable.fill(0xee);
  await provider.submit(prepared);
  assert.deepEqual(sent, PNG_16x16);
});

test("one active job per provider; the second waits without consuming its handle", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { provider } = harness(
    async () => {
      await gate;
      return jsonResponse(imageBody(PNG_1x1));
    },
    { credentials: () => "sk-test-secret" },
  );
  const first = provider.prepare(request());
  const second = provider.prepare(request());
  const pending = provider.submit(first);
  assert.equal(provider.busy, true);
  const clash = await errorOf(provider.submit(second));
  assert.equal(clash.reason, "busy");
  release!();
  await pending;
  assert.equal(provider.busy, false);
  // The refused handle stayed usable: it was not consumed by the clash.
  await provider.submit(second);
});

test("cancel and a late-arriving result stay contained", async () => {
  const { provider } = harness(
    () =>
      new Promise<Response>((resolve) => {
        // The mock ignores the abort and still answers late; submit must
        // consume that answer quietly and still reject cancelled.
        setTimeout(() => resolve(jsonResponse(imageBody(PNG_1x1))), 30);
      }),
  );
  const controller = new AbortController();
  const pending = provider.submit(provider.prepare(request()), { signal: controller.signal });
  controller.abort();
  const error = await errorOf(pending);
  assert.equal(error.reason, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(provider.busy, false);
  // The instance still works afterwards.
  await provider.submit(provider.prepare(request()));
});

test("a measured timeout is distinct from a cancel", async () => {
  const { provider } = harness(
    (call) =>
      // Honoring the request signal the way fetch does, the mock rejects
      // when the adapter's own deadline aborts the request.
      new Promise<Response>((_resolve, reject) => {
        call.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      }),
    { timeoutMs: 30 },
  );
  const error = await errorOf(provider.submit(provider.prepare(request())));
  assert.equal(error.reason, "timeout");
});

test("an already-aborted signal asks for no key and sends nothing", async () => {
  const { provider, calls, keys } = harness();
  const error = await errorOf(
    provider.submit(provider.prepare(request()), { signal: AbortSignal.abort() }),
  );
  assert.equal(error.reason, "cancelled");
  assert.equal(calls.length, 0);
  assert.equal(keys.length, 0);
});

test("a missing key refuses once and sends nothing; errors carry no key", async () => {
  let keyCalls = 0;
  const { provider, calls } = harness(undefined, {
    credentials: () => {
      keyCalls++;
      return null;
    },
  });
  const prepared = provider.prepare(request());
  assert.equal(keyCalls, 0);
  const error = await errorOf(provider.submit(prepared));
  assert.equal(error.reason, "no-key");
  assert.equal(calls.length, 0);
  assert.equal(keyCalls, 1);
});

test("provider failures classify by code and status without echoing the key", async () => {
  const cases: [number, Record<string, unknown>, string][] = [
    [401, { error: { code: "invalid_api_key", message: "bad key" } }, "auth"],
    [403, { error: { message: "not allowed" } }, "model-access"],
    [404, { error: { code: "model_not_found", message: "no such model" } }, "model-access"],
    [429, { error: { code: "rate_limit_exceeded", message: "slow down" } }, "rate-limit"],
    [429, { error: { code: "insufficient_quota", message: "billing" } }, "quota"],
    [402, { error: { message: "billing hard limit" } }, "quota"],
    [
      400,
      {
        error: {
          type: "image_generation_user_error",
          code: "moderation_blocked",
          message: "blocked",
        },
      },
      "user-error",
    ],
    [400, { error: { message: "bad size" } }, "user-error"],
    [500, { error: { message: "upstream" } }, "transport"],
    [503, { error: { message: "overloaded" } }, "transport"],
  ];
  for (const [status, body, reason] of cases) {
    const { provider } = harness(() => jsonResponse(body, { status, requestId: "req_x" }));
    const error = await errorOf(provider.submit(provider.prepare(request())));
    assert.equal(error.reason, reason, `status ${status}`);
    assert.equal(error.status, status);
    assert.equal(error.requestId, "req_x");
    assert.ok(!JSON.stringify(error).includes("sk-test-secret"));
    assert.ok(!String(error.cause ?? "").includes("sk-test-secret"));
  }
});

test("a provider message that echoes the key is scrubbed everywhere", async () => {
  const { provider } = harness(() =>
    jsonResponse(
      { error: { code: "invalid_api_key", message: "key sk-test-secret is not valid" } },
      { status: 401 },
    ),
  );
  const error = await errorOf(provider.submit(provider.prepare(request())));
  assert.equal(error.reason, "auth");
  assert.ok(error.message.includes("[key]"));
  assert.ok(!error.message.includes("sk-test-secret"));
});

test("a fetch-level failure is transport, flagged as a possible CORS-class block", async () => {
  const { provider } = harness(() => Promise.reject(new TypeError("Failed to fetch")));
  const error = await errorOf(provider.submit(provider.prepare(request())));
  assert.equal(error.reason, "transport");
  assert.equal(error.possiblyCors, true);
});

test("response shape, base64 and returned-image validation", async () => {
  // The Content-Length hint alone can refuse early.
  {
    const { provider } = harness(
      () =>
        new Response("x", {
          headers: { "content-length": String(OPENAI_IMAGE_LIMITS.maxResponseBytes + 1) },
        }),
    );
    const error = await errorOf(provider.submit(provider.prepare(request())));
    assert.equal(error.reason, "invalid-output");
    assert.equal(error.code, "oversize");
  }
  // A streamed body is cut off at the ceiling before any JSON exists.
  {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    const { provider } = harness(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < 4; i++) controller.enqueue(chunk);
              controller.close();
            },
          }),
        ),
    );
    const error = await errorOf(provider.submit(provider.prepare(request())));
    assert.equal(error.reason, "invalid-output");
  }
  const bodies: [Record<string, unknown>, string][] = [
    [{ data: [] }, "count"],
    [{ data: [{ b64_json: "AA==" }, { b64_json: "AA==" }] }, "count"],
    [{ data: [{ url: "https://cdn.example/x.png" }] }, "missing-image"],
    [{ data: [{}] }, "missing-image"],
    [{ data: [{ b64_json: "not base64!" }] }, "base64"],
    [{ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }, "signature"],
    [{ data: [{ b64_json: Buffer.from(PNG_2x2).toString("base64") }] }, "dimensions"],
    [{ data: [{ b64_json: Buffer.from(withActl(PNG_1x1)).toString("base64") }] }, "animated"],
    [{ data: [{ b64_json: Buffer.from(JPEG_2x2).toString("base64") }] }, "format"],
    [
      { data: [{ b64_json: Buffer.from(PNG_1x1).toString("base64") }], output_format: "webp" },
      "format",
    ],
  ];
  for (const [body, code] of bodies) {
    const { provider } = harness(() => jsonResponse(body));
    const error = await errorOf(provider.submit(provider.prepare(request())));
    assert.equal(error.reason, "invalid-output", JSON.stringify(body));
    assert.equal(error.code, code, JSON.stringify(body));
  }
});

test("absent usage stays absent; a non-JSON body refuses", async () => {
  {
    const { provider } = harness(() => jsonResponse(imageBody(PNG_1x1)));
    const offer = await provider.submit(provider.prepare(request()));
    assert.equal(offer.usage, undefined);
  }
  {
    const { provider } = harness(() => new Response("not json at all"));
    const error = await errorOf(provider.submit(provider.prepare(request())));
    assert.equal(error.reason, "invalid-output");
    assert.equal(error.code, "json");
  }
});

test("preparation alone never calls credentials or the network", async () => {
  const { provider, calls, keys } = harness();
  provider.prepare(request());
  provider.prepare(
    request({
      kind: "edit",
      size: "16x16",
      asset: material(PNG_16x16),
      mask: { bytes: MASK_16x16 },
    }),
  );
  assert.equal(calls.length, 0);
  assert.equal(keys.length, 0);
  assert.equal(provider.busy, false);
});

test("the review summary is detached and frozen", async () => {
  const { provider, calls } = harness((call) => {
    const body = call.body as FormData;
    assert.equal(body.get("model"), TINY.id);
    return jsonResponse(imageBody(PNG_16x16));
  });
  const edit = request({
    kind: "edit",
    size: "16x16",
    asset: material(PNG_16x16),
    references: [material(PNG_2x2, ["style"])],
    mask: { bytes: MASK_16x16 },
  });
  const prepared = provider.prepare(edit);
  const summary = prepared.summary;
  assert.ok(Object.isFrozen(summary));
  assert.ok(Object.isFrozen(summary.images));
  assert.ok(Object.isFrozen(summary.images[0]));
  assert.ok(Object.isFrozen(summary.mask));
  assert.equal(summary.model, TINY.id);
  assert.equal(summary.size, "16x16");
  assert.equal(summary.quality, "low");
  assert.equal(summary.promptCodeUnits, "a lighthouse at dusk".length);
  assert.equal(summary.images.length, 2);
  assert.equal(summary.images[0]!.hash, sha256Hex(PNG_16x16));
  assert.equal(summary.images[1]!.hash, sha256Hex(PNG_2x2));
  assert.deepEqual(summary.images[1]!.roles, ["style"]);
  // A mutation attempt against the frozen summary throws or is ignored;
  // either way nothing detached reaches the wire.
  try {
    (summary as { model: string }).model = "gpt-image-2";
  } catch {
    /* frozen */
  }
  await provider.submit(prepared);
  assert.equal(calls.length, 1);
});

test("a handle prepared on another provider instance is stale here", async () => {
  const first = harness();
  const second = harness();
  const prepared = first.provider.prepare(request());
  const error = await errorOf(second.provider.submit(prepared));
  assert.equal(error.reason, "stale");
});

test("a getter-backed material is read once and owned before the await", async () => {
  let sent: Uint8Array | undefined;
  const { provider } = harness(async (call) => {
    const form = call.body as FormData;
    const file = form.getAll("image[]")[0] as File;
    sent = new Uint8Array(await file.arrayBuffer());
    return jsonResponse(imageBody(PNG_16x16));
  });
  let reads = 0;
  const sneaky: OpenAiImageMaterial = {
    identity: IDENTITY,
    roles: ["exact-source"],
    // The first read is the valid PNG; any later read hands garbage. The
    // wire must carry the first read's owned copy.
    get bytes() {
      reads++;
      return reads === 1 ? PNG_16x16 : Uint8Array.of(0xde, 0xad);
    },
  };
  const prepared = provider.prepare(request({ kind: "edit", size: "16x16", asset: sneaky }));
  await provider.submit(prepared);
  assert.equal(reads, 1);
  assert.deepEqual(sent, PNG_16x16);
});

test("the intake helper routes exact offer bytes into canonical intake", async () => {
  const { intakeGeneratedImage } = await import("../src/studio/creative/generatedImageIntake.ts");
  const { CreativeImageError } = await import("../src/references/creativeImageDecode.ts");
  const { provider } = harness();
  const offer = await provider.submit(provider.prepare(request()));
  // Node has no canvas decode: a valid PNG reaches the decode step and is
  // refused there, proving header inspection accepted the offered bytes.
  const intake = await intakeGeneratedImage(offer).then(
    () => ({ ok: true as const, reason: "" }),
    (error: unknown) => ({
      ok: false as const,
      reason: error instanceof CreativeImageError ? error.reason : String(error),
    }),
  );
  assert.equal(intake.reason, "decode");
  // A tampered offer is refused at the signature gate — the helper hands
  // intake the exact bytes, not a re-encode.
  const forged = {
    ...offer,
    encodedBytes: Uint8Array.of(0x00, 0x01, 0x02),
  };
  const refused = await intakeGeneratedImage(forged).then(
    () => ({ ok: true as const, reason: "" }),
    (error: unknown) => ({
      ok: false as const,
      reason: error instanceof CreativeImageError ? error.reason : String(error),
    }),
  );
  assert.equal(refused.reason, "signature");
});

test("documented image prompts, inputs and custom sizes reach paid review", () => {
  assert.equal(OPENAI_IMAGE_LIMITS.maxInputImages, 16);
  assert.equal(OPENAI_IMAGE_LIMITS.maxPromptLength, 32000);
  const provider = createOpenAiImageProvider({ credentials: () => "placeholder" });
  const prepared = provider.prepare(
    request({
      model: "gpt-image-2.5-sunburst",
      size: "2048x2048",
      prompt: "x".repeat(32000),
      references: Array.from({ length: 16 }, (_, i) =>
        material(PNG_1x1, ["style"], { ...IDENTITY, id: `reference-${i}` }),
      ),
    }),
  );
  assert.equal(prepared.summary.size, "2048x2048");
  assert.equal(prepared.summary.images.length, 16);
});

test("image quality and pixel count extend the whole-job timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [quality, size, timeout] of [
    ["high", "1024x1024", 360000],
    ["xhigh", "2048x2048", 2880000],
    ["max", "1024x1024", 1080000],
  ] as const) {
    const provider = createOpenAiImageProvider({
      credentials: () => "placeholder",
      fetch: () => new Promise<Response>(() => {}),
    });
    const pending = errorOf(
      provider.submit(
        provider.prepare(request({ model: "gpt-image-2.5-sunburst", quality, size })),
      ),
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    t.mock.timers.tick(180000);
    await Promise.resolve();
    assert.equal(provider.busy, true, "the baseline deadline allows long generation to continue");
    t.mock.timers.tick(timeout - 180000);
    const error = await pending;
    assert.equal(error.reason, "timeout");
    assert.match(error.message, new RegExp(`${timeout / 1000} seconds`));
  }
});

test("paid request estimates use the documented image output calculator", async () => {
  const { estimateImageOutputCost } = await import("../src/studio/creative/openaiImageProvider.ts");
  assert.equal(estimateImageOutputCost("gpt-image-2.5-sunburst", "low", "1024x1024"), 0.00588);
  assert.equal(estimateImageOutputCost("gpt-image-2.5-flare", "high", "1024x1024"), 0.05268);
  assert.equal(estimateImageOutputCost("unknown", "low", "1024x1024"), null);
});

test("streaming publishes a bounded partial before accepting the final image", async () => {
  const b64 = Buffer.from(PNG_1x1).toString("base64");
  const partial = `data: ${JSON.stringify({ type: "image_generation.partial_image", partial_image_index: 0, b64_json: b64 })}\r\n\r\n`;
  const final = `data: ${JSON.stringify({ type: "image_generation.completed", b64_json: b64, output_format: "png", usage: { input_tokens: 1, output_tokens: 2 } })}\n\n`;
  const events: string[] = [];
  const provider = createOpenAiImageProvider({
    credentials: () => "test-key",
    models: { [TINY.id]: { ...TINY, streaming: true } },
    fetch: async (_url, init) => {
      const wire = JSON.parse(init!.body as string);
      assert.equal(wire.stream, true);
      assert.equal(wire.partial_images, 2);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(partial.slice(0, 19)));
            controller.enqueue(new TextEncoder().encode(partial.slice(19)));
            controller.enqueue(new TextEncoder().encode(final));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const offer = await provider.submit(provider.prepare(request()), {
    onPartial(bytes) {
      assert.deepEqual(bytes, PNG_1x1);
      events.push("partial");
    },
  });
  events.push("final");
  assert.deepEqual(events, ["partial", "final"]);
  assert.equal(offer.usage!.outputTokens, 2);
});

test("a streaming request accepts a provider's ordinary JSON response without another request", async () => {
  let requests = 0;
  const provider = createOpenAiImageProvider({
    credentials: () => "test-key",
    models: { [TINY.id]: { ...TINY, streaming: true } },
    fetch: async () => {
      requests++;
      return jsonResponse(imageBody(PNG_1x1));
    },
  });
  const offer = await provider.submit(provider.prepare(request()), {
    onPartial() {
      assert.fail("JSON has no partials");
    },
  });
  assert.deepEqual(offer.encodedBytes, PNG_1x1);
  assert.equal(requests, 1);
});
