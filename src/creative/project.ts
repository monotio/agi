/**
 * Portable kept-creative manifest: the archive-format view of a project's
 * kept creative catalog.
 *
 * A manifest carries exactly the kept record set — source originals with
 * their canonical rasters, derivatives, reference-board entries and
 * recipes — plus the descriptors of the blobs those records reference.
 * Blob bodies are never embedded: they travel as separate hash-addressed
 * binary entries beside the manifest. Nothing storage-local survives into
 * the portable form: no record keys, no catalog head or kept revision, no
 * project lifetime, no lease or hold authority.
 *
 * The record payloads are the catalog's own shapes, read through the same
 * strict readers. The manifest adds its own envelope and a registry
 * consistency rule: the `blobs` index must equal the descriptors the kept
 * set's claims derive, nothing more and nothing less. Unknown nested
 * formats or versions, duplicate identities, dangling references,
 * mismatching descriptors or a non-canonical stored order are refused
 * without rewriting the input.
 *
 * Zero runtime dependencies; runs in browser, worker and Node.
 */

import {
  CREATIVE_LIMITS,
  CreativeCatalogError,
  checkCreativeBudgets,
  checkKeptSetIntegrity,
  compareCodePoints,
  derivativeBlobBucket,
  mergeBlobRegistration,
  readCreativeBoardEntry,
  readCreativeDerivative,
  readCreativeRecipe,
  readCreativeSource,
  type BlobBucket,
  type BlobHash,
  type CreativeBoardEntry,
  type CreativeDerivative,
  type CreativeRecipe,
  type CreativeSource,
  type RegisteredBlob,
  type VersionRef,
} from "./catalog.ts";

export const CREATIVE_PROJECT_FORMAT = "monotio.agi.creative-project";
const CREATIVE_PROJECT_VERSION = 1;

/** The kept record set a manifest serializes. */
export interface CreativeKeptSet {
  readonly sources: readonly CreativeSource[];
  readonly derivatives: readonly CreativeDerivative[];
  readonly board: readonly CreativeBoardEntry[];
  readonly recipes: readonly CreativeRecipe[];
}

/**
 * The portable manifest: the kept set plus the descriptor registry for
 * exactly the blobs it references. Bucket provenance covers the kept
 * claims alone; retained provenance for blobs outside the kept set is a
 * storage concern and never travels.
 */
export interface CreativeProjectManifest extends CreativeKeptSet {
  readonly blobs: Readonly<Record<BlobHash, RegisteredBlob>>;
}

/**
 * A manifest together with its verified blob bodies — what the archive
 * reader returns and the durable reimport rebuilds from.
 */
export interface CreativeProjectAssets {
  readonly manifest: CreativeProjectManifest;
  readonly blobs: Readonly<Record<BlobHash, Uint8Array>>;
}

function invalid(message: string): never {
  throw new CreativeCatalogError("invalid", `Invalid creative project data: ${message}`);
}

function unsupported(message: string): never {
  throw new CreativeCatalogError("unsupported", `Unsupported creative project data: ${message}`);
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

// The manifest registry validates the same closed bucket set the catalog
// declares; a catalog bucket added without manifest support fails here at
// compile time rather than drifting.
const MANIFEST_BUCKETS: Record<BlobBucket, true> = {
  canonical: true,
  disposable: true,
  original: true,
};

function compareIdentities(a: VersionRef, b: VersionRef): number {
  return (
    compareCodePoints(a.id, b.id) ||
    compareCodePoints(a.incarnation, b.incarnation) ||
    a.revision - b.revision
  );
}

function readManifestBlob(value: unknown, label: string): RegisteredBlob {
  const record = fields(value, label, ["hash", "byteLength", "mime", "buckets"]);
  const buckets = record["buckets"];
  if (
    !Array.isArray(buckets) ||
    buckets.length === 0 ||
    !buckets.every((b) => MANIFEST_BUCKETS[b as BlobBucket] === true) ||
    new Set(buckets).size !== buckets.length
  )
    invalid(`${label}.buckets must list each known budget bucket at most once.`);
  return {
    hash: blobHash(record["hash"], `${label}.hash`),
    byteLength: int(record["byteLength"], 1, Number.MAX_SAFE_INTEGER, `${label}.byteLength`),
    mime: boundedString(record["mime"], CREATIVE_LIMITS.maxMimeLength, `${label}.mime`),
    buckets: [...(buckets as readonly BlobBucket[])].sort(compareCodePoints),
  };
}

/** The blob descriptors a kept record set claims, with bucket provenance. */
function derivedRegistry(kept: CreativeKeptSet): Record<BlobHash, RegisteredBlob> {
  const registry: Record<BlobHash, RegisteredBlob> = {};
  for (const source of kept.sources) {
    mergeBlobRegistration(registry, source.encoded, "original");
    mergeBlobRegistration(registry, source.normalized.blob, "canonical");
  }
  for (const derivative of kept.derivatives)
    mergeBlobRegistration(registry, derivative.blob, derivativeBlobBucket(derivative.purpose));
  return registry;
}

function sameDescriptor(a: RegisteredBlob, b: RegisteredBlob): boolean {
  return (
    a.byteLength === b.byteLength &&
    a.mime === b.mime &&
    a.buckets.length === b.buckets.length &&
    a.buckets.every((bucket, i) => bucket === b.buckets[i])
  );
}

/**
 * Read a stored or offered manifest into owned canonical records. The raw
 * value is never mutated; every returned object and array is detached.
 */
export function readCreativeProjectManifest(value: unknown): CreativeProjectManifest {
  const record = fields(value, "creative project manifest", [
    "format",
    "version",
    "sources",
    "derivatives",
    "board",
    "recipes",
    "blobs",
  ]);
  if (record["format"] !== CREATIVE_PROJECT_FORMAT)
    unsupported(
      `manifest format '${String(record["format"])}' is not '${CREATIVE_PROJECT_FORMAT}'.`,
    );
  if (record["version"] !== CREATIVE_PROJECT_VERSION)
    unsupported(
      `manifest version ${String(record["version"])} is not ${CREATIVE_PROJECT_VERSION}.`,
    );
  // Records are read in stored order and must already be canonical: a
  // stored order that disagrees is corruption, not something to resort.
  const ordered = <T extends { identity: VersionRef }>(
    list: unknown,
    label: string,
    read: (item: unknown, label: string) => T,
    limit: number,
  ): T[] => {
    if (!Array.isArray(list)) invalid(`${label} must be an array.`);
    if (list.length > limit) invalid(`${label} keeps ${list.length} records, over the limit.`);
    const items = list.map((item, i) => read(item, `${label}[${i}]`));
    for (let i = 1; i < items.length; i++)
      if (compareIdentities(items[i - 1]!.identity, items[i]!.identity) >= 0)
        invalid(`${label} is not stored in canonical identity order.`);
    return items;
  };
  const sources = ordered(
    record["sources"],
    "manifest.sources",
    readCreativeSource,
    CREATIVE_LIMITS.maxSources,
  );
  const derivatives = ordered(
    record["derivatives"],
    "manifest.derivatives",
    readCreativeDerivative,
    CREATIVE_LIMITS.maxDerivatives,
  );
  const board = ordered(
    record["board"],
    "manifest.board",
    readCreativeBoardEntry,
    CREATIVE_LIMITS.maxBoardEntries,
  );
  const recipes = ordered(
    record["recipes"],
    "manifest.recipes",
    readCreativeRecipe,
    CREATIVE_LIMITS.maxRecipes,
  );
  const blobsValue = plainObject(record["blobs"], "manifest.blobs");
  const blobs: Record<BlobHash, RegisteredBlob> = {};
  let previousKey = "";
  for (const key of Object.keys(blobsValue)) {
    blobHash(key, "manifest.blobs key");
    if (compareCodePoints(key, previousKey) <= 0)
      invalid("manifest.blobs keys are not in canonical order.");
    previousKey = key;
    const descriptor = readManifestBlob(blobsValue[key], `manifest.blobs['${key}']`);
    if (descriptor.hash !== key) invalid(`manifest.blobs['${key}'] describes a different hash.`);
    blobs[key] = descriptor;
  }
  const kept = { sources, derivatives, board, recipes };
  checkKeptSetIntegrity(kept);
  checkCreativeBudgets(kept, "manifest");
  // The registry is derived data: it must equal the kept set's claims
  // exactly — no missing descriptor, no orphan entry, no mismatched shape.
  const derived = derivedRegistry(kept);
  const declared = Object.keys(blobs);
  const expected = Object.keys(derived).sort(compareCodePoints);
  if (declared.length !== expected.length || declared.some((key, i) => key !== expected[i]))
    invalid("manifest.blobs does not match the blob descriptors the kept set references.");
  for (const key of expected)
    if (!sameDescriptor(blobs[key]!, derived[key]!))
      invalid(`manifest.blobs['${key}'] does not match the descriptor the kept set claims.`);
  return { sources, derivatives, board, recipes, blobs };
}

/**
 * The canonical JSON record for a kept set: detached from the caller and
 * self-checked, so an offer that is not already canonical is refused
 * instead of silently resorted.
 */
export function writeCreativeProjectManifest(kept: CreativeKeptSet): Record<string, unknown> {
  const cloned = structuredClone({
    sources: kept.sources,
    derivatives: kept.derivatives,
    board: kept.board,
    recipes: kept.recipes,
  }) as CreativeKeptSet;
  const derived = derivedRegistry(cloned);
  const blobs: Record<string, unknown> = {};
  for (const key of Object.keys(derived).sort(compareCodePoints)) {
    const entry = derived[key]!;
    blobs[key] = {
      hash: entry.hash,
      byteLength: entry.byteLength,
      mime: entry.mime,
      buckets: [...entry.buckets],
    };
  }
  const record: Record<string, unknown> = {
    format: CREATIVE_PROJECT_FORMAT,
    version: CREATIVE_PROJECT_VERSION,
    sources: cloned.sources,
    derivatives: cloned.derivatives,
    board: cloned.board,
    recipes: cloned.recipes,
    blobs,
  };
  readCreativeProjectManifest(record);
  return record;
}

/** Derive the manifest a kept set declares, as owned canonical records. */
export function deriveCreativeProjectManifest(kept: CreativeKeptSet): CreativeProjectManifest {
  return readCreativeProjectManifest(writeCreativeProjectManifest(kept));
}

/** The unique blob hashes a manifest carries, in canonical order. */
export function creativeProjectBlobHashes(manifest: {
  readonly blobs: Readonly<Record<BlobHash, unknown>>;
}): BlobHash[] {
  return Object.keys(manifest.blobs).sort(compareCodePoints);
}
