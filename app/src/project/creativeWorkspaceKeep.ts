/**
 * Workspace-owned creative publication for an editable Keep.
 *
 * EditableProject.prepareCreativeKeep delegates here: the caller's declared
 * intent — the staging lease the Keep consumes, the complete kept record
 * set it results in, the native destinations its staged recipes prepared,
 * and the kept records it drops — is captured and detached before the first
 * await, then checked once against a single catalog read and the issued
 * candidate's own frozen image. The returned handle is opaque: ownership
 * lives in this module's WeakMap, bound to that exact candidate, so
 * supplied metadata stays review evidence and never authority.
 *
 * Keep resolves the handle back to its sanitized CreativeKeepRequest on the
 * candidate's single ProjectCommitRequest; commitProject re-runs the lease,
 * head, kept-set, blob and removal checks inside the commit transaction and
 * remains the validator of last resort. Nothing in this module writes — a
 * refused or failed publication leaves the staged lease, pending source
 * work and the previous kept catalog untouched.
 */
import { openContainer } from "../../../src/container/container.ts";
import {
  planCreativeKeep,
  readCreativeKeepRequest,
  readVersionRef,
  versionRefKey,
  type CreativeBoardEntry,
  type CreativeCatalog,
  type CreativeKeepRequest,
  type VersionRef,
} from "../../../src/creative/catalog.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import type { ProjectId } from "../../../src/gameIdentity.ts";
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";
import { loadCreativeCatalog } from "./creativeStore.ts";
import type { EditableCandidate } from "./editableProject.ts";

/**
 * The caller's declared creative publication intent. Every field is review
 * evidence only: the lease claim must match the stored lease, the kept set
 * must resolve to kept or lease-staged records, and `destinations` must
 * name exactly the native resources this Keep's staged recipes prepared.
 */
export interface CreativeKeepPreparation {
  /** The live staging lease this Keep consumes; workspace is bound by the service. */
  readonly lease: { readonly id: string; readonly owner: string };
  /** The complete resulting kept set, by identity — not a patch. */
  readonly keep: {
    readonly sources?: readonly VersionRef[];
    readonly derivatives?: readonly VersionRef[];
    readonly recipes?: readonly VersionRef[];
    /** Board entries arrive whole: they are the resulting board. */
    readonly board?: readonly CreativeBoardEntry[];
  };
  /**
   * The native destinations this Keep's staged recipes claim to prepare —
   * every staged recipe destination exactly once, nothing else. Payload
   * recipes (view, picture-conversion) additionally require the destination
   * in the candidate's selected documents; a picture-underlay guides
   * drawing only and never authorizes native plane changes.
   */
  readonly destinations?: readonly {
    readonly kind: "picture" | "view";
    readonly resourceId: number;
  }[];
  /** Kept records this publication drops, reviewed exactly by identity. */
  readonly reviewedCreativeRemovals?: readonly VersionRef[];
}

/**
 * An owned creative publication prepared against one issued candidate. The
 * object itself is the authority: only this exact instance, supplied back to
 * its own candidate's Keep, resolves to a request — a rebuilt lookalike
 * carries none.
 */
export interface EditableCreativeKeep {
  /** The staging lease this Keep consumes. */
  readonly lease: { readonly id: string; readonly owner: string };
  /** The frozen catalog head the publication was prepared against. */
  readonly expectedHead: number;
  /** The intended kept record set, frozen at preparation. */
  readonly keep: {
    readonly sources: readonly VersionRef[];
    readonly derivatives: readonly VersionRef[];
    readonly recipes: readonly VersionRef[];
    readonly board: readonly CreativeBoardEntry[];
  };
}

/**
 * The candidate facts a preparation is bound to, supplied by the issuing
 * workspace. `files` is the candidate's own compiled image, so destination
 * checks read exactly what Keep would publish — never a live draft.
 */
export interface WorkspaceCreativeContext {
  readonly projectId: ProjectId;
  readonly workspaceId: string;
  readonly profileId: ProfileId;
  /** The candidate's exact selected document closure. */
  readonly selectionKeys: readonly string[];
  /** The kept native resources this candidate removes. */
  readonly removedResources: readonly string[];
  /** The candidate's compiled file image. */
  readonly files: Readonly<Record<string, Uint8Array>>;
}

interface BoundKeep {
  readonly candidate: EditableCandidate;
  readonly request: CreativeKeepRequest;
}

/** Issued handles to their sealed intent. Keyed by identity: never forged. */
const issued = new WeakMap<EditableCreativeKeep, BoundKeep>();

function destinationKey(kind: "picture" | "view", resourceId: number): string {
  return `${kind}:${resourceId}`;
}

function readDestinations(
  value: unknown,
): readonly { readonly kind: "picture" | "view"; readonly resourceId: number }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error("Creative preparation 'destinations' must be an array.");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const label = `destinations[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new Error(`Creative preparation ${label} must be a destination record.`);
    const raw = entry as Record<string, unknown>;
    const kind = raw["kind"];
    const resourceId = raw["resourceId"];
    if (kind !== "picture" && kind !== "view")
      throw new Error(`Creative preparation ${label}.kind must be 'picture' or 'view'.`);
    if (!Number.isInteger(resourceId) || (resourceId as number) < 0 || (resourceId as number) > 255)
      throw new Error(`Creative preparation ${label}.resourceId must be an integer 0..255.`);
    const key = destinationKey(kind, resourceId as number);
    if (seen.has(key)) throw new Error(`Creative preparation names destination ${key} twice.`);
    seen.add(key);
    return { kind, resourceId: resourceId as number };
  });
}

/**
 * The kept records a publication drops must be reviewed by identity, the
 * same contract native removals follow: the list names exactly the records
 * leaving the kept set — recipes dropping a destination use, sources and
 * board entries being released — and cannot widen what the request drops.
 */
function checkDroppedReview(
  request: CreativeKeepRequest,
  catalog: CreativeCatalog,
  reviewed: unknown,
): void {
  const keptRefs = [
    ...catalog.sources,
    ...catalog.derivatives,
    ...catalog.recipes,
    ...catalog.board,
  ].map((record) => versionRefKey(record.identity));
  const resulting = new Set(
    [
      ...request.keep.sources,
      ...request.keep.derivatives,
      ...request.keep.recipes,
      ...request.keep.board.map((entry) => entry.identity),
    ].map(versionRefKey),
  );
  const dropped = new Set(keptRefs.filter((key) => !resulting.has(key)));
  if (reviewed !== undefined && !Array.isArray(reviewed))
    throw new Error("Creative preparation 'reviewedCreativeRemovals' must be an array.");
  const reviewedKeys = new Set(
    (reviewed ?? []).map((ref, index) =>
      versionRefKey(readVersionRef(ref, `reviewedCreativeRemovals[${index}]`)),
    ),
  );
  const unreviewed = [...dropped].filter((key) => !reviewedKeys.has(key));
  if (unreviewed.length > 0)
    throw new Error(
      `This creative publication drops kept records ${unreviewed.join(", ")}; ` +
        "dropping requires review: pass the exact identities in 'reviewedCreativeRemovals'.",
    );
  const foreign = [...reviewedKeys].filter((key) => !dropped.has(key));
  if (foreign.length > 0)
    throw new Error(
      `Creative review names ${foreign.join(", ")}, which this publication does not drop.`,
    );
}

/**
 * Capture and check a creative publication against the candidate's frozen
 * context. The returned handle binds exactly this candidate; the catalog
 * head and lease are frozen into the request so a moved base refuses at the
 * commit transaction instead of rebasing.
 */
export async function prepareWorkspaceCreativeKeep(
  context: WorkspaceCreativeContext,
  candidate: EditableCandidate,
  preparation: CreativeKeepPreparation,
): Promise<EditableCreativeKeep> {
  // Capture and detach before the first await: the offered intent and its
  // arrays are cloned now, so caller mutation or reentrancy during the
  // catalog read cannot change what is admitted.
  const captured = structuredClone(preparation) as CreativeKeepPreparation;
  const destinations = readDestinations(captured.destinations);
  const leaseClaim = captured.lease;
  if (
    typeof leaseClaim !== "object" ||
    leaseClaim === null ||
    typeof leaseClaim.id !== "string" ||
    typeof leaseClaim.owner !== "string"
  )
    throw new Error("Creative preparation 'lease' must name the staging lease id and owner.");
  const keepClaim = captured.keep;
  if (typeof keepClaim !== "object" || keepClaim === null || Array.isArray(keepClaim))
    throw new Error("Creative preparation 'keep' must list the resulting kept record set.");

  const { catalog } = await loadCreativeCatalog(context.projectId);
  if (catalog === null) throw new Error("This project has no staged creative work to keep.");

  const request = readCreativeKeepRequest({
    expectedHead: catalog.head,
    asOf: Date.now(),
    lease: {
      id: leaseClaim.id,
      owner: leaseClaim.owner,
      workspace: context.workspaceId,
    },
    keep: {
      sources: keepClaim.sources ?? [],
      derivatives: keepClaim.derivatives ?? [],
      recipes: keepClaim.recipes ?? [],
      board: keepClaim.board ?? [],
    },
  });
  // One plan against the catalog just read: lease liveness and ownership,
  // kept-set resolution, internal consistency, budgets and staged blob
  // descriptors all refuse here with their named errors before admission.
  const plan = planCreativeKeep(request, catalog, Date.now());
  checkDroppedReview(request, catalog, captured.reviewedCreativeRemovals);

  const lease = catalog.leases.find((entry) => entry.id === request.lease.id)!;
  const stagedRecipeKeys = new Set(
    lease.staged.recipes.map((recipe) => versionRefKey(recipe.identity)),
  );
  const declared = new Map(
    destinations.map((entry) => [destinationKey(entry.kind, entry.resourceId), entry]),
  );
  const selected = new Set(context.selectionKeys);
  const removed = new Set(context.removedResources);
  const profile = PROFILES[context.profileId];
  if (!profile) throw new Error(`Unknown build profile: ${context.profileId}`);
  const container = openContainer(new Map(Object.entries(context.files)), { profile });
  const claimed = new Set<string>();
  for (const recipe of plan.recipes) {
    const ref = versionRefKey(recipe.identity);
    const destination = recipe.destination;
    const key = destinationKey(destination.kind, destination.resourceId);
    let payload: Uint8Array | null;
    try {
      payload = container.getResource(destination.kind, destination.resourceId);
    } catch (error) {
      throw new Error(
        `Kept creative recipe '${ref}' destination ${key} cannot be verified: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (payload === null)
      throw new Error(
        `Kept creative recipe '${ref}' prepares destination ${key}, which ${
          removed.has(key) ? "is removed by this candidate" : "does not exist in this candidate"
        }; drop the recipe in 'reviewedCreativeRemovals' to remove the resource.`,
      );
    if (!stagedRecipeKeys.has(ref)) continue;
    if (!declared.has(key))
      throw new Error(
        `Staged creative recipe '${ref}' prepares ${key}, which 'destinations' does not declare.`,
      );
    claimed.add(key);
    if (recipe.preparation.kind === "picture-underlay") continue;
    if (!selected.has(key))
      throw new Error(
        `Staged creative recipe '${ref}' produces the native payload for ${key}; ` +
          "this candidate's selected documents must contain the prepared resource.",
      );
    if (recipe.outputPayloadHash !== undefined && sha256Hex(payload) !== recipe.outputPayloadHash)
      throw new Error(
        `This candidate's ${key} does not match the prepared result recipe '${ref}' reviewed.`,
      );
  }
  for (const key of declared.keys()) {
    if (!claimed.has(key))
      throw new Error(
        `Creative preparation declares destination ${key}, which no staged recipe prepares.`,
      );
  }

  const keep: EditableCreativeKeep = Object.freeze({
    lease: Object.freeze({ id: request.lease.id, owner: request.lease.owner }),
    expectedHead: request.expectedHead,
    keep: Object.freeze({
      sources: Object.freeze([...request.keep.sources]),
      derivatives: Object.freeze([...request.keep.derivatives]),
      recipes: Object.freeze([...request.keep.recipes]),
      board: Object.freeze([...request.keep.board]),
    }),
  });
  // The stored request is detached from the handle's exposed record lists:
  // mutating them cannot touch the sealed intent.
  issued.set(keep, { candidate, request: structuredClone(request) });
  return keep;
}

/**
 * Resolve a prepared publication back to a request for exactly its own
 * candidate. Anything else — a foreign workspace's candidate, a rebuilt
 * lookalike, a plain object carrying the same fields — refuses. The result
 * is a detached copy: mutating it never reaches the candidate's sealed
 * intent, its retry hash or the request commitProject eventually writes.
 */
export function resolveWorkspaceCreativeKeep(
  candidate: EditableCandidate,
  keep: EditableCreativeKeep,
): CreativeKeepRequest {
  const bound = issued.get(keep);
  if (bound === undefined)
    throw new Error("This creative publication was not prepared by a workspace candidate.");
  if (bound.candidate !== candidate)
    throw new Error("This creative publication was prepared for another candidate.");
  return structuredClone(bound.request);
}
