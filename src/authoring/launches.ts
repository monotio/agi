/**
 * Per-room launch configurations ("Launches"): named entry states a creator
 * saves on a room — where the run came from, which flags, variables and
 * inventory locations it presets, an optional hero spot and an optional fixed
 * random seed. Anything a launch does not list carries over from the running
 * game. This module owns the stored shape, its validation and pure edits; how
 * a launch is applied to a running game is the engine's business.
 */
import type { AuthoringState } from "./authoringState.ts";
import { roomEntryProblem, type RoomEntryState } from "../runtime/roomEntry.ts";

export interface Launch {
  id: string;
  name: string;
  note?: string;
  cameFrom?: { room: number; edge?: 1 | 2 | 3 | 4 };
  flags?: Record<string, boolean>;
  variables?: Record<string, number>;
  items?: Record<string, number>;
  hero?: { x: number; y: number };
  seed?: number;
}

export interface RoomLaunches {
  selected?: string;
  entries: Launch[];
}

/** Per-room launch lists, keyed by the room number spelled in decimal. */
export type WorldLaunches = Record<string, RoomLaunches>;

type World = AuthoringState["world"];

/** The fields one may write when adding or updating a launch. */
export type LaunchFields = Omit<Launch, "id"> & { id?: string };
export type LaunchPatch = { [K in keyof LaunchFields]?: LaunchFields[K] | undefined };

const ROOM_MAX = 255;
const NAME_MAX = 60;
const LAUNCH_FIELDS = [
  "id",
  "name",
  "note",
  "cameFrom",
  "flags",
  "variables",
  "items",
  "hero",
  "seed",
];
const ROOM_LAUNCH_FIELDS = ["selected", "entries"];
const SELECTIONS = ["carry", "beginning", "my-game"];
const RESERVED_KEYS = ["__proto__", "constructor", "prototype"];

function record(value: unknown, label: string, limit: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}: expected an object.`);
  const entries = Object.entries(value);
  if (entries.length > limit || entries.some(([key]) => RESERVED_KEYS.includes(key)))
    throw new Error(`Invalid ${label}: too many entries or reserved name.`);
  return value as Record<string, unknown>;
}

function readFields(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  const read = record(value, label, allowed.length);
  for (const key of Object.keys(read)) {
    if (!allowed.includes(key)) throw new Error(`Invalid ${label} field '${key}'.`);
  }
  return read;
}

function ordered<T>(read: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(read).sort()) out[key] = read[key]!;
  return out;
}

/** A decimal key spelled canonically: "3" yes, "03" or "3.0" no. */
function decimalKey(key: string, min: number, max: number): number | undefined {
  const value = Number(key);
  return Number.isInteger(value) && value >= min && value <= max && String(value) === key
    ? value
    : undefined;
}

function readEntry(value: unknown, room: string, used: ReadonlySet<string>): Launch {
  const entry = record(value, `launch in room ${room}`, LAUNCH_FIELDS.length);
  for (const field of Object.keys(entry)) {
    if (!LAUNCH_FIELDS.includes(field)) {
      throw new Error(`Invalid launch field '${field}' in room ${room}.`);
    }
  }
  const id = entry["id"];
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(`Invalid launch id '${id}' in room ${room}.`);
  }
  if (used.has(id)) throw new Error(`Duplicate launch id '${id}' in room ${room}.`);
  if (SELECTIONS.includes(id)) throw new Error(`Reserved launch id '${id}' in room ${room}.`);
  const name = entry["name"];
  const named = typeof name === "string" ? name.trim() : "";
  if (named.length < 1 || named.length > NAME_MAX) {
    throw new Error(`Invalid launch '${id}' name in room ${room}.`);
  }
  const launch: Launch = { id, name: named };
  const note = entry["note"];
  if (note !== undefined) {
    if (typeof note !== "string") throw new Error(`Invalid launch '${id}' note in room ${room}.`);
    if (note.trim() !== "") launch.note = note.trim();
  }
  const problem = roomEntryProblem(entry);
  if (problem) throw new Error(`Invalid launch '${id}' in room ${room}: ${problem}`);
  const inputs = entry as RoomEntryState;
  if (inputs.cameFrom) launch.cameFrom = { ...inputs.cameFrom };
  if (inputs.hero) launch.hero = { ...inputs.hero };
  for (const field of ["flags", "variables", "items"] as const) {
    const values = inputs[field];
    if (values && Object.keys(values).length) {
      if (field === "flags") launch.flags = ordered(values as Record<string, boolean>);
      else launch[field] = ordered(values as Record<string, number>);
    }
  }
  if (inputs.seed !== undefined) launch.seed = inputs.seed;
  return launch;
}

/**
 * Validates stored launches into a detached record keyed by decimal room
 * number. Every key and value range is checked and rejected with a named
 * reason; nothing is dropped silently.
 */
export function readWorldLaunches(value: unknown): WorldLaunches {
  const read = record(value, "launches", 256);
  const launches: WorldLaunches = {};
  for (const key of Object.keys(read)) {
    // Launch targets are playable rooms, so like `world.rooms` they are 1..255.
    if (decimalKey(key, 1, ROOM_MAX) === undefined) {
      throw new Error(`Invalid launches room '${key}'.`);
    }
    const room = readFields(read[key], ROOM_LAUNCH_FIELDS, `launches for room '${key}'`);
    const entries = room["entries"];
    if (!Array.isArray(entries) || entries.length > 256)
      throw new Error(`Invalid launches entries for room '${key}'.`);
    const used = new Set<string>();
    const list = entries.map((entry) => {
      const launch = readEntry(entry, key, used);
      used.add(launch.id);
      return launch;
    });
    const selected = room["selected"];
    if (
      selected !== undefined &&
      (typeof selected !== "string" || (!SELECTIONS.includes(selected) && !used.has(selected)))
    ) {
      throw new Error(`Invalid launches selected '${selected}' for room '${key}'.`);
    }
    launches[key] = selected === undefined ? { entries: list } : { selected, entries: list };
  }
  return ordered(launches);
}

/** The first free "launch-N" id inside one room's list. */
export function newLaunchId(launches: RoomLaunches | undefined): string {
  const used = new Set((launches?.entries ?? []).map((entry) => entry.id));
  for (let n = 1; ; n += 1) {
    const id = `launch-${n}`;
    if (!used.has(id)) return id;
  }
}

function checkedRoom(room: number, verb: string): string {
  if (!Number.isInteger(room) || room < 1 || room > ROOM_MAX) {
    throw new Error(`Refused to ${verb} in room '${room}'.`);
  }
  return String(room);
}

function withRoomLaunches(world: World, key: string, value: RoomLaunches): World {
  const launches = { ...world.launches };
  if (value.entries.length === 0 && value.selected === undefined) {
    delete launches[key];
  } else {
    launches[key] = value;
  }
  if (Object.keys(launches).length === 0) {
    const next = { ...world };
    delete next.launches;
    return next;
  }
  return { ...world, launches: ordered(launches) };
}

/** Adds a launch to one room; invents a "launch-N" id when none is given. */
export function addLaunch(world: World, room: number, fields: LaunchFields): World {
  const key = checkedRoom(room, "add launch");
  const current = world.launches?.[key];
  const used = new Set((current?.entries ?? []).map((entry) => entry.id));
  const entry = readEntry({ ...fields, id: fields.id ?? newLaunchId(current) }, key, used);
  return withRoomLaunches(world, key, {
    ...current,
    entries: [...(current?.entries ?? []), entry],
  });
}

/** Replaces fields of one launch; a `undefined` patch field drops it. */
export function updateLaunch(world: World, room: number, id: string, patch: LaunchPatch): World {
  const key = checkedRoom(room, "update launch");
  const current = world.launches?.[key];
  const index = current?.entries.findIndex((entry) => entry.id === id) ?? -1;
  if (!current || index < 0) {
    throw new Error(`Refused to update launch '${id}' in room ${key}: no such launch.`);
  }
  const merged: Record<string, unknown> = { ...current.entries[index] };
  for (const [field, next] of Object.entries(
    record(patch, `launch '${id}' patch in room ${key}`, LAUNCH_FIELDS.length),
  )) {
    if (field === "id") continue;
    if (next === undefined) {
      delete merged[field];
    } else {
      merged[field] = next;
    }
  }
  const used = new Set(current.entries.filter((entry) => entry.id !== id).map((e) => e.id));
  const entries = [...current.entries];
  entries[index] = readEntry(merged, key, used);
  return withRoomLaunches(world, key, { ...current, entries });
}

/** Drops a launch; removing the selected one restores the "carry" default. */
export function removeLaunch(world: World, room: number, id: string): World {
  const key = checkedRoom(room, "remove launch");
  const current = world.launches?.[key];
  if (!current?.entries.some((entry) => entry.id === id)) {
    throw new Error(`Refused to remove launch '${id}' from room ${key}: no such launch.`);
  }
  const next: RoomLaunches = { entries: current.entries.filter((entry) => entry.id !== id) };
  if (current.selected !== undefined && current.selected !== id) next.selected = current.selected;
  return withRoomLaunches(world, key, next);
}

/** Moves a launch inside its room's stable order. */
export function moveLaunch(world: World, room: number, id: string, index: number): World {
  const key = checkedRoom(room, "move launch");
  const current = world.launches?.[key];
  const from = current?.entries.findIndex((entry) => entry.id === id) ?? -1;
  if (!current || from < 0) {
    throw new Error(`Refused to move launch '${id}' in room ${key}: no such launch.`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= current.entries.length) {
    throw new Error(`Refused to move launch '${id}' in room ${key} to index ${index}.`);
  }
  const entries = [...current.entries];
  entries.splice(index, 0, ...entries.splice(from, 1));
  return withRoomLaunches(world, key, { ...current, entries });
}

/**
 * Selects which launch a room opens with: "carry" (the default, so the record
 * stays absent), "beginning", "my-game" or an entry id.
 */
export function selectLaunch(world: World, room: number, selected: string): World {
  const key = checkedRoom(room, "select launch");
  const current = world.launches?.[key];
  if (!SELECTIONS.includes(selected) && !current?.entries.some((e) => e.id === selected)) {
    throw new Error(`Refused to select launch '${selected}' in room ${key}: no such launch.`);
  }
  const next: RoomLaunches = { entries: current?.entries ?? [] };
  if (selected !== "carry") next.selected = selected;
  return withRoomLaunches(world, key, next);
}

/** Removes Launch inputs tied to deleted LOGIC resources, preserving every other entry. */
export function pruneWorldLaunches(
  launches: WorldLaunches | undefined,
  removedKeys: ReadonlySet<string>,
): WorldLaunches | undefined {
  if (!launches) return launches;
  let changed = false;
  const next: WorldLaunches = {};
  for (const [room, list] of Object.entries(launches)) {
    if (removedKeys.has(`logic:${room}`)) {
      changed = true;
      continue;
    }
    let entriesChanged = false;
    const entries = list.entries.map((entry) => {
      const clearCameFrom =
        entry.cameFrom !== undefined && removedKeys.has(`logic:${entry.cameFrom.room}`);
      const items =
        entry.items &&
        Object.fromEntries(
          Object.entries(entry.items).filter(([, room]) => !removedKeys.has(`logic:${room}`)),
        );
      const clearItems =
        entry.items !== undefined && Object.keys(items!).length !== Object.keys(entry.items).length;
      if (!clearCameFrom && !clearItems) return entry;
      entriesChanged = true;
      const patched = { ...entry };
      if (clearCameFrom) delete patched.cameFrom;
      if (clearItems) {
        if (Object.keys(items!).length) patched.items = items!;
        else delete patched.items;
      }
      return patched;
    });
    changed ||= entriesChanged;
    next[room] = entriesChanged ? { ...list, entries } : list;
  }
  if (!changed) return launches;
  return Object.keys(next).length ? next : undefined;
}

/** Prunes a planned room's Launches through the shared resource-removal edit. */
export function pruneRoomLaunches(world: World, room: number): World {
  const launches = pruneWorldLaunches(world.launches, new Set([`logic:${room}`]));
  if (launches === world.launches) return world;
  const next = { ...world };
  if (launches) next.launches = launches;
  else delete next.launches;
  return next;
}
