/** Private archives store shared image bytes once, outside the JSON envelopes. */
import { sha256Hex } from "../../../src/crypto.ts";
import {
  preflightProjectWorkspace,
  type PortableProjectWorkspace,
} from "../../../src/authoring/projectWorkspace.ts";
import {
  preflightProjectHistory,
  type PortableProjectHistory,
} from "../../../src/authoring/projectHistoryCodec.ts";
import type { ZipFileInput } from "./zip.ts";

export function externalizeImageAttachments(
  workspace: PortableProjectWorkspace | undefined,
  history: PortableProjectHistory | undefined,
  entries: ZipFileInput[],
) {
  const attached: Record<string, string> = {};
  const written = new Set<string>();
  function attach(hash: string, bytes: readonly number[]) {
    const owned = Uint8Array.from(bytes);
    if (sha256Hex(owned) !== hash)
      throw new Error("Image attachment bytes differ from their hash.");
    if (!written.has(hash)) {
      entries.push({ name: `ATTACHMENTS/${hash}.bin`, data: owned });
      written.add(hash);
    }
    return { type: "attachment", hash };
  }
  for (const commit of history?.commits ?? [])
    for (const [key, blob] of Object.entries(commit.documents)) {
      if (key.startsWith("attachment:") && blob !== null) attached[blob] = key.slice(11);
    }
  return {
    workspace:
      workspace === undefined
        ? undefined
        : {
            ...workspace,
            documents: workspace.documents.map((document) => {
              if (!document.key.startsWith("attachment:")) return document;
              if (document.content.type !== "bytes")
                throw new Error("Image attachments must contain bytes.");
              return {
                ...document,
                content: attach(document.key.slice(11), document.content.bytes),
              };
            }),
          },
    history:
      history === undefined
        ? undefined
        : {
            ...history,
            blobs: Object.fromEntries(
              Object.entries(history.blobs).map(([id, blob]) => {
                const hash = attached[id];
                if (hash === undefined) return [id, blob];
                if (blob.type !== "bytes") throw new Error("Image attachments must contain bytes.");
                return [id, attach(hash, blob.bytes)];
              }),
            ),
          },
  };
}

/** Preflight both envelopes before sharing verified attachment arrays across them. */
export function hydrateImageAttachments(
  workspace: unknown,
  history: unknown,
  entries: ReadonlyMap<string, Uint8Array>,
  root: string,
): { workspace: unknown; history: unknown } {
  const expanded: Record<string, readonly number[]> = Object.create(null);
  function attachment(hash: string): Uint8Array {
    const bytes = entries.get(`${root}ATTACHMENTS/${hash}.bin`.toUpperCase());
    if (!bytes) throw new Error("Missing image attachment. Add a complete project file.");
    return bytes;
  }
  const size = (hash: string) => attachment(hash).length;
  if (workspace !== undefined) preflightProjectWorkspace(workspace, size);
  if (history !== undefined) preflightProjectHistory(history, sha256Hex, size);
  function hydrate(value: unknown): unknown {
    const holder = value as Record<string, unknown>;
    if (holder["type"] !== "attachment") return value;
    const hash = holder["hash"] as string;
    if (!Object.hasOwn(expanded, hash)) {
      const bytes = attachment(hash);
      if (sha256Hex(bytes) !== hash)
        throw new Error("Corrupt image attachment. Add a fresh copy of the project file.");
      expanded[hash] = Object.freeze(Array.from(bytes));
    }
    return { type: "bytes", bytes: expanded[hash] };
  }
  const storedWorkspace = workspace as PortableProjectWorkspace | undefined;
  const storedHistory = history as PortableProjectHistory | undefined;
  return {
    workspace:
      storedWorkspace === undefined
        ? undefined
        : {
            ...storedWorkspace,
            documents: storedWorkspace.documents.map((document) => ({
              ...document,
              content: hydrate(document.content),
            })),
          },
    history:
      storedHistory === undefined
        ? undefined
        : {
            ...storedHistory,
            blobs: Object.fromEntries(
              Object.entries(storedHistory.blobs).map(([key, holder]) => [key, hydrate(holder)]),
            ),
          },
  };
}
