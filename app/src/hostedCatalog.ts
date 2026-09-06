import type { GameCatalogEntry } from "./gameCatalog.ts";
import { readGameFiles, type OpenedGame } from "./gameZip.ts";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_GAME_BYTES = 256 * 1024 * 1024;
const PUBLIC_GAME_FILE =
  /^(?:[A-Z0-9_]*DIR|[A-Z0-9_]*VOL\.(?:[0-9]|1[0-5])|WORDS\.TOK|OBJECT|AGIDATA\.OVL|AGI|[A-Z0-9_-]+\.COM|GAME\.JSON)$/;

export interface HostedCatalogRecord {
  id: string;
  version: string;
  title: string;
  description?: string | undefined;
  author?: string | undefined;
  license: string;
  path: string;
  files: string[];
}

function text(value: unknown, name: string, limit: number, required: boolean): string | undefined {
  if (typeof value !== "string") {
    if (required) throw new Error(`Hosted catalog ${name} must be a string.`);
    return undefined;
  }
  const result = value.trim();
  if ((!result && required) || result.length > limit)
    throw new Error(`Hosted catalog ${name} is empty or too long.`);
  return result || undefined;
}

export function readHostedCatalogManifest(raw: unknown, manifestUrl: URL): HostedCatalogRecord[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Hosted catalog manifest is invalid.");
  const value = raw as Record<string, unknown>;
  if (value["format"] !== "monotio.agi.catalog" || value["version"] !== 1)
    throw new Error("This hosted catalog version is not supported by this app.");
  if (!Array.isArray(value["games"]) || value["games"].length > 100)
    throw new Error("Hosted catalog must contain at most 100 games.");
  const ids = new Set<string>();
  return value["games"].map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Hosted catalog game entry is invalid.");
    const game = item as Record<string, unknown>;
    const id = text(game["id"], "game id", 80, true)!;
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(id) || ids.has(id.toLowerCase()))
      throw new Error("Hosted catalog game ids must be unique safe identifiers.");
    ids.add(id.toLowerCase());
    const version = text(game["version"], "game version", 80, true)!;
    if (!/^[A-Za-z0-9._+-]{1,80}$/.test(version))
      throw new Error("Hosted catalog game version is invalid.");
    const path = text(game["path"], "game path", 240, true)!;
    if (
      !/^(?:[A-Za-z0-9._-]+\/)+$/.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("Hosted catalog game path must be a safe relative directory.");
    const resolved = new URL(path, manifestUrl);
    if (resolved.origin !== manifestUrl.origin)
      throw new Error("Hosted catalog game path must use the catalog origin.");
    if (!Array.isArray(game["files"]) || !game["files"].length || game["files"].length > 1024)
      throw new Error("Hosted catalog file list is invalid.");
    const names = new Set<string>();
    const files = game["files"].map((file) => {
      if (typeof file !== "string" || file !== file.trim())
        throw new Error("Hosted catalog file name is invalid.");
      const upper = file.toUpperCase();
      if (!PUBLIC_GAME_FILE.test(upper) || names.has(upper))
        throw new Error("Hosted catalog file list contains an unsafe or duplicate file.");
      names.add(upper);
      return file;
    });
    const description = text(game["description"], "description", 600, false);
    const author = text(game["author"], "author", 160, false);
    return {
      id,
      version,
      title: text(game["title"], "game title", 160, true)!,
      ...(description ? { description } : {}),
      ...(author ? { author } : {}),
      license: text(game["license"], "license provenance", 160, true)!,
      path,
      files,
    };
  });
}

async function boundedBytes(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new Error(`${label} exceeds the ${Math.floor(limit / 1024 / 1024)} MB limit.`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit)
      throw new Error(`${label} exceeds the ${Math.floor(limit / 1024 / 1024)} MB limit.`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > limit)
        throw new Error(`${label} exceeds the ${Math.floor(limit / 1024 / 1024)} MB limit.`);
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function fetchFile(url: URL, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const response = await fetchImpl(url, { credentials: "omit", redirect: "error" });
  if (!response.ok)
    throw new Error(`Hosted game file ${url.pathname} failed (${response.status}).`);
  return boundedBytes(response, MAX_FILE_BYTES, "Hosted game file");
}

function catalogEntry(
  record: HostedCatalogRecord,
  manifestUrl: URL,
  fetchImpl: typeof fetch,
): GameCatalogEntry {
  return {
    id: record.id,
    version: record.version,
    title: record.title,
    description: record.description ?? "",
    author: record.author ?? "",
    license: record.license,
    load: async (): Promise<OpenedGame> => {
      const files = new Map<string, Uint8Array>();
      let total = 0;
      for (const name of record.files) {
        const bytes = await fetchFile(new URL(`${record.path}${name}`, manifestUrl), fetchImpl);
        total += bytes.length;
        if (total > MAX_GAME_BYTES) throw new Error("Hosted game exceeds the 256 MB total limit.");
        files.set(name, bytes);
      }
      const opened = readGameFiles(files);
      return {
        ...opened,
        title: record.title,
        metadata: {
          ...opened.metadata,
          ...(record.description ? { description: record.description } : {}),
          ...(record.author ? { author: record.author } : {}),
          license: record.license,
        },
      };
    },
  };
}

export async function loadHostedCatalog(
  manifestUrl: URL,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GameCatalogEntry[]> {
  const response = await fetchImpl(manifestUrl, { credentials: "omit", redirect: "error" });
  if (response.status === 404) return [];
  if (!response.ok)
    throw new Error(`Hosted catalog failed to load (${response.status}). Try again.`);
  const bytes = await boundedBytes(response, MAX_MANIFEST_BYTES, "Hosted catalog manifest");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Hosted catalog manifest contains invalid JSON.");
  }
  return readHostedCatalogManifest(raw, manifestUrl).map((record) =>
    catalogEntry(record, manifestUrl, fetchImpl),
  );
}
