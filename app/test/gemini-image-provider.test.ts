import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePngRgba } from "../../src/creative/composite.ts";
import {
  GEMINI_IMAGE_MODELS,
  createGeminiImageProvider,
  createMultiImageProvider,
} from "../src/studio/creative/geminiImageProvider.ts";
import {
  OPENAI_IMAGE_MODELS,
  OpenAiImageError,
  createOpenAiImageProvider,
} from "../src/studio/creative/openaiImageProvider.ts";

function tinyPng(width = 8, height = 6): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([0, 170, 170, 255], i);
  return encodePngRgba(width, height, rgba);
}

/** Minimal valid 1×1 baseline JPEG (SOI + APP0 + DQT + SOF0 + EOI). */
function tinyJpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x20, 0x01, 0x01, 0x11,
    0x00, 0xff, 0xd9,
  ]);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

test("Gemini image provider sends x-goog-api-key, maps aspectRatio/imageSize, and parses PNG + JPEG offers", async () => {
  const calls: { url: string; key: string | null; body: Record<string, unknown> }[] = [];
  let replyFormat: "png" | "jpeg" = "png";
  const provider = createGeminiImageProvider({
    credentials: () => "gm-image-secret",
    baseUrl: "https://example.test",
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        key: new Headers(init?.headers).get("x-goog-api-key"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      const bytes = replyFormat === "png" ? tinyPng(12, 8) : tinyJpeg();
      return new Response(
        JSON.stringify({
          responseId: "resp-img-1",
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "planning layout", thought: true },
                  {
                    inlineData: {
                      mimeType: replyFormat === "png" ? "image/png" : "image/jpeg",
                      data: toBase64(bytes),
                    },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 120,
            candidatesTokenCount: 1290,
            thoughtsTokenCount: 40,
            totalTokenCount: 1450,
            promptTokensDetails: [{ modality: "TEXT", tokenCount: 120 }],
            candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1290 }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.deepEqual(Object.keys(provider.models), ["gemini-3.1-flash-image", "gemini-3-pro-image"]);
  assert.equal(GEMINI_IMAGE_MODELS["gemini-3.1-flash-image"]?.mask, false);
  assert.equal(GEMINI_IMAGE_MODELS["gemini-3-pro-image"]?.provider, "gemini");

  const prepared = provider.prepare({
    kind: "generate",
    role: "room",
    model: "gemini-3.1-flash-image",
    prompt: "A moonlit lighthouse",
    size: "1536x1024",
    quality: "medium",
    background: "opaque",
  });
  assert.equal(prepared.summary.provider, "gemini");
  assert.equal(prepared.summary.endpoint, "/v1beta/models/gemini-3.1-flash-image:generateContent");
  const offer = await provider.submit(prepared);
  assert.equal(offer.format, "png");
  assert.equal(offer.width, 12);
  assert.equal(offer.height, 8);
  assert.equal(offer.encoded.mime, "image/png");
  assert.deepEqual(offer.usage, {
    inputTokens: 120,
    outputTokens: 1330,
    totalTokens: 1450,
    inputTextTokens: 120,
    inputImageTokens: 0,
    outputImageTokens: 1290,
    outputTextTokens: 40,
  });
  assert.equal(
    calls[0]?.url,
    "https://example.test/v1beta/models/gemini-3.1-flash-image:generateContent",
  );
  assert.equal(calls[0]?.key, "gm-image-secret");
  assert.deepEqual(calls[0]?.body["generationConfig"], {
    responseModalities: ["IMAGE"],
    imageConfig: { aspectRatio: "3:2", imageSize: "1K" },
  });

  // Consumed handle refuses stale.
  await assert.rejects(
    provider.submit(prepared),
    (err: unknown) => err instanceof OpenAiImageError && err.reason === "stale",
  );

  // Nano Banana Pro high quality maps to 4K and accepts JPEG output without OpenAI size lock.
  replyFormat = "jpeg";
  const proPrepared = provider.prepare({
    kind: "variation",
    role: "character",
    model: "gemini-3-pro-image",
    prompt: "Give her a red cloak",
    size: "1024x1536",
    quality: "high",
    background: "opaque",
    asset: {
      identity: { id: "a1", incarnation: "run", revision: 1 },
      roles: ["exact-source"],
      bytes: tinyPng(4, 4),
    },
  });
  const proOffer = await provider.submit(proPrepared);
  assert.equal(proOffer.format, "jpeg");
  assert.equal(proOffer.encoded.mime, "image/jpeg");
  assert.equal(proOffer.width, 32);
  assert.equal(proOffer.height, 16);
  assert.deepEqual(calls[1]?.body["generationConfig"], {
    responseModalities: ["IMAGE"],
    imageConfig: { aspectRatio: "2:3", imageSize: "4K" },
  });
  const sentParts = (calls[1]?.body["contents"] as { parts: unknown[] }[])[0]!.parts;
  assert.equal(sentParts.length, 2);
  assert.ok("inlineData" in (sentParts[0] as Record<string, unknown>));
});

test("Gemini image provider refuses mask edits locally, classifies HTTP/safety errors, and scrubs keys", async () => {
  const png = tinyPng(4, 4);
  let mode: "auth" | "quota" | "safety" | "no-image" = "auth";
  const provider = createGeminiImageProvider({
    credentials: () => "gm-super-secret",
    baseUrl: "https://example.test",
    fetch: async () => {
      if (mode === "auth")
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: "API key not valid: gm-super-secret",
              status: "INVALID_ARGUMENT",
              details: [{ reason: "API_KEY_INVALID" }],
            },
          }),
          { status: 400 },
        );
      if (mode === "quota")
        return new Response(
          JSON.stringify({
            error: { code: 429, message: "Too many requests", status: "RESOURCE_EXHAUSTED" },
          }),
          { status: 429 },
        );
      if (mode === "safety")
        return new Response(
          JSON.stringify({
            candidates: [{ finishReason: "IMAGE_SAFETY", content: { role: "model", parts: [] } }],
          }),
        );
      return new Response(
        JSON.stringify({
          candidates: [
            { finishReason: "STOP", content: { role: "model", parts: [{ text: "no img" }] } },
          ],
        }),
      );
    },
  });

  assert.throws(
    () =>
      provider.prepare({
        kind: "edit",
        role: "room",
        model: "gemini-3.1-flash-image",
        prompt: "Replace the sky",
        size: "1024x1024",
        quality: "low",
        background: "opaque",
        asset: { identity: { id: "a", incarnation: "r", revision: 0 }, roles: [], bytes: png },
        mask: { bytes: png },
      }),
    (err: unknown) =>
      err instanceof OpenAiImageError && err.reason === "unsupported" && err.code === "mask",
  );

  const req = () =>
    provider.prepare({
      kind: "generate",
      role: "room",
      model: "gemini-3.1-flash-image",
      prompt: "Forest",
      size: "1024x1024",
      quality: "low",
      background: "opaque",
    });

  await assert.rejects(provider.submit(req()), (err: unknown) => {
    assert.ok(err instanceof OpenAiImageError);
    assert.equal(err.reason, "auth");
    assert.equal(err.provider, "gemini");
    assert.ok(!err.message.includes("gm-super-secret"), "secret key is scrubbed from error text");
    return true;
  });

  mode = "quota";
  await assert.rejects(
    provider.submit(req()),
    (err: unknown) => err instanceof OpenAiImageError && err.reason === "rate-limit",
  );
  mode = "safety";
  await assert.rejects(
    provider.submit(req()),
    (err: unknown) => err instanceof OpenAiImageError && err.reason === "user-error",
  );
  mode = "no-image";
  await assert.rejects(
    provider.submit(req()),
    (err: unknown) => err instanceof OpenAiImageError && err.reason === "invalid-output",
  );
});

test("multi-image provider exposes both catalogs and routes each model to its owning provider", async () => {
  const hits: string[] = [];
  const openai = createOpenAiImageProvider({
    credentials: () => "sk-open",
    baseUrl: "https://openai.test",
    fetch: async (input) => {
      hits.push(String(input));
      return new Response(JSON.stringify({ data: [{ b64_json: toBase64(tinyPng(1024, 1024)) }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const gemini = createGeminiImageProvider({
    credentials: () => "gm-key",
    baseUrl: "https://gemini.test",
    fetch: async (input) => {
      hits.push(String(input));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ inlineData: { mimeType: "image/png", data: toBase64(tinyPng(16, 16)) } }],
              },
              finishReason: "STOP",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const multi = createMultiImageProvider([openai, gemini]);
  assert.deepEqual(Object.keys(multi.models), [
    ...Object.keys(OPENAI_IMAGE_MODELS),
    ...Object.keys(GEMINI_IMAGE_MODELS),
  ]);

  const openPrepared = multi.prepare({
    kind: "generate",
    role: "room",
    model: "gpt-image-2.6-sunburst",
    prompt: "Castle",
    size: "1024x1024",
    quality: "low",
    background: "opaque",
  });
  await multi.submit(openPrepared);

  const gemPrepared = multi.prepare({
    kind: "generate",
    role: "room",
    model: "gemini-3.1-flash-image",
    prompt: "Castle",
    size: "1024x1024",
    quality: "low",
    background: "opaque",
  });
  await multi.submit(gemPrepared);

  assert.deepEqual(hits, [
    "https://openai.test/v1/images/generations",
    "https://gemini.test/v1beta/models/gemini-3.1-flash-image:generateContent",
  ]);

  // Cross-provider busy check: while OpenAI is in flight, Gemini submit refuses busy.
  let release!: () => void;
  const heldOpenAi = createOpenAiImageProvider({
    credentials: () => "sk-open",
    baseUrl: "https://openai.test",
    fetch: () =>
      new Promise<Response>((resolve) => {
        release = () =>
          resolve(
            new Response(JSON.stringify({ data: [{ b64_json: toBase64(tinyPng(1024, 1024)) }] }), {
              headers: { "content-type": "application/json" },
            }),
          );
      }),
  });
  const busyMulti = createMultiImageProvider([heldOpenAi, gemini]);
  const p1 = busyMulti.prepare({
    kind: "generate",
    role: "room",
    model: "gpt-image-2.6-sunburst",
    prompt: "Keep",
    size: "1024x1024",
    quality: "low",
    background: "opaque",
  });
  const p2 = busyMulti.prepare({
    kind: "generate",
    role: "room",
    model: "gemini-3.1-flash-image",
    prompt: "Tower",
    size: "1024x1024",
    quality: "low",
    background: "opaque",
  });
  const inflight = busyMulti.submit(p1);
  await assert.rejects(
    busyMulti.submit(p2),
    (err: unknown) => err instanceof OpenAiImageError && err.reason === "busy",
  );
  release();
  await inflight;
});
