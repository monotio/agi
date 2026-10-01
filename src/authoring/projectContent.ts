/** Shared exact document ownership and platform-injected SHA-256 identities. */
import { checkProjectDocumentKey } from "./projectDocumentKey.ts";

export type ProjectContent = string | Uint8Array;
export interface ProjectChange {
  readonly key: string;
  readonly content: ProjectContent | null;
}
export type ProjectDigest = (bytes: Uint8Array) => string;

/** UTF-16BE preserves every code unit, including unpaired surrogates. */
function projectTextBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i));
  return bytes;
}

/** v1 blob framing: 0x01 + exact UTF-16BE text, or 0x00 + exact native bytes. */
export function projectContentHash(content: ProjectContent, digest: ProjectDigest): string {
  const payload = typeof content === "string" ? projectTextBytes(content) : content;
  const bytes = new Uint8Array(payload.length + 1);
  bytes[0] = typeof content === "string" ? 1 : 0;
  bytes.set(payload, 1);
  const hash = digest(bytes);
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new Error("Project digest must return a SHA-256 hex hash.");
  return hash;
}

export function copyProjectDocuments(
  documents: Readonly<Record<string, ProjectContent>>,
): Readonly<Record<string, ProjectContent>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(documents)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, content]) => {
          checkProjectDocumentKey(key);
          if (typeof content !== "string" && !(content instanceof Uint8Array))
            throw new Error(`Invalid project document ${key}: expected text or bytes.`);
          return [key, typeof content === "string" ? content : new Uint8Array(content)];
        }),
    ),
  );
}

export function sameProjectContent(
  a: ProjectContent | null | undefined,
  b: ProjectContent | null | undefined,
): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function diffProjectDocuments(
  before: Readonly<Record<string, ProjectContent>>,
  after: Readonly<Record<string, ProjectContent>>,
): readonly ProjectChange[] {
  return Object.freeze(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .filter((key) => !sameProjectContent(before[key], after[key]))
      .map((key) =>
        Object.freeze({
          key,
          content:
            after[key] instanceof Uint8Array ? new Uint8Array(after[key]) : (after[key] ?? null),
        }),
      ),
  );
}

export function projectDocumentId(
  documents: Readonly<Record<string, ProjectContent>>,
  digest: ProjectDigest,
): string {
  const manifest = Object.entries(copyProjectDocuments(documents)).map(([key, content]) => [
    key,
    typeof content === "string" ? "text" : "bytes",
    projectContentHash(content, digest),
  ]);
  return projectContentHash(JSON.stringify(manifest), digest);
}
