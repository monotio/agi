/**
 * Bounded portable envelope for unfinished ProjectDraft recovery state.
 * Persisted drafts are incomplete by definition: text stays exact (including
 * malformed source and unpaired UTF-16 surrogates), deletions and native bytes
 * are kept, and nothing here compiles or executes document content. The
 * envelope records the canonical connected operation partition from
 * ProjectDraft.captureRecovery, not an operation log. The base triple
 * (resource revision, kept editable-content digest, interpreter profile)
 * decides staleness; a mismatch refuses restoration instead of rebasing.
 */
import { checkProjectDocumentKey, ProjectDraft, type DraftRecovery } from "./projectDraft.ts";
import { requireResourceRevision, type ResourceRevision } from "../gameIdentity.ts";
import { PROFILES, type ProfileId } from "../runtime/profile.ts";

export const PROJECT_RECOVERY_FORMAT = "monotio.agi.recovery-draft";

/** Hard bounds applied before any output allocation in both directions. */
export const PROJECT_RECOVERY_LIMITS = Object.freeze({
  maxDocuments: 1030,
  maxOperations: 515,
  maxOperationMembers: 1030,
  /** Per-document payload: text counts 2 bytes per UTF-16 code unit, bytes count 1. */
  maxDocumentBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

/**
 * The identity a stored draft was captured against. Local workspace
 * generation/lifetime guards, project ids, timestamps and credentials are
 * deliberately absent; they belong to a separate sidecar record.
 */
export interface RecoveryBase {
  readonly revision: ResourceRevision;
  /** 64 lowercase hex digits: SHA-256 of the kept editable content. */
  readonly authoring: string;
  readonly profileId: ProfileId;
}

export type RecoveryDocumentContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "bytes"; readonly bytes: readonly number[] }
  | { readonly type: "deleted" };

/** Plain JSON structure: sorted, frozen and detached from the inputs. */
export interface PortableProjectRecovery {
  readonly format: typeof PROJECT_RECOVERY_FORMAT;
  readonly version: 1;
  readonly base: RecoveryBase;
  readonly documents: readonly {
    readonly key: string;
    readonly version: number;
    readonly content: RecoveryDocumentContent;
  }[];
  readonly operations: readonly { readonly keys: readonly string[] }[];
}

const AUTHORING_DIGEST = /^[0-9a-f]{64}$/;
const BASE_FIELDS = ["revision", "authoring", "profileId"] as const;
const DOCUMENT_FIELDS = ["key", "version", "content"] as const;
const ENVELOPE_FIELDS = ["format", "version", "base", "documents", "operations"] as const;

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function invalid(message: string): never {
  throw new Error(`Invalid project recovery: ${message}`);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    invalid(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

function fields(value: unknown, label: string, names: readonly string[]): Record<string, unknown> {
  const record = plainObject(value, label);
  if (
    Object.keys(record).length !== names.length ||
    names.some((name) => !Object.hasOwn(record, name))
  )
    invalid(`${label} must have exactly the fields ${names.join(", ")}.`);
  return record;
}

function documentKey(value: unknown): string {
  if (typeof value !== "string") invalid("document keys must be strings.");
  checkProjectDocumentKey(value);
  return value;
}

function readBase(value: unknown): RecoveryBase {
  const record = fields(value, "base", BASE_FIELDS);
  const authoring = record["authoring"];
  if (typeof authoring !== "string" || !AUTHORING_DIGEST.test(authoring))
    invalid("base authoring must be a 64-digit lowercase SHA-256 hex digest.");
  const profile = record["profileId"];
  if (typeof profile !== "string" || !Object.hasOwn(PROFILES, profile))
    invalid(`base profileId is not a known profile: ${String(profile)}.`);
  return Object.freeze({
    revision: requireResourceRevision(record["revision"]),
    authoring,
    profileId: profile as ProfileId,
  });
}

function checkPayload(key: string, size: number, total: { bytes: number }): void {
  if (size > PROJECT_RECOVERY_LIMITS.maxDocumentBytes)
    invalid(`document '${key}' payload exceeds the per-document limit.`);
  total.bytes += size;
  if (total.bytes > PROJECT_RECOVERY_LIMITS.maxTotalBytes)
    invalid("document payloads exceed the total recovery limit.");
}

interface ParsedChange {
  readonly key: string;
  readonly version: number;
  readonly content: string | readonly number[] | Uint8Array | null;
}

function readVersion(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    invalid(`document '${key}' must have a safe integer version of at least 1.`);
  return value;
}

/**
 * Group members are the canonical connected partition produced by
 * captureRecovery: each operation needs two or more distinct document keys and
 * a key may appear in one operation only. Members may name unchanged or
 * absent documents, which keeps earlier coupled operations whole.
 */
function memberPartition(
  list: unknown,
  label: string,
  keysOf: (entry: unknown) => unknown,
): string[][] {
  if (!Array.isArray(list) || list.length > PROJECT_RECOVERY_LIMITS.maxOperations)
    invalid(`${label} must list at most ${PROJECT_RECOVERY_LIMITS.maxOperations} operations.`);
  const memberKeys = new Set<string>();
  const total = { count: 0 };
  const groups: string[][] = [];
  for (const entry of list) {
    const keys = keysOf(entry);
    if (!Array.isArray(keys)) invalid("operation keys must be an array.");
    if (keys.length < 2) invalid("an operation needs at least two member keys.");
    total.count += keys.length;
    if (total.count > PROJECT_RECOVERY_LIMITS.maxOperationMembers)
      invalid(
        `operations exceed the member limit of ${PROJECT_RECOVERY_LIMITS.maxOperationMembers}.`,
      );
    const members: string[] = [];
    for (const item of keys) {
      const key = documentKey(item);
      if (members.includes(key)) invalid(`operation repeats member '${key}'.`);
      if (memberKeys.has(key)) invalid(`'${key}' appears in more than one operation.`);
      memberKeys.add(key);
      members.push(key);
    }
    groups.push(members.sort(byKey));
  }
  return groups.sort((a, b) => byKey(a[0]!, b[0]!));
}

/**
 * Serialize one workspace's captured draft state. Validates keys, versions,
 * the operation partition and every payload bound before copying; the output
 * is a frozen JSON-safe structure that shares no mutable state with the input.
 */
export function writeProjectRecovery(
  base: RecoveryBase,
  recovery: DraftRecovery,
): PortableProjectRecovery {
  const checkedBase = readBase(base);
  const source = fields(recovery, "draft recovery", ["changes", "groups"]);
  const changes = source["changes"];
  const groups = source["groups"];
  if (!Array.isArray(changes) || changes.length > PROJECT_RECOVERY_LIMITS.maxDocuments)
    invalid(
      `draft recovery must list at most ${PROJECT_RECOVERY_LIMITS.maxDocuments} changed documents.`,
    );
  const parsed: ParsedChange[] = [];
  const seen = new Set<string>();
  const total = { bytes: 0 };
  for (const entry of changes) {
    const record = fields(entry, "changed document", DOCUMENT_FIELDS);
    const key = documentKey(record["key"]);
    if (seen.has(key)) invalid(`duplicate changed document '${key}'.`);
    seen.add(key);
    const version = readVersion(key, record["version"]);
    const content = record["content"];
    if (typeof content === "string") {
      checkPayload(key, content.length * 2, total);
      parsed.push({ key, version, content });
    } else if (content instanceof Uint8Array) {
      checkPayload(key, content.length, total);
      parsed.push({ key, version, content });
    } else if (content === null) {
      parsed.push({ key, version, content });
    } else {
      invalid(`changed document '${key}' content must be text, bytes or a deletion.`);
    }
  }
  const operations = memberPartition(groups, "draft recovery", (entry) => entry);
  parsed.sort((a, b) => byKey(a.key, b.key));
  return Object.freeze({
    format: PROJECT_RECOVERY_FORMAT,
    version: 1,
    base: checkedBase,
    documents: Object.freeze(
      parsed.map(({ key, version, content }) =>
        Object.freeze({
          key,
          version,
          content:
            typeof content === "string"
              ? Object.freeze({ type: "text" as const, text: content })
              : content === null
                ? Object.freeze({ type: "deleted" as const })
                : Object.freeze({
                    type: "bytes" as const,
                    bytes: Object.freeze(Array.from(content)),
                  }),
        }),
      ),
    ),
    operations: Object.freeze(
      operations.map((keys) => Object.freeze({ keys: Object.freeze(keys) })),
    ),
  });
}

/**
 * Validate a stored envelope. Format and version are checked before any
 * content is traversed; every field set is exact and all payload bounds hold
 * before the detached copies are allocated. Byte arrays reject holes, floats
 * and out-of-range values rather than wrapping or coercing.
 */
export function readProjectRecovery(value: unknown): {
  base: RecoveryBase;
  recovery: DraftRecovery;
} {
  const envelope = plainObject(value, "envelope");
  if (envelope["format"] !== PROJECT_RECOVERY_FORMAT)
    throw new Error(`Unsupported project recovery format: ${String(envelope["format"])}.`);
  if (envelope["version"] !== 1)
    throw new Error(`Unsupported project recovery version: ${String(envelope["version"])}.`);
  const record = fields(envelope, "envelope", ENVELOPE_FIELDS);
  const base = readBase(record["base"]);
  const documents = record["documents"];
  if (!Array.isArray(documents) || documents.length > PROJECT_RECOVERY_LIMITS.maxDocuments)
    invalid(`envelope must list at most ${PROJECT_RECOVERY_LIMITS.maxDocuments} documents.`);
  const parsed: ParsedChange[] = [];
  const seen = new Set<string>();
  const total = { bytes: 0 };
  for (const entry of documents) {
    const document = fields(entry, "document", DOCUMENT_FIELDS);
    const key = documentKey(document["key"]);
    if (seen.has(key)) invalid(`duplicate document '${key}'.`);
    seen.add(key);
    const version = readVersion(key, document["version"]);
    const holder = plainObject(document["content"], `document '${key}' content`);
    const type = holder["type"];
    if (type === "text") {
      fields(holder, `document '${key}' content`, ["type", "text"]);
      const text = holder["text"];
      if (typeof text !== "string") invalid(`document '${key}' text content must be a string.`);
      checkPayload(key, text.length * 2, total);
      parsed.push({ key, version, content: text });
    } else if (type === "bytes") {
      fields(holder, `document '${key}' content`, ["type", "bytes"]);
      const bytes = holder["bytes"];
      if (!Array.isArray(bytes)) invalid(`document '${key}' bytes content must be a byte array.`);
      checkPayload(key, bytes.length, total);
      parsed.push({ key, version, content: bytes });
    } else if (type === "deleted") {
      fields(holder, `document '${key}' content`, ["type"]);
      parsed.push({ key, version, content: null });
    } else {
      invalid(`document '${key}' has an unknown content type '${String(type)}'.`);
    }
  }
  const operations = memberPartition(
    record["operations"],
    "envelope",
    (entry) => fields(entry, "operation", ["keys"])["keys"],
  );
  const changes = parsed.map(({ key, version, content }) => {
    if (typeof content === "string" || content === null)
      return Object.freeze({ key, version, content });
    const bytes = new Uint8Array(content.length);
    for (let index = 0; index < content.length; index++) {
      const byte = content[index];
      if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)
        invalid(`document '${key}' byte payload holds a non-byte value.`);
      bytes[index] = byte;
    }
    return Object.freeze({ key, version, content: bytes });
  });
  return {
    base,
    recovery: Object.freeze({
      changes: Object.freeze(changes),
      groups: Object.freeze(operations.map((keys) => Object.freeze(keys))),
    }),
  };
}

/**
 * Restore a stored draft after the user chose Restore. The envelope is fully
 * validated and all three saved base identities are compared exactly against
 * the current base before any workspace is constructed; a mismatch is stale
 * recovery, never a silent rebase. The new workspace owns a fresh lifetime:
 * proposals, selections and undo handles from the old workspace carry no
 * authority into it.
 */
export function restoreProjectRecovery(input: {
  readonly documents: Readonly<Record<string, string | Uint8Array>>;
  readonly base: RecoveryBase;
  readonly recovery: unknown;
}): ProjectDraft {
  const request = fields(input, "restore request", ["documents", "base", "recovery"]);
  const { base: saved, recovery } = readProjectRecovery(request["recovery"]);
  const current = readBase(request["base"]);
  const stale = BASE_FIELDS.filter((name) => saved[name] !== current[name]);
  if (stale.length > 0)
    throw new Error(
      `Stale project recovery: saved base ${stale.join(", ")} does not match the current project.`,
    );
  const documents = plainObject(request["documents"], "kept documents");
  return ProjectDraft.recover(documents as Readonly<Record<string, string | Uint8Array>>, recovery);
}
