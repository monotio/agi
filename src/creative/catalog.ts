/**
 * Creative asset catalog: strict record types, codecs and budget helpers for
 * the project's imported/generated art store.
 *
 * The catalog is the authoritative description of a project's creative data —
 * source originals and their orientation-normalized rasters, derived blobs,
 * reference-board entries and preparation recipes — keyed by content hash.
 * It carries no blob bytes itself; the storage layer keeps those in sibling
 * content-addressed blob records and uses these codecs to validate every
 * manifest it reads or writes.
 *
 * Source identity uses the same {id, incarnation, revision} contract as
 * src/view/preparation.ts's SourceIdentity. View recipes reuse the existing
 * ViewPreparationRecipe shape verbatim; picture recipes are a strictly
 * validated JSON envelope only — this module validates the declared fields
 * and never converts pixels. Unknown nested formats/versions are refused on
 * read and write; nothing is normalized away.
 *
 * Zero runtime dependencies; runs in browser, worker and Node.
 */

import { sha256Hex } from "../crypto.ts";
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

/** The budget bucket a blob reference belongs to: encoded original, canonical raster/approved variant, or disposable derivative. */
export type BlobBucket = (typeof BLOB_BUCKETS)[number];

/**
 * A blob record the catalog registered: its descriptor plus the budget
 * buckets the hash has ever been claimed under. Bucket provenance is
 * retained even after the records that claimed it leave the kept set, so
 * recovery/undo holds keep counting retained bytes against the right
 * budget. `buckets` is required — a registered blob without provenance is
 * malformed and refused, never reinterpreted.
 */
export interface RegisteredBlob extends BlobRef {
  readonly buckets: readonly BlobBucket[];
}
/** Canonical raster: orientation applied once, tightly packed RGBA8. */
export interface RasterRef {
  readonly blob: BlobRef;
  readonly format: "rgba8-srgb-unpremultiplied-v1";
  readonly width: number;
  readonly height: number;
}

export const CREATIVE_SOURCE_FORMAT = "agi.creative-source";
export const CREATIVE_RECIPE_FORMAT = "agi.preparation";
export const VIEW_PREPARATION_KIND = "view";
export const RASTER_FORMAT = "rgba8-srgb-unpremultiplied-v1";
export const CREATIVE_CATALOG_FORMAT = "monotio.agi.creative-catalog";
const CREATIVE_BLOB_FORMAT = "monotio.agi.creative-blob";

const SOURCE_AVAILABILITY = ["original", "legacy-reduced"] as const;
const ORIGIN_KINDS = ["import", "paste", "generated", "composite", "legacy"] as const;
/** The only composite pixel transform this format version admits. */
export const SELECTION_COMPOSITE_ALGORITHM = "agi.edit-selection-composite-v1";
const DERIVATIVE_PURPOSES = ["thumbnail", "provider-input", "approved-variant"] as const;
const BOARD_ROLES = ["style", "composition", "character-identity", "exact-source"] as const;
const BOARD_APPROVALS = ["unapproved", "approved"] as const;
const HOLD_KINDS = ["recovery", "retained-undo"] as const;
const BLOB_BUCKETS = ["canonical", "disposable", "original"] as const;
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

/** One kept source: exact original bytes plus the canonical raster. */
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

/** A derived blob (thumbnail, provider input, approved variant). */
export interface CreativeDerivative {
  readonly identity: VersionRef;
  readonly source: VersionRef;
  readonly blob: BlobRef;
  readonly purpose: (typeof DERIVATIVE_PURPOSES)[number];
  readonly generatorVersion: string;
  readonly recipe?: VersionRef | undefined;
}

/** One source's placement on the reference board. */
export interface CreativeBoardEntry {
  readonly identity: VersionRef;
  readonly source: VersionRef;
  readonly derivative?: VersionRef | undefined;
  readonly roles: readonly (typeof BOARD_ROLES)[number][];
  readonly approval: (typeof BOARD_APPROVALS)[number];
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

/** Records staged under a lease, awaiting a Keep that promotes them. */
interface CreativeStaged {
  readonly sources: readonly CreativeSource[];
  readonly derivatives: readonly CreativeDerivative[];
  readonly recipes: readonly CreativeRecipe[];
  /** Blob descriptors written beside this lease. */
  readonly blobs: readonly BlobRef[];
}

/** A staging lease: staged bytes stay reachable while it is live. */
export interface CreativeLease {
  readonly id: string;
  readonly owner: string;
  /** The workspace incarnation this lease was staged under. */
  readonly workspace: string;
  readonly expiresAt: number;
  readonly staged: CreativeStaged;
}

/** A durable reachability hold (recovery payload, retained undo). */
export interface CreativeHold {
  readonly id: string;
  readonly kind: (typeof HOLD_KINDS)[number];
  readonly hashes: readonly BlobHash[];
}

/**
 * The validated catalog. `head` is the manifest's monotone revision — every
 * staging, lease, hold or GC write advances it. `kept` advances only when the
 * kept record set changes, and is what a project body's marker pins.
 */
export interface CreativeCatalog {
  /** The record's key in the shared store: `creative/<projectId>`. */
  readonly projectId: string;
  readonly head: number;
  readonly kept: number;
  readonly sources: readonly CreativeSource[];
  readonly derivatives: readonly CreativeDerivative[];
  readonly board: readonly CreativeBoardEntry[];
  readonly recipes: readonly CreativeRecipe[];
  readonly leases: readonly CreativeLease[];
  readonly holds: readonly CreativeHold[];
  /** Existence index of blob records the catalog wrote: hash → descriptor + bucket provenance. */
  readonly blobs: Readonly<Record<BlobHash, RegisteredBlob>>;
}

/** Declared policy bounds. Defaults to measure, not a browser quota promise. */
export const CREATIVE_LIMITS = Object.freeze({
  /** One encoded original file. */
  maxFileBytes: 8 * 1024 * 1024,
  /** Kept source records per project. */
  maxSources: 16,
  /** Unique encoded original bytes per project. */
  maxOriginalBytes: 128 * 1024 * 1024,
  /** Unique canonical raster + approved-variant bytes per project. */
  maxCanonicalBytes: 128 * 1024 * 1024,
  /** Unique disposable (thumbnail/provider-input) bytes per project. */
  maxDisposableBytes: 16 * 1024 * 1024,
  /** Decoded pixels per canonical raster. */
  maxDecodedPixels: 16 * 1024 * 1024,
  /** Longest decoded raster side. */
  maxDecodedSide: 8192,
  /** Logical picture cells. */
  pictureWidth: 160,
  pictureHeight: 168,
  /** Manifest bookkeeping bounds. */
  maxDerivatives: 256,
  maxRecipes: 256,
  maxBoardEntries: 256,
  maxLeases: 8,
  maxStagedRecords: 256,
  maxStagedBlobs: 256,
  maxHolds: 64,
  maxHoldHashes: 1024,
  maxIdLength: 128,
  maxTitleLength: 240,
  maxOriginFieldLength: 1024,
  maxNotesLength: 4096,
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

/** Code-point order, the canonical order for ids, keys and hash strings. */
export function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < x.length && i < y.length; i++) {
    const order = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (order !== 0) return order;
  }
  return x.length - y.length;
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

function recordId(value: unknown, label: string): RecordId {
  const id = boundedString(value, CREATIVE_LIMITS.maxIdLength, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    invalid(`${label} must be a printable id (letters, digits, '.', '_', '-').`);
  return id;
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

/** The logical asset a versioned identity belongs to: same id and incarnation, any revision. */
function logicalIdentityKey(ref: VersionRef): string {
  return `${ref.id} ${ref.incarnation}`;
}

function compareVersionRefs(a: VersionRef, b: VersionRef): number {
  return (
    compareCodePoints(a.id, b.id) ||
    compareCodePoints(a.incarnation, b.incarnation) ||
    a.revision - b.revision
  );
}

function readBlobRef(value: unknown, label: string): BlobRef {
  const record = fields(value, label, ["hash", "byteLength", "mime"]);
  return {
    hash: blobHash(record["hash"], `${label}.hash`),
    byteLength: int(record["byteLength"], 1, Number.MAX_SAFE_INTEGER, `${label}.byteLength`),
    mime: boundedString(record["mime"], CREATIVE_LIMITS.maxMimeLength, `${label}.mime`),
  };
}

function readBlobBuckets(value: unknown, label: string): BlobBucket[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((b) => BLOB_BUCKETS.includes(b as BlobBucket)) ||
    new Set(value).size !== value.length
  )
    invalid(`${label} must list each known budget bucket at most once.`);
  return (value as BlobBucket[]).sort(compareCodePoints);
}

function readRegisteredBlob(value: unknown, label: string): RegisteredBlob {
  const record = fields(value, label, ["hash", "byteLength", "mime", "buckets"]);
  return {
    hash: blobHash(record["hash"], `${label}.hash`),
    byteLength: int(record["byteLength"], 1, Number.MAX_SAFE_INTEGER, `${label}.byteLength`),
    mime: boundedString(record["mime"], CREATIVE_LIMITS.maxMimeLength, `${label}.mime`),
    buckets: readBlobBuckets(record["buckets"], `${label}.buckets`),
  };
}

/** The budget bucket a derivative's blob belongs to. */
export function derivativeBlobBucket(purpose: CreativeDerivative["purpose"]): BlobBucket {
  return purpose === "approved-variant" ? "canonical" : "disposable";
}

/**
 * Record a reference's claim in a mutable bucket index. The same bytes under
 * another role keep both buckets; a conflicting byte length or mime for the
 * same hash is an integrity refusal, never a silent merge.
 */
export function mergeBlobRegistration(
  blobs: Record<BlobHash, RegisteredBlob>,
  ref: BlobRef,
  bucket: BlobBucket,
): void {
  const existing = blobs[ref.hash];
  if (existing === undefined) {
    blobs[ref.hash] = {
      hash: ref.hash,
      byteLength: ref.byteLength,
      mime: ref.mime,
      buckets: [bucket],
    };
    return;
  }
  if (existing.byteLength !== ref.byteLength || existing.mime !== ref.mime)
    invalid(`blob '${ref.hash}' is claimed with a different byte length or mime than registered.`);
  if (!existing.buckets.includes(bucket))
    blobs[ref.hash] = {
      ...existing,
      buckets: [...existing.buckets, bucket].sort(compareCodePoints),
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

export function readCreativeDerivative(value: unknown, label = "derivative"): CreativeDerivative {
  const record = fields(
    value,
    label,
    ["identity", "source", "blob", "purpose", "generatorVersion"],
    ["recipe"],
  );
  if (!DERIVATIVE_PURPOSES.includes(record["purpose"] as (typeof DERIVATIVE_PURPOSES)[number]))
    invalid(`${label}.purpose '${String(record["purpose"])}' is unknown.`);
  return {
    identity: readVersionRef(record["identity"], `${label}.identity`),
    source: readVersionRef(record["source"], `${label}.source`),
    blob: readBlobRef(record["blob"], `${label}.blob`),
    purpose: record["purpose"] as CreativeDerivative["purpose"],
    generatorVersion: boundedString(
      record["generatorVersion"],
      CREATIVE_LIMITS.maxGeneratorLength,
      `${label}.generatorVersion`,
    ),
    ...(record["recipe"] !== undefined
      ? { recipe: readVersionRef(record["recipe"], `${label}.recipe`) }
      : {}),
  };
}

export function readCreativeBoardEntry(value: unknown, label = "board entry"): CreativeBoardEntry {
  const record = fields(
    value,
    label,
    ["identity", "source", "roles", "approval", "notes"],
    ["derivative"],
  );
  const roles = record["roles"];
  if (
    !Array.isArray(roles) ||
    roles.length > BOARD_ROLES.length ||
    !roles.every((role) => BOARD_ROLES.includes(role as (typeof BOARD_ROLES)[number])) ||
    new Set(roles).size !== roles.length
  )
    invalid(`${label}.roles must list each known role at most once.`);
  if (!BOARD_APPROVALS.includes(record["approval"] as (typeof BOARD_APPROVALS)[number]))
    invalid(`${label}.approval '${String(record["approval"])}' is unknown.`);
  const notes = record["notes"];
  if (typeof notes !== "string" || notes.length > CREATIVE_LIMITS.maxNotesLength)
    invalid(
      `${label}.notes must be a string of at most ${CREATIVE_LIMITS.maxNotesLength} characters.`,
    );
  return {
    identity: readVersionRef(record["identity"], `${label}.identity`),
    source: readVersionRef(record["source"], `${label}.source`),
    ...(record["derivative"] !== undefined
      ? { derivative: readVersionRef(record["derivative"], `${label}.derivative`) }
      : {}),
    roles: [...(roles as CreativeBoardEntry["roles"])].sort(compareCodePoints),
    approval: record["approval"] as CreativeBoardEntry["approval"],
    notes,
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

function readStaged(value: unknown, label: string): CreativeStaged {
  const record = fields(value, label, ["sources", "derivatives", "recipes", "blobs"]);
  const sources = record["sources"];
  const derivatives = record["derivatives"];
  const recipes = record["recipes"];
  const blobs = record["blobs"];
  if (
    !Array.isArray(sources) ||
    !Array.isArray(derivatives) ||
    !Array.isArray(recipes) ||
    !Array.isArray(blobs)
  )
    invalid(`${label} must carry sources, derivatives, recipes and blobs arrays.`);
  if (
    sources.length + derivatives.length + recipes.length > CREATIVE_LIMITS.maxStagedRecords ||
    blobs.length > CREATIVE_LIMITS.maxStagedBlobs
  )
    invalid(`${label} exceeds the staged record bound.`);
  const stagedBlobs = blobs.map((blob, i) => readBlobRef(blob, `${label}.blobs[${i}]`));
  if (new Set(stagedBlobs.map((blob) => blob.hash)).size !== stagedBlobs.length)
    invalid(`${label}.blobs lists a hash twice.`);
  return {
    sources: sources
      .map((source, i) => readCreativeSource(source, `${label}.sources[${i}]`))
      .sort((a, b) => compareVersionRefs(a.identity, b.identity)),
    derivatives: derivatives
      .map((derivative, i) => readCreativeDerivative(derivative, `${label}.derivatives[${i}]`))
      .sort((a, b) => compareVersionRefs(a.identity, b.identity)),
    recipes: recipes
      .map((recipe, i) => readCreativeRecipe(recipe, `${label}.recipes[${i}]`))
      .sort((a, b) => compareVersionRefs(a.identity, b.identity)),
    blobs: [...stagedBlobs].sort((a, b) => compareCodePoints(a.hash, b.hash)),
  };
}

export function readCreativeLease(value: unknown, label = "lease"): CreativeLease {
  const record = fields(value, label, ["id", "owner", "workspace", "expiresAt", "staged"]);
  return {
    id: recordId(record["id"], `${label}.id`),
    owner: boundedString(record["owner"], CREATIVE_LIMITS.maxIdLength, `${label}.owner`),
    workspace: boundedString(
      record["workspace"],
      CREATIVE_LIMITS.maxIdLength,
      `${label}.workspace`,
    ),
    expiresAt: int(record["expiresAt"], 0, Number.MAX_SAFE_INTEGER, `${label}.expiresAt`),
    staged: readStaged(record["staged"], `${label}.staged`),
  };
}

export function readCreativeHold(value: unknown, label = "hold"): CreativeHold {
  const record = fields(value, label, ["id", "kind", "hashes"]);
  if (!HOLD_KINDS.includes(record["kind"] as (typeof HOLD_KINDS)[number]))
    invalid(`${label}.kind '${String(record["kind"])}' is unknown.`);
  const hashes = record["hashes"];
  if (!Array.isArray(hashes) || hashes.length > CREATIVE_LIMITS.maxHoldHashes)
    invalid(`${label}.hashes must list at most ${CREATIVE_LIMITS.maxHoldHashes} hashes.`);
  const parsed = hashes.map((hash, i) => blobHash(hash, `${label}.hashes[${i}]`));
  if (new Set(parsed).size !== parsed.length) invalid(`${label}.hashes lists a hash twice.`);
  return {
    id: recordId(record["id"], `${label}.id`),
    kind: record["kind"] as CreativeHold["kind"],
    hashes: [...parsed].sort(compareCodePoints),
  };
}

function uniqueIdentities<T extends { identity: VersionRef }>(
  items: readonly T[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = versionRefKey(item.identity);
    if (seen.has(key)) invalid(`${label} identity '${key}' is duplicated.`);
    seen.add(key);
  }
}

/**
 * The closed derivation graph over one pool of source records: every
 * composite's two parents resolve inside this same set, the provider
 * parent is an original (non-composite) `generated` source, the reviewed
 * rectangle fits inside the base's canonical raster, the composite's
 * canonical dimensions equal the base's, and following base links never
 * revisits a record. An identity carried under two different records, a
 * missing or mismatched parent, or a dependency on a record outside this
 * pool — including another lease's staged set — refuses by name.
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
//
// The catalog and its blobs live as sidecars of the project body inside the
// same object store, namespaced under `creative/` so discovery (which skips
// every key containing "/") never lists them as projects.

/** The kept catalog's record key. */
export function creativeCatalogKey(projectId: string): string {
  return `creative/${projectId}`;
}

/** One immutable blob record's key. */
export function creativeBlobKey(projectId: string, hash: BlobHash): string {
  return `creative/${projectId}/blob/${hash}`;
}

/** The cursor prefix covering every blob record of a project. */
export function creativeBlobPrefix(projectId: string): string {
  return `creative/${projectId}/blob/`;
}

/** The empty catalog a project starts with: head and kept revisions are 0. */
export function emptyCreativeCatalog(projectId: string): CreativeCatalog {
  return {
    projectId: creativeCatalogKey(projectId),
    head: 0,
    kept: 0,
    sources: [],
    derivatives: [],
    board: [],
    recipes: [],
    leases: [],
    holds: [],
    blobs: {},
  };
}

/**
 * Validate a stored catalog manifest into owned canonical order. Unknown
 * formats, nested versions and field shapes throw; the stored record is
 * never rewritten in the attempt. Lists come back in code-point identity
 * order and must be stored that way — a stored order that disagrees is
 * corruption, so reads check it rather than silently resorting.
 */
export function readCreativeCatalog(value: unknown): CreativeCatalog {
  const record = fields(value, "catalog", [
    "projectId",
    "format",
    "version",
    "head",
    "kept",
    "sources",
    "derivatives",
    "board",
    "recipes",
    "leases",
    "holds",
    "blobs",
  ]);
  if (record["format"] !== CREATIVE_CATALOG_FORMAT)
    unsupported(
      `catalog format '${String(record["format"])}' is not '${CREATIVE_CATALOG_FORMAT}'.`,
    );
  if (record["version"] !== 1)
    unsupported(`catalog version ${String(record["version"])} is not 1.`);
  const arrays = (name: "sources" | "derivatives" | "board" | "recipes" | "leases" | "holds") => {
    const list = record[name];
    if (!Array.isArray(list)) invalid(`catalog.${name} must be an array.`);
    return list;
  };
  const sources = arrays("sources")
    .map((s, i) => readCreativeSource(s, `catalog.sources[${i}]`))
    .sort((a, b) => compareVersionRefs(a.identity, b.identity));
  const derivatives = arrays("derivatives")
    .map((d, i) => readCreativeDerivative(d, `catalog.derivatives[${i}]`))
    .sort((a, b) => compareVersionRefs(a.identity, b.identity));
  const board = arrays("board")
    .map((b, i) => readCreativeBoardEntry(b, `catalog.board[${i}]`))
    .sort((a, b) => compareVersionRefs(a.identity, b.identity));
  const recipes = arrays("recipes")
    .map((r, i) => readCreativeRecipe(r, `catalog.recipes[${i}]`))
    .sort((a, b) => compareVersionRefs(a.identity, b.identity));
  const leases = arrays("leases")
    .map((l, i) => readCreativeLease(l, `catalog.leases[${i}]`))
    .sort((a, b) => compareCodePoints(a.id, b.id));
  const holds = arrays("holds")
    .map((h, i) => readCreativeHold(h, `catalog.holds[${i}]`))
    .sort((a, b) => compareCodePoints(a.id, b.id));
  if (sources.length > CREATIVE_LIMITS.maxSources)
    invalid(
      `catalog keeps ${sources.length} sources, over the ${CREATIVE_LIMITS.maxSources} limit.`,
    );
  if (derivatives.length > CREATIVE_LIMITS.maxDerivatives)
    invalid("catalog keeps too many derivatives.");
  if (board.length > CREATIVE_LIMITS.maxBoardEntries)
    invalid("catalog keeps too many board entries.");
  if (recipes.length > CREATIVE_LIMITS.maxRecipes) invalid("catalog keeps too many recipes.");
  if (leases.length > CREATIVE_LIMITS.maxLeases) invalid("catalog holds too many leases.");
  if (holds.length > CREATIVE_LIMITS.maxHolds)
    invalid("catalog holds too many reachability holds.");
  uniqueIdentities(sources, "catalog.sources");
  uniqueIdentities(derivatives, "catalog.derivatives");
  uniqueIdentities(board, "catalog.board");
  uniqueIdentities(recipes, "catalog.recipes");
  if (new Set(leases.map((l) => l.id)).size !== leases.length)
    invalid("catalog lease id is duplicated.");
  if (new Set(holds.map((h) => h.id)).size !== holds.length)
    invalid("catalog hold id is duplicated.");
  // The kept set is self-contained: a kept composite's parents are kept
  // records. A staged set closes over the kept set and its own records —
  // never another lease's staged set.
  checkSourceDerivations(sources, "catalog.sources");
  for (const lease of leases)
    checkSourceDerivations(
      [...sources, ...lease.staged.sources],
      `catalog lease '${lease.id}' staged sources`,
    );
  const blobsValue = plainObject(record["blobs"], "catalog.blobs");
  const keys = Object.keys(blobsValue).sort(compareCodePoints);
  const blobs: Record<BlobHash, RegisteredBlob> = {};
  for (const key of keys) {
    blobHash(key, "catalog.blobs key");
    const descriptor = readRegisteredBlob(blobsValue[key], `catalog.blobs['${key}']`);
    if (descriptor.hash !== key) invalid(`catalog.blobs['${key}'] describes a different hash.`);
    blobs[key] = descriptor;
  }
  const stored = value as Record<string, unknown>;
  const storedOrder = (name: "sources" | "derivatives" | "board" | "recipes") => {
    const list = stored[name] as readonly { identity?: VersionRef }[];
    for (let i = 1; i < list.length; i++)
      if (compareVersionRefs(list[i - 1]!.identity!, list[i]!.identity!) > 0)
        invalid(`catalog.${name} is not stored in canonical identity order.`);
  };
  storedOrder("sources");
  storedOrder("derivatives");
  storedOrder("board");
  storedOrder("recipes");
  if (typeof record["projectId"] !== "string" || record["projectId"] === "")
    invalid("catalog.projectId must be a non-empty string.");
  return {
    projectId: record["projectId"],
    head: int(record["head"], 0, Number.MAX_SAFE_INTEGER, "catalog.head"),
    kept: int(record["kept"], 0, Number.MAX_SAFE_INTEGER, "catalog.kept"),
    sources,
    derivatives,
    board,
    recipes,
    leases,
    holds,
    blobs,
  };
}

/** Blob hashes the kept records reference: originals, rasters, derivatives. */
function keptBlobHashes(catalog: {
  sources: readonly CreativeSource[];
  derivatives: readonly CreativeDerivative[];
}): Set<BlobHash> {
  const hashes = new Set<BlobHash>();
  for (const source of catalog.sources) {
    hashes.add(source.encoded.hash);
    hashes.add(source.normalized.blob.hash);
  }
  for (const derivative of catalog.derivatives) hashes.add(derivative.blob.hash);
  return hashes;
}

/**
 * The blob hashes a GC pass must preserve: kept refs, every live lease's
 * staged blobs and every explicit recovery/retained-undo hold. Expired
 * leases contribute nothing.
 */
export function reachableBlobHashes(catalog: CreativeCatalog, now: number): Set<BlobHash> {
  const hashes = keptBlobHashes(catalog);
  for (const lease of catalog.leases)
    if (lease.expiresAt > now) for (const blob of lease.staged.blobs) hashes.add(blob.hash);
  for (const hold of catalog.holds) for (const hash of hold.hashes) hashes.add(hash);
  return hashes;
}

/**
 * Byte usage by policy bucket. Originals count unique encoded hashes across
 * kept sources; canonical counts normalized rasters plus approved-variant
 * derivatives; disposable counts thumbnail/provider-input derivatives. A
 * hash shared by two identities counts once per bucket. The source count is
 * logical assets — distinct id/incarnation pairs — so an older revision kept
 * beside its successor does not consume another slot.
 */
export function creativeUsage(catalog: {
  sources: readonly CreativeSource[];
  derivatives: readonly CreativeDerivative[];
}): { sources: number; originals: number; canonical: number; disposable: number } {
  const sourceIds = new Set<string>();
  const originalBytes = new Map<BlobHash, number>();
  const canonicalBytes = new Map<BlobHash, number>();
  const disposableBytes = new Map<BlobHash, number>();
  for (const source of catalog.sources) {
    sourceIds.add(logicalIdentityKey(source.identity));
    originalBytes.set(source.encoded.hash, source.encoded.byteLength);
    canonicalBytes.set(source.normalized.blob.hash, source.normalized.blob.byteLength);
  }
  for (const derivative of catalog.derivatives)
    if (derivative.purpose === "approved-variant")
      canonicalBytes.set(derivative.blob.hash, derivative.blob.byteLength);
    else disposableBytes.set(derivative.blob.hash, derivative.blob.byteLength);
  const sum = (map: Map<BlobHash, number>) => {
    let total = 0;
    for (const size of map.values()) total += size;
    return total;
  };
  return {
    sources: sourceIds.size,
    originals: sum(originalBytes),
    canonical: sum(canonicalBytes),
    disposable: sum(disposableBytes),
  };
}

/** Refuse when a kept set exceeds a declared budget; unique bytes per hash. */
export function checkCreativeBudgets(
  catalog: { sources: readonly CreativeSource[]; derivatives: readonly CreativeDerivative[] },
  label = "catalog",
): void {
  const usage = creativeUsage(catalog);
  if (usage.sources > CREATIVE_LIMITS.maxSources)
    invalid(
      `${label} keeps ${usage.sources} sources, over the ${CREATIVE_LIMITS.maxSources} limit.`,
    );
  if (usage.originals > CREATIVE_LIMITS.maxOriginalBytes)
    invalid(
      `${label} original bytes ${usage.originals} exceed the ${CREATIVE_LIMITS.maxOriginalBytes} limit.`,
    );
  if (usage.canonical > CREATIVE_LIMITS.maxCanonicalBytes)
    invalid(
      `${label} canonical bytes ${usage.canonical} exceed the ${CREATIVE_LIMITS.maxCanonicalBytes} limit.`,
    );
  if (usage.disposable > CREATIVE_LIMITS.maxDisposableBytes)
    invalid(
      `${label} disposable bytes ${usage.disposable} exceed the ${CREATIVE_LIMITS.maxDisposableBytes} limit.`,
    );
}

/**
 * Byte usage over everything retained at `now`: kept records, every live
 * lease's staged candidates, and every durable recovery/retained-undo hold.
 * Records classify their own references; a held hash whose claiming records
 * left the kept set counts via the registry's retained bucket provenance.
 * The source count covers distinct logical assets — kept sources plus
 * staged identities keyed by id and incarnation — so revising an asset
 * already kept does not consume another source slot. A historical source
 * revision pinned only by an undo hold adds bytes, not a source.
 */
export function retainedCreativeUsage(
  catalog: CreativeCatalog,
  now: number,
): { sources: number; originals: number; canonical: number; disposable: number } {
  const sourceIds = new Set<string>();
  const buckets: Record<BlobBucket, Map<BlobHash, number>> = {
    canonical: new Map(),
    disposable: new Map(),
    original: new Map(),
  };
  const addSource = (source: CreativeSource): void => {
    sourceIds.add(logicalIdentityKey(source.identity));
    buckets["original"].set(source.encoded.hash, source.encoded.byteLength);
    buckets["canonical"].set(source.normalized.blob.hash, source.normalized.blob.byteLength);
  };
  const addDerivative = (derivative: CreativeDerivative): void => {
    buckets[derivativeBlobBucket(derivative.purpose)].set(
      derivative.blob.hash,
      derivative.blob.byteLength,
    );
  };
  for (const source of catalog.sources) addSource(source);
  for (const derivative of catalog.derivatives) addDerivative(derivative);
  for (const lease of catalog.leases) {
    if (lease.expiresAt <= now) continue;
    for (const source of lease.staged.sources) addSource(source);
    for (const derivative of lease.staged.derivatives) addDerivative(derivative);
  }
  for (const hold of catalog.holds)
    for (const hash of hold.hashes) {
      const entry = catalog.blobs[hash];
      if (entry === undefined) continue;
      for (const bucket of entry.buckets) buckets[bucket].set(hash, entry.byteLength);
    }
  const sum = (map: Map<BlobHash, number>) => {
    let total = 0;
    for (const size of map.values()) total += size;
    return total;
  };
  return {
    sources: sourceIds.size,
    originals: sum(buckets["original"]),
    canonical: sum(buckets["canonical"]),
    disposable: sum(buckets["disposable"]),
  };
}

/** Refuse when the retained set — kept, live-staged and held — exceeds a declared budget. */
export function checkRetainedBudgets(
  catalog: CreativeCatalog,
  now: number,
  label = "catalog",
): void {
  const usage = retainedCreativeUsage(catalog, now);
  if (usage.sources > CREATIVE_LIMITS.maxSources)
    invalid(
      `${label} retains ${usage.sources} sources, over the ${CREATIVE_LIMITS.maxSources} limit.`,
    );
  if (usage.originals > CREATIVE_LIMITS.maxOriginalBytes)
    invalid(
      `${label} retained original bytes ${usage.originals} exceed the ${CREATIVE_LIMITS.maxOriginalBytes} limit.`,
    );
  if (usage.canonical > CREATIVE_LIMITS.maxCanonicalBytes)
    invalid(
      `${label} retained canonical bytes ${usage.canonical} exceed the ${CREATIVE_LIMITS.maxCanonicalBytes} limit.`,
    );
  if (usage.disposable > CREATIVE_LIMITS.maxDisposableBytes)
    invalid(
      `${label} retained disposable bytes ${usage.disposable} exceed the ${CREATIVE_LIMITS.maxDisposableBytes} limit.`,
    );
}

/**
 * Internal-consistency check of a kept record set: every reference resolves
 * inside the set. Storage calls this before writing a kept manifest; a set
 * naming an absent source, derivative or recipe is refused.
 */
export function checkKeptSetIntegrity(catalog: {
  sources: readonly CreativeSource[];
  derivatives: readonly CreativeDerivative[];
  board: readonly CreativeBoardEntry[];
  recipes: readonly CreativeRecipe[];
}): void {
  const sourceIds = new Set(catalog.sources.map((s) => versionRefKey(s.identity)));
  const derivativeIds = new Set(catalog.derivatives.map((d) => versionRefKey(d.identity)));
  const recipeIds = new Set(catalog.recipes.map((r) => versionRefKey(r.identity)));
  for (const [i, derivative] of catalog.derivatives.entries()) {
    if (!sourceIds.has(versionRefKey(derivative.source)))
      invalid(`catalog.derivatives[${i}] references a source outside the kept set.`);
    if (derivative.recipe !== undefined && !recipeIds.has(versionRefKey(derivative.recipe)))
      invalid(`catalog.derivatives[${i}] references a recipe outside the kept set.`);
  }
  for (const [i, entry] of catalog.board.entries()) {
    if (!sourceIds.has(versionRefKey(entry.source)))
      invalid(`catalog.board[${i}] references a source outside the kept set.`);
    if (entry.derivative !== undefined && !derivativeIds.has(versionRefKey(entry.derivative)))
      invalid(`catalog.board[${i}] references a derivative outside the kept set.`);
  }
  for (const [i, recipe] of catalog.recipes.entries())
    for (const ref of recipe.sources)
      if (!sourceIds.has(versionRefKey(ref)))
        invalid(`catalog.recipes[${i}] references a source outside the kept set.`);
  // Composite derivations close over the same kept set: removing a parent
  // its descendants still need, or keeping a composite without both
  // parents, refuses here.
  checkSourceDerivations(catalog.sources, "the kept set");
}

// ---------- stored records ----------

/** Validate a stored manifest for `projectId`; absent reads as undefined. */
export function readCreativeCatalogRecord(
  value: unknown,
  projectId: string,
): CreativeCatalog | undefined {
  if (value === undefined) return undefined;
  const catalog = readCreativeCatalog(value);
  if (catalog.projectId !== creativeCatalogKey(projectId))
    invalid(
      `catalog key '${catalog.projectId}' does not match '${creativeCatalogKey(projectId)}'.`,
    );
  return catalog;
}

/**
 * The put-able manifest record: canonical order and fully detached from the
 * caller's object — persisting it asynchronously can never capture a later
 * mutation. The offered catalog must already be canonical; the writer checks
 * rather than silently resorted output.
 */
export function writeCreativeCatalogRecord(catalog: CreativeCatalog): Record<string, unknown> {
  const owned = structuredClone(catalog) as CreativeCatalog;
  const blobs: Record<string, unknown> = {};
  for (const key of Object.keys(owned.blobs).sort(compareCodePoints)) {
    const entry = owned.blobs[key]!;
    blobs[key] = {
      hash: entry.hash,
      byteLength: entry.byteLength,
      mime: entry.mime,
      buckets: [...entry.buckets],
    };
  }
  const record: Record<string, unknown> = {
    projectId: owned.projectId,
    format: CREATIVE_CATALOG_FORMAT,
    version: 1,
    head: owned.head,
    kept: owned.kept,
    sources: owned.sources,
    derivatives: owned.derivatives,
    board: owned.board,
    recipes: owned.recipes,
    leases: owned.leases,
    holds: owned.holds,
    blobs,
  };
  readCreativeCatalog(record);
  return record;
}

/**
 * The immutable blob record's stored shape. The bytes are verified against
 * the claimed hash and copied — a caller mutating its array after the write
 * was issued cannot change what lands.
 */
export function writeCreativeBlobRecord(
  projectId: string,
  ref: BlobRef,
  bytes: Uint8Array,
): Record<string, unknown> {
  const owned = new Uint8Array(bytes);
  if (owned.length === 0 || owned.length !== ref.byteLength)
    invalid(`blob '${ref.hash}' byte length does not match its descriptor.`);
  if (sha256Hex(owned) !== ref.hash)
    invalid(`blob '${ref.hash}' bytes do not match their content hash.`);
  return {
    projectId: creativeBlobKey(projectId, ref.hash),
    format: CREATIVE_BLOB_FORMAT,
    version: 1,
    hash: ref.hash,
    byteLength: owned.length,
    mime: ref.mime,
    bytes: owned,
  };
}

/**
 * Validate a stored blob record for `projectId` and verify the bytes against
 * the content hash they claim. `expected` may be a bare hash — read paths
 * verify internal consistency and preserve whatever bytes exist — or the
 * required descriptor, which additionally binds the record's declared byte
 * length and mime so a self-consistent but tampered record cannot stand in
 * for the blob a manifest or keep describes. Returns a detached copy of the
 * bytes; a missing, malformed or corrupted record throws.
 */
export function verifyCreativeBlob(
  value: unknown,
  projectId: string,
  expected: BlobHash | BlobRef,
): Uint8Array {
  const hash = typeof expected === "string" ? expected : expected.hash;
  const key = creativeBlobKey(projectId, hash);
  if (value === undefined) throw new CreativeCatalogError("invalid", `blob '${hash}' is missing.`);
  const record = fields(value, `blob '${hash}'`, [
    "projectId",
    "format",
    "version",
    "hash",
    "byteLength",
    "mime",
    "bytes",
  ]);
  if (record["format"] !== CREATIVE_BLOB_FORMAT)
    unsupported(
      `blob '${hash}' format '${String(record["format"])}' is not '${CREATIVE_BLOB_FORMAT}'.`,
    );
  if (record["version"] !== 1)
    unsupported(`blob '${hash}' version ${String(record["version"])} is not 1.`);
  if (record["projectId"] !== key) invalid(`blob record key does not match '${key}'.`);
  if (record["hash"] !== hash) invalid(`blob '${hash}' record claims another hash.`);
  const bytes = record["bytes"];
  if (!(bytes instanceof Uint8Array)) invalid(`blob '${hash}' bytes must be a byte array.`);
  if (bytes.length !== record["byteLength"])
    invalid(`blob '${hash}' byte length does not match its record.`);
  if (sha256Hex(bytes) !== hash) invalid(`blob '${hash}' bytes do not match their content hash.`);
  if (
    typeof expected !== "string" &&
    (record["byteLength"] !== expected.byteLength || record["mime"] !== expected.mime)
  )
    invalid(`blob '${hash}' record does not match the descriptor that claims it.`);
  return new Uint8Array(bytes);
}

// ---------- keep publication ----------

/** What a Keep asks the catalog to publish; validated before storage. */
export interface CreativeKeepRequest {
  /** Catalog head revision this request was prepared against. */
  readonly expectedHead: number;
  /** Millisecond time the caller staged its decision at. */
  readonly asOf: number;
  /** The live staging lease this Keep consumes. */
  readonly lease: { readonly id: string; readonly owner: string; readonly workspace: string };
  /** The complete resulting kept set, by identity. */
  readonly keep: {
    readonly sources: readonly VersionRef[];
    readonly derivatives: readonly VersionRef[];
    readonly recipes: readonly VersionRef[];
    /** Board entries arrive whole: they are the resulting board. */
    readonly board: readonly CreativeBoardEntry[];
  };
}

/** Validate an offered publication request into canonical records. */
export function readCreativeKeepRequest(value: unknown): CreativeKeepRequest {
  const record = fields(value, "creative publication", ["expectedHead", "asOf", "lease", "keep"]);
  const lease = fields(record["lease"], "creative publication lease", ["id", "owner", "workspace"]);
  const keep = fields(record["keep"], "creative publication keep", [
    "sources",
    "derivatives",
    "recipes",
    "board",
  ]);
  const refList = (list: unknown, label: string): VersionRef[] => {
    if (!Array.isArray(list) || list.length > CREATIVE_LIMITS.maxStagedRecords)
      invalid(`${label} must list at most ${CREATIVE_LIMITS.maxStagedRecords} identities.`);
    const refs = list.map((ref, i) => readVersionRef(ref, `${label}[${i}]`));
    const keys = new Set(refs.map(versionRefKey));
    if (keys.size !== refs.length) invalid(`${label} names an identity twice.`);
    return refs;
  };
  const board = keep["board"];
  if (!Array.isArray(board) || board.length > CREATIVE_LIMITS.maxBoardEntries)
    invalid(
      `creative publication keep.board must list at most ${CREATIVE_LIMITS.maxBoardEntries} entries.`,
    );
  const entries = board
    .map((entry, i) => readCreativeBoardEntry(entry, `keep.board[${i}]`))
    .sort((a, b) => compareVersionRefs(a.identity, b.identity));
  uniqueIdentities(entries, "keep.board");
  return {
    expectedHead: int(
      record["expectedHead"],
      0,
      Number.MAX_SAFE_INTEGER,
      "creative publication.expectedHead",
    ),
    asOf: int(record["asOf"], 0, Number.MAX_SAFE_INTEGER, "creative publication.asOf"),
    lease: {
      id: recordId(lease["id"], "creative publication lease.id"),
      owner: boundedString(
        lease["owner"],
        CREATIVE_LIMITS.maxIdLength,
        "creative publication lease.owner",
      ),
      workspace: boundedString(
        lease["workspace"],
        CREATIVE_LIMITS.maxIdLength,
        "creative publication lease.workspace",
      ),
    },
    keep: {
      sources: refList(keep["sources"], "creative publication keep.sources"),
      derivatives: refList(keep["derivatives"], "creative publication keep.derivatives"),
      recipes: refList(keep["recipes"], "creative publication keep.recipes"),
      board: entries,
    },
  };
}

/** The resolved publication: what the new kept set looks like. */
export interface CreativeKeepPlan {
  readonly sources: readonly CreativeSource[];
  readonly derivatives: readonly CreativeDerivative[];
  readonly recipes: readonly CreativeRecipe[];
  readonly board: readonly CreativeBoardEntry[];
  /** Every blob descriptor the kept set needs, deduplicated and sorted. */
  readonly referenced: readonly BlobRef[];
}

/**
 * Resolve a publication request against a catalog at admission time `now`:
 * the lease must be live at the transaction's own clock — the request's
 * `asOf` is caller-declared and never authoritative — owned as claimed,
 * every kept identity must resolve to a kept or lease-staged record, and
 * the resulting set must satisfy internal consistency and budgets. Pure —
 * performs no storage access.
 */
export function planCreativeKeep(
  request: CreativeKeepRequest,
  catalog: CreativeCatalog,
  now: number,
): CreativeKeepPlan {
  if (catalog.head !== request.expectedHead)
    throw new CreativeCatalogError(
      "invalid",
      `catalog head ${catalog.head} does not match the publication's expected head ${request.expectedHead}.`,
    );
  const lease = catalog.leases.find((entry) => entry.id === request.lease.id);
  if (lease === undefined)
    throw new CreativeCatalogError(
      "invalid",
      `staging lease '${request.lease.id}' was not found in the catalog.`,
    );
  if (lease.owner !== request.lease.owner || lease.workspace !== request.lease.workspace)
    throw new CreativeCatalogError(
      "invalid",
      `staging lease '${request.lease.id}' belongs to another owner or workspace.`,
    );
  if (lease.expiresAt <= now)
    throw new CreativeCatalogError(
      "invalid",
      `staging lease '${request.lease.id}' expired at ${lease.expiresAt}.`,
    );
  const resolve = <T extends { readonly identity: VersionRef }>(
    refs: readonly VersionRef[],
    kept: readonly T[],
    staged: readonly T[],
    label: string,
  ): T[] =>
    refs.map((ref) => {
      const hit =
        kept.find((record) => sameVersionRef(record.identity, ref)) ??
        staged.find((record) => sameVersionRef(record.identity, ref));
      if (hit === undefined)
        throw new CreativeCatalogError(
          "invalid",
          `${label} identity '${versionRefKey(ref)}' is neither kept nor staged under the lease.`,
        );
      return hit;
    });
  const sources = resolve(
    request.keep.sources,
    catalog.sources,
    lease.staged.sources,
    "sources",
  ).sort((a, b) => compareVersionRefs(a.identity, b.identity));
  const derivatives = resolve(
    request.keep.derivatives,
    catalog.derivatives,
    lease.staged.derivatives,
    "derivatives",
  ).sort((a, b) => compareVersionRefs(a.identity, b.identity));
  const recipes = resolve(
    request.keep.recipes,
    catalog.recipes,
    lease.staged.recipes,
    "recipes",
  ).sort((a, b) => compareVersionRefs(a.identity, b.identity));
  const board = request.keep.board;
  checkKeptSetIntegrity({ sources, derivatives, board, recipes });
  checkCreativeBudgets({ sources, derivatives }, "publication");
  // A removal must not strand a composite another live lease still stages:
  // every surviving lease's staged set revalidates against the post-Keep
  // kept set plus its own records — never a different lease's.
  for (const other of catalog.leases)
    if (other.id !== lease.id)
      checkSourceDerivations([...sources, ...other.staged.sources], `staging lease '${other.id}'`);
  const stagedBlobs = new Map(lease.staged.blobs.map((blob) => [blob.hash, blob]));
  const referenced = new Map<BlobHash, BlobRef>();
  const requireBlob = (ref: BlobRef, label: string): void => {
    const descriptor = catalog.blobs[ref.hash] ?? stagedBlobs.get(ref.hash);
    if (descriptor === undefined)
      throw new CreativeCatalogError(
        "invalid",
        `${label} references blob '${ref.hash}' which the catalog never staged.`,
      );
    if (descriptor.byteLength !== ref.byteLength || descriptor.mime !== ref.mime)
      throw new CreativeCatalogError(
        "invalid",
        `${label} blob '${ref.hash}' does not match its staged descriptor.`,
      );
    if (!referenced.has(ref.hash)) referenced.set(ref.hash, ref);
  };
  for (const [i, source] of sources.entries()) {
    requireBlob(source.encoded, `sources[${i}].encoded`);
    requireBlob(source.normalized.blob, `sources[${i}].normalized`);
  }
  for (const [i, derivative] of derivatives.entries())
    requireBlob(derivative.blob, `derivatives[${i}].blob`);
  return {
    sources,
    derivatives,
    recipes,
    board,
    referenced: [...referenced.values()].sort((a, b) => compareCodePoints(a.hash, b.hash)),
  };
}

/** The catalog after a planned Keep: the lease is consumed, kept advances. */
export function applyCreativeKeep(
  catalog: CreativeCatalog,
  request: CreativeKeepRequest,
  plan: CreativeKeepPlan,
): CreativeCatalog {
  // The kept records' claims join the registry's bucket provenance so a
  // later removal from the kept set still accounts retained bytes correctly.
  const blobs: Record<BlobHash, RegisteredBlob> = { ...catalog.blobs };
  for (const source of plan.sources) {
    mergeBlobRegistration(blobs, source.encoded, "original");
    mergeBlobRegistration(blobs, source.normalized.blob, "canonical");
  }
  for (const derivative of plan.derivatives)
    mergeBlobRegistration(blobs, derivative.blob, derivativeBlobBucket(derivative.purpose));
  return {
    projectId: catalog.projectId,
    head: catalog.head + 1,
    kept: catalog.kept + 1,
    sources: plan.sources,
    derivatives: plan.derivatives,
    board: plan.board,
    recipes: plan.recipes,
    leases: catalog.leases.filter((entry) => entry.id !== request.lease.id),
    holds: catalog.holds,
    blobs,
  };
}
