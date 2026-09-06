/** Versioned library metadata. Resource revisions and local project IDs have separate jobs. */
export interface PublicGameMetadata {
  description?: string | undefined;
  author?: string | undefined;
  license?: string | undefined;
  parent?: { gameId: string; revision: string } | undefined;
}

export interface LibraryMetadata extends PublicGameMetadata {
  version: 1;
  /** Stable game lineage, independent of its title, local storage slug or resource revision. */
  gameId: string;
  revision: string;
  source: "catalog" | "zip" | "folder" | "authored" | "remix";
  catalog?: { id: string; version: string } | undefined;
  /** A browser-generated PNG, never an imported remote URL. */
  preview?: string | undefined;
  validation: {
    status: "ready" | "needs-input" | "unverified";
    message: string;
    profile?: string | undefined;
  };
}

const SHA256 = /^[a-f0-9]{64}$/;
const LIBRARY_SOURCES: Record<LibraryMetadata["source"], true> = {
  catalog: true,
  zip: true,
  folder: true,
  authored: true,
  remix: true,
};

function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, limit) : undefined;
}

/** Library previews are generated in this browser. Remote and active content never enters the index. */
export function isLocalGamePreview(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2 * 1024 * 1024 &&
    /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value)
  );
}

export function publicGameMetadata(value?: PublicGameMetadata): PublicGameMetadata {
  const result: PublicGameMetadata = {};
  for (const key of ["description", "author", "license"] as const) {
    const text = boundedText(value?.[key], key === "description" ? 600 : 160);
    if (text) result[key] = text;
  }
  const parentId = boundedText(value?.parent?.gameId, 160);
  if (parentId && SHA256.test(value?.parent?.revision ?? ""))
    result.parent = { gameId: parentId, revision: value!.parent!.revision };
  return result;
}

/** Validate the released version-1 library record, or create one for a new project. */
export function normalizeLibraryMetadata(
  raw: unknown,
  defaults: Pick<LibraryMetadata, "gameId" | "revision" | "source">,
): LibraryMetadata {
  if (raw !== undefined && (!raw || typeof raw !== "object"))
    throw new Error("Invalid library metadata.");
  const value = (raw as Record<string, unknown> | undefined) ?? {};
  if (raw !== undefined && value["version"] !== 1)
    throw new Error("This library metadata version is not supported by this app.");
  const gameId = boundedText(value["gameId"], 160) ?? defaults.gameId;
  const revision =
    typeof value["revision"] === "string" && SHA256.test(value["revision"])
      ? value["revision"]
      : defaults.revision;
  const source = Object.hasOwn(LIBRARY_SOURCES, value["source"] as PropertyKey)
    ? (value["source"] as LibraryMetadata["source"])
    : defaults.source;
  const catalogValue = value["catalog"] as Record<string, unknown> | undefined;
  const catalogId = boundedText(catalogValue?.["id"], 160);
  const catalogVersion = boundedText(catalogValue?.["version"], 80);
  const validationValue = value["validation"] as Record<string, unknown> | undefined;
  const status = validationValue?.["status"];
  const message = boundedText(validationValue?.["message"], 300);
  const profile = boundedText(validationValue?.["profile"], 80);
  return {
    ...publicGameMetadata(value as PublicGameMetadata),
    version: 1,
    gameId,
    revision,
    source,
    ...(source === "catalog" && catalogId && catalogVersion
      ? { catalog: { id: catalogId, version: catalogVersion } }
      : {}),
    ...(isLocalGamePreview(value["preview"]) ? { preview: value["preview"] } : {}),
    validation: {
      status:
        status === "ready" || status === "needs-input" || status === "unverified"
          ? status
          : "unverified",
      message: message ?? "Opening not checked yet.",
      ...(profile ? { profile } : {}),
    },
  };
}

export function readPublicMetadata(raw: unknown): {
  title?: string;
  roomGeneration: boolean;
  metadata?: PublicGameMetadata;
} {
  if (!raw || typeof raw !== "object") throw new Error("GAME.JSON must contain game metadata.");
  const value = raw as Record<string, unknown>;
  if (value["format"] !== "monotio.agi") return { roomGeneration: false };
  if (value["version"] !== 1)
    throw new Error(
      "This game metadata version is newer than this app. Update the app and try again.",
    );
  return {
    ...(typeof value["title"] === "string" ? { title: value["title"].slice(0, 160) } : {}),
    roomGeneration: value["roomGeneration"] === true,
    metadata: publicGameMetadata(value["metadata"] as PublicGameMetadata | undefined),
  };
}

/** SHA-256 of sorted, length-delimited names and bytes; ZIP headers and timestamps are irrelevant. */
export async function gameRevision(files: Record<string, Uint8Array>): Promise<string> {
  const encoder = new TextEncoder();
  const normalized = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) {
    const key = name.toUpperCase();
    if (normalized.has(key)) throw new Error(`Duplicate game resource name: ${name}.`);
    normalized.set(key, bytes);
  }
  const entries = [...normalized].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = entries.map(([name, bytes]) => ({
    name: encoder.encode(name.toUpperCase()),
    bytes,
  }));
  const packed = new Uint8Array(
    parts.reduce((n, entry) => n + 8 + entry.name.length + entry.bytes.length, 0),
  );
  const view = new DataView(packed.buffer);
  let offset = 0;
  for (const { name, bytes } of parts) {
    view.setUint32(offset, name.length);
    view.setUint32(offset + 4, bytes.length);
    packed.set(name, offset + 8);
    packed.set(bytes, offset + 8 + name.length);
    offset += 8 + name.length + bytes.length;
  }
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", packed))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
