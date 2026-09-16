/**
 * One identity record for a library entry.
 *
 * `GameIdentity = { project, revision }` is the single shape every stored
 * record — save, history recording, walkthrough artifact, game test, export —
 * carries. `ProjectId` names one library entry: an imported game, a created
 * adventure, a copy, a remix. Renaming the entry's title does not change it;
 * a remix stores its parent's identity in the same record type.
 * `ResourceRevision` is the digest of the canonical playable bytes — the
 * sorted-name SHA-256 bundle scheme in app/src/gameMetadata.ts. The same
 * bytes give the same value, including after a no-op patch or an undo;
 * notes, references, tests, history and archive timestamps never move it.
 *
 * Both are branded: a bare string cannot be assigned where an identity is
 * expected, and the validated constructors are the only way a serialized
 * value becomes one. Sierra title recognition (a WORDS.TOK fingerprint) is a
 * function over the files that returns a catalog entry or nothing — it is
 * never stored as identity. Aliases resolve at the two edges only: the
 * test/CLI argument parser and the hosted catalog route. Edit-conflict
 * tokens (patchGeneration, draft base revisions) are not identity.
 */

declare const PROJECT_ID_TAG: unique symbol;
declare const RESOURCE_REVISION_TAG: unique symbol;

/** One library entry's stable identifier. */
export type ProjectId = string & { readonly [PROJECT_ID_TAG]: true };
/** Sorted-name SHA-256 of the canonical playable file set. */
export type ResourceRevision = string & { readonly [RESOURCE_REVISION_TAG]: true };

/** The one record: which entry, at which playable-bytes revision. */
export interface GameIdentity {
  readonly project: ProjectId;
  readonly revision: ResourceRevision;
}

/**
 * Project ids are storage keys (localStorage prefixes, IDB key paths): a
 * bounded printable slug. `custom`, `remix-<uuid>` and `<slug>-<suffix>`
 * are the shapes the app already mints; catalog and installed entries use
 * their catalog id or folder name.
 */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESOURCE_REVISION_PATTERN = /^[0-9a-f]{64}$/;

/** Validate a serialized project id; null when the value cannot be one. */
export function projectId(value: unknown): ProjectId | null {
  return typeof value === "string" && PROJECT_ID_PATTERN.test(value) ? (value as ProjectId) : null;
}

/** Validate a serialized project id; throws naming the bad value. */
export function requireProjectId(value: unknown): ProjectId {
  const id = projectId(value);
  if (id === null) throw new Error(`Invalid project id: ${String(value)}`);
  return id;
}

/** Validate a serialized resource revision; null when the value cannot be one. */
export function resourceRevision(value: unknown): ResourceRevision | null {
  return typeof value === "string" && RESOURCE_REVISION_PATTERN.test(value)
    ? (value as ResourceRevision)
    : null;
}

/** Validate a serialized resource revision; throws naming the bad value. */
export function requireResourceRevision(value: unknown): ResourceRevision {
  const revision = resourceRevision(value);
  if (revision === null) throw new Error(`Invalid resource revision: ${String(value)}`);
  return revision;
}

/** Validate a serialized `{ project, revision }` record. */
export function gameIdentity(value: unknown): GameIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const project = projectId(record["project"]);
  const revision = resourceRevision(record["revision"]);
  return project === null || revision === null ? null : { project, revision };
}

/** Validate a serialized identity record; throws naming the bad value. */
export function requireGameIdentity(value: unknown): GameIdentity {
  const identity = gameIdentity(value);
  if (identity === null) throw new Error(`Invalid game identity: ${JSON.stringify(value)}`);
  return identity;
}

/** The plain serialized shape of a GameIdentity. */
export function serializeGameIdentity(identity: GameIdentity): {
  project: string;
  revision: string;
} {
  return { project: identity.project, revision: identity.revision };
}

/** Compile-time pin: a bare string must never satisfy either brand. */
type AssertFalse<T extends false> = T;
type _BareStringIsNotAProjectId = AssertFalse<string extends ProjectId ? true : false>;
type _BareStringIsNotARevision = AssertFalse<string extends ResourceRevision ? true : false>;
