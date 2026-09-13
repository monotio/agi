/**
 * The world map's sidecar: a bounded, versioned record of the room journal
 * and the map's UI data (node positions, notes). It lives in browser storage
 * per game — keyed by the same target the autosave uses — and travels with a
 * project archive as `MAP.JSON`. A published game never carries it.
 *
 * The record is a storage contract, not the canonical plan: `world.rooms`
 * stays in the authoring state; journal observations are append-only facts;
 * the static graph is derived from the resources and never stored.
 */
import {
  serializeMapSidecar,
  validateMapSidecar,
  type RoomMapSidecar,
} from "../../src/agent/roomMap.ts";

const MAP_PREFIX = "monotio_agi.map.";
/** Where a project archive keeps the sidecar. */
export const MAP_FILE = "MAP.JSON";
/** Bytes, not just counts: a full journal with notes stays well under this. */
export const MAX_MAP_BYTES = 2 * 1024 * 1024;

export function mapKey(target: string): string {
  return `${MAP_PREFIX}${target}`;
}

export function emptyMapSidecar(): RoomMapSidecar {
  return { journal: [], layout: {}, notes: {} };
}

/**
 * The stored sidecar for a game. Missing data is an empty map. Malformed or
 * unsupported data throws — the caller explains a reset or reimport — and the
 * record is left in place so the failure stays visible.
 */
export function readMapSidecar(storage: Pick<Storage, "getItem">, target: string): RoomMapSidecar {
  const raw = storage.getItem(mapKey(target));
  if (raw === null) return emptyMapSidecar();
  if (raw.length > MAX_MAP_BYTES) throw new Error("Stored map data is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored map data is corrupt. Reset the map or reimport the project.");
  }
  try {
    return validateMapSidecar(parsed);
  } catch (error) {
    throw new Error(
      `Stored map data is not readable (${error instanceof Error ? error.message : String(error)}). Reset the map or reimport the project.`,
      { cause: error },
    );
  }
}

/**
 * Write the sidecar. Storage refusal and quota errors are reported, not
 * hidden: the caller keeps the map in memory and offers retry or export.
 * Nothing is reported saved before the write commits.
 */
export function writeMapSidecar(
  storage: Pick<Storage, "setItem">,
  target: string,
  sidecar: RoomMapSidecar,
): boolean {
  try {
    const raw = JSON.stringify(serializeMapSidecar(sidecar));
    if (raw.length > MAX_MAP_BYTES) return false;
    storage.setItem(mapKey(target), raw);
    return true;
  } catch {
    return false;
  }
}

/** Forget a game's map record — the library removal path calls this too. */
export function removeMapSidecar(storage: Pick<Storage, "removeItem">, target: string): void {
  storage.removeItem(mapKey(target));
}

/** The serialized record for a project archive's MAP.JSON entry. */
export function mapArchiveData(sidecar: RoomMapSidecar): string {
  return JSON.stringify(serializeMapSidecar(sidecar));
}

/** A MAP.JSON entry from an archive: missing is an empty map. */
export function readMapArchive(bytes: Uint8Array): RoomMapSidecar {
  if (bytes.length > MAX_MAP_BYTES) throw new Error("MAP.JSON is too large to be map data.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("MAP.JSON contains invalid JSON. Reset the map or reimport the project.");
  }
  try {
    return validateMapSidecar(parsed);
  } catch (error) {
    throw new Error(
      `MAP.JSON is not map data this app understands (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }
}
