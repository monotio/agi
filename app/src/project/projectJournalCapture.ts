/** A journal carries edited versions; playable files and History are rebuilt from its durable base. */
import { sha256Hex } from "../../../src/crypto.ts";
import type { ProjectCommitRequest } from "./gameStorage.ts";
import type { CachedGameData } from "./gameTypes.ts";
import type { ProjectJournalOperation } from "./projectJournalReplay.ts";
import { bytesToBase64, base64ToBytes } from "./bytes.ts";

function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const order = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (order !== 0) return order;
  }
  return left.length - right.length;
}
type Patch =
  | { readonly value: unknown }
  | { readonly fields: Record<string, Patch>; readonly keys: readonly string[] };
function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function difference(base: unknown, next: unknown): Patch | undefined {
  if (Object.is(base, next)) return undefined;
  if (plain(base) && plain(next)) {
    const fields: Record<string, Patch> = Object.create(null);
    for (const key of Object.keys(next)) {
      const patch = difference(base[key], next[key]);
      if (patch !== undefined || !Object.hasOwn(base, key))
        fields[key] = patch ?? { value: undefined };
    }
    const keys = Object.keys(next).sort(compareCodePoints);
    return Object.keys(fields).length === 0 && keys.length === Object.keys(base).length
      ? undefined
      : { keys, fields };
  }
  if (
    Array.isArray(base) &&
    Array.isArray(next) &&
    base.length === next.length &&
    Array.from(next).every((value, index) => difference(base[index], value) === undefined)
  )
    return undefined;
  if (
    base instanceof Uint8Array &&
    next instanceof Uint8Array &&
    base.length === next.length &&
    base.every((value, index) => value === next[index])
  )
    return undefined;
  return { value: next };
}
function applyPatch(base: unknown, patch: Patch): unknown {
  if ("value" in patch) return patch.value;
  const record = plain(base) ? base : {};
  return Object.fromEntries(
    patch.keys.map((key) => [
      key,
      !Object.hasOwn(patch.fields, key) ? record[key] : applyPatch(record[key], patch.fields[key]!),
    ]),
  );
}
function metadata(data: ProjectCommitRequest["data"]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(
      ([key]) => !["files", "workspace", "projectHistory", "words"].includes(key),
    ),
  );
}
export interface ProjectJournalCapture {
  readonly identity: Omit<ProjectCommitRequest, "data" | "documents">;
  readonly versions: readonly { readonly key: string; readonly version: number }[];
  readonly base: NonNullable<ProjectCommitRequest["expected"]>;
  readonly openedAt: number;
  readonly operations: readonly ProjectJournalOperation[];
  readonly metadata: Patch;
  readonly hash: string;
}
export function captureProjectJournal(input: {
  readonly request: ProjectCommitRequest;
  readonly base: CachedGameData;
  readonly expected: NonNullable<ProjectCommitRequest["expected"]>;
  readonly openedAt: number;
  readonly operations: readonly ProjectJournalOperation[];
}): ProjectJournalCapture {
  const { data, documents, ...identity } = input.request;
  const original = metadata(data);
  const patch = difference(metadata(input.base), original) ?? {
    fields: Object.create(null),
    keys: Object.keys(original).sort(compareCodePoints),
  };
  // Storage stamps these fields after accepting a candidate; a retry retains the original values.
  if ("fields" in patch)
    for (const key of ["projectId", "authoredAt", "generation"])
      if (Object.hasOwn(original, key)) patch.fields[key] = { value: original[key] };
  const capture = {
    identity,
    versions: documents.filter(({ version }) => version !== 1),
    base: input.expected,
    openedAt: input.openedAt,
    operations: input.operations,
    metadata: patch,
  };
  return {
    ...capture,
    hash: sha256Hex(new TextEncoder().encode(JSON.stringify(encodeJournalValue(capture)))),
  };
}
export function journalCandidate(
  capture: ProjectJournalCapture,
  rebuilt: ProjectCommitRequest["data"],
): ProjectCommitRequest {
  const restored = applyPatch(metadata(rebuilt), capture.metadata) as Record<string, unknown>;
  const versionByKey = Object.fromEntries(
    capture.versions.map(({ key, version }) => [key, version]),
  );
  return {
    ...capture.identity,
    documents: rebuilt.workspace!.documents.map(({ key }) => ({
      key,
      version: versionByKey[key] ?? 1,
    })),
    data: {
      ...restored,
      files: rebuilt.files,
      words: rebuilt.words,
      workspace: rebuilt.workspace,
      projectHistory: rebuilt.projectHistory,
    } as ProjectCommitRequest["data"],
  };
}
export function encodeJournalValue(value: unknown): unknown {
  if (value === undefined) return ["undefined"];
  if (Object.is(value, -0)) return ["negative-zero"];
  if (value instanceof Uint8Array) return ["base64", bytesToBase64(value)];
  if (Array.isArray(value)) return ["array", Array.from(value, encodeJournalValue)];
  if (plain(value))
    return [
      "record",
      Object.keys(value)
        .sort(compareCodePoints)
        .map((key) => [key, encodeJournalValue(value[key])]),
    ];
  if (value !== null && typeof value === "object")
    throw new Error("A pending project write contains an unsupported value.");
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("A pending project write contains a non-finite number.");
  if (value !== null && !["string", "number", "boolean"].includes(typeof value))
    throw new Error("A pending project write contains an unsupported value.");
  return value;
}
export function decodeJournalValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const [tag, items] = value;
  if (tag === "undefined") return undefined;
  if (tag === "negative-zero") return -0;
  if (tag === "base64" && typeof items === "string") return base64ToBytes(items);
  if (!Array.isArray(items)) throw new Error("Invalid pending project write.");
  if (tag === "bytes") return Uint8Array.from(items as number[]);
  if (tag === "array") return items.map(decodeJournalValue);
  if (tag === "record")
    return Object.fromEntries(
      (items as [string, unknown][]).map(([key, item]) => [key, decodeJournalValue(item)]),
    );
  throw new Error("Invalid pending project write.");
}
