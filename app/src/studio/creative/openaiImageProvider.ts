/**
 * Optional BYOK OpenAI image transport for the creative workflow.
 *
 * This adapter owns exactly one paid boundary: an explicit request (kind,
 * role, prompt, capability-checked model/options and the exact approved
 * image inputs) is captured at `prepare`, behind an opaque handle and a
 * detached frozen summary the UI reviews before anything can be billed.
 * Only `submit` calls the credentials callback — once — and performs the
 * single network request. Mutating the caller's request object, the offered
 * byte arrays or the returned summary after `prepare` cannot widen what is
 * sent: the wire payload is built from owned copies in a WeakMap the caller
 * never sees.
 *
 * Prompt-only requests go to `/v1/images/generations` as JSON. Any request
 * carrying the selected asset or approved references goes to
 * `/v1/images/edits` as browser-owned multipart form data — encoded bytes
 * the caller handed in, never remote URLs, Files-API ids, board reads or
 * stored originals beyond the explicit selection. Generation is exactly one
 * image per submit (`n=1`), no streaming partials, no automatic retry:
 * rate-limit and server errors surface typed so the user can resubmit.
 *
 * A mask guides the provider's edit of the first image only; it is PNG,
 * same format and dimensions as its edited source, and it is not a
 * protected-pixel authorization boundary — native protected areas get a
 * separate deterministic composite downstream. Output is pinned to PNG so
 * the returned original keeps immutable bytes and straight alpha.
 *
 * The response side is as suspicious as the request side: the body is read
 * under a hard byte ceiling before any JSON or base64 allocation
 * (Content-Length is an early hint only), base64 is strictly validated and
 * bounded before decode, and the decoded PNG must match the requested
 * dimensions through the shared header inspector. Missing, multiple,
 * URL-only or malformed results refuse as `invalid-output`.
 *
 * Nothing here writes resources, storage or the worker; the returned offer
 * carries detached original bytes, their hash and observed request identity
 * for a later canonical decode and staging. Fixed count/byte/timeout bounds
 * are engineering admission limits, not a guaranteed dollar ceiling, and
 * usage is reported only when the provider actually returns it.
 */
import { sha256Hex } from "../../../../src/crypto.ts";
import {
  CREATIVE_IMAGE_MIME,
  inspectCreativeImageHeader,
  type CreativeImageFormat,
  type CreativeImageHeader,
} from "../../../../src/creative/imageHeader.ts";
import {
  CREATIVE_LIMITS,
  type BlobRef,
  type VersionRef,
} from "../../../../src/creative/catalog.ts";

/** What the user asked for; transport decides the endpoint, not the name. */
export type OpenAiImageKind = "generate" | "variation" | "edit";
/** The intended destination role, captured for review. */
export type OpenAiImageRole = "room" | "character" | "object" | "inspiration";
export type OpenAiImageQuality = "low" | "medium" | "high" | "xhigh" | "max";
export type OpenAiImageBackground = "opaque" | "transparent";

/** Why a prepare or submit refused. Stable; UI and tests branch on it. */
export type OpenAiImageFailure =
  /** The capability record refuses the option before any request exists. */
  | "unsupported"
  /** A local bound refused the offer: bytes, count, prompt, mask shape. */
  | "invalid-request"
  /** The credentials callback returned nothing usable. */
  | "no-key"
  /** Authentication rejected (401 or an auth error code). */
  | "auth"
  /** The key cannot reach the selected model or API (403/404). */
  | "model-access"
  /** Billing or quota exhaustion; resubmitting unchanged will not help. */
  | "quota"
  /** 429 or a rate-limit error code; the user may resubmit later. */
  | "rate-limit"
  /** The provider refused the request itself: 400-class, moderation, user-correctable. */
  | "user-error"
  /** fetch-level failure: offline, DNS or a browser network/CORS block. */
  | "transport"
  /** The caller's AbortSignal fired. */
  | "cancelled"
  /** The measured request timeout elapsed. */
  | "timeout"
  /** The response envelope, base64 or decoded header failed validation. */
  | "invalid-output"
  /** The prepared handle is unknown, consumed or belongs to another provider. */
  | "stale"
  /** A job is already in flight on this provider instance. */
  | "busy";

export class OpenAiImageError extends Error {
  readonly reason: OpenAiImageFailure;
  /** Local sub-reason ("oversize", "mask-alpha", ...) or the provider's error.code. */
  readonly code?: string;
  /** HTTP status when a response arrived. */
  readonly status?: number;
  /** `x-request-id` when the provider answered; useful for support. */
  readonly requestId?: string;
  /** A fetch-class failure a browser CORS block can also produce. */
  readonly possiblyCors: boolean;
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
    super(message);
    this.name = "OpenAiImageError";
    this.reason = reason;
    this.possiblyCors = options?.possiblyCors ?? false;
    if (options?.code !== undefined) this.code = options.code;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.requestId !== undefined) this.requestId = options.requestId;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Internal brand: every error this module throws is a MintedImageError.
 * Callers can construct OpenAiImageError but not this unexported subclass,
 * so an external throw that merely shares the class is untrusted material:
 * its message, cause and stack may carry secrets and it is rebuilt at the
 * boundary rather than rethrown.
 */
class MintedImageError extends OpenAiImageError {}

function isMinted(error: unknown): error is OpenAiImageError {
  return error instanceof MintedImageError;
}

/**
 * What one configured model can honor — capability-based admission, checked
 * locally before any request exists. Lists hold concrete values only: the
 * adapter never auto-chooses a size, quality or background.
 */
export interface OpenAiImageModel {
  readonly id: string;
  readonly label: string;
  /** Accepts image inputs on `/v1/images/edits`. */
  readonly edits: boolean;
  /** Documented Image API partial-image events. */
  readonly streaming?: boolean;
  /** Accepts a same-format/same-size PNG mask bound to the first image. */
  readonly mask: boolean;
  /** Accepts `input_fidelity` (gpt-image-2 always runs high and rejects the field). */
  readonly inputFidelity: boolean;
  readonly qualities: readonly OpenAiImageQuality[];
  /** Exact "WIDTHxHEIGHT" strings the record admits. */
  readonly sizes: readonly string[];
  /** Documented 2.5 custom dimensions. */
  readonly customSizes?: boolean;
  readonly backgrounds: readonly OpenAiImageBackground[];
}

const STANDARD_SIZES: readonly string[] = ["1024x1024", "1536x1024", "1024x1536"];
const QUALITIES_25: readonly OpenAiImageQuality[] = ["low", "medium", "high", "xhigh", "max"];
const QUALITIES_2: readonly OpenAiImageQuality[] = ["low", "medium", "high"];
const BACKGROUNDS_25: readonly OpenAiImageBackground[] = ["opaque", "transparent"];
const BACKGROUNDS_2: readonly OpenAiImageBackground[] = ["opaque"];

/**
 * The shipped capability table. Sunburst is the precise-editing model and
 * Flare the fast-draft model; both take the xhigh/max quality tiers.
 * gpt-image-2 stays selectable as the legacy model: quality tops out at
 * high, it rejects `input_fidelity`, and this table admits opaque only —
 * a deployment can widen its own records, the shipped one stays safe.
 * https://developers.openai.com/api/docs/guides/image-generation
 */
export const OPENAI_IMAGE_MODELS: Readonly<Record<string, OpenAiImageModel>> = Object.freeze({
  "gpt-image-2.5-sunburst": Object.freeze({
    id: "gpt-image-2.5-sunburst",
    label: "GPT Image 2.5 Sunburst",
    edits: true,
    streaming: true,
    mask: true,
    inputFidelity: true,
    qualities: QUALITIES_25,
    customSizes: true,
    sizes: STANDARD_SIZES,
    backgrounds: BACKGROUNDS_25,
  }),
  "gpt-image-2.5-flare": Object.freeze({
    id: "gpt-image-2.5-flare",
    label: "GPT Image 2.5 Flare",
    edits: true,
    streaming: true,
    mask: true,
    inputFidelity: true,
    qualities: QUALITIES_25,
    customSizes: true,
    sizes: STANDARD_SIZES,
    backgrounds: BACKGROUNDS_25,
  }),
  "gpt-image-2": Object.freeze({
    id: "gpt-image-2",
    label: "GPT Image 2",
    edits: true,
    streaming: true,
    mask: true,
    inputFidelity: false,
    qualities: QUALITIES_2,
    sizes: STANDARD_SIZES,
    backgrounds: BACKGROUNDS_2,
  }),
});

/** Conservative starting options a caller can present; every request still names its own.
 * @public */
export const OPENAI_IMAGE_DEFAULTS = Object.freeze({
  model: "gpt-image-2.5-sunburst",
  quality: "low" as OpenAiImageQuality,
  size: "1024x1024",
  background: "opaque" as OpenAiImageBackground,
});

/** Engineering admission bounds — a policy ceiling, not a promised dollar cost. */
export const OPENAI_IMAGE_LIMITS = Object.freeze({
  /** Selected image inputs on one request: the asset plus approved references. */
  maxInputImages: 16,
  /** Encoded bytes per input image, mask or returned original. */
  maxEncodedBytes: CREATIVE_LIMITS.maxFileBytes,
  /** Total encoded input bytes, mask included. */
  maxInputBytesTotal: 16 * 1024 * 1024,
  /** Prompt length in UTF-16 code units. */
  maxPromptLength: 32000,
  /** Whole-body response ceiling; covers the 4/3 base64 expansion of the output cap. */
  maxResponseBytes: 12 * 1024 * 1024,
  /** Baseline whole-job timeout; quality and pixel count extend it. */
  timeoutMs: 180_000,
});

/** One approved image input: encoded original bytes plus the identity/roles the caller asserts. */
export interface OpenAiImageMaterial {
  /** The catalog identity of the source or board entry this material came from. */
  readonly identity: VersionRef;
  /** Board roles the caller asserts, for example "style" or "exact-source". */
  readonly roles: readonly string[];
  /** Encoded PNG, JPEG or WebP original; the sniffed header wins over any claim. */
  readonly bytes: Uint8Array;
}

export interface OpenAiImageRequest {
  readonly kind: OpenAiImageKind;
  readonly role: OpenAiImageRole;
  readonly model: string;
  readonly prompt: string;
  /** Exact "WIDTHxHEIGHT" admitted by the model record. */
  readonly size: string;
  readonly quality: OpenAiImageQuality;
  readonly background: OpenAiImageBackground;
  /** Edit-only hint for how strongly inputs steer the result. */
  readonly inputFidelity?: "low" | "high";
  /** The selected asset an edit or variation departs from; the mask binds to it. */
  readonly asset?: OpenAiImageMaterial;
  /** Additional approved references leaving the browser. */
  readonly references?: readonly OpenAiImageMaterial[];
  /** PNG mask, same format and dimensions as `asset`; edit kind only. */
  readonly mask?: { readonly bytes: Uint8Array };
}

/** What one image input contributes to the detached review summary. */
interface OpenAiImageMaterialSummary {
  readonly identity: VersionRef;
  readonly roles: readonly string[];
  readonly hash: string;
  readonly byteLength: number;
  /** Sniffed canonical MIME — never the caller's claim. */
  readonly mime: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The detached review record: exactly what would leave the browser and the
 * bounds it was admitted under. Carries no credentials and no live
 * references into the caller's objects; mutating it changes nothing the
 * wire sees.
 */
export interface OpenAiImageSummary {
  readonly provider: "openai";
  readonly kind: OpenAiImageKind;
  readonly role: OpenAiImageRole;
  readonly model: string;
  readonly endpoint: "/v1/images/generations" | "/v1/images/edits";
  readonly transport: "json" | "multipart";
  readonly prompt: string;
  readonly promptCodeUnits: number;
  readonly count: 1;
  readonly size: string;
  readonly quality: OpenAiImageQuality;
  readonly background: OpenAiImageBackground;
  readonly outputFormat: "png";
  readonly inputFidelity?: "low" | "high";
  /** The asset first (mask order), then the approved references. */
  readonly images: readonly OpenAiImageMaterialSummary[];
  readonly mask?:
    | {
        readonly hash: string;
        readonly byteLength: number;
        readonly width: number;
        readonly height: number;
      }
    | undefined;
  readonly totalInputBytes: number;
  readonly limits: typeof OPENAI_IMAGE_LIMITS;
}

/** The opaque prepared handle: the summary is for review; the wire data lives server-side of it. */
export interface PreparedOpenAiImage {
  readonly summary: OpenAiImageSummary;
}

/** Token accounting the provider returned; absent stays absent, never a fabricated zero. */
export interface OpenAiImageUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly inputTextTokens?: number;
  readonly inputImageTokens?: number;
  /** Cached image input, included in inputImageTokens by the provider. */
  readonly inputCachedTokens?: number;
  readonly outputImageTokens?: number;
}

/**
 * One generated original, ready for the same canonical intake an upload
 * takes. It carries detached bytes and request evidence for image intake.
 */
export interface OpenAiImageOffer {
  /** The request actually sent — the same detached summary. */
  readonly summary: OpenAiImageSummary;
  /** Descriptor for `encodedBytes`. */
  readonly encoded: BlobRef;
  /** The exact encoded PNG the provider returned, owned by this offer. */
  readonly encodedBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly format: "png";
  /** `background: "transparent"` was requested and sent; the PNG may carry alpha. */
  readonly transparent: boolean;
  /** Provider-reported usage, only when actually returned. */
  readonly usage?: OpenAiImageUsage;
  /** Provider `x-request-id`, when delivered. */
  readonly requestId?: string;
  /** Provider `created` timestamp, when delivered. */
  readonly created?: number;
}

/** Supplies the user's own key. Called only inside submit, exactly once per submit. */
type OpenAiImageCredentials = () => string | null | undefined | Promise<string | null | undefined>;

export interface OpenAiImageProviderOptions {
  readonly credentials: OpenAiImageCredentials;
  /** Platform fetch; defaults to the global one. */
  readonly fetch?: typeof fetch;
  /** Platform FormData; defaults to the global constructor. */
  readonly createFormData?: () => FormData;
  /** Capability table override; defaults to {@link OPENAI_IMAGE_MODELS}. */
  readonly models?: Readonly<Record<string, OpenAiImageModel>>;
  /** API base; defaults to the dev proxy in dev and api.openai.com elsewhere. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export interface OpenAiImageProvider {
  /** The capability table this instance admits. */
  readonly models: Readonly<Record<string, OpenAiImageModel>>;
  /** True while a submit is in flight. */
  readonly busy: boolean;
  /**
   * Capture and validate a request. Pure and synchronous: copies every
   * offered byte, checks capabilities and bounds, and returns an opaque
   * handle plus a detached summary. Never touches credentials or the
   * network.
   */
  prepare(request: OpenAiImageRequest): PreparedOpenAiImage;
  /**
   * Consume a prepared handle once: ask credentials, send the one request,
   * validate the response into an offer. Handles are single-use; a prepared
   * handle from another instance, a forged one or a consumed one refuses
   * `stale`.
   */
  submit(
    prepared: PreparedOpenAiImage,
    options?: { readonly signal?: AbortSignal; readonly onPartial?: (bytes: Uint8Array) => void },
  ): Promise<OpenAiImageOffer>;
}

const IMAGE_EXT: Record<CreativeImageFormat, string> = { png: "png", jpeg: "jpg", webp: "webp" };
const KINDS: readonly OpenAiImageKind[] = ["generate", "variation", "edit"];
const ROLES: readonly OpenAiImageRole[] = ["room", "character", "object", "inspiration"];
const OUTPUT_MIME = "image/png";

interface CapturedImage {
  readonly summary: OpenAiImageMaterialSummary;
  /** Owned copy, taken before any await. */
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly format: CreativeImageFormat;
  readonly header: CreativeImageHeader;
  readonly filename: string;
}

interface CapturedRequest {
  readonly summary: OpenAiImageSummary;
  readonly endpoint: "/v1/images/generations" | "/v1/images/edits";
  readonly model: string;
  readonly prompt: string;
  readonly size: string;
  readonly quality: OpenAiImageQuality;
  readonly background: OpenAiImageBackground;
  readonly inputFidelity?: "low" | "high";
  readonly images: readonly CapturedImage[];
  readonly mask?: {
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly summary: NonNullable<OpenAiImageSummary["mask"]>;
  };
  consumed: boolean;
}

function invalidRequest(message: string, code?: string): OpenAiImageError {
  return new MintedImageError("invalid-request", message, { ...(code ? { code } : {}) });
}

function unsupported(message: string): OpenAiImageError {
  return new MintedImageError("unsupported", message);
}

function parseSize(size: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (match === null) throw invalidRequest(`Size '${size}' is not a "WIDTHxHEIGHT" value.`, "size");
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * PNG alpha evidence: colour types 4 and 6 always carry it; 0, 2 and 3
 * carry it only through a tRNS chunk before IDAT. The header inspector has
 * already admitted the structure, so the walk is a plain bound-checked scan.
 */
function pngHasAlpha(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colourType = view.getUint8(25);
  if (colourType === 4 || colourType === 6) return true;
  const TRNS = 0x74524e53;
  const IDAT = 0x49444154;
  let pos = 33;
  while (pos + 8 <= bytes.length) {
    const type = view.getUint32(pos + 4, false);
    if (type === IDAT) break;
    if (type === TRNS) return true;
    pos += 12 + view.getUint32(pos, false);
  }
  return false;
}

function captureMaterial(
  material: OpenAiImageMaterial,
  offered: Uint8Array,
  label: string,
  index: number,
): CapturedImage {
  // `offered` was read once by the caller; the copy is taken here so a
  // getter or a later mutation cannot change what leaves.
  const bytes = offered.slice();
  const verdict = inspectCreativeImageHeader(bytes);
  if (!verdict.ok) throw invalidRequest(`${label}: ${verdict.message}`, verdict.reason);
  const header = verdict.header;
  if (header.animated)
    throw invalidRequest(`${label} is animated; choose a still image.`, "animated");
  const identity = material.identity;
  if (
    identity === null ||
    typeof identity !== "object" ||
    typeof identity.id !== "string" ||
    identity.id.length === 0 ||
    typeof identity.incarnation !== "string" ||
    identity.incarnation.length === 0 ||
    !Number.isSafeInteger(identity.revision) ||
    identity.revision < 0
  )
    throw invalidRequest(`${label} needs its source identity.`, "identity");
  return {
    bytes,
    format: header.format,
    header,
    filename: `image-${index}.${IMAGE_EXT[header.format]}`,
    summary: Object.freeze({
      identity: Object.freeze({
        id: identity.id,
        incarnation: identity.incarnation,
        revision: identity.revision,
      }),
      roles: Object.freeze(material.roles.map((role) => String(role))),
      hash: sha256Hex(bytes),
      byteLength: bytes.length,
      mime: CREATIVE_IMAGE_MIME[header.format],
      width: header.width,
      height: header.height,
    }),
  };
}

function capture(
  request: OpenAiImageRequest,
  models: Readonly<Record<string, OpenAiImageModel>>,
): CapturedRequest {
  // Every offered field is read exactly once: a getter answering a
  // different value on a later read cannot slip an unreviewed prompt,
  // option or byte array past admission and into the wire payload.
  const kind = request.kind;
  const role = request.role;
  const model = request.model;
  const prompt = request.prompt;
  const size = request.size;
  const quality = request.quality;
  const background = request.background;
  const inputFidelity = request.inputFidelity;
  const asset = request.asset;
  const references = request.references ?? [];
  const offeredMask = request.mask;

  if (!KINDS.includes(kind))
    throw invalidRequest(`Kind '${String(kind)}' is not a generation kind.`, "kind");
  if (!ROLES.includes(role))
    throw invalidRequest(`Role '${String(role)}' is not a destination role.`, "role");
  const capability = models[model];
  if (capability === undefined)
    throw unsupported(`Model '${model}' is not in the configured image models.`);
  const dimensions = parseSize(size);
  const pixels = dimensions.width * dimensions.height;
  const customSize =
    capability.customSizes &&
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width % 16 === 0 &&
    dimensions.height % 16 === 0 &&
    Math.max(dimensions.width, dimensions.height) <= 3840 &&
    Math.max(dimensions.width, dimensions.height) <=
      3 * Math.min(dimensions.width, dimensions.height) &&
    pixels >= 655360 &&
    pixels <= 8294400;
  if (!capability.sizes.includes(size) && !customSize)
    throw unsupported(`${capability.label} does not offer size '${size}'.`);
  if (!capability.qualities.includes(quality))
    throw unsupported(`${capability.label} does not offer quality '${quality}'.`);
  if (!capability.backgrounds.includes(background))
    throw unsupported(`${capability.label} does not offer a '${background}' background.`);
  if (inputFidelity !== undefined && !capability.inputFidelity)
    throw unsupported(`${capability.label} does not accept an input fidelity setting.`);
  if (typeof prompt !== "string" || prompt.trim().length === 0)
    throw invalidRequest("Write a prompt for the generation.", "prompt");
  if (prompt.length > OPENAI_IMAGE_LIMITS.maxPromptLength)
    throw invalidRequest(
      `That prompt is ${prompt.length} characters; requests accept up to ${OPENAI_IMAGE_LIMITS.maxPromptLength}.`,
      "prompt",
    );
  parseSize(size);
  if ((kind === "edit" || kind === "variation") && asset === undefined)
    throw invalidRequest(`A ${kind} needs the selected asset it departs from.`, "asset");
  if (offeredMask !== undefined && kind !== "edit")
    throw invalidRequest("A mask belongs to an edit of the selected asset.", "mask");
  if (offeredMask !== undefined && asset === undefined)
    throw invalidRequest("A mask needs the asset it edits.", "mask");
  const inputCount = (asset ? 1 : 0) + references.length;
  if (inputCount > OPENAI_IMAGE_LIMITS.maxInputImages)
    throw invalidRequest(
      `That request carries ${inputCount} images; requests accept up to ${OPENAI_IMAGE_LIMITS.maxInputImages}.`,
      "count",
    );
  if (inputCount > 0 && !capability.edits)
    throw unsupported(`${capability.label} does not accept image inputs.`);
  if (offeredMask !== undefined && !capability.mask)
    throw unsupported(`${capability.label} does not accept an edit mask.`);
  if (inputFidelity !== undefined && inputCount === 0)
    throw invalidRequest("An input fidelity setting needs image inputs.", "input-fidelity");

  // The same read-once discipline for offered byte arrays: cheap byte
  // accounting happens before any header walk.
  const offeredMaterials = [
    ...(asset ? [["The asset", asset] as const] : []),
    ...references.map((m, i) => [`Reference ${i + 1}`, m] as const),
  ];
  const offeredBytes: Uint8Array[] = [];
  let totalInputBytes = 0;
  const declared: (readonly [string, unknown])[] = [
    ...offeredMaterials.map(([label, m]) => [label, m.bytes] as const),
    ...(offeredMask ? [["The mask", offeredMask.bytes] as const] : []),
  ];
  for (const [label, bytes] of declared) {
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

  const images: CapturedImage[] = [];
  offeredMaterials.forEach(([label, m], i) =>
    images.push(captureMaterial(m, offeredBytes[i]!, label, i)),
  );

  let mask: CapturedRequest["mask"];
  if (offeredMask !== undefined) {
    const asset = images[0]!;
    const maskBytes = offeredBytes[offeredMaterials.length]!.slice();
    const verdict = inspectCreativeImageHeader(maskBytes);
    if (!verdict.ok) throw invalidRequest(`The mask: ${verdict.message}`, verdict.reason);
    if (verdict.header.format !== "png" || asset.format !== "png")
      throw invalidRequest("A mask and its edited asset must share the PNG format.", "mask-format");
    if (
      verdict.header.width !== asset.header.width ||
      verdict.header.height !== asset.header.height
    )
      throw invalidRequest(
        `That mask is ${verdict.header.width}x${verdict.header.height}; it must match its asset's ${asset.header.width}x${asset.header.height}.`,
        "mask-dimensions",
      );
    if (!pngHasAlpha(maskBytes))
      throw invalidRequest(
        "A mask needs an alpha channel marking the editable area.",
        "mask-alpha",
      );
    mask = {
      bytes: maskBytes,
      summary: Object.freeze({
        hash: sha256Hex(maskBytes),
        byteLength: maskBytes.length,
        width: verdict.header.width,
        height: verdict.header.height,
      }),
    };
  }

  const endpoint = images.length === 0 ? "/v1/images/generations" : "/v1/images/edits";
  const summary: OpenAiImageSummary = {
    provider: "openai",
    kind,
    role,
    model: capability.id,
    endpoint,
    transport: endpoint === "/v1/images/generations" ? "json" : "multipart",
    prompt,
    promptCodeUnits: prompt.length,
    count: 1,
    size,
    quality,
    background,
    outputFormat: "png",
    ...(inputFidelity !== undefined ? { inputFidelity } : {}),
    images: Object.freeze(images.map((image) => image.summary)),
    ...(mask ? { mask: mask.summary } : {}),
    totalInputBytes,
    limits: OPENAI_IMAGE_LIMITS,
  };
  return {
    summary,
    endpoint,
    model: capability.id,
    prompt,
    size,
    quality,
    background,
    ...(inputFidelity !== undefined ? { inputFidelity } : {}),
    images,
    ...(mask ? { mask } : {}),
    consumed: false,
  };
}

/** The base64 alphabet index; -1 marks anything outside it. */
const B64_VALUES = new Int16Array(128).fill(-1);
{
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) B64_VALUES[alphabet.charCodeAt(i)] = i;
}

function invalidOutput(message: string, code?: string): OpenAiImageError {
  return new MintedImageError("invalid-output", message, { ...(code ? { code } : {}) });
}

/**
 * Strict base64: canonical quartets, '=' padding only where it belongs, and
 * the decoded length proven against the bound before the buffer exists.
 */
function decodeBase64Strict(text: string, maxBytes: number): Uint8Array {
  if (text.length === 0 || text.length % 4 !== 0)
    throw invalidOutput("The provider returned malformed base64.", "base64");
  let padding = 0;
  if (text.endsWith("==")) padding = 2;
  else if (text.endsWith("=")) padding = 1;
  const byteLength = (text.length / 4) * 3 - padding;
  if (byteLength < 1 || byteLength > maxBytes)
    throw invalidOutput(
      `The provider's image decodes past the ${maxBytes / 1024 / 1024} MB output bound.`,
      "oversize",
    );
  const out = new Uint8Array(byteLength);
  const lastQuartet = text.length - 4;
  for (let i = 0; i < text.length; i += 4) {
    const last = i === lastQuartet;
    let block = 0;
    for (let j = 0; j < 4; j++) {
      const code = text.charCodeAt(i + j);
      if (code === 0x3d) {
        // '=' closes the result; it may sit only in the tail slots of the
        // final quartet, exactly `padding` of them.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedMessage(value: unknown, max: number, secret: string): string | undefined {
  if (typeof value !== "string") return undefined;
  // A provider must never see the key echoed back at the user; scrub it
  // wherever a message might carry it, then bound the text.
  const safe = secret === "" ? value : value.split(secret).join("[key]");
  const trimmed = safe.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Map a failed HTTP response to a typed reason; provider code wins over status. */
function classifyHttpError(
  status: number,
  body: Uint8Array,
  requestId: string | undefined,
  secret: string,
): OpenAiImageError {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    const error = isRecord(parsed) && isRecord(parsed["error"]) ? parsed["error"] : undefined;
    if (error) {
      if (typeof error["code"] === "string") code = boundedMessage(error["code"], 120, secret);
      if (typeof error["type"] === "string" && code === undefined)
        code = boundedMessage(error["type"], 120, secret);
      message = boundedMessage(error["message"], 300, secret);
    }
  } catch {
    /* a non-JSON error body still carries its status */
  }
  // A header value is untrusted text: bounded and scrubbed like messages.
  const safeRequestId = boundedMessage(requestId, 120, secret);
  const options = {
    ...(code ? { code } : {}),
    status,
    ...(safeRequestId ? { requestId: safeRequestId } : {}),
  };
  const text = message ?? `The provider answered with status ${status}.`;
  if (code === "insufficient_quota" || code === "billing_hard_limit_reached")
    return new MintedImageError(
      "quota",
      `The provider reports the account is out of quota: ${text}`,
      options,
    );
  if (status === 401 || code === "invalid_api_key")
    return new MintedImageError("auth", `The provider rejected the API key: ${text}`, options);
  if (status === 403 || status === 404 || code === "model_not_found")
    return new MintedImageError(
      "model-access",
      `The API key cannot reach this model or the image API: ${text}`,
      options,
    );
  if (status === 402)
    return new MintedImageError("quota", `The provider reports a billing block: ${text}`, options);
  if (status === 429 || code === "rate_limit_exceeded")
    return new MintedImageError(
      "rate-limit",
      `The provider is rate-limiting requests: ${text}`,
      options,
    );
  if (status >= 500)
    return new MintedImageError(
      "transport",
      `The provider failed with status ${status}: ${text}`,
      options,
    );
  return new MintedImageError("user-error", `The provider refused the request: ${text}`, options);
}

/**
 * Read a response under the hard body ceiling. Content-Length is only an
 * early hint; a streamed body is cut off at the bound mid-flight, before
 * any JSON string or base64 buffer can be allocated from it.
 */
async function readBodyBounded(response: Response): Promise<Uint8Array> {
  const hint = Number(response.headers.get("content-length"));
  if (Number.isFinite(hint) && hint > OPENAI_IMAGE_LIMITS.maxResponseBytes)
    throw invalidOutput(
      `The provider's response is larger than the ${OPENAI_IMAGE_LIMITS.maxResponseBytes / 1024 / 1024} MB ceiling.`,
      "oversize",
    );
  const body = response.body;
  if (body !== null) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined && value.length > 0) {
          total += value.length;
          if (total > OPENAI_IMAGE_LIMITS.maxResponseBytes) {
            await reader.cancel().catch(() => undefined);
            throw invalidOutput(
              `The provider's response passed the ${OPENAI_IMAGE_LIMITS.maxResponseBytes / 1024 / 1024} MB ceiling.`,
              "oversize",
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > OPENAI_IMAGE_LIMITS.maxResponseBytes)
    throw invalidOutput(
      `The provider's response is larger than the ${OPENAI_IMAGE_LIMITS.maxResponseBytes / 1024 / 1024} MB ceiling.`,
      "oversize",
    );
  return new Uint8Array(buffer);
}

function readUsage(value: unknown): OpenAiImageUsage | undefined {
  if (!isRecord(value)) return undefined;
  const number = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const details = isRecord(value["input_tokens_details"]) ? value["input_tokens_details"] : {};
  const outDetails = isRecord(value["output_tokens_details"]) ? value["output_tokens_details"] : {};
  const usage: { -readonly [K in keyof OpenAiImageUsage]?: OpenAiImageUsage[K] } = {};
  const input = number(value["input_tokens"]);
  if (input !== undefined) usage.inputTokens = input;
  const output = number(value["output_tokens"]);
  if (output !== undefined) usage.outputTokens = output;
  const total = number(value["total_tokens"]);
  if (total !== undefined) usage.totalTokens = total;
  const inputText = number(details["text_tokens"]);
  if (inputText !== undefined) usage.inputTextTokens = inputText;
  const inputImage = number(details["image_tokens"]);
  if (inputImage !== undefined) usage.inputImageTokens = inputImage;
  const cached = number(details["cached_tokens"]);
  if (cached !== undefined) usage.inputCachedTokens = cached;
  const outputImage = number(outDetails["image_tokens"]);
  if (outputImage !== undefined) usage.outputImageTokens = outputImage;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Envelope → validated offer: one image, strict base64, sniffed PNG at the requested size. */
function parseOffer(
  body: Uint8Array,
  captured: CapturedRequest,
  headers: Headers,
  secret: string,
): OpenAiImageOffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw invalidOutput("The provider's response is not JSON.", "json");
  }
  if (!isRecord(parsed)) throw invalidOutput("The provider's response is not an object.", "json");
  const data = parsed["data"];
  if (!Array.isArray(data) || data.length !== 1)
    throw invalidOutput(
      `The provider returned ${Array.isArray(data) ? data.length : 0} images; exactly one was requested.`,
      "count",
    );
  const item = data[0];
  if (!isRecord(item) || typeof item["b64_json"] !== "string")
    throw invalidOutput(
      isRecord(item) && typeof item["url"] === "string"
        ? "The provider returned a URL; byte output was requested."
        : "The provider returned no image bytes.",
      "missing-image",
    );
  if (parsed["output_format"] !== undefined && parsed["output_format"] !== "png")
    throw invalidOutput(
      `The provider answered in '${String(parsed["output_format"])}' format; PNG was requested.`,
      "format",
    );
  const bytes = decodeBase64Strict(item["b64_json"], OPENAI_IMAGE_LIMITS.maxEncodedBytes);
  const verdict = inspectCreativeImageHeader(bytes);
  if (!verdict.ok)
    throw invalidOutput(
      `The provider's image is not a valid PNG: ${verdict.message}`,
      verdict.reason,
    );
  const header = verdict.header;
  if (header.format !== "png")
    throw invalidOutput(
      `The provider returned ${header.format} bytes; PNG was requested.`,
      "format",
    );
  if (header.animated) throw invalidOutput("The provider returned an animated image.", "animated");
  const size = parseSize(captured.size);
  if (header.width !== size.width || header.height !== size.height)
    throw invalidOutput(
      `The provider returned ${header.width}x${header.height}; ${size.width}x${size.height} was requested.`,
      "dimensions",
    );
  const requestId = boundedMessage(headers.get("x-request-id"), 120, secret);
  const created = typeof parsed["created"] === "number" ? parsed["created"] : undefined;
  const usage = readUsage(parsed["usage"]);
  return {
    summary: captured.summary,
    encoded: { hash: sha256Hex(bytes), byteLength: bytes.length, mime: OUTPUT_MIME },
    encodedBytes: bytes,
    width: header.width,
    height: header.height,
    format: "png",
    transparent: captured.background === "transparent",
    ...(usage ? { usage } : {}),
    ...(requestId ? { requestId } : {}),
    ...(created !== undefined ? { created } : {}),
  };
}

/** Bounded SSE reader; response Content-Type detects streaming versus the JSON fallback. */
async function readStreamedOffer(
  response: Response,
  captured: CapturedRequest,
  secret: string,
  signal: AbortSignal,
  onPartial?: (bytes: Uint8Array) => void,
): Promise<OpenAiImageOffer> {
  if (!response.body) throw invalidOutput("The image stream is empty.", "missing-image");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    total = 0,
    partials = 0;
  let completed: OpenAiImageOffer | null = null;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  function consume(frame: string) {
    if (signal.aborted) throw new MintedImageError("cancelled", "The request was cancelled.");
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw invalidOutput("The image stream contains an unreadable event.", "json");
    }
    if (!isRecord(event))
      throw invalidOutput("The image stream contains an invalid event.", "json");
    const prefix =
      captured.endpoint === "/v1/images/generations" ? "image_generation" : "image_edit";
    if (event["type"] === `${prefix}.partial_image`) {
      if (++partials > 3 || completed)
        throw invalidOutput("The image stream contains too many previews.", "count");
      if (typeof event["b64_json"] !== "string")
        throw invalidOutput("The preview has no image bytes.", "missing-image");
      const bytes = decodeBase64Strict(event["b64_json"], OPENAI_IMAGE_LIMITS.maxEncodedBytes);
      const header = inspectCreativeImageHeader(bytes);
      if (!header.ok || header.header.format !== "png" || header.header.animated)
        throw invalidOutput("The preview is not a still PNG.", "format");
      onPartial?.(bytes);
    } else if (event["type"] === `${prefix}.completed`) {
      if (completed)
        throw invalidOutput("The image stream contains more than one result.", "count");
      completed = parseOffer(
        new TextEncoder().encode(
          JSON.stringify({
            data: [{ b64_json: event["b64_json"] }],
            output_format: event["output_format"],
            usage: event["usage"],
            created: event["created_at"],
          }),
        ),
        captured,
        response.headers,
        secret,
      );
    } else if (event["type"] === "error" || event["error"] !== undefined) {
      throw classifyHttpError(
        400,
        new TextEncoder().encode(JSON.stringify({ error: event["error"] ?? event })),
        response.headers.get("x-request-id") ?? undefined,
        secret,
      );
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > OPENAI_IMAGE_LIMITS.maxResponseBytes * 4)
        throw invalidOutput("The image stream passed its response limit.", "oversize");
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        consume(frame);
      }
      if (buffer.length > OPENAI_IMAGE_LIMITS.maxResponseBytes)
        throw invalidOutput("An image event passed its response limit.", "oversize");
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (completed === null)
      throw invalidOutput("The image stream ended before the picture was ready.", "missing-image");
    return completed;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function defaultBaseUrl(): string {
  if ((import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === "test")
    return `${globalThis.location.origin}/api/test-images`;
  // Version-free API root; endpoints below carry the /v1 prefix. Dev
  // convention shared with llmClient: the Vite server proxies /api/openai
  // to api.openai.com so local development exercises the same path.
  if (
    typeof import.meta !== "undefined" &&
    Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV)
  ) {
    const origin =
      typeof globalThis.location !== "undefined" && globalThis.location?.origin
        ? globalThis.location.origin
        : "http://localhost:5199";
    return `${origin}/api/openai`;
  }
  return "https://api.openai.com";
}

export function createOpenAiImageProvider(
  options: OpenAiImageProviderOptions,
): OpenAiImageProvider {
  const models = options.models ?? OPENAI_IMAGE_MODELS;
  const transport =
    options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const makeFormData = options.createFormData ?? (() => new FormData());
  const baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, "");
  const jobs = new WeakMap<PreparedOpenAiImage, CapturedRequest>();
  let activeJob = false;

  function buildInit(captured: CapturedRequest, key: string, streaming: boolean): RequestInit {
    if (captured.endpoint === "/v1/images/generations") {
      return {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...(streaming ? { stream: true, partial_images: 2 } : {}),
          model: captured.model,
          prompt: captured.prompt,
          n: 1,
          size: captured.size,
          quality: captured.quality,
          background: captured.background,
          output_format: "png",
        }),
      };
    }
    const form = makeFormData();
    if (streaming) {
      form.append("stream", "true");
      form.append("partial_images", "2");
    }
    form.append("model", captured.model);
    form.append("prompt", captured.prompt);
    form.append("n", "1");
    form.append("size", captured.size);
    form.append("quality", captured.quality);
    form.append("background", captured.background);
    form.append("output_format", "png");
    if (captured.inputFidelity !== undefined) form.append("input_fidelity", captured.inputFidelity);
    for (const image of captured.images)
      form.append("image[]", new Blob([image.bytes], { type: image.summary.mime }), image.filename);
    if (captured.mask !== undefined)
      form.append("mask", new Blob([captured.mask.bytes], { type: OUTPUT_MIME }), "mask.png");
    // The runtime sets the multipart boundary itself; only auth travels on the header.
    return { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form };
  }

  async function run(
    captured: CapturedRequest,
    signal?: AbortSignal,
    onPartial?: (bytes: Uint8Array) => void,
  ): Promise<OpenAiImageOffer> {
    const size = parseSize(captured.size);
    const qualityScale =
      captured.quality === "max"
        ? 6
        : captured.quality === "xhigh"
          ? 4
          : captured.quality === "high"
            ? 2
            : 1;
    const pixelScale = Math.max(1, (size.width * size.height) / (1024 * 1024));
    const timeoutMs =
      options.timeoutMs ?? Math.ceil(OPENAI_IMAGE_LIMITS.timeoutMs * qualityScale * pixelScale);
    if (signal?.aborted) throw new MintedImageError("cancelled", "The request was cancelled.");
    const controller = new AbortController();
    let aborted: "cancelled" | "timeout" | undefined;
    let settled = false;
    let rejectHalt: ((error: OpenAiImageError) => void) | undefined;
    // Every provider await races this: a transport that never settles after
    // an abort still loses, and its late result is consumed by nobody.
    const halt = new Promise<never>((_resolve, reject) => {
      rejectHalt = reject;
    });
    const trip = (kind: "cancelled" | "timeout") => {
      if (settled || aborted !== undefined) return;
      aborted = kind;
      controller.abort();
      rejectHalt?.(
        kind === "timeout"
          ? new MintedImageError(
              "timeout",
              `The provider did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
            )
          : new MintedImageError("cancelled", "The request was cancelled."),
      );
    };
    const timer = setTimeout(() => trip("timeout"), timeoutMs);
    const onAbort = () => trip("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    // A listener does not fire for an abort that landed before it
    // registered; cover that window explicitly.
    if (signal?.aborted) trip("cancelled");
    const checkAborted = () => {
      if (aborted === "timeout")
        throw new MintedImageError(
          "timeout",
          `The provider did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
        );
      if (aborted === "cancelled" || signal?.aborted)
        throw new MintedImageError("cancelled", "The request was cancelled.");
    };
    // Credentials once, inside submit only: preparation and local import
    // paths never ask for the key, and it lives only in the Authorization
    // header of this one request. Declared outside the try so error
    // scrubbing can reach it.
    let key: string | null | undefined;
    try {
      try {
        key = await Promise.race([options.credentials(), halt]);
      } catch (error) {
        // Only a minted error is ours (a halt's cancel/timeout). Any other
        // failure — even a same-class lookalike — is raw callback material:
        // the key may never have been returned, so nothing of it survives.
        if (isMinted(error)) throw error;
        throw new MintedImageError("no-key", "The credentials callback failed.");
      }
      checkAborted();
      if (typeof key !== "string" || key.trim() === "")
        throw new MintedImageError("no-key", "Generation needs the project's OpenAI API key.");
      const streaming = onPartial !== undefined && models[captured.model]?.streaming === true;
      const init = { ...buildInit(captured, key, streaming), signal: controller.signal };
      const response = await Promise.race([
        transport(`${baseUrl}${captured.endpoint}`, init),
        halt,
      ]);
      // A late answer after cancel/timeout is consumed, never published.
      checkAborted();
      if (response.ok && response.headers.get("content-type")?.includes("text/event-stream")) {
        const offer = await Promise.race([
          readStreamedOffer(response, captured, key, controller.signal, onPartial),
          halt,
        ]);
        checkAborted();
        return offer;
      }
      const body = await Promise.race([readBodyBounded(response), halt]);
      checkAborted();
      if (!response.ok)
        throw classifyHttpError(
          response.status,
          body,
          response.headers.get("x-request-id") ?? undefined,
          key,
        );
      const offer = parseOffer(body, captured, response.headers, key);
      checkAborted();
      return offer;
    } catch (error) {
      if (isMinted(error)) throw error;
      checkAborted();
      // External material is rebuilt, never rethrown: a same-class error's
      // message, cause and stack could all carry the key. Bounded detached
      // scalar fields are kept; the cause becomes a scrubbed message.
      const secret = key ?? "";
      const detail: {
        code?: string;
        status?: number;
        requestId?: string;
        possiblyCors: boolean;
        cause?: string;
      } = { possiblyCors: error instanceof TypeError };
      const cause =
        error instanceof Error
          ? (boundedMessage(error.message, 300, secret) ?? error.name)
          : boundedMessage(String(error), 300, secret);
      if (cause !== undefined) detail.cause = cause;
      if (error instanceof OpenAiImageError) {
        if (error.possiblyCors) detail.possiblyCors = true;
        const code = boundedMessage(error.code, 120, secret);
        if (code !== undefined) detail.code = code;
        const status = error.status;
        if (
          typeof status === "number" &&
          Number.isInteger(status) &&
          status >= 100 &&
          status <= 599
        )
          detail.status = status;
        const requestId = boundedMessage(error.requestId, 120, secret);
        if (requestId !== undefined) detail.requestId = requestId;
      }
      throw new MintedImageError(
        "transport",
        "The provider could not be reached: offline, DNS or a browser network block.",
        detail,
      );
    } finally {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // A halt armed but never fired, or fired after the win, is absorbed.
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
        throw new MintedImageError("stale", "That prepared request is stale; prepare it again.");
      if (activeJob)
        throw new MintedImageError(
          "busy",
          "A generation is already running; wait for it or cancel it first.",
        );
      captured.consumed = true;
      activeJob = true;
      try {
        return await run(captured, submitOptions?.signal, submitOptions?.onPartial);
      } finally {
        activeJob = false;
      }
    },
  };
}
