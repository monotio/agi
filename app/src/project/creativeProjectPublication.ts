/**
 * Validated admission of a complete new project that carries kept creative
 * data: the coordinator library import and copy share.
 *
 * Portable creative assets — a manifest and its blob bodies — are owned and
 * fully verified before the first await, so a caller mutating its offer
 * during the asynchronous checks can never mix two moments into one
 * publication. The coordinator then runs the archive's own prospective
 * admission: the exact entry list the project download writes (native
 * resources, the version-2 PROJECT.JSON metadata, reference images and the
 * unique creative binaries) is measured with the writer's arithmetic, and a
 * candidate whose durable authoring data could never be backed up refuses
 * here instead of publishing a project that always fails to export.
 *
 * The durable write itself is `publishNewProject`: one transaction for the
 * body, a fresh catalog bound to the target project and its blob records.
 * Nothing storage-local travels — catalog head and kept pins, leases,
 * holds, body markers and lifetimes are derived at publication, not taken
 * from the portable manifest.
 */
import {
  CreativeCatalogError,
  creativeCatalogKey,
  type BlobHash,
  type CreativeCatalog,
  type RegisteredBlob,
} from "../../../src/creative/catalog.ts";
import {
  creativeProjectBlobHashes,
  readCreativeProjectManifest,
  writeCreativeProjectManifest,
  type CreativeKeptSet,
  type CreativeProjectAssets,
} from "../../../src/creative/project.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import type { PortableCreativeWork } from "../../../src/creative/workArchive.ts";
import type { ProjectId } from "../../../src/gameIdentity.ts";
import {
  collectProjectArchiveEntries,
  measureStoredArchive,
  type CreativeSnapshotOffer,
} from "../archive/projectArchive.ts";
import { gameRevision } from "./gameMetadata.ts";
import type { CachedGameData } from "./gameTypes.ts";
import { ownCreativeWorkBlobs, ownCreativeWorkEnvelope } from "./creativeWorkArchive.ts";
import { publishNewProject, type ProjectPublishReceipt } from "./gameStorage.ts";

/** The archive admission needs the body's storage pins; a first publication always takes these. */
const FIRST_PUBLICATION = { generation: 1, kept: 1, head: 1 } as const;

/** Whether the offered blob registry names exactly the descriptors the kept set derives. */
function sameRegistry(
  offered: unknown,
  expected: Readonly<Record<BlobHash, RegisteredBlob>>,
): boolean {
  if (offered === null || typeof offered !== "object" || Array.isArray(offered)) return false;
  const registry = offered as Record<
    string,
    { hash?: unknown; byteLength?: unknown; mime?: unknown; buckets?: unknown } | null
  >;
  const keys = Object.keys(registry);
  const expectedKeys = Object.keys(expected);
  if (keys.length !== expectedKeys.length) return false;
  return keys.every((hash) => {
    const descriptor = expected[hash];
    const entry = registry[hash];
    return (
      descriptor !== undefined &&
      entry !== null &&
      typeof entry === "object" &&
      entry.hash === hash &&
      entry.hash === descriptor.hash &&
      entry.byteLength === descriptor.byteLength &&
      entry.mime === descriptor.mime &&
      Array.isArray(entry.buckets) &&
      entry.buckets.length === descriptor.buckets.length &&
      descriptor.buckets.every((bucket) => (entry.buckets as unknown[]).includes(bucket))
    );
  });
}

/**
 * Own and verify the portable assets: the kept set re-canonicalizes through
 * the manifest writer and strict reader, its declared registry must equal
 * the derived one, and every declared blob body is checked against its
 * content hash and descriptor. Refusals are named — corrupt bytes, a
 * registry/blob mismatch, an unknown nested version — never a partial set.
 */
function ownedCreativeAssets(assets: CreativeProjectAssets): CreativeProjectAssets {
  if (assets === null || typeof assets !== "object" || Array.isArray(assets))
    throw new Error("Invalid creative project assets.");
  const offered = assets as { manifest: unknown; blobs: unknown };
  if (
    offered.manifest === null ||
    typeof offered.manifest !== "object" ||
    Array.isArray(offered.manifest)
  )
    throw new Error("Invalid creative project manifest.");
  const manifest = readCreativeProjectManifest(
    writeCreativeProjectManifest(offered.manifest as CreativeKeptSet),
  );
  const declaredRegistry = (offered.manifest as { blobs?: unknown } | undefined)?.blobs;
  if (!sameRegistry(declaredRegistry, manifest.blobs))
    throw new Error("The creative manifest's blob registry does not match its kept set.");
  const offeredBlobs = offered.blobs;
  if (offeredBlobs === null || typeof offeredBlobs !== "object" || Array.isArray(offeredBlobs))
    throw new Error("Invalid creative project blob set.");
  const declared = creativeProjectBlobHashes(manifest);
  const keys = Object.keys(offeredBlobs);
  if (
    keys.length !== declared.length ||
    declared.some((hash) => !Object.hasOwn(offeredBlobs, hash))
  )
    throw new Error("The creative blob set does not match its manifest.");
  const blobs: Record<BlobHash, Uint8Array> = {};
  for (const hash of declared) {
    const bytes = (offeredBlobs as Record<BlobHash, unknown>)[hash];
    const descriptor = manifest.blobs[hash]!;
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length !== descriptor.byteLength ||
      sha256Hex(bytes) !== hash
    )
      throw new Error(`creative blob '${hash}' does not match its manifest descriptor.`);
    blobs[hash] = new Uint8Array(bytes);
  }
  return { manifest, blobs };
}

/**
 * The durable catalog an initial publication writes: the kept records and
 * their blob registry exactly as the portable manifest carries them,
 * bound to the target project with fresh pins. Storage authority starts
 * empty — no lease or hold survives a publication.
 */
function assemblePublicationCatalog(
  projectId: ProjectId,
  manifest: CreativeProjectAssets["manifest"],
): CreativeCatalog {
  return {
    projectId: creativeCatalogKey(projectId),
    head: FIRST_PUBLICATION.head,
    kept: FIRST_PUBLICATION.kept,
    sources: manifest.sources,
    derivatives: manifest.derivatives,
    board: manifest.board,
    recipes: manifest.recipes,
    leases: [],
    holds: [],
    blobs: manifest.blobs,
  };
}

/** The durable-work half of a publication offer: the portable envelope plus the bodies its registry declares. */
export interface PortableWorkAssets {
  readonly work: PortableCreativeWork;
  readonly blobs: Readonly<Record<BlobHash, Uint8Array>>;
}

/**
 * Publish a complete new project — body, kept creative catalog and durable
 * work — into storage in one atomic write. Validation order: own the
 * portable assets, derive the target-bound catalog, measure the
 * prospective archive against the writer's real entry construction, then
 * commit. A refusal at any step leaves no body, catalog, blob record,
 * recovery row, index entry or fake-complete receipt behind.
 */
export async function publishProjectWithCreative(input: {
  readonly projectId: ProjectId;
  readonly data: Omit<CachedGameData, "projectId" | "authoredAt" | "generation">;
  readonly creative?: CreativeProjectAssets | undefined;
  readonly work?: PortableWorkAssets | undefined;
}): Promise<{ receipt: ProjectPublishReceipt; warnings: readonly "indexRepairPending"[] }> {
  // The candidate is owned before the first await: the caller may keep
  // mutating its offer meanwhile, and the measured archive must be exactly
  // the body and assets that publish — never a half-mutated mix.
  const data = structuredClone(input.data);
  if (data.creative !== undefined)
    throw new CreativeCatalogError(
      "invalid",
      "The candidate's creative marker is assigned by storage.",
    );
  const assets = input.creative === undefined ? undefined : ownedCreativeAssets(input.creative);
  const catalog =
    assets === undefined ? undefined : assemblePublicationCatalog(input.projectId, assets.manifest);
  const blobs =
    assets === undefined
      ? []
      : creativeProjectBlobHashes(assets.manifest).map((hash) => ({
          ref: assets.manifest.blobs[hash]!,
          bytes: assets.blobs[hash]!,
        }));
  const ownedWork = input.work === undefined ? undefined : ownCreativeWorkEnvelope(input.work.work);
  const ownedWorkBlobs =
    ownedWork === undefined || input.work === undefined
      ? undefined
      : ownCreativeWorkBlobs(ownedWork, input.work.blobs);
  // Prospective admission: measure the exact archive this publication would
  // have to fit in later — real entries, real UTF-8 names, the writer's
  // packed arithmetic — before anything durable exists. Progress, map and
  // history stay independent download-time attachments and are not
  // promised capacity here.
  const prospective: CachedGameData = {
    ...data,
    projectId: input.projectId,
    authoredAt: new Date().toISOString(),
    generation: FIRST_PUBLICATION.generation,
    ...(catalog !== undefined ? { creative: { kept: FIRST_PUBLICATION.kept } } : {}),
  };
  const offer: CreativeSnapshotOffer = {
    projectId: input.projectId,
    generation: FIRST_PUBLICATION.generation,
    kept: catalog === undefined ? 0 : FIRST_PUBLICATION.kept,
    head: FIRST_PUBLICATION.head,
    revision: await gameRevision(prospective.files),
    manifest: assets?.manifest ?? null,
    blobs: assets?.blobs ?? {},
    work: ownedWork ?? null,
    workBlobs: ownedWorkBlobs ?? {},
  };
  measureStoredArchive(
    await collectProjectArchiveEntries(
      prospective,
      undefined,
      undefined,
      undefined,
      undefined,
      offer,
    ),
  );
  return publishNewProject({
    projectId: input.projectId,
    data,
    ...(catalog !== undefined ? { creative: { catalog, blobs } } : {}),
    ...(ownedWork !== undefined && ownedWorkBlobs !== undefined
      ? { work: { work: ownedWork, blobs: ownedWorkBlobs } }
      : {}),
  });
}
