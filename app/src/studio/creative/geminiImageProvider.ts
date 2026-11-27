/**
 * Optional BYOK Google Gemini image transport for the creative workflow.
 *
 * Mirrors the single-submit, frozen-summary, WeakMap-owned boundary of
 * `openaiImageProvider.ts` over Gemini's `v1beta/models/{model}:generateContent`
 * endpoint (`x-goog-api-key` header, `responseModalities: ["IMAGE"]`).
 *
 * Gemini image models accept prompt-only generation and multimodal image
 * variations with reference images, and do not take PNG edit masks. Returned
 * images may be PNG, JPEG, or WebP and are validated through the shared
 * creative image header inspector before handoff to canonical intake.
 */
import { sha256Hex } from "../../../../src/crypto.ts";
import {
  CREATIVE_IMAGE_MIME,
  inspectCreativeImageHeader,
  type CreativeImageFormat,
} from "../../../../src/creative/imageHeader.ts";
import {
  OPENAI_IMAGE_LIMITS,
  OpenAiImageError,
  type OpenAiImageBackground,
  type OpenAiImageFailure,
  type OpenAiImageKind,
  type OpenAiImageMaterial,
  type OpenAiImageModel,
  type OpenAiImageOffer,
  type OpenAiImageProvider,
  type OpenAiImageQuality,
  type OpenAiImageRequest,
  type OpenAiImageRole,
  type OpenAiImageSummary,
  type OpenAiImageUsage,
  type PreparedOpenAiImage,
} from "./openaiImageProvider.ts";

class MintedGeminiImageError extends OpenAiImageError {
  constructor(
    reason: OpenAiImageFailure,
    message: string,
    options?: {
      code?: string;
      status?: number;
      requestId?: string;
      possiblyCors?: boolean;
      cause?: unknown;
    },
  ) {
    super(reason, message, { ...options, provider: "gemini" });
  }
}

function isMinted(error: unknown): error is OpenAiImageError {
  return error instanceof MintedGeminiImageError;
}

const GEMINI_SIZES: readonly string[] = ["1024x1024", "1536x1024", "1024x1536"];
const GEMINI_QUALITIES: readonly OpenAiImageQuality[] = ["low", "medium", "high"];
const GEMINI_BACKGROUNDS: readonly OpenAiImageBackground[] = ["opaque"];

const ASPECT_RATIO_BY_SIZE: Record<string, string> = {
  "1024x1024": "1:1",
  "1536x1024": "3:2",
  "1024x1536": "2:3",
};

const IMAGE_SIZE_BY_MODEL: Record<string, Record<string, string>> = {
  "gemini-3.1-flash-image": { low: "512px", medium: "1K", high: "2K" },
  "gemini-3-pro-image": { low: "1K", medium: "2K", high: "4K" },
};

/**
 * Shipped Gemini image generation models:
 * - Nano Banana 2 (`gemini-3.1-flash-image`): fast, $0.50 input / $3 text / $60 image per 1M.
 * - Nano Banana Pro (`gemini-3-pro-image`): highest fidelity, $2 input / $12 text / $120 image per 1M.
 */
export const GEMINI_IMAGE_MODELS: Readonly<Record<string, OpenAiImageModel>> = Object.freeze({
  "gemini-3.1-flash-image": Object.freeze({
    id: "gemini-3.1-flash-image",
    label: "Gemini 3.1 Flash Image (Nano Banana 2)",
    provider: "gemini",
    edits: true,
    streaming: false,
    mask: false,
    inputFidelity: false,
    qualities: GEMINI_QUALITIES,
    sizes: GEMINI_SIZES,
    backgrounds: GEMINI_BACKGROUNDS,
  }),
  "gemini-3-pro-image": Object.freeze({
    id: "gemini-3-pro-image",
    label: "Gemini 3 Pro Image (Nano Banana Pro)",
    provider: "gemini",
    edits: true,
    streaming: false,
    mask: false,
    inputFidelity: false,
    qualities: GEMINI_QUALITIES,
    sizes: GEMINI_SIZES,
    backgrounds: GEMINI_BACKGROUNDS,
  }),
});

export interface GeminiImageProviderOptions {
  readonly credentials: () => string | null | undefined | Promise<string | null | undefined>;
  readonly fetch?: typeof fetch;
  readonly models?: Readonly<Record<string, OpenAiImageModel>>;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

const KINDS: readonly OpenAiImageKind[] = ["generate", "variation", "edit"];
const ROLES: readonly OpenAiImageRole[] = ["room", "character", "object", "inspiration"];

interface CapturedGeminiImage {
  readonly summary: OpenAiImageSummary["images"][number];
  readonly bytes: Uint8Array;
  readonly format: CreativeImageFormat;
}

interface CapturedGeminiRequest {
  readonly summary: OpenAiImageSummary;
  readonly endpoint: `/v1beta/models/${string}:generateContent`;
  readonly model: string;
  readonly prompt: string;
  readonly aspectRatio: string;
  readonly imageSize: string;
  readonly images: readonly CapturedGeminiImage[];
  consumed: boolean;
}

function invalidRequest(message: string, code: string): OpenAiImageError {
  return new MintedGeminiImageError("invalid-request", message, { code });
}

function unsupported(message: string, code: string): OpenAiImageError {
  return new MintedGeminiImageError("unsupported", message, { code });
}

function invalidOutput(message: string, code?: string): OpenAiImageError {
  return new MintedGeminiImageError("invalid-output", message, { ...(code ? { code } : {}) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedMessage(value: unknown, max: number, secret: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = secret === "" ? value : value.split(secret).join("[key]");
  const trimmed = safe.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

const B64_VALUES = new Int16Array(128).fill(-1);
{
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) B64_VALUES[alphabet.charCodeAt(i)] = i;
}

function decodeBase64Strict(text: string, maxBytes: number): Uint8Array {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0)
    throw invalidOutput("The provider returned malformed base64.", "base64");
  let padding = 0;
  if (compact.endsWith("==")) padding = 2;
  else if (compact.endsWith("=")) padding = 1;
  const byteLength = (compact.length / 4) * 3 - padding;
  if (byteLength < 1 || byteLength > maxBytes)
    throw invalidOutput(
      `The provider's image decodes past the ${maxBytes / 1024 / 1024} MB output bound.`,
      "oversize",
    );
  const out = new Uint8Array(byteLength);
  const lastQuartet = compact.length - 4;
  for (let i = 0; i < compact.length; i += 4) {
    const last = i === lastQuartet;
    let block = 0;
    for (let j = 0; j < 4; j++) {
      const code = compact.charCodeAt(i + j);
      if (code === 0x3d) {
        if (!last || j < 4 - padding)
          throw invalidOutput("The provider returned malformed base64.", "base64");
        block <<= 6;
        continue;
      }
      if (code >= 128 || B64_VALUES[code]! < 0)
        throw invalidOutput("The provider returned malformed base64.", "base64");
      block = (block << 6) | B64_VALUES[code]!;
    }
    const offset = (i / 4) * 3;
    if (offset < byteLength) out[offset] = (block >>> 16) & 0xff;
    if (offset + 1 < byteLength) out[offset + 1] = (block >>> 8) & 0xff;
    if (offset + 2 < byteLength) out[offset + 2] = block & 0xff;
  }
  return out;
}

function captureMaterial(
  material: OpenAiImageMaterial,
  offeredBytes: Uint8Array,
  label: string,
): CapturedGeminiImage {
  if (!material || typeof material !== "object")
    throw invalidRequest(`${label} must be an image material.`, "material");
  const bytes = offeredBytes.slice();
  const verdict = inspectCreativeImageHeader(bytes);
  if (!verdict.ok) throw invalidRequest(`${label}: ${verdict.message}`, verdict.reason);
  const mime = CREATIVE_IMAGE_MIME[verdict.header.format];
  const summary: OpenAiImageSummary["images"][number] = Object.freeze({
    identity: Object.freeze({ ...material.identity }),
    roles: Object.freeze(material.roles.map(String)),
    hash: sha256Hex(bytes),
    byteLength: bytes.length,
    mime,
    width: verdict.header.width,
    height: verdict.header.height,
  });
  return { summary, bytes, format: verdict.header.format };
}

function capture(
  request: OpenAiImageRequest,
  models: Readonly<Record<string, OpenAiImageModel>>,
): CapturedGeminiRequest {
  if (!isRecord(request)) throw invalidRequest("A generation request is required.", "request");
  const { kind, role, model, prompt, size, quality, background, inputFidelity } = request;
  if (!KINDS.includes(kind)) throw invalidRequest("Unknown generation kind.", "kind");
  if (!ROLES.includes(role)) throw invalidRequest("Unknown generation role.", "role");
  const capability = Object.hasOwn(models, model) ? models[model] : undefined;
  if (capability === undefined)
    throw unsupported(`The model "${String(model)}" is not available.`, "model");
  if (typeof prompt !== "string" || prompt.trim() === "")
    throw invalidRequest("Write a prompt before generating.", "prompt");
  if (prompt.length > OPENAI_IMAGE_LIMITS.maxPromptLength)
    throw invalidRequest(
      `The prompt is ${prompt.length} characters; the limit is ${OPENAI_IMAGE_LIMITS.maxPromptLength}.`,
      "prompt-length",
    );
  if (!capability.sizes.includes(size))
    throw unsupported(`Size "${size}" is not supported by ${capability.label}.`, "size");
  if (!capability.qualities.includes(quality))
    throw unsupported(`Quality "${quality}" is not supported by ${capability.label}.`, "quality");
  if (!capability.backgrounds.includes(background))
    throw unsupported(
      `Background "${background}" is not supported by ${capability.label}.`,
      "background",
    );
  if (inputFidelity !== undefined && !capability.inputFidelity)
    throw unsupported(`Input fidelity is not supported by ${capability.label}.`, "input-fidelity");
  if (kind === "edit" || request.mask !== undefined)
    throw unsupported(
      `Mask editing is not supported by ${capability.label}. Choose an OpenAI image model for mask editing.`,
      "mask",
    );

  const asset = request.asset;
  const references = request.references ? [...request.references] : [];
  if (kind === "variation" && asset === undefined)
    throw invalidRequest("A variation needs a source image.", "asset");
  if (kind === "generate" && asset !== undefined)
    throw invalidRequest("A new image does not take an edited asset.", "asset");
  const inputCount = (asset ? 1 : 0) + references.length;
  if (inputCount > 0 && !capability.edits)
    throw unsupported(`${capability.label} does not accept reference images.`, "edits");
  if (inputCount > OPENAI_IMAGE_LIMITS.maxInputImages)
    throw invalidRequest(
      `Choose at most ${OPENAI_IMAGE_LIMITS.maxInputImages} input images.`,
      "input-count",
    );

  const offeredMaterials = [
    ...(asset ? [["The asset", asset] as const] : []),
    ...references.map((m, i) => [`Reference ${i + 1}`, m] as const),
  ];
  const offeredBytes: Uint8Array[] = [];
  let totalInputBytes = 0;
  for (const [label, m] of offeredMaterials) {
    const bytes = m?.bytes;
    if (!(bytes instanceof Uint8Array))
      throw invalidRequest(`${label} must carry its encoded bytes.`, "bytes");
    offeredBytes.push(bytes);
    if (bytes.length > OPENAI_IMAGE_LIMITS.maxEncodedBytes)
      throw invalidRequest(
        `${label} is ${Math.ceil(bytes.length / 1024 / 1024)} MB; inputs accept up to ${OPENAI_IMAGE_LIMITS.maxEncodedBytes / 1024 / 1024} MB each.`,
        "oversize",
      );
    totalInputBytes += bytes.length;
  }
  if (totalInputBytes > OPENAI_IMAGE_LIMITS.maxInputBytesTotal)
    throw invalidRequest(
      `Those inputs total ${Math.ceil(totalInputBytes / 1024 / 1024)} MB; requests accept up to ${OPENAI_IMAGE_LIMITS.maxInputBytesTotal / 1024 / 1024} MB.`,
      "oversize",
    );

  const images = offeredMaterials.map(([label, m], i) =>
    captureMaterial(m, offeredBytes[i]!, label),
  );
  const endpoint: `/v1beta/models/${string}:generateContent` = `/v1beta/models/${encodeURIComponent(capability.id)}:generateContent`;
  const aspectRatio = ASPECT_RATIO_BY_SIZE[size] ?? "1:1";
  const imageSize = IMAGE_SIZE_BY_MODEL[capability.id]?.[quality] ?? "1K";
  const summary: OpenAiImageSummary = {
    provider: "gemini",
    kind,
    role,
    model: capability.id,
    endpoint,
    transport: "json",
    prompt,
    promptCodeUnits: prompt.length,
    count: 1,
    size,
    quality,
    background,
    outputFormat: "image",
    images: Object.freeze(images.map((image) => image.summary)),
    totalInputBytes,
    limits: OPENAI_IMAGE_LIMITS,
  };
  return {
    summary,
    endpoint,
    model: capability.id,
    prompt,
    aspectRatio,
    imageSize,
    images,
    consumed: false,
  };
}

async function readBodyBounded(response: Response): Promise<string> {
  const max = OPENAI_IMAGE_LIMITS.maxResponseBytes;
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max)
    throw invalidOutput("The provider's response exceeded the output size bound.", "oversize");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw invalidOutput("The provider's response exceeded the output size bound.", "oversize");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function classifyHttpError(status: number, body: string, secret: string): OpenAiImageError {
  let message = boundedMessage(body, 300, secret) ?? `HTTP ${status}`;
  let statusCode: string | undefined;
  let detailReason: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    const err = isRecord(parsed) && isRecord(parsed["error"]) ? parsed["error"] : undefined;
    if (err) {
      message = boundedMessage(err["message"], 300, secret) ?? message;
      statusCode = typeof err["status"] === "string" ? err["status"] : undefined;
      if (Array.isArray(err["details"])) {
        for (const item of err["details"]) {
          if (isRecord(item) && typeof item["reason"] === "string") {
            detailReason = item["reason"];
            break;
          }
        }
      }
    }
  } catch {
    // Non-JSON proxy or gateway error; classify by status below.
  }
  const code = detailReason ?? statusCode;
  if (
    detailReason === "API_KEY_INVALID" ||
    statusCode === "UNAUTHENTICATED" ||
    status === 401 ||
    /api key not valid|api_key_invalid/i.test(message)
  )
    return new MintedGeminiImageError("auth", message, { code: code ?? "API_KEY_INVALID", status });
  if (
    statusCode === "PERMISSION_DENIED" ||
    status === 403 ||
    status === 404 ||
    statusCode === "NOT_FOUND"
  )
    return new MintedGeminiImageError("model-access", message, {
      ...(code ? { code } : {}),
      status,
    });
  if (status === 429 || statusCode === "RESOURCE_EXHAUSTED") {
    const isQuota = /billing|quota.*exhausted|plan/i.test(message);
    return new MintedGeminiImageError(isQuota ? "quota" : "rate-limit", message, {
      code: code ?? "RESOURCE_EXHAUSTED",
      status,
    });
  }
  if (status >= 400 && status < 500)
    return new MintedGeminiImageError("user-error", message, { ...(code ? { code } : {}), status });
  return new MintedGeminiImageError("transport", message, { ...(code ? { code } : {}), status });
}

function parseGeminiUsage(raw: unknown, hadImageInput: boolean): OpenAiImageUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const promptTotal = num(raw["promptTokenCount"]);
  const candidatesTotal = num(raw["candidatesTokenCount"]);
  const thoughts = num(raw["thoughtsTokenCount"]) ?? 0;
  const totalTokens = num(raw["totalTokenCount"]);

  let inputTextTokens: number | undefined;
  let inputImageTokens: number | undefined;
  if (Array.isArray(raw["promptTokensDetails"])) {
    let textSum = 0;
    let imageSum = 0;
    let sawDetail = false;
    for (const detail of raw["promptTokensDetails"]) {
      if (!isRecord(detail)) continue;
      const count = num(detail["tokenCount"]);
      if (count === undefined) continue;
      sawDetail = true;
      if (detail["modality"] === "IMAGE") imageSum += count;
      else textSum += count;
    }
    if (sawDetail) {
      inputTextTokens = textSum;
      inputImageTokens = imageSum;
    }
  }
  if (inputTextTokens === undefined && promptTotal !== undefined) {
    inputTextTokens = hadImageInput ? 0 : promptTotal;
    inputImageTokens = hadImageInput ? promptTotal : 0;
  }

  let outputImageTokens: number | undefined;
  let outputTextFromCandidates = 0;
  let sawCandidateDetails = false;
  if (Array.isArray(raw["candidatesTokensDetails"])) {
    let imgSum = 0;
    let sawImage = false;
    for (const detail of raw["candidatesTokensDetails"]) {
      if (!isRecord(detail)) continue;
      const count = num(detail["tokenCount"]);
      if (count === undefined) continue;
      sawCandidateDetails = true;
      if (detail["modality"] === "IMAGE") {
        imgSum += count;
        sawImage = true;
      } else {
        outputTextFromCandidates += count;
      }
    }
    if (sawImage) outputImageTokens = imgSum;
  }
  if (!sawCandidateDetails && outputImageTokens === undefined && candidatesTotal !== undefined) {
    outputImageTokens = candidatesTotal;
  }
  const outputTextTokens = outputTextFromCandidates + thoughts;
  const outputTokens =
    candidatesTotal !== undefined ? candidatesTotal + thoughts : outputImageTokens;

  if (promptTotal === undefined && outputImageTokens === undefined && totalTokens === undefined)
    return undefined;

  return Object.freeze({
    ...(promptTotal !== undefined ? { inputTokens: promptTotal } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(inputTextTokens !== undefined ? { inputTextTokens } : {}),
    ...(inputImageTokens !== undefined ? { inputImageTokens } : {}),
    ...(outputImageTokens !== undefined ? { outputImageTokens } : {}),
    outputTextTokens,
  });
}

function parseOffer(
  body: string,
  captured: CapturedGeminiRequest,
  secret: string,
): OpenAiImageOffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalidOutput("The provider returned a malformed JSON response.", "json");
  }
  if (!isRecord(parsed))
    throw invalidOutput("The provider returned an unexpected response.", "json");
  if (
    isRecord(parsed["promptFeedback"]) &&
    typeof parsed["promptFeedback"]["blockReason"] === "string"
  ) {
    const reason = parsed["promptFeedback"]["blockReason"];
    const message =
      boundedMessage(parsed["promptFeedback"]["blockReasonMessage"], 300, secret) ??
      `Google Gemini blocked the image request (${reason}).`;
    throw new MintedGeminiImageError("user-error", message, { code: reason });
  }
  const candidates = Array.isArray(parsed["candidates"]) ? parsed["candidates"] : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : undefined;
  const finishReason =
    typeof candidate?.["finishReason"] === "string" ? candidate["finishReason"] : undefined;
  if (
    finishReason &&
    ["SAFETY", "IMAGE_SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(
      finishReason,
    )
  ) {
    throw new MintedGeminiImageError(
      "user-error",
      `Google Gemini declined to generate that image (${finishReason}).`,
      { code: finishReason },
    );
  }

  const content = isRecord(candidate?.["content"]) ? candidate["content"] : undefined;
  const parts = Array.isArray(content?.["parts"]) ? content["parts"] : [];
  const imageDataList: string[] = [];
  for (const part of parts) {
    if (!isRecord(part) || part["thought"] === true) continue;
    const inline = isRecord(part["inlineData"]) ? part["inlineData"] : undefined;
    if (inline && typeof inline["data"] === "string" && inline["data"].length > 0) {
      imageDataList.push(inline["data"]);
    }
  }
  if (imageDataList.length !== 1)
    throw invalidOutput(
      imageDataList.length === 0
        ? "Google Gemini did not return an image for this prompt."
        : "Google Gemini returned multiple images; one is expected.",
      "count",
    );

  const bytes = decodeBase64Strict(imageDataList[0]!, OPENAI_IMAGE_LIMITS.maxEncodedBytes);
  const verdict = inspectCreativeImageHeader(bytes);
  if (!verdict.ok)
    throw invalidOutput(`The returned image is unreadable: ${verdict.message}`, verdict.reason);

  const mime = CREATIVE_IMAGE_MIME[verdict.header.format];
  const usage = parseGeminiUsage(parsed["usageMetadata"], captured.images.length > 0);
  const requestId =
    typeof parsed["responseId"] === "string"
      ? boundedMessage(parsed["responseId"], 120, secret)
      : undefined;
  return Object.freeze({
    summary: captured.summary,
    encoded: Object.freeze({
      hash: sha256Hex(bytes),
      byteLength: bytes.length,
      mime,
    }),
    encodedBytes: bytes,
    width: verdict.header.width,
    height: verdict.header.height,
    format: verdict.header.format,
    transparent: false,
    ...(usage ? { usage } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

function defaultGeminiImageBaseUrl(): string {
  if ((import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === "test")
    return `${globalThis.location.origin}/api/test-gemini-images`;
  if (
    typeof import.meta !== "undefined" &&
    Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV)
  ) {
    const origin =
      typeof globalThis.location !== "undefined" && globalThis.location?.origin
        ? globalThis.location.origin
        : "http://localhost:5199";
    return `${origin}/api/gemini`;
  }
  return "https://generativelanguage.googleapis.com";
}

export function createGeminiImageProvider(
  options: GeminiImageProviderOptions,
): OpenAiImageProvider {
  const models = options.models ?? GEMINI_IMAGE_MODELS;
  const transport =
    options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const baseUrl = (options.baseUrl ?? defaultGeminiImageBaseUrl()).replace(/\/+$/, "");
  const jobs = new WeakMap<PreparedOpenAiImage, CapturedGeminiRequest>();
  let activeJob = false;

  async function run(
    captured: CapturedGeminiRequest,
    signal?: AbortSignal,
  ): Promise<OpenAiImageOffer> {
    const timeoutMs = options.timeoutMs ?? OPENAI_IMAGE_LIMITS.timeoutMs;
    if (signal?.aborted)
      throw new MintedGeminiImageError("cancelled", "The request was cancelled.");
    const controller = new AbortController();
    let aborted: "cancelled" | "timeout" | undefined;
    let settled = false;
    let rejectHalt: ((error: OpenAiImageError) => void) | undefined;
    const halt = new Promise<never>((_resolve, reject) => {
      rejectHalt = reject;
    });
    const trip = (kind: "cancelled" | "timeout") => {
      if (settled || aborted !== undefined) return;
      aborted = kind;
      controller.abort();
      rejectHalt?.(
        kind === "timeout"
          ? new MintedGeminiImageError(
              "timeout",
              `Google Gemini did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
            )
          : new MintedGeminiImageError("cancelled", "The request was cancelled."),
      );
    };
    const timer = setTimeout(() => trip("timeout"), timeoutMs);
    const onAbort = () => trip("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) trip("cancelled");
    const checkAborted = () => {
      if (aborted === "timeout")
        throw new MintedGeminiImageError(
          "timeout",
          `Google Gemini did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
        );
      if (aborted === "cancelled" || signal?.aborted)
        throw new MintedGeminiImageError("cancelled", "The request was cancelled.");
    };

    let key: string | null | undefined;
    try {
      try {
        key = await Promise.race([options.credentials(), halt]);
      } catch (error) {
        if (isMinted(error)) throw error;
        throw new MintedGeminiImageError("no-key", "The credentials callback failed.");
      }
      checkAborted();
      if (typeof key !== "string" || key.trim() === "")
        throw new MintedGeminiImageError(
          "no-key",
          "Generation needs a saved Google Gemini API key.",
        );
      const trimmedKey = key.trim();
      const parts: Record<string, unknown>[] = [];
      for (const image of captured.images) {
        parts.push({
          inlineData: {
            mimeType: image.summary.mime,
            data: encodeBase64(image.bytes),
          },
        });
      }
      parts.push({ text: captured.prompt });
      const init: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": trimmedKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: {
              aspectRatio: captured.aspectRatio,
              imageSize: captured.imageSize,
            },
          },
        }),
        signal: controller.signal,
      };
      const response = await Promise.race([
        transport(`${baseUrl}${captured.endpoint}`, init),
        halt,
      ]);
      checkAborted();
      const body = await Promise.race([readBodyBounded(response), halt]);
      checkAborted();
      if (!response.ok) throw classifyHttpError(response.status, body, trimmedKey);
      const offer = parseOffer(body, captured, trimmedKey);
      checkAborted();
      return offer;
    } catch (error) {
      if (isMinted(error)) throw error;
      checkAborted();
      const secret = typeof key === "string" ? key.trim() : "";
      const cause =
        error instanceof Error
          ? (boundedMessage(error.message, 300, secret) ?? error.name)
          : boundedMessage(String(error), 300, secret);
      throw new MintedGeminiImageError(
        "transport",
        "Google Gemini could not be reached: offline, DNS or a browser network block.",
        { possiblyCors: error instanceof TypeError, ...(cause ? { cause } : {}) },
      );
    } finally {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      halt.catch(() => undefined);
    }
  }

  return {
    models,
    get busy() {
      return activeJob;
    },
    prepare(request: OpenAiImageRequest): PreparedOpenAiImage {
      const captured = capture(request, models);
      const prepared: PreparedOpenAiImage = { summary: Object.freeze(captured.summary) };
      jobs.set(prepared, captured);
      return prepared;
    },
    async submit(
      prepared: PreparedOpenAiImage,
      submitOptions?: {
        readonly signal?: AbortSignal;
        readonly onPartial?: (bytes: Uint8Array) => void;
      },
    ): Promise<OpenAiImageOffer> {
      const captured = jobs.get(prepared);
      if (captured === undefined || captured.consumed)
        throw new MintedGeminiImageError(
          "stale",
          "That prepared request is stale; prepare it again.",
        );
      if (activeJob)
        throw new MintedGeminiImageError(
          "busy",
          "A generation is already running; wait for it or cancel it first.",
        );
      captured.consumed = true;
      activeJob = true;
      try {
        return await run(captured, submitOptions?.signal);
      } finally {
        activeJob = false;
      }
    },
  };
}

/**
 * Combines multiple image providers (e.g. OpenAI + Google Gemini) under one
 * `OpenAiImageProvider` interface, routing each `prepare`/`submit` by model id.
 */
export function createMultiImageProvider(
  providers: readonly OpenAiImageProvider[],
): OpenAiImageProvider {
  const models: Record<string, OpenAiImageModel> = {};
  const ownerByModel = new Map<string, OpenAiImageProvider>();
  for (const provider of providers) {
    for (const [id, model] of Object.entries(provider.models)) {
      models[id] = model;
      ownerByModel.set(id, provider);
    }
  }
  const frozenModels = Object.freeze(models);
  const ownerByPrepared = new WeakMap<PreparedOpenAiImage, OpenAiImageProvider>();

  return {
    models: frozenModels,
    get busy() {
      return providers.some((provider) => provider.busy);
    },
    prepare(request: OpenAiImageRequest): PreparedOpenAiImage {
      const owner = ownerByModel.get(request.model);
      if (!owner)
        throw new OpenAiImageError(
          "unsupported",
          `The model "${String(request.model)}" is not available.`,
          { code: "model" },
        );
      const prepared = owner.prepare(request);
      ownerByPrepared.set(prepared, owner);
      return prepared;
    },
    async submit(prepared, submitOptions) {
      const owner = ownerByPrepared.get(prepared);
      if (!owner)
        throw new OpenAiImageError("stale", "That prepared request is stale; prepare it again.");
      if (providers.some((provider) => provider.busy))
        throw new OpenAiImageError(
          "busy",
          "A generation is already running; wait for it or cancel it first.",
        );
      return owner.submit(prepared, submitOptions);
    },
  };
}
