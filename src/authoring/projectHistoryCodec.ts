/** Bounded, hash-verified History data. Decoding confers no model authority. */
import { checkProjectDocumentKey } from "./projectDocumentKey.ts";
import { projectContentHash, type ProjectContent, type ProjectDigest } from "./projectContent.ts";
import {
  changedProjectManifest,
  projectCommitId,
  PROJECT_HISTORY_ORIGINS,
  type ProjectHistoryCommit,
  type ProjectHistoryState,
  type ProjectEditOrigin,
} from "./projectHistoryData.ts";

export const PROJECT_HISTORY_FORMAT = "monotio.agi.project-history";
export const PROJECT_HISTORY_LIMITS = Object.freeze({
  maxCommits: 1024,
  maxBlobs: 16384,
  maxDocuments: 1031,
  maxManifestEntries: 128 * 1024,
  maxBlobBytes: 8 * 1024 * 1024,
  maxImageBlobBytes: 64 * 1024 * 1024,
  maxImageTotalBytes: 128 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxTags: 1024,
  maxLabelLength: 1024,
  maxTagLength: 256,
});
type PortableBlob =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "bytes"; readonly bytes: readonly number[] };
export interface PortableProjectHistory {
  readonly format: typeof PROJECT_HISTORY_FORMAT;
  readonly version: 1 | 2;
  readonly prunedParents?: readonly string[];
  readonly blobs: Readonly<Record<string, PortableBlob>>;
  readonly commits: readonly ProjectHistoryCommit[];
  readonly cursor: string | null;
  readonly future: readonly string[];
  readonly tags: Readonly<Record<string, string>>;
}

function invalid(message: string): never {
  throw new Error(`Invalid project history: ${message}`);
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid("expected a plain object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid("expected a plain object.");
  return value as Record<string, unknown>;
}
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  const parsed = record(value);
  if (
    Object.keys(parsed).length !== names.length ||
    names.some((name) => !Object.hasOwn(parsed, name))
  )
    invalid(`expected fields ${names.join(", ")}.`);
  return parsed;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    invalid("expected a SHA-256 hash.");
  return value;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit)
    invalid("text exceeds its limit or is malformed.");
  return value;
}

function compareTagNames(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0)!);
  const right = Array.from(b, (char) => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  return left.length - right.length;
}

export function readProjectHistory(value: unknown, digest: ProjectDigest): ProjectHistoryState {
  const envelope = record(value);
  if (envelope["format"] !== PROJECT_HISTORY_FORMAT)
    throw new Error("Unsupported project history format.");
  if (envelope["version"] !== 1 && envelope["version"] !== 2)
    throw new Error(`Unsupported project history version: ${String(envelope["version"])}.`);
  fields(envelope, [
    "format",
    "version",
    "blobs",
    "commits",
    "cursor",
    "future",
    "tags",
    ...(Object.hasOwn(envelope, "prunedParents") ? ["prunedParents"] : []),
  ]);
  const boundaries = envelope["prunedParents"] ?? [];
  if (!Array.isArray(boundaries) || boundaries.length > PROJECT_HISTORY_LIMITS.maxCommits)
    invalid("pruned parent count exceeds the limit.");
  const prunedParents = new Set(boundaries.map(hash));
  if (prunedParents.size !== boundaries.length) invalid("duplicate pruned parent.");
  const usedParents = new Set<string>();
  const storedBlobs = record(envelope["blobs"]);
  if (Object.keys(storedBlobs).length > PROJECT_HISTORY_LIMITS.maxBlobs)
    invalid("blob count exceeds the limit.");
  let total = 0;
  // Bound every payload before allocating any owned byte payload.
  const checked: { key: string; content: string | readonly number[] }[] = [];
  for (const [key, value] of Object.entries(storedBlobs)) {
    hash(key);
    const blob = record(value);
    let content: string | readonly number[];
    if (blob["type"] === "text") {
      fields(blob, ["type", "text"]);
      content = text(blob["text"], PROJECT_HISTORY_LIMITS.maxBlobBytes / 2);
    } else if (blob["type"] === "bytes") {
      fields(blob, ["type", "bytes"]);
      const bytes = blob["bytes"];
      if (
        !Array.isArray(bytes) ||
        bytes.length >
          (envelope["version"] === 2
            ? PROJECT_HISTORY_LIMITS.maxImageBlobBytes
            : PROJECT_HISTORY_LIMITS.maxBlobBytes)
      )
        invalid("byte payload exceeds the limit.");
      content = bytes;
    } else invalid("unknown blob type.");
    total += typeof content === "string" ? content.length * 2 : content.length;
    if (
      total >
      (envelope["version"] === 2
        ? PROJECT_HISTORY_LIMITS.maxImageTotalBytes
        : PROJECT_HISTORY_LIMITS.maxTotalBytes)
    )
      invalid("blob payloads exceed the total limit.");
    checked.push({ key, content });
  }
  const blobs: Record<string, ProjectContent> = Object.create(null);
  for (const { key, content } of checked) {
    let owned: ProjectContent;
    if (typeof content === "string") owned = content;
    else {
      for (let i = 0; i < content.length; i++) {
        const byte = content[i];
        if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)
          invalid("blob contains a non-byte value.");
      }
      owned = Uint8Array.from(content);
    }
    if (projectContentHash(owned, digest) !== key) invalid("blob hash differs from its content.");
    blobs[key] = owned;
  }
  const storedCommits = envelope["commits"];
  if (!Array.isArray(storedCommits) || storedCommits.length > PROJECT_HISTORY_LIMITS.maxCommits)
    invalid("commit count exceeds the limit.");
  const commits: ProjectHistoryCommit[] = [];
  const byId: Record<string, ProjectHistoryCommit> = Object.create(null);
  let entries = 0;
  for (const value of storedCommits) {
    const stored = fields(value, [
      "id",
      "parent",
      "documents",
      "changed",
      "label",
      "origin",
      "author",
      "time",
    ]);
    const id = hash(stored["id"]);
    if (Object.hasOwn(byId, id)) invalid("duplicate commit identity.");
    const parent = stored["parent"] === null ? null : hash(stored["parent"]);
    const boundary = parent !== null && prunedParents.has(parent);
    if (parent !== null && !Object.hasOwn(byId, parent) && !boundary)
      invalid("parent must precede its child.");
    if (boundary) usedParents.add(parent);
    if (parent === null && commits.length > 0) invalid("History must have one root commit.");
    const manifest = record(stored["documents"]);
    const keys = Object.keys(manifest).sort();
    entries += keys.length;
    if (
      keys.length > PROJECT_HISTORY_LIMITS.maxDocuments ||
      entries > PROJECT_HISTORY_LIMITS.maxManifestEntries
    )
      invalid("manifest exceeds the limit.");
    const documents = Object.freeze(
      Object.fromEntries(
        keys.map((key) => {
          checkProjectDocumentKey(key);
          if (envelope["version"] === 1 && (key === "images" || key.startsWith("attachment:")))
            invalid("image attachments require History version 2.");
          const value = manifest[key];
          const blob = value === null ? null : hash(value);
          if (blob !== null && !Object.hasOwn(blobs, blob))
            invalid("manifest names a missing blob.");
          return [key, blob];
        }),
      ),
    );
    const parentDocuments = parent === null || boundary ? {} : byId[parent]!.documents;
    const changed = stored["changed"];
    const expected =
      boundary && Array.isArray(changed)
        ? [
            ...new Set(
              changed.map((key: unknown) => {
                if (typeof key !== "string") invalid("changed key must be text.");
                checkProjectDocumentKey(key);
                return key;
              }),
            ),
          ].sort()
        : changedProjectManifest(parentDocuments, documents);
    if (
      !Array.isArray(changed) ||
      changed.length !== expected.length ||
      expected.some((key, i) => changed[i] !== key)
    )
      invalid("changed keys differ from the parent diff.");
    const label = text(stored["label"], PROJECT_HISTORY_LIMITS.maxLabelLength);
    const origin = stored["origin"];
    if (!(PROJECT_HISTORY_ORIGINS as readonly unknown[]).includes(origin))
      invalid("unknown edit origin.");
    const author = stored["author"];
    if (author !== "creator" && author !== "agent") invalid("unknown author.");
    const time = stored["time"];
    if (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0)
      invalid("time must be a nonnegative integer.");
    const commit = Object.freeze({
      id,
      parent,
      documents,
      changed: expected,
      label,
      origin: origin as ProjectEditOrigin,
      author,
      time,
    });
    if (projectCommitId(commit, digest) !== id) invalid("commit hash differs from its identity.");
    commits.push(commit);
    byId[id] = commit;
  }
  if ([...prunedParents].some((id) => Object.hasOwn(byId, id) || !usedParents.has(id)))
    invalid("pruned parent must name a missing ancestor of a retained commit.");
  const cursor = envelope["cursor"] === null ? null : hash(envelope["cursor"]);
  if (
    (commits.length === 0) !== (cursor === null) ||
    (cursor !== null && !Object.hasOwn(byId, cursor))
  )
    invalid("cursor names a missing commit.");
  const future = envelope["future"];
  if (!Array.isArray(future) || future.length > PROJECT_HISTORY_LIMITS.maxCommits)
    invalid("future exceeds its limit.");
  let previous = cursor;
  const futureIds: string[] = [];
  for (const value of future) {
    const id = hash(value);
    if (!Object.hasOwn(byId, id) || byId[id]!.parent !== previous)
      invalid("future must follow the cursor's branch.");
    futureIds.push(id);
    previous = id;
  }
  const storedTags = record(envelope["tags"]);
  if (Object.keys(storedTags).length > PROJECT_HISTORY_LIMITS.maxTags)
    invalid("tag count exceeds its limit.");
  const tags = Object.freeze(
    Object.fromEntries(
      Object.entries(storedTags)
        .sort(([a], [b]) => compareTagNames(a, b))
        .map(([name, value]) => {
          if (text(name, PROJECT_HISTORY_LIMITS.maxTagLength).length === 0)
            invalid("tag names must have text.");
          const id = hash(value);
          if (!Object.hasOwn(byId, id)) invalid("tag names a missing commit.");
          return [name, id];
        }),
    ),
  );
  return Object.freeze({
    ...(prunedParents.size > 0 ? { prunedParents: Object.freeze([...prunedParents].sort()) } : {}),
    blobs: Object.freeze(blobs),
    commits: Object.freeze(commits),
    cursor,
    future: Object.freeze(futureIds),
    tags,
  });
}

/** The writer uses the reader's full validation before publishing portable data. */
export function writeProjectHistory(
  state: ProjectHistoryState,
  digest: ProjectDigest,
): PortableProjectHistory {
  const entries = Object.entries(record(state.blobs));
  if (entries.length > PROJECT_HISTORY_LIMITS.maxBlobs) invalid("blob count exceeds the limit.");
  const images = state.commits.some((commit) =>
    Object.keys(commit.documents).some((key) => key === "images" || key.startsWith("attachment:")),
  );
  let total = 0;
  for (const [, content] of entries) {
    if (typeof content !== "string" && !(content instanceof Uint8Array))
      invalid("blob content must be text or bytes.");
    const size = typeof content === "string" ? content.length * 2 : content.length;
    total += size;
    if (
      size >
        (images && content instanceof Uint8Array
          ? PROJECT_HISTORY_LIMITS.maxImageBlobBytes
          : PROJECT_HISTORY_LIMITS.maxBlobBytes) ||
      total >
        (images ? PROJECT_HISTORY_LIMITS.maxImageTotalBytes : PROJECT_HISTORY_LIMITS.maxTotalBytes)
    )
      invalid("blob payload exceeds its limit.");
  }
  const portable: PortableProjectHistory = {
    format: PROJECT_HISTORY_FORMAT,
    version: state.commits.some((c) =>
      Object.keys(c.documents).some((key) => key === "images" || key.startsWith("attachment:")),
    )
      ? 2
      : 1,
    ...(state.prunedParents !== undefined ? { prunedParents: [...state.prunedParents] } : {}),
    blobs: Object.fromEntries(
      entries
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, content]) => [
          key,
          typeof content === "string"
            ? Object.freeze({ type: "text" as const, text: content })
            : Object.freeze({
                type: "bytes" as const,
                bytes: Object.freeze(Array.from(content as Uint8Array)),
              }),
        ]),
    ),
    commits: state.commits,
    cursor: state.cursor,
    future: state.future,
    tags: state.tags,
  };
  const checked = readProjectHistory(portable, digest);
  return Object.freeze({
    ...portable,
    blobs: Object.freeze(portable.blobs),
    commits: checked.commits,
    future: checked.future,
    tags: checked.tags,
  });
}
