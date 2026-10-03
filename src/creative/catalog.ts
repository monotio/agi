/** Strict source and preparation codecs shared by image intake and native art preparation. */
import type { ViewPreparationRecipe } from "../view/preparation.ts";

/** Lowercase hex SHA-256 over exact bytes. */
export type BlobHash = string;
/** A creative record's stable id (bounded printable slug). */
type RecordId = string;
/** The {id, incarnation, revision} identity triple every record carries. */
export interface VersionRef {
  readonly id: RecordId;
  readonly incarnation: string;
  readonly revision: number;
}
/** Positive-integer rectangle with half-open pixel edges. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** Content-addressed pointer at an immutable stored blob. */
export interface BlobRef {
  readonly hash: BlobHash;
  readonly byteLength: number;
  readonly mime: string;
}
/** Canonical raster: orientation applied once, tightly packed RGBA8. */
export interface RasterRef {
  readonly blob: BlobRef;
  readonly format: "rgba8-srgb-unpremultiplied-v1";
  readonly width: number;
  readonly height: number;
}

export const CREATIVE_SOURCE_FORMAT = "agi.creative-source";
const CREATIVE_RECIPE_FORMAT = "agi.preparation";
const VIEW_PREPARATION_KIND = "view";
export const RASTER_FORMAT = "rgba8-srgb-unpremultiplied-v1";

const SOURCE_AVAILABILITY = ["original", "legacy-reduced"] as const;
const ORIGIN_KINDS = ["import", "paste", "generated", "composite", "legacy"] as const;
/** The only composite pixel transform this format version admits. */
export const SELECTION_COMPOSITE_ALGORITHM = "agi.edit-selection-composite-v1";
const PICTURE_KINDS = ["picture-underlay", "picture-conversion"] as const;
const PICTURE_FITS = ["contain", "cover", "stretch"] as const;
const PICTURE_ASPECTS = ["native", "original-4:3"] as const;
const PICTURE_SAMPLE = "nearest-centre-v1";
const PICTURE_PALETTE = "ega-weighted-243-v1";
const PICTURE_SCOPE = "art";
const DESTINATION_KINDS = ["picture", "view"] as const;

/**
 * Closed provenance for a locally produced composite source: which exact
 * parent records and reviewed rectangle produced its canonical pixels
 * under `SELECTION_COMPOSITE_ALGORITHM`. Present exactly when
 * `origin.kind` is `"composite"`. Both parents resolve inside the same
 * record pool — the base may itself be a composite, the provider parent
 * must be an original `generated` source.
 */
export interface CreativeSourceDerivation {
  readonly kind: "selection-composite";
  readonly version: 1;
  readonly base: VersionRef;
  readonly provider: VersionRef;
  readonly selection: Rect;
  readonly algorithm: typeof SELECTION_COMPOSITE_ALGORITHM;
}

/** One source: exact original bytes plus the canonical raster. */
export interface CreativeSource {
  readonly format: typeof CREATIVE_SOURCE_FORMAT;
  readonly version: 1;
  readonly identity: VersionRef;
  /** Upload/provider output bytes, immutable. */
  readonly encoded: BlobRef;
  readonly availability: (typeof SOURCE_AVAILABILITY)[number];
  /** Orientation applied once; the stable recipe input. */
  readonly normalized: RasterRef;
  readonly origin: {
    readonly kind: (typeof ORIGIN_KINDS)[number];
    readonly title: string;
    readonly attribution?: string | undefined;
    readonly originUrl?: string | undefined;
    readonly rights?: string | undefined;
  };
  readonly derivation?: CreativeSourceDerivation | undefined;
}

/** One source's placement on the reference board. */
export interface CreativeBoardEntry {
  readonly identity: VersionRef;
  readonly source: VersionRef;
  readonly derivative?: VersionRef | undefined;
  readonly roles: readonly ("style" | "composition" | "character-identity" | "exact-source")[];
  readonly approval: "unapproved" | "approved";
  readonly notes: string;
}

/**
 * The picture-side recipe payload, carried as a strictly validated JSON
 * envelope per the 1.2 contracts. No converter exists yet; this codec checks
 * the declared shape so that any other payload (including a later nested
 * version) is refused rather than reinterpreted.
 */
export interface PicturePreparation {
  readonly kind: (typeof PICTURE_KINDS)[number];
  readonly source: VersionRef;
  /** Crop in oriented canonical source pixels. */
  readonly crop: Rect;
  /** Logical AGI cells, inside 160 x 168. */
  readonly destination: Rect;
  readonly fit: (typeof PICTURE_FITS)[number];
  readonly intendedAspect: (typeof PICTURE_ASPECTS)[number];
  readonly sample: typeof PICTURE_SAMPLE;
  readonly opacity: number;
  readonly palette: typeof PICTURE_PALETTE;
  readonly alpha: { readonly threshold: number; readonly matte: number };
  readonly scope: typeof PICTURE_SCOPE;
}

/** The recipe payload: the existing view recipe type or a picture envelope. */
export type CreativePreparation = ViewPreparationRecipe | PicturePreparation;

/** A preparation recipe as the catalog keeps it. */
export interface CreativeRecipe {
  readonly format: typeof CREATIVE_RECIPE_FORMAT;
  readonly version: 1;
  readonly identity: VersionRef;
  readonly sources: readonly VersionRef[];
  /** Pins sampling, palette and mask behavior. */
  readonly algorithm: string;
  readonly preparation: CreativePreparation;
  readonly destination: {
    readonly kind: (typeof DESTINATION_KINDS)[number];
    readonly resourceId: number;
  };
  /** Equality evidence for produced payloads; never identity. */
  readonly outputPayloadHash?: BlobHash | undefined;
}

/** Declared policy bounds. Defaults to measure, not a browser quota promise. */
export const CREATIVE_LIMITS = Object.freeze({
  /** One encoded original file. */
  maxFileBytes: 8 * 1024 * 1024,
  /** Decoded pixels per canonical raster. */
  maxDecodedPixels: 16 * 1024 * 1024,
  /** Longest decoded raster side. */
  maxDecodedSide: 8192,
  /** Logical picture cells. */
  pictureWidth: 160,
  pictureHeight: 168,
  maxIdLength: 128,
  maxTitleLength: 240,
  maxOriginFieldLength: 1024,
  maxAlgorithmLength: 128,
  maxGeneratorLength: 128,
  maxMimeLength: 255,
} as const);

/** Codec refusal: stored or offered catalog data this version rejects. */
export class CreativeCatalogError extends Error {
  readonly code: "unsupported" | "invalid";
  constructor(code: "unsupported" | "invalid", message: string) {
    super(message);
    this.name = "CreativeCatalogError";
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new CreativeCatalogError("invalid", `Invalid creative catalog data: ${message}`);
}

function unsupported(message: string): never {
  throw new CreativeCatalogError("unsupported", `Unsupported creative catalog data: ${message}`);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    invalid(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

/** Every field declared, nothing else — unknown fields are a newer shape. */
function fields(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const record = plainObject(value, label);
  for (const name of required)
    if (!Object.hasOwn(record, name)) invalid(`${label} is missing '${name}'.`);
  for (const key of Object.keys(record))
    if (!required.includes(key) && !optional.includes(key))
      invalid(`${label} has an unknown field '${key}'.`);
  return record;
}

function int(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    invalid(`${label} must be an integer ${min}..${max}.`);
  return value;
}

function boundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    invalid(`${label} must be a string of 1..${max} characters.`);
  return value;
}

function blobHash(value: unknown, label: string): BlobHash {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    invalid(`${label} must be a lowercase SHA-256 hex digest.`);
  return value;
}

export function readVersionRef(value: unknown, label: string): VersionRef {
  const record = fields(value, label, ["id", "incarnation", "revision"]);
  // The src/view/preparation.ts SourceIdentity contract: non-empty id and
  // incarnation, non-negative safe revision.
  return {
    id: boundedString(record["id"], CREATIVE_LIMITS.maxIdLength, `${label}.id`),
    incarnation: boundedString(
      record["incarnation"],
      CREATIVE_LIMITS.maxIdLength,
      `${label}.incarnation`,
    ),
    revision: int(record["revision"], 0, Number.MAX_SAFE_INTEGER, `${label}.revision`),
  };
}

export function versionRefKey(ref: VersionRef): string {
  return `${ref.id} ${ref.incarnation} ${ref.revision}`;
}

export function sameVersionRef(a: VersionRef, b: VersionRef): boolean {
  return a.id === b.id && a.incarnation === b.incarnation && a.revision === b.revision;
}

function readBlobRef(value: unknown, label: string): BlobRef {
  const record = fields(value, label, ["hash", "byteLength", "mime"]);
  return {
    hash: blobHash(record["hash"], `${label}.hash`),
    byteLength: int(record["byteLength"], 1, Number.MAX_SAFE_INTEGER, `${label}.byteLength`),
    mime: boundedString(record["mime"], CREATIVE_LIMITS.maxMimeLength, `${label}.mime`),
  };
}

function readRasterRef(value: unknown, label: string): RasterRef {
  const record = fields(value, label, ["blob", "format", "width", "height"]);
  if (record["format"] !== RASTER_FORMAT)
    unsupported(`${label}.format '${String(record["format"])}' is not '${RASTER_FORMAT}'.`);
  const width = int(record["width"], 1, CREATIVE_LIMITS.maxDecodedSide, `${label}.width`);
  const height = int(record["height"], 1, CREATIVE_LIMITS.maxDecodedSide, `${label}.height`);
  if (width * height > CREATIVE_LIMITS.maxDecodedPixels)
    invalid(`${label} is ${width}x${height}, over the decoded pixel limit.`);
  const blob = readBlobRef(record["blob"], `${label}.blob`);
  if (blob.byteLength !== width * height * 4)
    invalid(`${label}.blob length does not match ${width}x${height} tightly packed RGBA8.`);
  return { blob, format: RASTER_FORMAT, width, height };
}

function readSourceDerivation(value: unknown, label = "derivation"): CreativeSourceDerivation {
  const record = fields(value, label, [
    "kind",
    "version",
    "base",
    "provider",
    "selection",
    "algorithm",
  ]);
  if (record["kind"] !== "selection-composite")
    unsupported(`${label}.kind '${String(record["kind"])}' is not 'selection-composite'.`);
  if (record["version"] !== 1)
    unsupported(`${label}.version ${String(record["version"])} is not 1.`);
  if (record["algorithm"] !== SELECTION_COMPOSITE_ALGORITHM)
    unsupported(
      `${label}.algorithm '${String(record["algorithm"])}' is not '${SELECTION_COMPOSITE_ALGORITHM}'.`,
    );
  return {
    kind: "selection-composite",
    version: 1,
    base: readVersionRef(record["base"], `${label}.base`),
    provider: readVersionRef(record["provider"], `${label}.provider`),
    selection: readRect(record["selection"], `${label}.selection`),
    algorithm: SELECTION_COMPOSITE_ALGORITHM,
  };
}

export function readCreativeSource(value: unknown, label = "source"): CreativeSource {
  const record = fields(
    value,
    label,
    ["format", "version", "identity", "encoded", "availability", "normalized", "origin"],
    ["derivation"],
  );
  if (record["format"] !== CREATIVE_SOURCE_FORMAT)
    unsupported(
      `${label}.format '${String(record["format"])}' is not '${CREATIVE_SOURCE_FORMAT}'.`,
    );
  if (record["version"] !== 1)
    unsupported(`${label}.version ${String(record["version"])} is not 1.`);
  const encoded = readBlobRef(record["encoded"], `${label}.encoded`);
  if (encoded.byteLength > CREATIVE_LIMITS.maxFileBytes)
    invalid(`${label}.encoded exceeds the per-file byte limit.`);
  const availability = record["availability"];
  if (!SOURCE_AVAILABILITY.includes(availability as (typeof SOURCE_AVAILABILITY)[number]))
    invalid(`${label}.availability '${String(availability)}' is unknown.`);
  const origin = fields(
    record["origin"],
    `${label}.origin`,
    ["kind", "title"],
    ["attribution", "originUrl", "rights"],
  );
  if (!ORIGIN_KINDS.includes(origin["kind"] as (typeof ORIGIN_KINDS)[number]))
    invalid(`${label}.origin.kind '${String(origin["kind"])}' is unknown.`);
  const derivation =
    record["derivation"] === undefined
      ? undefined
      : readSourceDerivation(record["derivation"], `${label}.derivation`);
  if ((origin["kind"] === "composite") !== (derivation !== undefined))
    invalid(
      derivation === undefined
        ? `${label} is a 'composite' origin without a derivation.`
        : `${label}.derivation requires a 'composite' origin.`,
    );
  if (derivation !== undefined) {
    const identity = readVersionRef(record["identity"], `${label}.identity`);
    if (sameVersionRef(derivation.base, identity) || sameVersionRef(derivation.provider, identity))
      invalid(`${label}.derivation cannot name the record itself as a parent.`);
    if (sameVersionRef(derivation.base, derivation.provider))
      invalid(`${label}.derivation parents must be two distinct records.`);
  }
  const optionalOrigin = (name: "attribution" | "originUrl" | "rights") =>
    origin[name] === undefined
      ? undefined
      : boundedString(
          origin[name],
          CREATIVE_LIMITS.maxOriginFieldLength,
          `${label}.origin.${name}`,
        );
  return {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: readVersionRef(record["identity"], `${label}.identity`),
    encoded,
    availability: availability as CreativeSource["availability"],
    normalized: readRasterRef(record["normalized"], `${label}.normalized`),
    ...(derivation !== undefined ? { derivation } : {}),
    origin: {
      kind: origin["kind"] as CreativeSource["origin"]["kind"],
      title: boundedString(
        origin["title"],
        CREATIVE_LIMITS.maxTitleLength,
        `${label}.origin.title`,
      ),
      ...(optionalOrigin("attribution") !== undefined
        ? { attribution: optionalOrigin("attribution") }
        : {}),
      ...(optionalOrigin("originUrl") !== undefined
        ? { originUrl: optionalOrigin("originUrl") }
        : {}),
      ...(optionalOrigin("rights") !== undefined ? { rights: optionalOrigin("rights") } : {}),
    },
  };
}

function readRect(value: unknown, label: string): Rect {
  const record = fields(value, label, ["x", "y", "width", "height"]);
  return {
    x: int(record["x"], 0, Number.MAX_SAFE_INTEGER, `${label}.x`),
    y: int(record["y"], 0, Number.MAX_SAFE_INTEGER, `${label}.y`),
    width: int(record["width"], 1, Number.MAX_SAFE_INTEGER, `${label}.width`),
    height: int(record["height"], 1, Number.MAX_SAFE_INTEGER, `${label}.height`),
  };
}

/**
 * The picture recipe envelope: the declared contract fields, exactly. It is
 * deliberately shape-locked — a field added by a later schema makes this read
 * fail instead of dropping the field on the next write.
 */
function readPicturePreparation(value: unknown, label: string): PicturePreparation {
  const record = fields(value, label, [
    "kind",
    "source",
    "crop",
    "destination",
    "fit",
    "intendedAspect",
    "sample",
    "opacity",
    "palette",
    "alpha",
    "scope",
  ]);
  const kind = record["kind"];
  if (!PICTURE_KINDS.includes(kind as (typeof PICTURE_KINDS)[number]))
    unsupported(`${label}.kind '${String(kind)}' is not a known picture preparation.`);
  if (!PICTURE_FITS.includes(record["fit"] as (typeof PICTURE_FITS)[number]))
    invalid(`${label}.fit '${String(record["fit"])}' is unknown.`);
  if (!PICTURE_ASPECTS.includes(record["intendedAspect"] as (typeof PICTURE_ASPECTS)[number]))
    invalid(`${label}.intendedAspect '${String(record["intendedAspect"])}' is unknown.`);
  if (record["sample"] !== PICTURE_SAMPLE)
    unsupported(`${label}.sample '${String(record["sample"])}' is not '${PICTURE_SAMPLE}'.`);
  if (record["palette"] !== PICTURE_PALETTE)
    unsupported(`${label}.palette '${String(record["palette"])}' is not '${PICTURE_PALETTE}'.`);
  if (record["scope"] !== PICTURE_SCOPE)
    unsupported(`${label}.scope '${String(record["scope"])}' is not '${PICTURE_SCOPE}'.`);
  const opacity = record["opacity"];
  if (typeof opacity !== "number" || !(opacity >= 0 && opacity <= 1))
    invalid(`${label}.opacity must be a number 0..1.`);
  const alpha = fields(record["alpha"], `${label}.alpha`, ["threshold", "matte"]);
  const destination = readRect(record["destination"], `${label}.destination`);
  if (
    destination.x + destination.width > CREATIVE_LIMITS.pictureWidth ||
    destination.y + destination.height > CREATIVE_LIMITS.pictureHeight
  )
    invalid(
      `${label}.destination must fit inside ${CREATIVE_LIMITS.pictureWidth}x${CREATIVE_LIMITS.pictureHeight} logical cells.`,
    );
  return {
    kind: kind as PicturePreparation["kind"],
    source: readVersionRef(record["source"], `${label}.source`),
    crop: readRect(record["crop"], `${label}.crop`),
    destination,
    fit: record["fit"] as PicturePreparation["fit"],
    intendedAspect: record["intendedAspect"] as PicturePreparation["intendedAspect"],
    sample: PICTURE_SAMPLE,
    opacity,
    palette: PICTURE_PALETTE,
    alpha: {
      threshold: int(alpha["threshold"], 0, 255, `${label}.alpha.threshold`),
      matte: int(alpha["matte"], 0, 15, `${label}.alpha.matte`),
    },
    scope: PICTURE_SCOPE,
  };
}

const VIEW_RECIPE_FRAME_FIELDS = [
  "id",
  "source",
  "region",
  "outputWidth",
  "outputHeight",
  "sourceAnchor",
  "outputAnchorX",
  "sample",
  "allowCropBelowBaseline",
  "allowCropOutsideCanvas",
] as const;
const VIEW_RECIPE_LOOP_FIELDS = ["id", "frameIds", "mirrorOf", "explicitlyApproved", "facing"];
const VIEW_FACINGS = ["right", "left", "down", "up"] as const;

/**
 * Storage-shape validation for the existing ViewPreparationRecipe. Semantic
 * validation (anchors, sampling, native encoding) remains prepareView's job;
 * this codec guarantees the stored payload's declared format, version and
 * field set so unknown nested versions fail before any interpretation.
 */
function readViewPreparation(value: unknown, label: string): ViewPreparationRecipe {
  const record = fields(
    value,
    label,
    ["format", "version", "kind", "algorithm", "sources", "palette", "mask", "frames", "loops"],
    ["description"],
  );
  if (record["format"] !== CREATIVE_RECIPE_FORMAT)
    unsupported(
      `${label}.format '${String(record["format"])}' is not '${CREATIVE_RECIPE_FORMAT}'.`,
    );
  if (record["version"] !== 1)
    unsupported(`${label}.version ${String(record["version"])} is not 1.`);
  if (record["kind"] !== VIEW_PREPARATION_KIND)
    unsupported(`${label}.kind '${String(record["kind"])}' is not '${VIEW_PREPARATION_KIND}'.`);
  const algorithm = boundedString(
    record["algorithm"],
    CREATIVE_LIMITS.maxAlgorithmLength,
    `${label}.algorithm`,
  );
  if (!Array.isArray(record["sources"]))
    invalid(`${label}.sources must be an array of source identities.`);
  const sources = (record["sources"] as unknown[]).map((ref, i) =>
    readVersionRef(ref, `${label}.sources[${i}]`),
  );
  const mask = fields(record["mask"], `${label}.mask`, ["alphaThreshold", "key"]);
  const alphaThreshold = int(mask["alphaThreshold"], 0, 255, `${label}.mask.alphaThreshold`);
  const key = mask["key"];
  let parsedKey: ViewPreparationRecipe["mask"]["key"];
  if (key === null) parsedKey = null;
  else {
    const keyRecord = fields(key, `${label}.mask.key`, ["mode", "rgb"]);
    const rgb = keyRecord["rgb"];
    if (
      !Array.isArray(rgb) ||
      rgb.length !== 3 ||
      !rgb.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
    )
      invalid(`${label}.mask.key.rgb must be three integers 0..255.`);
    parsedKey = {
      mode: boundedString(
        keyRecord["mode"],
        CREATIVE_LIMITS.maxAlgorithmLength,
        `${label}.mask.key.mode`,
      ),
      rgb: [rgb[0]!, rgb[1]!, rgb[2]!],
    };
  }
  const palette = boundedString(
    record["palette"],
    CREATIVE_LIMITS.maxAlgorithmLength,
    `${label}.palette`,
  );
  const frameIds = new Set<string>();
  const framesValue = record["frames"];
  if (!Array.isArray(framesValue)) invalid(`${label}.frames must be an array.`);
  const frames = framesValue.map((frame, i) => {
    const frameLabel = `${label}.frames[${i}]`;
    const f = fields(frame, frameLabel, [...VIEW_RECIPE_FRAME_FIELDS]);
    const id = boundedString(f["id"], CREATIVE_LIMITS.maxIdLength, `${frameLabel}.id`);
    if (frameIds.has(id)) invalid(`${frameLabel}.id '${id}' is duplicated.`);
    frameIds.add(id);
    const anchor = fields(f["sourceAnchor"], `${frameLabel}.sourceAnchor`, ["x", "baselineEdgeY"]);
    if (f["sample"] !== PICTURE_SAMPLE)
      unsupported(`${frameLabel}.sample '${String(f["sample"])}' is not '${PICTURE_SAMPLE}'.`);
    if (
      typeof f["allowCropBelowBaseline"] !== "boolean" ||
      typeof f["allowCropOutsideCanvas"] !== "boolean"
    )
      invalid(`${frameLabel} crop approvals must be explicit booleans.`);
    return {
      id,
      source: readVersionRef(f["source"], `${frameLabel}.source`),
      region: readRect(f["region"], `${frameLabel}.region`),
      outputWidth: int(
        f["outputWidth"],
        1,
        CREATIVE_LIMITS.pictureWidth,
        `${frameLabel}.outputWidth`,
      ),
      outputHeight: int(
        f["outputHeight"],
        1,
        CREATIVE_LIMITS.pictureHeight,
        `${frameLabel}.outputHeight`,
      ),
      sourceAnchor: {
        x: int(anchor["x"], 0, Number.MAX_SAFE_INTEGER, `${frameLabel}.sourceAnchor.x`),
        baselineEdgeY: int(
          anchor["baselineEdgeY"],
          0,
          Number.MAX_SAFE_INTEGER,
          `${frameLabel}.sourceAnchor.baselineEdgeY`,
        ),
      },
      outputAnchorX: int(
        f["outputAnchorX"],
        0,
        CREATIVE_LIMITS.pictureWidth,
        `${frameLabel}.outputAnchorX`,
      ),
      sample: f["sample"],
      allowCropBelowBaseline: f["allowCropBelowBaseline"],
      allowCropOutsideCanvas: f["allowCropOutsideCanvas"],
    };
  });
  const loopIds = new Set<string>();
  const loopsValue = record["loops"];
  if (!Array.isArray(loopsValue)) invalid(`${label}.loops must be an array.`);
  const loops = loopsValue.map((loop, i) => {
    const loopLabel = `${label}.loops[${i}]`;
    const l = plainObject(loop, loopLabel);
    for (const key of Object.keys(l))
      if (!VIEW_RECIPE_LOOP_FIELDS.includes(key))
        invalid(`${loopLabel} has an unknown field '${key}'.`);
    const id = boundedString(l["id"], CREATIVE_LIMITS.maxIdLength, `${loopLabel}.id`);
    if (loopIds.has(id)) invalid(`${loopLabel}.id '${id}' is duplicated.`);
    loopIds.add(id);
    const facing = l["facing"];
    if (facing !== undefined && !VIEW_FACINGS.includes(facing as (typeof VIEW_FACINGS)[number]))
      invalid(`${loopLabel}.facing '${String(facing)}' is unknown.`);
    const hasFrames = l["frameIds"] !== undefined;
    const hasMirror = l["mirrorOf"] !== undefined;
    if (hasFrames === hasMirror)
      invalid(`${loopLabel} must declare exactly one of frameIds or mirrorOf.`);
    if (hasFrames) {
      const ids = l["frameIds"];
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        !ids.every((f) => typeof f === "string" && frameIds.has(f))
      )
        invalid(`${loopLabel}.frameIds must reference declared frames.`);
      return {
        id,
        frameIds: [...ids] as readonly string[],
        ...(facing !== undefined ? { facing: facing as (typeof VIEW_FACINGS)[number] } : {}),
      };
    }
    if (l["explicitlyApproved"] !== true)
      invalid(`${loopLabel}.explicitlyApproved must be true for a mirrored loop.`);
    return {
      id,
      mirrorOf: boundedString(l["mirrorOf"], CREATIVE_LIMITS.maxIdLength, `${loopLabel}.mirrorOf`),
      explicitlyApproved: true,
      ...(facing !== undefined ? { facing: facing as (typeof VIEW_FACINGS)[number] } : {}),
    };
  });
  const description = record["description"];
  if (description !== undefined && (typeof description !== "string" || description.length > 1024))
    invalid(`${label}.description must be a string of at most 1024 characters.`);
  return {
    format: CREATIVE_RECIPE_FORMAT,
    version: 1,
    kind: VIEW_PREPARATION_KIND,
    algorithm,
    sources,
    palette,
    mask: { alphaThreshold, key: parsedKey },
    frames,
    loops,
    ...(description !== undefined ? { description: description as string } : {}),
  };
}

/** Read one preparation payload, discriminated by its declared kind. */
export function readCreativePreparation(
  value: unknown,
  label = "preparation",
): CreativePreparation {
  const record = plainObject(value, label);
  if (record["kind"] === VIEW_PREPARATION_KIND) return readViewPreparation(record, label);
  return readPicturePreparation(record, label);
}

export function readCreativeRecipe(value: unknown, label = "recipe"): CreativeRecipe {
  const record = fields(
    value,
    label,
    ["format", "version", "identity", "sources", "algorithm", "preparation", "destination"],
    ["outputPayloadHash"],
  );
  if (record["format"] !== CREATIVE_RECIPE_FORMAT)
    unsupported(
      `${label}.format '${String(record["format"])}' is not '${CREATIVE_RECIPE_FORMAT}'.`,
    );
  if (record["version"] !== 1)
    unsupported(`${label}.version ${String(record["version"])} is not 1.`);
  const sourcesValue = record["sources"];
  if (!Array.isArray(sourcesValue) || sourcesValue.length === 0)
    invalid(`${label}.sources must be a non-empty array of source identities.`);
  const sources = sourcesValue.map((ref, i) => readVersionRef(ref, `${label}.sources[${i}]`));
  const preparation = readCreativePreparation(record["preparation"], `${label}.preparation`);
  const declared = new Set(sources.map(versionRefKey));
  const innerSources =
    preparation.kind === "view"
      ? preparation.sources
      : [(preparation as PicturePreparation).source];
  for (const ref of innerSources)
    if (!declared.has(versionRefKey(ref)))
      invalid(`${label}.sources does not cover the preparation's source identities.`);
  const destination = fields(record["destination"], `${label}.destination`, ["kind", "resourceId"]);
  if (!DESTINATION_KINDS.includes(destination["kind"] as (typeof DESTINATION_KINDS)[number]))
    invalid(`${label}.destination.kind '${String(destination["kind"])}' is unknown.`);
  if (destination["kind"] === "view" && preparation.kind !== "view")
    invalid(`${label}.destination is a view but the preparation is not.`);
  if (destination["kind"] === "picture" && preparation.kind === "view")
    invalid(`${label}.destination is a picture but the preparation is a view recipe.`);
  return {
    format: CREATIVE_RECIPE_FORMAT,
    version: 1,
    identity: readVersionRef(record["identity"], `${label}.identity`),
    sources,
    algorithm: boundedString(
      record["algorithm"],
      CREATIVE_LIMITS.maxAlgorithmLength,
      `${label}.algorithm`,
    ),
    preparation,
    destination: {
      kind: destination["kind"] as CreativeRecipe["destination"]["kind"],
      resourceId: int(destination["resourceId"], 0, 255, `${label}.destination.resourceId`),
    },
    ...(record["outputPayloadHash"] !== undefined
      ? { outputPayloadHash: blobHash(record["outputPayloadHash"], `${label}.outputPayloadHash`) }
      : {}),
  };
}

/**
 * The closed derivation graph over one pool of source records: every
 * composite's two parents resolve inside this same set, the provider
 * parent is an original (non-composite) `generated` source, the reviewed
 * rectangle fits inside the base's canonical raster, the composite's
 * canonical dimensions equal the base's, and following base links never
 * revisits a record. An identity carried under two different records, a
 * missing or mismatched parent, or a dependency on a record outside this
 * pool refuses by name.
 */
export function checkSourceDerivations(
  sources: readonly CreativeSource[],
  label = "creative sources",
): void {
  const pool = new Map<string, CreativeSource>();
  for (const source of sources) {
    const key = versionRefKey(source.identity);
    const prior = pool.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(source))
      invalid(`${label}: identity '${key}' names two different records.`);
    pool.set(key, source);
  }
  const resolve = (ref: VersionRef, role: string, owner: CreativeSource): CreativeSource => {
    const record = pool.get(versionRefKey(ref));
    if (record === undefined)
      invalid(
        `${label}: composite '${owner.identity.id}' ${role} '${ref.id}@${ref.revision}' is not carried in this record set.`,
      );
    return record;
  };
  for (const source of sources) {
    const derivation = source.derivation;
    if ((source.origin.kind === "composite") !== (derivation !== undefined))
      invalid(
        `${label}: '${source.identity.id}' origin '${source.origin.kind}' and derivation do not agree.`,
      );
    if (derivation === undefined) continue;
    const base = resolve(derivation.base, "base", source);
    const provider = resolve(derivation.provider, "provider", source);
    if (provider.origin.kind !== "generated" || provider.derivation !== undefined)
      invalid(
        `${label}: composite '${source.identity.id}' provider parent must be an original generated source.`,
      );
    if (
      source.normalized.width !== base.normalized.width ||
      source.normalized.height !== base.normalized.height
    )
      invalid(
        `${label}: composite '${source.identity.id}' dimensions ${source.normalized.width}x${source.normalized.height} do not equal its base's ${base.normalized.width}x${base.normalized.height}.`,
      );
    const { x, y, width, height } = derivation.selection;
    if (x + width > base.normalized.width || y + height > base.normalized.height)
      invalid(
        `${label}: composite '${source.identity.id}' selection ${width}x${height} at ${x},${y} exceeds its ${base.normalized.width}x${base.normalized.height} base.`,
      );
    // Base links must terminate: a bounded walk that refuses a revisit.
    const seen = new Set<string>([versionRefKey(source.identity)]);
    let cursor: CreativeSource = base;
    while (cursor.derivation !== undefined) {
      const key = versionRefKey(cursor.identity);
      if (seen.has(key))
        invalid(`${label}: composite '${source.identity.id}' derivation cycles through '${key}'.`);
      seen.add(key);
      cursor = resolve(cursor.derivation.base, "base", cursor);
    }
  }
}

// ---------- record keys ----------
