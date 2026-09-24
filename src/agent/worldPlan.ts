/**
 * The world plan's revisioned write path.
 *
 * `AuthoringState.world` is the canonical plan; every writer — the agent's
 * update_world and the player's map edits — goes through
 * validateAuthoringState, so both share the same limits. A player draft forks
 * from a base revision and commits only while the world still matches it; a
 * mismatch is a conflict the caller surfaces rather than a silent overwrite.
 *
 * Layout and notes stay in the map sidecar — they are UI data, not plan data.
 */
import { validateAuthoringState, type AuthoringState } from "./authoringState.ts";

export type WorldPlan = AuthoringState["world"];
export type WorldRooms = WorldPlan["rooms"];

/**
 * A detached copy of the world plan the player edits on the map. The base
 * revision is the worldRevision the draft forked from; "" adopts
 * unconditionally (a draft restored from storage has no in-memory base).
 */
export interface WorldDraft {
  baseRevision: string;
  world: WorldPlan;
}

/** FNV-1a over the canonical (sorted-key) serialization — content revision, not identity. */
export function worldRevision(world: WorldPlan): string {
  const canonical = JSON.stringify(world, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : value,
  );
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++)
    hash = Math.imul(hash ^ canonical.charCodeAt(i), 0x01000193) >>> 0;
  return `${canonical.length}-${hash.toString(16).padStart(8, "0")}`;
}

export function createWorldDraft(world: WorldPlan): WorldDraft {
  return { baseRevision: worldRevision(world), world: structuredClone(world) };
}

export type WorldCommit =
  | { status: "committed"; authoring: AuthoringState }
  /** A room or remix turn owns the session world until its staged fork
   *  adopts back — a mid-turn commit would be silently overwritten. */
  | { status: "busy" }
  | { status: "conflict" }
  | { status: "invalid"; error: string };

/**
 * Commit a draft back: the base revision must still match (unless the draft
 * is an adoption), then the merged world passes the shared validator —
 * the same limits update_world enforces. `authoring` is never mutated.
 */
export function commitWorldDraft(authoring: AuthoringState, draft: WorldDraft): WorldCommit {
  if (draft.baseRevision !== "" && worldRevision(authoring.world) !== draft.baseRevision)
    return { status: "conflict" };
  return commitWorld(authoring, draft.world);
}

/**
 * Commit a full replacement world — the plan surface writes whole rooms, and
 * adopting a restored draft replaces the empty world of a fresh session.
 */
export function commitWorld(authoring: AuthoringState, world: WorldPlan): WorldCommit {
  try {
    const committed = validateAuthoringState({ ...authoring, world });
    return { status: "committed", authoring: committed };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Validate a draft-in-progress; null means the draft would commit cleanly. */
export function validateWorldDraft(draft: WorldDraft): string | null {
  try {
    validateAuthoringState({ version: 1, bindings: {}, world: draft.world });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const EDIT_LIMITS = { title: 160, exitName: 32 };

/**
 * Apply one player edit: mutate a candidate world, validate it against the
 * shared limits, and advance the draft only on success — a rejected edit
 * leaves the draft untouched instead of poisoning later edits.
 */
function applyEdit(draft: WorldDraft, mutate: (world: WorldPlan) => void): string | null {
  const candidate = structuredClone(draft.world);
  mutate(candidate);
  const error = validateWorldDraft({ baseRevision: "", world: candidate });
  if (!error) draft.world = candidate;
  return error;
}

/**
 * One compound edit (e.g. a room plus its connecting exit): mutate a
 * candidate world, validate it, and advance the draft only on success.
 */
export function draftEdit(draft: WorldDraft, mutate: (world: WorldPlan) => void): string | null {
  return applyEdit(draft, mutate);
}

/** Lowest unused room number, honoring rooms and any externally-taken numbers. */
export function lowestFreeRoom(
  rooms: WorldRooms,
  taken?: (num: number) => boolean,
): number | undefined {
  for (let num = 1; num <= 255; num++) {
    if (!rooms[String(num)] && !taken?.(num)) return num;
  }
  return undefined;
}

export function draftRenameRoom(draft: WorldDraft, room: number, title: string): string | null {
  if (!draft.world.rooms[String(room)]) return `Room ${room} is not in the plan`;
  if (!title.trim()) return "A room needs a title";
  return applyEdit(draft, (world) => {
    world.rooms[String(room)]!.title = title.trim();
  });
}

export function draftSetBrief(draft: WorldDraft, room: number, description: string): string | null {
  if (!draft.world.rooms[String(room)]) return `Room ${room} is not in the plan`;
  return applyEdit(draft, (world) => {
    world.rooms[String(room)]!.description = description.trim();
  });
}

export function draftAddRoom(
  draft: WorldDraft,
  room: number,
  title: string,
  description: string,
): string | null {
  if (!Number.isInteger(room) || room < 1 || room > 255) return "Invalid room number";
  if (draft.world.rooms[String(room)]) return `Room ${room} is already planned`;
  if (!title.trim()) return "A room needs a title";
  return applyEdit(draft, (world) => {
    world.rooms[String(room)] = { title: title.trim(), description: description.trim(), exits: {} };
  });
}

/** Remove a planned room and prune every exit that pointed at it. */
export function draftRemoveRoom(draft: WorldDraft, room: number): string | null {
  if (!draft.world.rooms[String(room)]) return `Room ${room} is not in the plan`;
  return applyEdit(draft, (world) => {
    delete world.rooms[String(room)];
    for (const entry of Object.values(world.rooms))
      for (const [name, target] of Object.entries(entry.exits))
        if (target === room) delete entry.exits[name];
  });
}

export function draftAddExit(
  draft: WorldDraft,
  from: number,
  name: string,
  to: number,
): string | null {
  if (!draft.world.rooms[String(from)]) return `Room ${from} is not in the plan`;
  const label = name.trim();
  if (!label) return "An exit needs a name";
  if (label.length > EDIT_LIMITS.exitName) return "Exit name is too long";
  if (!draft.world.rooms[String(to)]) return `Room ${to} is not in the plan`;
  return applyEdit(draft, (world) => {
    world.rooms[String(from)]!.exits[label] = to;
  });
}

export function draftRemoveExit(draft: WorldDraft, from: number, name: string): string | null {
  const entry = draft.world.rooms[String(from)];
  if (!entry) return `Room ${from} is not in the plan`;
  if (!(name in entry.exits)) return `Room ${from} has no exit '${name}'`;
  return applyEdit(draft, (world) => {
    delete world.rooms[String(from)]!.exits[name];
  });
}
