/**
 * Portable recovery envelope for unfinished creative preparation work.
 *
 * A workspace's imported sources, canonical rasters, derived variants, board
 * placements and preparation recipes exist — staged under a lease or kept —
 * before any native resource is Keep-able. This codec captures that whole set
 * in one detached, versioned record so a close, reload or crash cannot lose
 * the original import and its editable recipe state.
 *
 * The envelope carries every record its work references: staged records and
 * exact copies of the kept records they build on. `base.pins` names which of
 * the carried records were kept at capture — the version pins — while
 * `base.kept` pins the kept catalog revision itself. Moving the kept set or
 * the playable base afterwards makes the recovery stale; nothing rebases it.
 *
 * Two recipe shapes are admitted: complete `CreativeRecipe` records, strict
 * as kept ones, and bounded `CreativeRecipeDraft` records for unfinished
 * edits. A draft is the strict recipe minus completeness: `identity` and
 * `sources` are required, every present field is validated exactly as the
 * finished recipe validates it, and the missing pieces are the parts the
 * user has not chosen yet. Cross-field completeness — declared sources
 * covering every preparation reference, loops resolving every frame, a
 * destination and a finished preparation — is only required when a draft
 * matures into a recipe at Keep. A draft loop may name frame ids that are
 * not declared yet, and a mirror loop may name a loop that is not declared
 * yet; both are explicit unfinished states, never silently rewritten.
 *
 * The `blobs` registry is derived from the carried records, never declared:
 * exact verified descriptors for every referenced blob, nothing more. Bytes
 * never travel in this envelope; they live in the content-addressed blob
 * store a durable hold pins.
 *
 * No storage-local authority is admitted: no project id, lifetime,
 * generation, catalog head, lease owner, expiry, receipt or credentials.
 * The record is data only — no callbacks, no executable content.
 */
import {
  CREATIVE_LIMITS,
  CREATIVE_RECIPE_FORMAT,
  CreativeCatalogError,
  VIEW_PREPARATION_KIND,
  checkSourceDerivations,
  compareCodePoints,
  derivativeBlobBucket,
  mergeBlobRegistration,
  readCreativeBoardEntry,
  readCreativeDerivative,
  readCreativeRecipe,
  readCreativeSource,
  readVersionRef,
  versionRefKey,
  type BlobBucket,
  type BlobHash,
  type CreativeBoardEntry,
  type CreativeDerivative,
  type CreativeRecipe,
  type CreativeSource,
  type PicturePreparation,
  type Rect,
  type RegisteredBlob,
  type VersionRef,
} from "./catalog.ts";
import {
  readProjectRecovery,
  writeProjectRecovery,
  type PortableProjectRecovery,
} from "../authoring/projectRecoveryCodec.ts";
import { resourceRevision, type ResourceRevision } from "../gameIdentity.ts";
import { PROFILES, type ProfileId } from "../runtime/profile.ts";
import type { ViewFacing, ViewRecipeFrame, ViewRecipeMask } from "../view/preparation.ts";

export const CREATIVE_RECOVERY_FORMAT = "monotio.agi.creative-recovery";

/** Hard bounds applied before any output allocation in both directions. */
const CREATIVE_RECOVERY_LIMITS = Object.freeze({
  /** Unfinished recipe drafts one recovery may carry. */
  maxDrafts: 64,
  /** Frames and loops one view draft may declare so far. */
  maxDraftFrames: 256,
  maxDraftLoops: 255,
  /** Cel references across one view draft's loops. */
  maxDraftCels: 1024,
  /** Kept creative records one recovery may pin as its basis. */
  maxPins: 256,
} as const);

const DESTINATION_KINDS = ["picture", "view"] as const;
const PICTURE_DRAFT_KINDS = ["picture-underlay", "picture-conversion"] as const;
const PICTURE_FITS = ["contain", "cover", "stretch"] as const;
const PICTURE_ASPECTS = ["native", "original-4:3"] as const;
const PICTURE_SAMPLE = "nearest-centre-v1";
const PICTURE_PALETTE = "ega-weighted-243-v1";
const PICTURE_SCOPE = "art";
const VIEW_FACINGS = ["right", "left", "down", "up"] as const;
const BLOB_BUCKET_NAMES = ["canonical", "disposable", "original"] as const;
const AUTHORING_DIGEST = /^[0-9a-f]{64}$/;

/**
 * The identity a recovery was captured against. It binds the playable base
 * (resource revision, kept editable-content digest, interpreter profile) and
 * the kept creative base (the catalog's kept revision plus the exact kept
 * record identities the work depends on). Local workspace guards — project
 * id, generation, lifetime — are deliberately absent; they belong to the
 * sidecar record that stores this envelope.
 */
export interface CreativeRecoveryBase {
  readonly revision: ResourceRevision;
  /** 64 lowercase hex digits: SHA-256 of the kept editable content. */
  readonly authoring: string;
  readonly profileId: ProfileId;
  /** The kept catalog revision the work was prepared against. */
  readonly kept: number;
  /** Exact identities of the kept records the work builds on. */
  readonly pins: readonly VersionRef[];
}

/** A destination slot not necessarily chosen yet. */
export interface CreativeDraftDestination {
  readonly kind: "picture" | "view";
  readonly resourceId?: number | undefined;
}

/**
 * A loop in a draft may reference frame ids that are not declared yet or an
 * earlier loop id that is not declared yet — both explicit unfinished
 * states. `frameIds` may also be empty. Everything present keeps the strict
 * recipe's per-field validation.
 */
export type CreativeDraftLoop =
  | {
      readonly id: string;
      readonly frameIds: readonly string[];
      readonly facing?: ViewFacing | undefined;
    }
  | {
      readonly id: string;
      readonly mirrorOf: string;
      readonly explicitlyApproved: true;
      readonly facing?: ViewFacing | undefined;
    };

/** An unfinished view recipe: the strict recipe minus completeness. */
export interface CreativeViewDraft {
  readonly kind: typeof VIEW_PREPARATION_KIND;
  readonly algorithm?: string | undefined;
  readonly sources?: readonly VersionRef[] | undefined;
  readonly palette?: string | undefined;
  readonly mask?: ViewRecipeMask | undefined;
  readonly frames?: readonly ViewRecipeFrame[] | undefined;
  readonly loops?: readonly CreativeDraftLoop[] | undefined;
  readonly description?: string | undefined;
}

/** An unfinished picture recipe: the strict envelope minus completeness. */
export interface CreativePictureDraft {
  readonly kind: (typeof PICTURE_DRAFT_KINDS)[number];
  readonly source?: VersionRef | undefined;
  readonly crop?: Rect | undefined;
  readonly destination?: Rect | undefined;
  readonly fit?: PicturePreparation["fit"] | undefined;
  readonly intendedAspect?: PicturePreparation["intendedAspect"] | undefined;
  readonly sample?: PicturePreparation["sample"] | undefined;
  readonly opacity?: number | undefined;
  readonly palette?: PicturePreparation["palette"] | undefined;
  readonly alpha?: PicturePreparation["alpha"] | undefined;
  readonly scope?: PicturePreparation["scope"] | undefined;
}

export type CreativeDraftPreparation = CreativeViewDraft | CreativePictureDraft;

/**
 * One in-progress recipe. `identity` names the recipe being drafted and
 * `sources` declares the source records chosen so far (possibly none); both
 * are required so an empty draft still names its asset and cannot float.
 * Every remaining field is optional — its absence is the unfinished part —
 * and each present value must satisfy exactly the finished recipe's rule
 * for it. A destination/preparation kind disagreement is still refused.
 */
export interface CreativeRecipeDraft {
  readonly identity: VersionRef;
  readonly sources: readonly VersionRef[];
  readonly algorithm?: string | undefined;
  readonly destination?: CreativeDraftDestination | undefined;
  readonly preparation?: CreativeDraftPreparation | undefined;
  /** A short user-facing note about the work in progress. */
  readonly notes?: string | undefined;
}

/** The stored recovery: one workspace's creative work, detached and exact. */
export interface PortableCreativeRecovery {
  readonly format: typeof CREATIVE_RECOVERY_FORMAT;
  readonly version: 1;
  readonly base: CreativeRecoveryBase;
  /** Staged records plus copies of the kept records `base.pins` names. */
  readonly sources: readonly CreativeSource[];
  readonly derivatives: readonly CreativeDerivative[];
  readonly board: readonly CreativeBoardEntry[];
  readonly recipes: readonly CreativeRecipe[];
  readonly drafts: readonly CreativeRecipeDraft[];
  /** Derived claims: every blob descriptor the carried records reference. */
  readonly blobs: Readonly<Record<BlobHash, RegisteredBlob>>;
  /** Coordinated workspace document recovery, pinned to the same base. */
  readonly projectDraft?: PortableProjectRecovery | undefined;
}

/** The writable parts of a recovery; `format`, `version` and `blobs` are owned by the codec. */
export interface CreativeRecoveryData {
  readonly base: CreativeRecoveryBase;
  readonly sources: readonly CreativeSource[];
  readonly derivatives: readonly CreativeDerivative[];
  readonly board: readonly CreativeBoardEntry[];
  readonly recipes: readonly CreativeRecipe[];
  readonly drafts: readonly CreativeRecipeDraft[];
  readonly projectDraft?: PortableProjectRecovery | undefined;
}

function invalid(message: string): never {
  throw new CreativeCatalogError("invalid", `Invalid creative recovery data: ${message}`);
}

function unsupported(message: string): never {
  throw new CreativeCatalogError("unsupported", `Unsupported creative recovery data: ${message}`);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    invalid(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

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

function readRect(value: unknown, label: string): Rect {
  const record = fields(value, label, ["x", "y", "width", "height"]);
  return {
    x: int(record["x"], 0, Number.MAX_SAFE_INTEGER, `${label}.x`),
    y: int(record["y"], 0, Number.MAX_SAFE_INTEGER, `${label}.y`),
    width: int(record["width"], 1, Number.MAX_SAFE_INTEGER, `${label}.width`),
    height: int(record["height"], 1, Number.MAX_SAFE_INTEGER, `${label}.height`),
  };
}

function compareIdentities(a: VersionRef, b: VersionRef): number {
  return (
    compareCodePoints(a.id, b.id) ||
    compareCodePoints(a.incarnation, b.incarnation) ||
    a.revision - b.revision
  );
}

/** A canonical, strictly ordered identity list — no duplicates, no reordering. */
function readRefs(value: unknown, label: string, bound: number): VersionRef[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array of identities.`);
  if (value.length > bound) invalid(`${label} lists ${value.length} identities, over ${bound}.`);
  const refs = (value as unknown[]).map((ref, i) => readVersionRef(ref, `${label}[${i}]`));
  for (let i = 1; i < refs.length; i++)
    if (compareIdentities(refs[i - 1]!, refs[i]!) >= 0)
      invalid(`${label} is not stored in canonical identity order.`);
  return refs;
}

function readRecordList<T extends { readonly identity: VersionRef }>(
  value: unknown,
  label: string,
  bound: number,
  read: (entry: unknown, entryLabel: string) => T,
): T[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array of records.`);
  if (value.length > bound) invalid(`${label} lists ${value.length} records, over ${bound}.`);
  const list = (value as unknown[]).map((entry, i) => read(entry, `${label}[${i}]`));
  for (let i = 1; i < list.length; i++)
    if (compareIdentities(list[i - 1]!.identity, list[i]!.identity) >= 0)
      invalid(`${label} is not stored in canonical identity order.`);
  return list;
}

function readBase(value: unknown): CreativeRecoveryBase {
  const record = fields(value, "creative recovery base", [
    "revision",
    "authoring",
    "profileId",
    "kept",
    "pins",
  ]);
  const revision = resourceRevision(record["revision"]);
  if (revision === null)
    invalid(`base.revision '${String(record["revision"])}' is not a resource revision.`);
  const authoring = record["authoring"];
  if (typeof authoring !== "string" || !AUTHORING_DIGEST.test(authoring))
    invalid("base.authoring must be a 64-digit lowercase SHA-256 hex digest.");
  const profile = record["profileId"];
  if (typeof profile !== "string" || !Object.hasOwn(PROFILES, profile))
    invalid(`base.profileId is not a known profile: ${String(profile)}.`);
  return {
    revision,
    authoring,
    profileId: profile as ProfileId,
    kept: int(record["kept"], 0, Number.MAX_SAFE_INTEGER, "base.kept"),
    pins: readRefs(record["pins"], "base.pins", CREATIVE_RECOVERY_LIMITS.maxPins),
  };
}

function readDraftMask(value: unknown, label: string): ViewRecipeMask {
  const record = fields(value, label, ["alphaThreshold", "key"]);
  const alphaThreshold = int(record["alphaThreshold"], 0, 255, `${label}.alphaThreshold`);
  const key = record["key"];
  if (key === null) return { alphaThreshold, key: null };
  const keyRecord = fields(key, `${label}.key`, ["mode", "rgb"]);
  const rgb = keyRecord["rgb"];
  if (
    !Array.isArray(rgb) ||
    rgb.length !== 3 ||
    !rgb.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
  )
    invalid(`${label}.key.rgb must be three integers 0..255.`);
  return {
    alphaThreshold,
    key: {
      mode: boundedString(
        keyRecord["mode"],
        CREATIVE_LIMITS.maxAlgorithmLength,
        `${label}.key.mode`,
      ),
      rgb: [rgb[0]!, rgb[1]!, rgb[2]!],
    },
  };
}

/**
 * A draft frame keeps the strict recipe's exact per-field rules. Routing it
 * through a minimal finished recipe validates region, anchors, output size
 * and the pinned sample name with the catalog codec itself — the scaffold
 * is discarded and only the canonical frame survives.
 */
function readDraftFrame(value: unknown, label: string): ViewRecipeFrame {
  // The scaffold's declared sources only exist to carry the frame into the
  // strict reader; a missing source fails inside the frame check itself.
  const source =
    (plainObject(value, label) as { source?: unknown })["source"] ??
    ({ id: "missing", incarnation: "missing", revision: 0 } satisfies VersionRef);
  const recipe = readCreativeRecipe(
    {
      format: CREATIVE_RECIPE_FORMAT,
      version: 1,
      identity: { id: "draft-frame-check", incarnation: "draft", revision: 0 },
      sources: [source],
      algorithm: "draft-frame",
      preparation: {
        format: CREATIVE_RECIPE_FORMAT,
        version: 1,
        kind: VIEW_PREPARATION_KIND,
        algorithm: "draft-frame",
        sources: [source],
        palette: "draft-frame",
        mask: { alphaThreshold: 128, key: null },
        frames: [value],
        loops: [],
      },
      destination: { kind: "view", resourceId: 0 },
    },
    label,
  );
  const preparation = recipe.preparation;
  if (preparation.kind !== VIEW_PREPARATION_KIND)
    invalid(`${label} did not read back as a view frame.`);
  return preparation.frames[0]!;
}

const DRAFT_LOOP_FIELDS = ["id", "frameIds", "mirrorOf", "explicitlyApproved", "facing"];

function readDraftLoop(value: unknown, label: string, budget: { cels: number }): CreativeDraftLoop {
  const record = plainObject(value, label);
  for (const key of Object.keys(record))
    if (!DRAFT_LOOP_FIELDS.includes(key)) invalid(`${label} has an unknown field '${key}'.`);
  const id = boundedString(record["id"], CREATIVE_LIMITS.maxIdLength, `${label}.id`);
  const facing = record["facing"];
  if (facing !== undefined && !VIEW_FACINGS.includes(facing as (typeof VIEW_FACINGS)[number]))
    invalid(`${label}.facing '${String(facing)}' is unknown.`);
  const hasFrames = record["frameIds"] !== undefined;
  const hasMirror = record["mirrorOf"] !== undefined;
  if (hasFrames === hasMirror)
    invalid(`${label} must declare exactly one of frameIds or mirrorOf.`);
  if (hasFrames) {
    const ids = record["frameIds"];
    if (
      !Array.isArray(ids) ||
      !ids.every(
        (frameId) => typeof frameId === "string" && frameId.length <= CREATIVE_LIMITS.maxIdLength,
      )
    )
      invalid(`${label}.frameIds must be an array of frame ids.`);
    budget.cels += ids.length;
    if (budget.cels > CREATIVE_RECOVERY_LIMITS.maxDraftCels)
      invalid(`${label} exceeds the draft cel bound.`);
    return {
      id,
      frameIds: [...ids] as readonly string[],
      ...(facing !== undefined ? { facing: facing as ViewFacing } : {}),
    };
  }
  if (record["explicitlyApproved"] !== true)
    invalid(`${label}.explicitlyApproved must be true for a mirrored loop.`);
  return {
    id,
    mirrorOf: boundedString(record["mirrorOf"], CREATIVE_LIMITS.maxIdLength, `${label}.mirrorOf`),
    explicitlyApproved: true,
    ...(facing !== undefined ? { facing: facing as ViewFacing } : {}),
  };
}

function readViewDraft(value: unknown, label: string): CreativeViewDraft {
  const record = fields(
    value,
    label,
    ["kind"],
    ["algorithm", "sources", "palette", "mask", "frames", "loops", "description"],
  );
  const algorithm = record["algorithm"];
  const palette = record["palette"];
  const mask = record["mask"];
  const framesValue = record["frames"];
  const loopsValue = record["loops"];
  const description = record["description"];
  let frames: readonly ViewRecipeFrame[] | undefined;
  if (framesValue !== undefined) {
    if (!Array.isArray(framesValue)) invalid(`${label}.frames must be an array.`);
    if (framesValue.length > CREATIVE_RECOVERY_LIMITS.maxDraftFrames)
      invalid(
        `${label}.frames lists ${framesValue.length} frames, over ${CREATIVE_RECOVERY_LIMITS.maxDraftFrames}.`,
      );
    const ids = new Set<string>();
    frames = framesValue.map((frame, i) => {
      const parsed = readDraftFrame(frame, `${label}.frames[${i}]`);
      if (ids.has(parsed.id)) invalid(`${label}.frames[${i}].id '${parsed.id}' is duplicated.`);
      ids.add(parsed.id);
      return parsed;
    });
  }
  let loops: readonly CreativeDraftLoop[] | undefined;
  if (loopsValue !== undefined) {
    if (!Array.isArray(loopsValue)) invalid(`${label}.loops must be an array.`);
    if (loopsValue.length > CREATIVE_RECOVERY_LIMITS.maxDraftLoops)
      invalid(
        `${label}.loops lists ${loopsValue.length} loops, over ${CREATIVE_RECOVERY_LIMITS.maxDraftLoops}.`,
      );
    const ids = new Set<string>();
    const budget = { cels: 0 };
    loops = loopsValue.map((loop, i) => {
      const parsed = readDraftLoop(loop, `${label}.loops[${i}]`, budget);
      if (ids.has(parsed.id)) invalid(`${label}.loops[${i}].id '${parsed.id}' is duplicated.`);
      ids.add(parsed.id);
      return parsed;
    });
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 1024))
    invalid(`${label}.description must be a string of at most 1024 characters.`);
  return {
    kind: VIEW_PREPARATION_KIND,
    ...(algorithm !== undefined
      ? {
          algorithm: boundedString(
            algorithm,
            CREATIVE_LIMITS.maxAlgorithmLength,
            `${label}.algorithm`,
          ),
        }
      : {}),
    ...(record["sources"] !== undefined
      ? {
          sources: readRefs(
            record["sources"],
            `${label}.sources`,
            CREATIVE_LIMITS.maxStagedRecords,
          ),
        }
      : {}),
    ...(palette !== undefined
      ? { palette: boundedString(palette, CREATIVE_LIMITS.maxAlgorithmLength, `${label}.palette`) }
      : {}),
    ...(mask !== undefined ? { mask: readDraftMask(mask, `${label}.mask`) } : {}),
    ...(frames !== undefined ? { frames } : {}),
    ...(loops !== undefined ? { loops } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function readPictureDraft(value: unknown, label: string): CreativePictureDraft {
  const record = fields(
    value,
    label,
    ["kind"],
    [
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
    ],
  );
  const kind = record["kind"];
  if (!PICTURE_DRAFT_KINDS.includes(kind as (typeof PICTURE_DRAFT_KINDS)[number]))
    unsupported(`${label}.kind '${String(kind)}' is not a known picture preparation.`);
  const fit = record["fit"];
  const aspect = record["intendedAspect"];
  const sample = record["sample"];
  const palette = record["palette"];
  const scope = record["scope"];
  const opacity = record["opacity"];
  const alpha = record["alpha"];
  const destination = record["destination"];
  if (fit !== undefined && !PICTURE_FITS.includes(fit as (typeof PICTURE_FITS)[number]))
    invalid(`${label}.fit '${String(fit)}' is unknown.`);
  if (aspect !== undefined && !PICTURE_ASPECTS.includes(aspect as (typeof PICTURE_ASPECTS)[number]))
    invalid(`${label}.intendedAspect '${String(aspect)}' is unknown.`);
  if (sample !== undefined && sample !== PICTURE_SAMPLE)
    unsupported(`${label}.sample '${String(sample)}' is not '${PICTURE_SAMPLE}'.`);
  if (palette !== undefined && palette !== PICTURE_PALETTE)
    unsupported(`${label}.palette '${String(palette)}' is not '${PICTURE_PALETTE}'.`);
  if (scope !== undefined && scope !== PICTURE_SCOPE)
    unsupported(`${label}.scope '${String(scope)}' is not '${PICTURE_SCOPE}'.`);
  if (opacity !== undefined && (typeof opacity !== "number" || !(opacity >= 0 && opacity <= 1)))
    invalid(`${label}.opacity must be a number 0..1.`);
  let parsedAlpha: CreativePictureDraft["alpha"];
  if (alpha !== undefined) {
    const alphaRecord = fields(alpha, `${label}.alpha`, ["threshold", "matte"]);
    parsedAlpha = {
      threshold: int(alphaRecord["threshold"], 0, 255, `${label}.alpha.threshold`),
      matte: int(alphaRecord["matte"], 0, 15, `${label}.alpha.matte`),
    };
  }
  let parsedDestination: Rect | undefined;
  if (destination !== undefined) {
    parsedDestination = readRect(destination, `${label}.destination`);
    if (
      parsedDestination.x + parsedDestination.width > CREATIVE_LIMITS.pictureWidth ||
      parsedDestination.y + parsedDestination.height > CREATIVE_LIMITS.pictureHeight
    )
      invalid(
        `${label}.destination must fit inside ${CREATIVE_LIMITS.pictureWidth}x${CREATIVE_LIMITS.pictureHeight} logical cells.`,
      );
  }
  return {
    kind: kind as CreativePictureDraft["kind"],
    ...(record["source"] !== undefined
      ? { source: readVersionRef(record["source"], `${label}.source`) }
      : {}),
    ...(record["crop"] !== undefined ? { crop: readRect(record["crop"], `${label}.crop`) } : {}),
    ...(parsedDestination !== undefined ? { destination: parsedDestination } : {}),
    ...(fit !== undefined ? { fit: fit as CreativePictureDraft["fit"] } : {}),
    ...(aspect !== undefined
      ? { intendedAspect: aspect as CreativePictureDraft["intendedAspect"] }
      : {}),
    ...(sample !== undefined ? { sample: PICTURE_SAMPLE } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
    ...(palette !== undefined ? { palette: PICTURE_PALETTE } : {}),
    ...(parsedAlpha !== undefined ? { alpha: parsedAlpha } : {}),
    ...(scope !== undefined ? { scope: PICTURE_SCOPE } : {}),
  };
}

function readDraftPreparation(value: unknown, label: string): CreativeDraftPreparation {
  const record = plainObject(value, label);
  const kind = record["kind"];
  if (kind === VIEW_PREPARATION_KIND) return readViewDraft(record, label);
  return readPictureDraft(record, label);
}

function readDraftDestination(value: unknown, label: string): CreativeDraftDestination {
  const record = fields(value, label, ["kind"], ["resourceId"]);
  const kind = record["kind"];
  if (!DESTINATION_KINDS.includes(kind as (typeof DESTINATION_KINDS)[number]))
    invalid(`${label}.kind '${String(kind)}' is unknown.`);
  const resourceId = record["resourceId"];
  return {
    kind: kind as CreativeDraftDestination["kind"],
    ...(resourceId !== undefined
      ? { resourceId: int(resourceId, 0, 255, `${label}.resourceId`) }
      : {}),
  };
}

function readRecipeDraft(value: unknown, label: string): CreativeRecipeDraft {
  const record = fields(
    value,
    label,
    ["identity", "sources"],
    ["algorithm", "destination", "preparation", "notes"],
  );
  const algorithm = record["algorithm"];
  const notes = record["notes"];
  const destination =
    record["destination"] !== undefined
      ? readDraftDestination(record["destination"], `${label}.destination`)
      : undefined;
  const preparation =
    record["preparation"] !== undefined
      ? readDraftPreparation(record["preparation"], `${label}.preparation`)
      : undefined;
  if (destination !== undefined && preparation !== undefined) {
    if (destination.kind === "view" && preparation.kind !== VIEW_PREPARATION_KIND)
      invalid(`${label}.destination is a view but the preparation is not.`);
    if (destination.kind === "picture" && preparation.kind === VIEW_PREPARATION_KIND)
      invalid(`${label}.destination is a picture but the preparation is a view recipe.`);
  }
  if (algorithm !== undefined)
    boundedString(algorithm, CREATIVE_LIMITS.maxAlgorithmLength, `${label}.algorithm`);
  if (
    notes !== undefined &&
    (typeof notes !== "string" || notes.length > CREATIVE_LIMITS.maxNotesLength)
  )
    invalid(
      `${label}.notes must be a string of at most ${CREATIVE_LIMITS.maxNotesLength} characters.`,
    );
  return {
    identity: readVersionRef(record["identity"], `${label}.identity`),
    sources: readRefs(record["sources"], `${label}.sources`, CREATIVE_LIMITS.maxStagedRecords),
    ...(algorithm !== undefined ? { algorithm: algorithm as string } : {}),
    ...(destination !== undefined ? { destination } : {}),
    ...(preparation !== undefined ? { preparation } : {}),
    ...(notes !== undefined ? { notes: notes as string } : {}),
  };
}

/** Every source identity a draft's present fields name. */
function draftSourceRefs(draft: CreativeRecipeDraft): VersionRef[] {
  const refs = [...draft.sources];
  const preparation = draft.preparation;
  if (preparation === undefined) return refs;
  if (preparation.kind === VIEW_PREPARATION_KIND) {
    const view = preparation;
    if (view.sources !== undefined) refs.push(...view.sources);
    if (view.frames !== undefined) for (const frame of view.frames) refs.push(frame.source);
    return refs;
  }
  if (preparation.source !== undefined) refs.push(preparation.source);
  return refs;
}

/** The claims every carried record makes, with the buckets they claim under. */
function deriveRegistry(
  sources: readonly CreativeSource[],
  derivatives: readonly CreativeDerivative[],
): Record<BlobHash, RegisteredBlob> {
  const blobs: Record<BlobHash, RegisteredBlob> = {};
  for (const source of sources) {
    mergeBlobRegistration(blobs, source.encoded, "original");
    mergeBlobRegistration(blobs, source.normalized.blob, "canonical");
  }
  for (const derivative of derivatives)
    mergeBlobRegistration(blobs, derivative.blob, derivativeBlobBucket(derivative.purpose));
  return blobs;
}

function sameDescriptor(a: RegisteredBlob, b: RegisteredBlob): boolean {
  return (
    a.byteLength === b.byteLength &&
    a.mime === b.mime &&
    a.buckets.length === b.buckets.length &&
    a.buckets.every((bucket, i) => bucket === b.buckets[i])
  );
}

function readBlobBuckets(value: unknown, label: string): BlobBucket[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((bucket) => BLOB_BUCKET_NAMES.includes(bucket as BlobBucket)) ||
    new Set(value).size !== value.length
  )
    invalid(`${label} must list each known budget bucket at most once.`);
  return [...(value as BlobBucket[])].sort(compareCodePoints);
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

function readBlobMap(value: unknown, label: string): Record<BlobHash, RegisteredBlob> {
  const record = plainObject(value, label);
  const entries = Object.entries(record);
  if (entries.length > CREATIVE_LIMITS.maxHoldHashes)
    invalid(
      `${label} lists ${entries.length} blobs; the bound is ${CREATIVE_LIMITS.maxHoldHashes}.`,
    );
  const declared: Record<BlobHash, RegisteredBlob> = {};
  for (const [key, descriptor] of entries) {
    const hash = blobHash(key, `${label} key`);
    const entry = readRegisteredBlob(descriptor, `${label}['${hash}']`);
    if (entry.hash !== hash) invalid(`${label}['${hash}'] claims hash '${entry.hash}'.`);
    declared[hash] = entry;
  }
  return declared;
}

/** A declared registry must equal the records' derived claims, exactly. */
function checkRegistry(
  declared: Record<BlobHash, RegisteredBlob>,
  derived: Record<BlobHash, RegisteredBlob>,
  label: string,
): void {
  for (const [hash, ref] of Object.entries(derived)) {
    const entry = declared[hash];
    if (entry === undefined || !sameDescriptor(entry, ref))
      invalid(`${label}['${hash}'] does not match the records' claim.`);
  }
  for (const hash of Object.keys(declared))
    if (derived[hash] === undefined)
      invalid(`${label}['${hash}'] is not referenced by any record.`);
}

/**
 * Internal-consistency check: every reference resolves inside the carried
 * record set, and every pin names a carried record. A draft's present fields
 * were already validated; here its declared and preparation-level source
 * references must land on a carried source too.
 */
function checkRecoveryIntegrity(input: {
  readonly base: CreativeRecoveryBase;
  readonly sources: readonly CreativeSource[];
  readonly derivatives: readonly CreativeDerivative[];
  readonly board: readonly CreativeBoardEntry[];
  readonly recipes: readonly CreativeRecipe[];
  readonly drafts: readonly CreativeRecipeDraft[];
}): void {
  const sourceIds = new Set(input.sources.map((source) => versionRefKey(source.identity)));
  const derivativeIds = new Set(
    input.derivatives.map((derivative) => versionRefKey(derivative.identity)),
  );
  const boardIds = new Set(input.board.map((entry) => versionRefKey(entry.identity)));
  const recipeIds = new Set(input.recipes.map((recipe) => versionRefKey(recipe.identity)));
  const draftIds = new Set(input.drafts.map((draft) => versionRefKey(draft.identity)));
  for (const [i, derivative] of input.derivatives.entries()) {
    if (!sourceIds.has(versionRefKey(derivative.source)))
      invalid(`creative recovery.derivatives[${i}].source names an absent source.`);
    if (
      derivative.recipe !== undefined &&
      !recipeIds.has(versionRefKey(derivative.recipe)) &&
      !draftIds.has(versionRefKey(derivative.recipe))
    )
      invalid(`creative recovery.derivatives[${i}].recipe names an absent recipe.`);
  }
  for (const [i, entry] of input.board.entries()) {
    if (!sourceIds.has(versionRefKey(entry.source)))
      invalid(`creative recovery.board[${i}].source names an absent source.`);
    if (entry.derivative !== undefined && !derivativeIds.has(versionRefKey(entry.derivative)))
      invalid(`creative recovery.board[${i}].derivative names an absent derivative.`);
  }
  for (const [i, recipe] of input.recipes.entries())
    for (const ref of recipe.sources)
      if (!sourceIds.has(versionRefKey(ref)))
        invalid(`creative recovery.recipes[${i}].sources names an absent source.`);
  for (const [i, draft] of input.drafts.entries()) {
    if (recipeIds.has(versionRefKey(draft.identity)))
      invalid(`creative recovery.drafts[${i}].identity collides with a carried recipe.`);
    for (const ref of draftSourceRefs(draft))
      if (!sourceIds.has(versionRefKey(ref)))
        invalid(`creative recovery.drafts[${i}] names an absent source.`);
  }
  for (const pin of input.base.pins)
    if (
      !sourceIds.has(versionRefKey(pin)) &&
      !derivativeIds.has(versionRefKey(pin)) &&
      !boardIds.has(versionRefKey(pin)) &&
      !recipeIds.has(versionRefKey(pin))
    )
      invalid(`base.pins names '${versionRefKey(pin)}' which no carried record has.`);
  // Composite provenance closes over the carried source set: a pending
  // composite's parents — including kept ancestors carried only for it —
  // must travel as full records, not as hashes alone.
  checkSourceDerivations(input.sources, "creative recovery sources");
}

const ENVELOPE_REQUIRED = [
  "format",
  "version",
  "base",
  "sources",
  "derivatives",
  "board",
  "recipes",
  "drafts",
  "blobs",
] as const;
const ENVELOPE_OPTIONAL = ["projectDraft"] as const;

/**
 * Validate a stored recovery envelope. Format and version are checked before
 * any content is traversed; every field set is exact, references resolve
 * inside the carried record set, and the blob registry must equal what the
 * records claim. Returned records are the canonical detached reads.
 */
export function readCreativeRecovery(value: unknown): PortableCreativeRecovery {
  const envelope = plainObject(value, "creative recovery");
  if (envelope["format"] !== CREATIVE_RECOVERY_FORMAT)
    unsupported(
      `creative recovery.format '${String(envelope["format"])}' is not '${CREATIVE_RECOVERY_FORMAT}'.`,
    );
  if (envelope["version"] !== 1)
    unsupported(`creative recovery.version ${String(envelope["version"])} is not 1.`);
  const record = fields(envelope, "creative recovery", ENVELOPE_REQUIRED, ENVELOPE_OPTIONAL);
  const base = readBase(record["base"]);
  const sources = readRecordList(
    record["sources"],
    "creative recovery.sources",
    CREATIVE_LIMITS.maxStagedRecords,
    readCreativeSource,
  );
  const derivatives = readRecordList(
    record["derivatives"],
    "creative recovery.derivatives",
    CREATIVE_LIMITS.maxDerivatives,
    readCreativeDerivative,
  );
  const board = readRecordList(
    record["board"],
    "creative recovery.board",
    CREATIVE_LIMITS.maxBoardEntries,
    readCreativeBoardEntry,
  );
  const recipes = readRecordList(
    record["recipes"],
    "creative recovery.recipes",
    CREATIVE_LIMITS.maxRecipes,
    readCreativeRecipe,
  );
  const drafts = readRecordList(
    record["drafts"],
    "creative recovery.drafts",
    CREATIVE_RECOVERY_LIMITS.maxDrafts,
    readRecipeDraft,
  );
  const blobs = readBlobMap(record["blobs"], "creative recovery.blobs");
  checkRegistry(blobs, deriveRegistry(sources, derivatives), "creative recovery.blobs");
  let projectDraft: PortableProjectRecovery | undefined;
  if (record["projectDraft"] !== undefined) {
    const decoded = readProjectRecovery(record["projectDraft"]);
    if (
      decoded.base.revision !== base.revision ||
      decoded.base.authoring !== base.authoring ||
      decoded.base.profileId !== base.profileId
    )
      invalid("creative recovery.projectDraft.base must match the recovery base.");
    projectDraft = writeProjectRecovery(decoded.base, decoded.recovery);
  }
  checkRecoveryIntegrity({ base, sources, derivatives, board, recipes, drafts });
  const out: Record<BlobHash, RegisteredBlob> = {};
  for (const hash of Object.keys(blobs).sort(compareCodePoints)) out[hash] = blobs[hash]!;
  return {
    format: CREATIVE_RECOVERY_FORMAT,
    version: 1,
    base,
    sources,
    derivatives,
    board,
    recipes,
    drafts,
    blobs: out,
    ...(projectDraft !== undefined ? { projectDraft } : {}),
  };
}

/**
 * Serialize a workspace's creative recovery. The blob registry is derived
 * from the carried records — a caller may feed a previously decoded
 * envelope back, but a `blobs` map disagreeing with the records' claims is
 * refused. The stored record is self-checked through the reader before it
 * is returned.
 */
export function writeCreativeRecovery(
  data: CreativeRecoveryData | PortableCreativeRecovery,
): Record<string, unknown> {
  const input = fields(
    data,
    "creative recovery input",
    ["base", "sources", "derivatives", "board", "recipes", "drafts"],
    ["projectDraft", "format", "version", "blobs"],
  );
  if (input["format"] !== undefined && input["format"] !== CREATIVE_RECOVERY_FORMAT)
    unsupported(
      `creative recovery input.format '${String(input["format"])}' is not '${CREATIVE_RECOVERY_FORMAT}'.`,
    );
  if (input["version"] !== undefined && input["version"] !== 1)
    unsupported(`creative recovery input.version ${String(input["version"])} is not 1.`);
  const record: Record<string, unknown> = {
    format: CREATIVE_RECOVERY_FORMAT,
    version: 1,
    base: { ...structuredClone(data.base), pins: [...data.base.pins].sort(compareIdentities) },
    sources: [...structuredClone(data.sources)].sort((a, b) =>
      compareIdentities(a.identity, b.identity),
    ),
    derivatives: [...structuredClone(data.derivatives)].sort((a, b) =>
      compareIdentities(a.identity, b.identity),
    ),
    board: [...structuredClone(data.board)].sort((a, b) =>
      compareIdentities(a.identity, b.identity),
    ),
    recipes: [...structuredClone(data.recipes)].sort((a, b) =>
      compareIdentities(a.identity, b.identity),
    ),
    drafts: [...structuredClone(data.drafts)].sort((a, b) =>
      compareIdentities(a.identity, b.identity),
    ),
  };
  if (data.projectDraft !== undefined) record["projectDraft"] = structuredClone(data.projectDraft);
  const derived = deriveRegistry(
    record["sources"] as CreativeSource[],
    record["derivatives"] as CreativeDerivative[],
  );
  if (input["blobs"] !== undefined)
    checkRegistry(
      readBlobMap(input["blobs"], "creative recovery input.blobs"),
      derived,
      "creative recovery input.blobs",
    );
  record["blobs"] = derived;
  readCreativeRecovery(structuredClone(record));
  return record;
}

/** Every blob hash the recovery references, in canonical order. */
export function creativeRecoveryBlobHashes(recovery: PortableCreativeRecovery): BlobHash[] {
  return Object.keys(recovery.blobs).sort(compareCodePoints);
}
