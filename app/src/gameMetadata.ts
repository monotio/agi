import { detectKnownGameByHashes, type KnownAgiGame } from "../../src/games/knownGames.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
import {
  gameIdentity,
  resourceRevision,
  type GameIdentity,
  type ResourceRevision,
} from "../../src/gameIdentity.ts";
import { sha256Hex } from "./crypto.ts";
import type { BootedGame } from "./gameTypes.ts";

/** Versioned library metadata. Resource revisions and local project IDs have separate jobs. */
export interface PublicGameMetadata {
  description?: string | undefined;
  author?: string | undefined;
  license?: string | undefined;
  /** A remix's parent — the same GameIdentity record every store carries. */
  parent?: GameIdentity | undefined;
}

export interface LibraryMetadata extends PublicGameMetadata {
  version: 1;
  revision: ResourceRevision;
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
  const rawParent: unknown = value?.parent;
  const rawRecord = (rawParent && typeof rawParent === "object" ? rawParent : {}) as Record<
    string,
    unknown
  >;
  const rawRevision = rawRecord["revision"];
  const parent = gameIdentity(
    rawParent && typeof rawParent === "object"
      ? {
          project: rawRecord["project"],
          revision: typeof rawRevision === "string" ? rawRevision.toLowerCase() : rawRevision,
        }
      : rawParent,
  );
  if (parent) result.parent = parent;
  return result;
}

/** Validate the released version-1 library record, or create one for a new project. */
export function normalizeLibraryMetadata(
  raw: unknown,
  defaults: Pick<LibraryMetadata, "revision" | "source">,
): LibraryMetadata {
  if (raw !== undefined && (!raw || typeof raw !== "object"))
    throw new Error("Invalid library metadata.");
  const value = (raw as Record<string, unknown> | undefined) ?? {};
  if (raw !== undefined && value["version"] !== 1)
    throw new Error("This library metadata version is not supported by this app.");
  const revision = resourceRevision(value["revision"]) ?? defaults.revision;
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
  const title = boundedText(value["title"], 160);
  return {
    ...(title ? { title } : {}),
    roomGeneration: value["roomGeneration"] === true,
    metadata: publicGameMetadata(value["metadata"] as PublicGameMetadata | undefined),
  };
}

/**
 * The canonical playable file set — the names a Game export ships: AGI
 * directory and volume files, the vocabulary and object tables, the loader
 * overlay and interpreter executables. Tests, notes, maps and history are
 * authoring records: they travel in a Project archive, never in a Game
 * bundle, and never move the ResourceRevision.
 */
export function isPlayableFileName(name: string): boolean {
  return /^([A-Z0-9_]*DIR|[A-Z0-9_]*VOL\.(?:[0-9]|1[0-5])|WORDS\.TOK|OBJECT|AGIDATA\.OVL|AGI|[A-Z0-9_-]+\.COM)$/i.test(
    name,
  );
}

/**
 * SHA-256 of the canonical playable file set (`isPlayableFileName`), sorted
 * by uppercased name and length-delimited; ZIP headers, timestamps, and
 * non-playable records (TESTS.JSON and the like) are irrelevant — the same
 * playable bytes give the same revision.
 */
export async function gameRevision(files: Record<string, Uint8Array>): Promise<ResourceRevision> {
  const encoder = new TextEncoder();
  const normalized = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) {
    if (!isPlayableFileName(name)) continue;
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
  // The packed digest is a ResourceRevision by construction; validate it the
  // same way a serialized one is, so the brand is never an unchecked cast.
  return resourceRevision(await sha256Hex(packed))!;
}

/** Identify a collection of game files by hashing WORDS.TOK. */
export async function detectKnownGame(
  files: Record<string, Uint8Array>,
): Promise<KnownAgiGame | null> {
  const words = files["WORDS.TOK"] ?? files["words.tok"];
  if (!words) return null;
  const wordsSha = await sha256Hex(words);
  const obj = files["OBJECT"] ?? files["object"];
  const objSha = obj ? await sha256Hex(obj) : undefined;
  return detectKnownGameByHashes(wordsSha, objSha);
}

/**
 * Update the live booted game resources atomically with their dictionary
 * and revision so currentGame() and debug bundles never see obsolete snapshots.
 */
export async function updateBootedResources(
  booted: BootedGame,
  files: Record<string, Uint8Array>,
  words?: [string, number][],
): Promise<void> {
  const revision = await gameRevision(files);
  booted.files = files;
  if (words) {
    booted.words = words;
  } else if (files["WORDS.TOK"]) {
    booted.words = parseWordsTok(files["WORDS.TOK"]).map(({ word, id }) => [word, id]);
  }
  booted.revision = revision;
}
