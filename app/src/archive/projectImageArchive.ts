/** Private archives store shared image bytes once, outside the JSON envelopes. */
import { sha256Hex } from "../../../src/crypto.ts";
import type { PortableProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import type { PortableProjectHistory } from "../../../src/authoring/projectHistoryCodec.ts";
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

/** Expand only tagged byte holders; the normal strict codecs validate the result. */
export function hydrateImageAttachments(
  value: unknown,
  entries: ReadonlyMap<string, Uint8Array>,
  root: string,
  depth = 0,
): unknown {
  if (depth > 40) throw new Error("Image attachment metadata is nested too deeply.");
  if (Array.isArray(value))
    return value.map((child) => hydrateImageAttachments(child, entries, root, depth + 1));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record["type"] === "attachment") {
    if (
      Object.keys(record).length !== 2 ||
      typeof record["hash"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(record["hash"])
    )
      throw new Error("Invalid image attachment fields.");
    const bytes = entries.get(`${root}ATTACHMENTS/${record["hash"]}.bin`.toUpperCase());
    if (!bytes || sha256Hex(bytes) !== record["hash"])
      throw new Error("Missing or corrupt image attachment.");
    return { type: "bytes", bytes: Array.from(bytes) };
  }
  // Ordinary byte arrays stay intact; walking each pixel serves no validation purpose.
  if (record["type"] === "bytes") return record;
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [
      key,
      hydrateImageAttachments(child, entries, root, depth + 1),
    ]),
  );
}
