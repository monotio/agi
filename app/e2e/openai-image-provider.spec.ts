import { crc32, deflateSync } from "node:zlib";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./test.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import type {
  OpenAiImageModel,
  OpenAiImageRequest,
} from "../src/studio/creative/openaiImageProvider.ts";

/**
 * Browser transport mechanics for the optional BYOK OpenAI image adapter:
 * the real app serves the module, the real `fetch`/`FormData` runs, and
 * Playwright routes stand in for api.openai.com. Mocked transport proves
 * bounded wire behavior only — it says nothing about live CORS, account
 * access, model quality, cost or creative usefulness.
 */

const API_PATTERN = "**/api/openai/v1/images/**";

const PNG_1x1 = encodePngRgb(1, 1, Uint8Array.of(200, 30, 40));
const PNG_2x2 = encodePngRgb(2, 2, new Uint8Array(2 * 2 * 3).fill(9));
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

/** An RGBA PNG (colour type 6) encoded with real deflate, for masks. */
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

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const imageBody = (png: Uint8Array, extra?: Record<string, unknown>) => ({
  created: 1_700_000_000,
  data: [{ b64_json: b64(png) }],
  output_format: "png",
  ...extra,
});

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

/**
 * Route api.openai.com to scripted responders. Each captured request is
 * recorded, then the next responder in order answers (the default responder
 * is used when the queue runs out).
 */
async function mockApi(
  page: Page,
  responders: ((route: Route) => Promise<void> | void)[],
  requests: RecordedRequest[],
): Promise<void> {
  await page.route(API_PATTERN, async (route) => {
    const request = route.request();
    requests.push({
      url: request.url(),
      method: request.method(),
      headers: await request.headers(),
      body: request.postDataBuffer(),
    });
    const responder = responders.shift() ?? (() => route.fulfill({ json: imageBody(PNG_1x1) }));
    await responder(route);
  });
}

const fulfillImage = (png: Uint8Array, extra?: Record<string, unknown>, requestId?: string) => {
  return (route: Route) =>
    route.fulfill({
      json: imageBody(png, extra),
      headers: {
        "content-type": "application/json",
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
    });
};

/** The synthetic test capability table plus the shipped records, built in-page. */
const modelsArg: Record<string, OpenAiImageModel> = {
  "test-image-tiny": {
    id: "test-image-tiny",
    label: "Test Tiny",
    edits: true,
    mask: true,
    inputFidelity: true,
    qualities: ["low", "medium"],
    sizes: ["1x1", "2x2", "16x16"],
    backgrounds: ["opaque", "transparent"],
  },
};

const identity = { id: "source-one", incarnation: "ws", revision: 0 };

const generateRequest: OpenAiImageRequest = {
  kind: "generate",
  role: "room",
  model: "test-image-tiny",
  prompt: "a lighthouse at dusk",
  size: "1x1",
  quality: "low",
  background: "opaque",
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("heading", { name: "Your games" }).waitFor();
});

test("prompt-only generation posts exact JSON; exact bytes survive canonical intake @webkit-desktop", async ({
  page,
}) => {
  const requests: RecordedRequest[] = [];
  const usage = {
    input_tokens: 12,
    output_tokens: 41,
    total_tokens: 53,
    input_tokens_details: { text_tokens: 12, image_tokens: 0 },
    output_tokens_details: { image_tokens: 41 },
  };
  await mockApi(page, [fulfillImage(PNG_1x1, { usage }, "req_e2e")], requests);
  const outcome = await page.evaluate(
    async (args) => {
      const provider_mod = await import("/src/studio/creative/openaiImageProvider.ts");
      const intake_mod = await import("/src/studio/creative/generatedImageIntake.ts");
      const models = { ...provider_mod.OPENAI_IMAGE_MODELS, ...args.models };
      const provider = provider_mod.createOpenAiImageProvider({
        credentials: () => args.key,
        baseUrl: `${location.origin}/api/openai`,
        models,
      });
      const prepared = provider.prepare(args.request);
      const summary = {
        endpoint: prepared.summary.endpoint,
        transport: prepared.summary.transport,
        count: prepared.summary.count,
        images: prepared.summary.images.length,
      };
      try {
        const offer = await provider.submit(prepared);
        const intake = await intake_mod.intakeGeneratedImage(offer);
        return {
          ok: true as const,
          summary,
          hash: offer.encoded.hash,
          mime: offer.encoded.mime,
          requestId: offer.requestId,
          created: offer.created,
          usage: offer.usage ?? null,
          intake: {
            encodedHash: intake.encoded.hash,
            encodedExact:
              intake.encodedBytes.length === offer.encodedBytes.length &&
              intake.encodedBytes.every((b, i) => b === offer.encodedBytes[i]),
            normalizedFormat: intake.normalized.format,
            normalizedHash: intake.normalized.blob.hash,
            pixels: [...intake.pixels],
          },
        };
      } catch (error) {
        return {
          ok: false as const,
          reason: error instanceof provider_mod.OpenAiImageError ? error.reason : String(error),
          summary,
        };
      }
    },
    { key: "sk-e2e-secret", models: modelsArg, request: generateRequest },
  );

  expect(outcome.ok).toBe(true);
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.url).toMatch(/\/api\/openai\/v1\/images\/generations$/);
  expect(request.method).toBe("POST");
  expect(request.headers["authorization"]).toBe("Bearer sk-e2e-secret");
  expect(request.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(request.body!.toString("utf8"))).toEqual({
    model: "test-image-tiny",
    prompt: "a lighthouse at dusk",
    n: 1,
    size: "1x1",
    quality: "low",
    background: "opaque",
    output_format: "png",
  });
  if (outcome.ok) {
    expect(outcome.summary).toEqual({
      endpoint: "/v1/images/generations",
      transport: "json",
      count: 1,
      images: 0,
    });
    expect(outcome.hash).toBe(sha256Hex(PNG_1x1));
    expect(outcome.mime).toBe("image/png");
    expect(outcome.requestId).toBe("req_e2e");
    expect(outcome.created).toBe(1_700_000_000);
    expect(outcome.usage).toEqual({
      inputTokens: 12,
      outputTokens: 41,
      totalTokens: 53,
      inputTextTokens: 12,
      inputImageTokens: 0,
      outputImageTokens: 41,
    });
    expect(outcome.intake.encodedHash).toBe(sha256Hex(PNG_1x1));
    expect(outcome.intake.encodedExact).toBe(true);
    expect(outcome.intake.normalizedFormat).toBe("rgba8-srgb-unpremultiplied-v1");
    expect(outcome.intake.normalizedHash).toBe(sha256Hex(Uint8Array.of(200, 30, 40, 255)));
    expect(outcome.intake.pixels).toEqual([200, 30, 40, 255]);
  }
});

test("an edit posts real multipart: image[] in order, mask bound to the first image @webkit-desktop", async ({
  page,
}) => {
  const requests: RecordedRequest[] = [];
  await mockApi(page, [fulfillImage(PNG_16x16)], requests);
  const outcome = await page.evaluate(
    async (args) => {
      const provider_mod = await import("/src/studio/creative/openaiImageProvider.ts");
      const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const models = { ...provider_mod.OPENAI_IMAGE_MODELS, ...args.models };
      // The spy records what the adapter hands the platform: WebKit does not
      // expose serialized multipart file payloads to route interception, so
      // the parts are asserted here while the route proves the request left.
      const sent: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: string | null;
        parts: (
          | { name: string; filename: string; contentType: string; bytes: number[] }
          | { name: string; value: string }
        )[];
      }[] = [];
      const spy: typeof fetch = async (input, init) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => {
          headers[key] = value;
        });
        const record: (typeof sent)[number] = {
          url: String(input),
          method: init?.method ?? "GET",
          headers,
          body: null,
          parts: [],
        };
        if (init?.body instanceof FormData) {
          for (const [name, value] of init.body.entries()) {
            if (value instanceof File)
              record.parts.push({
                name,
                filename: value.name,
                contentType: value.type,
                bytes: [...new Uint8Array(await value.arrayBuffer())],
              });
            else record.parts.push({ name, value: String(value) });
          }
        } else if (typeof init?.body === "string") record.body = init.body;
        sent.push(record);
        return fetch(input, init);
      };
      const provider = provider_mod.createOpenAiImageProvider({
        credentials: () => args.key,
        baseUrl: `${location.origin}/api/openai`,
        models,
        fetch: spy,
      });
      const material = (b: string, roles: string[], id: string, revision: number) => ({
        identity: { id, incarnation: "ws", revision },
        roles,
        bytes: decode(b),
      });
      const prepared = provider.prepare({
        kind: "edit",
        role: "object",
        model: "test-image-tiny",
        prompt: "put the reference style on the asset",
        size: "16x16",
        quality: "low",
        background: "transparent",
        inputFidelity: "high",
        asset: material(args.png16, ["exact-source"], "asset-1", 3),
        references: [
          material(args.png2, ["style"], "ref-1", 1),
          material(args.png1, ["mood"], "ref-2", 7),
        ],
        mask: { bytes: decode(args.mask16) },
      });
      const summary = {
        endpoint: prepared.summary.endpoint,
        transport: prepared.summary.transport,
        imageIds: prepared.summary.images.map((i) => i.identity.id),
        roles: prepared.summary.images.map((i) => [...i.roles]),
        maskHash: prepared.summary.mask?.hash ?? null,
        total: prepared.summary.totalInputBytes,
      };
      try {
        const offer = await provider.submit(prepared);
        return { ok: true as const, summary, transparent: offer.transparent, sent };
      } catch (error) {
        return {
          ok: false as const,
          summary,
          reason: error instanceof provider_mod.OpenAiImageError ? error.reason : String(error),
          sent,
        };
      }
    },
    {
      key: "sk-e2e-secret",
      models: modelsArg,
      png16: b64(PNG_16x16),
      png2: b64(PNG_2x2),
      png1: b64(PNG_1x1),
      mask16: b64(MASK_16x16),
    },
  );

  expect(outcome.ok).toBe(true);
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.url).toMatch(/\/api\/openai\/v1\/images\/edits$/);
  expect(request.headers["authorization"]).toBe("Bearer sk-e2e-secret");
  expect(request.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  expect(outcome.sent).toHaveLength(1);
  const wire = outcome.sent[0]!;
  expect(wire.headers["authorization"]).toBe("Bearer sk-e2e-secret");
  // No content-type travels on the adapter's headers: the runtime supplies
  // the multipart boundary itself.
  expect(wire.headers["content-type"]).toBeUndefined();
  const partNames = wire.parts.map((p) => p.name);
  expect(partNames).toEqual([
    "model",
    "prompt",
    "n",
    "size",
    "quality",
    "background",
    "output_format",
    "input_fidelity",
    "image[]",
    "image[]",
    "image[]",
    "mask",
  ]);
  const field = (name: string) =>
    wire.parts.filter((p) => "value" in p).find((p) => p.name === name);
  expect(field("model")).toMatchObject({ value: "test-image-tiny" });
  expect(field("prompt")).toMatchObject({ value: "put the reference style on the asset" });
  expect(field("n")).toMatchObject({ value: "1" });
  expect(field("size")).toMatchObject({ value: "16x16" });
  expect(field("quality")).toMatchObject({ value: "low" });
  expect(field("background")).toMatchObject({ value: "transparent" });
  expect(field("output_format")).toMatchObject({ value: "png" });
  expect(field("input_fidelity")).toMatchObject({ value: "high" });
  const images = wire.parts.filter((p) => p.name === "image[]");
  const expected = [PNG_16x16, PNG_2x2, PNG_1x1];
  for (let i = 0; i < 3; i++) {
    const part = images[i]!;
    if ("bytes" in part) {
      expect(part.filename).toBe(`image-${i}.png`);
      expect(part.contentType).toBe("image/png");
      expect(part.bytes).toEqual([...expected[i]!]);
    }
  }
  const mask = wire.parts.find((p) => p.name === "mask");
  if (mask && "bytes" in mask) {
    expect(mask.filename).toBe("mask.png");
    expect(mask.contentType).toBe("image/png");
    expect(mask.bytes).toEqual([...MASK_16x16]);
  }
  if (outcome.ok) {
    expect(outcome.summary).toEqual({
      endpoint: "/v1/images/edits",
      transport: "multipart",
      imageIds: ["asset-1", "ref-1", "ref-2"],
      roles: [["exact-source"], ["style"], ["mood"]],
      maskHash: sha256Hex(MASK_16x16),
      total: PNG_16x16.length + PNG_2x2.length + PNG_1x1.length + MASK_16x16.length,
    });
    expect(outcome.transparent).toBe(true);
  }
});

test("handle discipline, byte ownership and local refusals hold in a real browser @webkit-desktop", async ({
  page,
}) => {
  const requests: RecordedRequest[] = [];
  // The gated edit asks 16x16, the replayed prepared submit asks 1x1.
  await mockApi(page, [fulfillImage(PNG_16x16), fulfillImage(PNG_1x1)], requests);
  const outcome = await page.evaluate(
    async (args) => {
      const provider_mod = await import("/src/studio/creative/openaiImageProvider.ts");
      const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const models = { ...provider_mod.OPENAI_IMAGE_MODELS, ...args.models };
      const sent: {
        url: string;
        body: string | null;
        parts: (
          | { name: string; filename: string; contentType: string; bytes: number[] }
          | { name: string; value: string }
        )[];
      }[] = [];
      const spy: typeof fetch = async (input, init) => {
        const record: (typeof sent)[number] = { url: String(input), body: null, parts: [] };
        if (init?.body instanceof FormData) {
          for (const [name, value] of init.body.entries()) {
            if (value instanceof File)
              record.parts.push({
                name,
                filename: value.name,
                contentType: value.type,
                bytes: [...new Uint8Array(await value.arrayBuffer())],
              });
            else record.parts.push({ name, value: String(value) });
          }
        } else if (typeof init?.body === "string") record.body = init.body;
        sent.push(record);
        return fetch(input, init);
      };
      const provider = provider_mod.createOpenAiImageProvider({
        credentials: () => args.key,
        baseUrl: `${location.origin}/api/openai`,
        models,
        fetch: spy,
      });
      const reasonOf = (error: unknown) =>
        error instanceof provider_mod.OpenAiImageError ? error.reason : "foreign";
      const refuse = async (promise: Promise<unknown>) => promise.then(() => "resolved", reasonOf);
      const failPrepare = (request: unknown) => {
        try {
          provider.prepare(request as never);
          return "prepared";
        } catch (error) {
          return reasonOf(error);
        }
      };
      const results: Record<string, unknown> = {};
      // Forged, cross-instance and replayed handles are all stale.
      results["forged"] = await refuse(provider.submit({ summary: {} } as never));
      const other = provider_mod.createOpenAiImageProvider({
        credentials: () => args.key,
        baseUrl: `${location.origin}/api/openai`,
        models,
      });
      results["crossInstance"] = await refuse(
        provider.submit(other.prepare(args.request) as never),
      );
      // A live request mutation after prepare cannot widen what leaves.
      const request = { ...args.request };
      const prepared = provider.prepare(request);
      (request as { prompt: string }).prompt = "an entirely different picture";
      // Mutating the offered array afterwards cannot change what leaves.
      const editable = decode(args.png16).slice();
      const edit = provider.prepare({
        kind: "edit",
        role: "room",
        model: "test-image-tiny",
        prompt: "recolour",
        size: "16x16",
        quality: "low",
        background: "opaque",
        asset: { identity: args.identity, roles: ["exact-source"], bytes: editable },
      });
      editable.fill(0xee);
      // One job at a time: the second submit is busy, not consumed.
      const slow = provider.submit(edit);
      const clash = await refuse(provider.submit(prepared));
      results["busy"] = clash;
      await slow.then(
        (offer) => {
          results["secondOffer"] = offer.width;
        },
        (error) => {
          results["secondError"] = reasonOf(error);
        },
      );
      // The refused handle stayed usable; mutating the request did not widen it.
      const offer = await provider.submit(prepared);
      results["offerPrompt"] = offer.summary.prompt;
      results["replay"] = await refuse(provider.submit(prepared));
      // Typed refusals before any fetch.
      results["badModel"] = failPrepare({ ...args.request, model: "not-a-model" });
      results["badBackground"] = failPrepare({
        ...args.request,
        background: "transparent",
        model: "gpt-image-2",
        size: "1024x1024",
      });
      results["badMask"] = failPrepare({
        kind: "edit",
        role: "room",
        model: "test-image-tiny",
        prompt: "x",
        size: "16x16",
        quality: "low",
        background: "opaque",
        asset: { identity: args.identity, roles: [], bytes: decode(args.png16) },
        mask: { bytes: decode(args.png16) },
      });
      results["oversize"] = failPrepare({
        ...args.request,
        kind: "edit",
        size: "16x16",
        asset: {
          identity: args.identity,
          roles: [],
          bytes: new Uint8Array(8 * 1024 * 1024 + 1),
        },
      });
      results["summaryFrozen"] =
        Object.isFrozen(prepared.summary) && Object.isFrozen(prepared.summary.images);
      return { results, sent };
    },
    {
      key: "sk-e2e-secret",
      models: modelsArg,
      request: generateRequest,
      png16: b64(PNG_16x16),
      identity,
    },
  );

  const results = outcome.results;
  const sent = outcome.sent;
  expect(results["forged"]).toBe("stale");
  expect(results["crossInstance"]).toBe("stale");
  expect(results["busy"]).toBe("busy");
  expect(results["secondOffer"]).toBe(16);
  expect(results["offerPrompt"]).toBe("a lighthouse at dusk");
  expect(results["replay"]).toBe("stale");
  expect(results["badModel"]).toBe("unsupported");
  expect(results["badBackground"]).toBe("unsupported");
  expect(results["badMask"]).toBe("invalid-request");
  expect(results["oversize"]).toBe("invalid-request");
  expect(results["summaryFrozen"]).toBe(true);
  // Two wire requests: the gated edit and the replay-safe prepared submit.
  expect(requests).toHaveLength(2);
  expect(sent).toHaveLength(2);
  // The edit's FormData carried the bytes as offered at prepare time.
  const image = sent[0]!.parts.find((p) => p.name === "image[]");
  if (image && "bytes" in image) expect(image.bytes).toEqual([...PNG_16x16]);
  // The second request kept the original prompt despite request mutation.
  expect(JSON.parse(sent[1]!.body!)["prompt"]).toBe("a lighthouse at dusk");
});

test("no-key, preparation and plain file intake never touch the provider @webkit-desktop", async ({
  page,
}) => {
  const requests: RecordedRequest[] = [];
  await mockApi(page, [], requests);
  const outcome = await page.evaluate(
    async (args) => {
      const provider_mod = await import("/src/studio/creative/openaiImageProvider.ts");
      const intake_mod = await import("/src/references/creativeImageDecode.ts");
      const models = { ...provider_mod.OPENAI_IMAGE_MODELS, ...args.models };
      const provider = provider_mod.createOpenAiImageProvider({
        credentials: () => null,
        baseUrl: `${location.origin}/api/openai`,
        models,
      });
      const prepared = provider.prepare(args.request);
      let refused = "";
      try {
        await provider.submit(prepared);
      } catch (error) {
        refused = error instanceof provider_mod.OpenAiImageError ? error.reason : "foreign";
      }
      const png = Uint8Array.from(atob(args.png1), (c) => c.charCodeAt(0));
      let intakeReason: string;
      try {
        await intake_mod.decodeCreativeImage(new Blob([png], { type: "image/png" }));
        intakeReason = "ok";
      } catch (error) {
        intakeReason = error instanceof intake_mod.CreativeImageError ? error.reason : "foreign";
      }
      return { refused, intakeReason };
    },
    {
      models: modelsArg,
      request: generateRequest,
      png1: b64(PNG_1x1),
    },
  );
  expect(outcome.refused).toBe("no-key");
  // The real browser decodes the 1x1 PNG with no provider involved.
  expect(outcome.intakeReason).toBe("ok");
  expect(requests).toHaveLength(0);
});

test("cancel, timeout and late answers stay contained @webkit-desktop", async ({ page }) => {
  const requests: RecordedRequest[] = [];
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const onWire = Promise.withResolvers<void>();
  const timeoutOnWire = Promise.withResolvers<void>();
  const cancelledAnswer = Promise.withResolvers<void>();
  const timeoutAnswer = Promise.withResolvers<void>();
  const lateReplies = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  await page.exposeFunction("imageRequestOnWire", () => onWire.promise);
  await mockApi(
    page,
    [
      async (route) => {
        onWire.resolve();
        await cancelledAnswer.promise;
        await route.fulfill({ json: imageBody(PNG_1x1) }).catch(() => {});
        lateReplies[0]!.resolve();
      },
      async (route) => {
        timeoutOnWire.resolve();
        await timeoutAnswer.promise;
        await route.fulfill({ json: imageBody(PNG_1x1) }).catch(() => {});
        lateReplies[1]!.resolve();
      },
      fulfillImage(PNG_1x1),
    ],
    requests,
  );
  const pendingOutcome = page.evaluate(
    async (args) => {
      const provider_mod = await import("/src/studio/creative/openaiImageProvider.ts");
      const models = { ...provider_mod.OPENAI_IMAGE_MODELS, ...args.models };
      const provider = provider_mod.createOpenAiImageProvider({
        credentials: () => args.key,
        baseUrl: `${location.origin}/api/openai`,
        models,
        timeoutMs: 120,
      });
      const reasonOf = (error: unknown) =>
        error instanceof provider_mod.OpenAiImageError ? error.reason : "foreign";
      const controller = new AbortController();
      const pending = provider.submit(provider.prepare(args.request), {
        signal: controller.signal,
      });
      await (Reflect.get(window, "imageRequestOnWire") as () => Promise<void>)();
      controller.abort();
      const cancelled = await pending.then(() => "resolved", reasonOf);
      const timedOut = await provider
        .submit(provider.prepare(args.request))
        .then(() => "resolved", reasonOf);
      const after = await provider
        .submit(provider.prepare(args.request))
        .then((offer) => `ok:${offer.width}`, reasonOf);
      return { cancelled, timedOut, after };
    },
    { key: "sk-e2e-secret", models: modelsArg, request: generateRequest },
  );
  await timeoutOnWire.promise;
  await page.clock.runFor(120);
  const outcome = await pendingOutcome;
  cancelledAnswer.resolve();
  timeoutAnswer.resolve();
  await Promise.all(lateReplies.map((reply) => reply.promise));
  expect(outcome.cancelled).toBe("cancelled");
  expect(outcome.timedOut).toBe("timeout");
  expect(outcome.after).toBe("ok:1");
  expect(requests.length).toBeGreaterThanOrEqual(2);
});

test("response validation refuses oversize, bad base64 and wrong images @webkit-desktop", async ({
  page,
}) => {
  const requests: RecordedRequest[] = [];
  const jpeg2x2 = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02, 0x03, 0x01, 0x11,
    0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
  ]);
  await mockApi(
    page,
    [
      // A body past the response ceiling, streamed to the page.
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: Buffer.alloc(13 * 1024 * 1024, 0x41),
        }),
      (route) => route.fulfill({ json: { data: [{ b64_json: "not base64!" }] } }),
      (route) => route.fulfill({ json: { data: [{ b64_json: jpeg2x2.toString("base64") }] } }),
      (route) => route.fulfill({ json: { data: [{ url: "https://cdn.example/x.png" }] } }),
      (route) => route.fulfill({ json: { data: [] } }),
      fulfillImage(PNG_1x1),
    ],
    requests,
  );
  const outcome = await page.evaluate(
    async (args) => {
      const provider_mod = await import("/src/studio/creative/openaiImageProvider.ts");
      const models = { ...provider_mod.OPENAI_IMAGE_MODELS, ...args.models };
      const provider = provider_mod.createOpenAiImageProvider({
        credentials: () => args.key,
        baseUrl: `${location.origin}/api/openai`,
        models,
      });
      const reasonOf = async () =>
        provider.submit(provider.prepare(args.request)).then(
          () => "resolved",
          (error) =>
            `${error instanceof provider_mod.OpenAiImageError ? error.reason : "foreign"}:${
              error instanceof provider_mod.OpenAiImageError ? (error.code ?? "") : ""
            }`,
        );
      return {
        oversize: await reasonOf(),
        badBase64: await reasonOf(),
        jpeg: await reasonOf(),
        urlOnly: await reasonOf(),
        noData: await reasonOf(),
        fine: await reasonOf(),
      };
    },
    { key: "sk-e2e-secret", models: modelsArg, request: generateRequest },
  );
  expect(outcome.oversize).toBe("invalid-output:oversize");
  expect(outcome.badBase64).toBe("invalid-output:base64");
  expect(outcome.jpeg).toBe("invalid-output:format");
  expect(outcome.urlOnly).toBe("invalid-output:missing-image");
  expect(outcome.noData).toBe("invalid-output:count");
  expect(outcome.fine).toBe("resolved");
  expect(requests).toHaveLength(6);
});

test("provider errors classify and never echo the key; usage stays honest @webkit-desktop", async ({
  page,
}) => {
  const requests: RecordedRequest[] = [];
  await mockApi(
    page,
    [
      (route) =>
        route.fulfill({
          status: 401,
          contentType: "application/json",
          json: { error: { code: "invalid_api_key", message: "key sk-e2e-secret refused" } },
        }),
      (route) =>
        route.fulfill({
          status: 429,
          contentType: "application/json",
          json: { error: { code: "rate_limit_exceeded", message: "slow down" } },
        }),
      // Success without usage, then success with it.
      fulfillImage(PNG_1x1),
      fulfillImage(PNG_1x1, { usage: { total_tokens: 9 } }),
    ],
    requests,
  );
  const outcome = await page.evaluate(
    async (args) => {
      const provider_mod = await import("/src/studio/creative/openaiImageProvider.ts");
      const models = { ...provider_mod.OPENAI_IMAGE_MODELS, ...args.models };
      const provider = provider_mod.createOpenAiImageProvider({
        credentials: () => args.key,
        baseUrl: `${location.origin}/api/openai`,
        models,
      });
      const one = () =>
        provider.submit(provider.prepare(args.request)).then(
          (offer) => ({ resolved: true as const, usage: offer.usage ?? null }),
          (error: unknown) => ({
            resolved: false as const,
            reason: error instanceof provider_mod.OpenAiImageError ? error.reason : "foreign",
            message: error instanceof Error ? error.message : String(error),
            serialized: JSON.stringify(error instanceof Error ? error : { e: String(error) }),
          }),
        );
      return {
        auth: await one(),
        rate: await one(),
        noUsage: await one(),
        withUsage: await one(),
      };
    },
    { key: "sk-e2e-secret", models: modelsArg, request: generateRequest },
  );
  expect(outcome.auth.resolved).toBe(false);
  if (!outcome.auth.resolved) {
    expect(outcome.auth.reason).toBe("auth");
    expect(outcome.auth.message).not.toContain("sk-e2e-secret");
    expect(outcome.auth.serialized).not.toContain("sk-e2e-secret");
  }
  expect(outcome.rate.resolved).toBe(false);
  if (!outcome.rate.resolved) expect(outcome.rate.reason).toBe("rate-limit");
  expect(outcome.noUsage.resolved).toBe(true);
  if (outcome.noUsage.resolved) expect(outcome.noUsage.usage).toBeNull();
  expect(outcome.withUsage.resolved).toBe(true);
  if (outcome.withUsage.resolved) expect(outcome.withUsage.usage).toEqual({ totalTokens: 9 });
  expect(requests).toHaveLength(4);
});
