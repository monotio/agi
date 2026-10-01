/**
 * Bounded portable envelope for the kept project document set — the exact
 * authored representation a workspace holds: source text where it exists,
 * retained native bytes where no source exists, plus owner metadata
 * documents. Text stays exact (including malformed source and unpaired
 * UTF-16 surrogates); the codec never compiles, executes, installs a run or
 * compares claimed source against playable bytes. Draft versions, deletions,
 * operation groups, local identities, generations, timestamps and
 * credentials are deliberately absent — unfinished drafts keep their own
 * separate envelope (projectRecovery.ts).
 */
import { checkProjectDocumentKey } from "./projectDocumentKey.ts";

export const PROJECT_WORKSPACE_FORMAT = "monotio.agi.project-workspace";

/** Hard bounds applied before any output allocation in both directions. */
export const PROJECT_WORKSPACE_LIMITS = Object.freeze({
  maxDocuments: 1031,
  /** Per-document payload: text counts 2 bytes per UTF-16 code unit, bytes count 1. */
  maxDocumentBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

type WorkspaceDocumentContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "bytes"; readonly bytes: readonly number[] };

/** Plain JSON structure: sorted, frozen and detached from the inputs. */
export interface PortableProjectWorkspace {
  readonly format: typeof PROJECT_WORKSPACE_FORMAT;
  readonly version: 1 | 2;
  readonly documents: readonly {
    readonly key: string;
    readonly content: WorkspaceDocumentContent;
  }[];
}

const ENVELOPE_FIELDS = ["format", "version", "documents"] as const;
const DOCUMENT_FIELDS = ["key", "content"] as const;
const TEXT_FIELDS = ["type", "text"] as const;
const BYTES_FIELDS = ["type", "bytes"] as const;

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function invalid(message: string): never {
  throw new Error(`Invalid project workspace: ${message}`);
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

function checkPayload(key: string, size: number, total: { bytes: number }): void {
  if (size > PROJECT_WORKSPACE_LIMITS.maxDocumentBytes)
    invalid(`document '${key}' payload exceeds the per-document limit.`);
  total.bytes += size;
  if (total.bytes > PROJECT_WORKSPACE_LIMITS.maxTotalBytes)
    invalid("document payloads exceed the total workspace limit.");
}

/**
 * Serialize the kept document set. Keys, per-document payload bounds and the
 * total bound are all validated before any output bytes are copied; the
 * result is a frozen JSON-safe structure with documents sorted by key that
 * shares no mutable state with the input.
 */
export function writeProjectWorkspace(
  documents: Readonly<Record<string, string | Uint8Array>>,
): PortableProjectWorkspace {
  const record = plainObject(documents, "kept documents");
  const entries = Object.entries(record);
  if (entries.length > PROJECT_WORKSPACE_LIMITS.maxDocuments)
    invalid(`kept documents must list at most ${PROJECT_WORKSPACE_LIMITS.maxDocuments} documents.`);
  const parsed: { key: string; content: string | Uint8Array }[] = [];
  const total = { bytes: 0 };
  for (const [key, content] of entries) {
    checkProjectDocumentKey(key);
    if (typeof content === "string") {
      checkPayload(key, content.length * 2, total);
    } else if (content instanceof Uint8Array) {
      checkPayload(key, content.length, total);
    } else {
      invalid(`document '${key}' content must be text or bytes.`);
    }
    parsed.push({ key, content });
  }
  parsed.sort((a, b) => byKey(a.key, b.key));
  return Object.freeze({
    format: PROJECT_WORKSPACE_FORMAT,
    version: Object.hasOwn(record, "notes") ? 2 : 1,
    documents: Object.freeze(
      parsed.map(({ key, content }) =>
        Object.freeze({
          key,
          content:
            typeof content === "string"
              ? Object.freeze({ type: "text" as const, text: content })
              : Object.freeze({
                  type: "bytes" as const,
                  bytes: Object.freeze(Array.from(content)),
                }),
        }),
      ),
    ),
  });
}

/**
 * Validate a stored envelope into an owned, frozen document record in
 * canonical key order. Format and version are checked before any content is
 * traversed; every field set is exact and all payload bounds hold before the
 * detached copies are allocated. Byte arrays reject holes, floats and
 * out-of-range values rather than wrapping or coercing.
 */
export function readProjectWorkspace(
  value: unknown,
): Readonly<Record<string, string | Uint8Array>> {
  const envelope = plainObject(value, "envelope");
  if (envelope["format"] !== PROJECT_WORKSPACE_FORMAT)
    throw new Error(`Unsupported project workspace format: ${String(envelope["format"])}.`);
  if (![1, 2].includes(envelope["version"] as number))
    throw new Error(`Unsupported project workspace version: ${String(envelope["version"])}.`);
  const record = fields(envelope, "envelope", ENVELOPE_FIELDS);
  const documents = record["documents"];
  if (!Array.isArray(documents) || documents.length > PROJECT_WORKSPACE_LIMITS.maxDocuments)
    invalid(`envelope must list at most ${PROJECT_WORKSPACE_LIMITS.maxDocuments} documents.`);
  const parsed: { key: string; content: string | readonly number[] }[] = [];
  const seen = new Set<string>();
  const total = { bytes: 0 };
  for (const entry of documents) {
    const document = fields(entry, "document", DOCUMENT_FIELDS);
    const key = documentKey(document["key"]);
    if (key === "notes" && envelope["version"] !== 2) invalid("Notes need workspace version 2.");
    if (seen.has(key)) invalid(`duplicate document '${key}'.`);
    seen.add(key);
    const holder = plainObject(document["content"], `document '${key}' content`);
    const type = holder["type"];
    if (type === "text") {
      fields(holder, `document '${key}' content`, TEXT_FIELDS);
      const text = holder["text"];
      if (typeof text !== "string") invalid(`document '${key}' text content must be a string.`);
      checkPayload(key, text.length * 2, total);
      parsed.push({ key, content: text });
    } else if (type === "bytes") {
      fields(holder, `document '${key}' content`, BYTES_FIELDS);
      const bytes = holder["bytes"];
      if (!Array.isArray(bytes)) invalid(`document '${key}' bytes content must be a byte array.`);
      checkPayload(key, bytes.length, total);
      parsed.push({ key, content: bytes });
    } else {
      invalid(`document '${key}' has an unknown content type '${String(type)}'.`);
    }
  }
  const entries = parsed
    .sort((a, b) => byKey(a.key, b.key))
    .map(({ key, content }): readonly [string, string | Uint8Array] => {
      if (typeof content === "string") return [key, content];
      const bytes = new Uint8Array(content.length);
      for (let index = 0; index < content.length; index++) {
        const byte = content[index];
        if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)
          invalid(`document '${key}' byte payload holds a non-byte value.`);
        bytes[index] = byte;
      }
      return [key, bytes];
    });
  return Object.freeze(Object.fromEntries(entries));
}
