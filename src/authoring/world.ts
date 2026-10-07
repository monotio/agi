/**
 * World-document transforms that preserve everything they do not touch. Room
 * names are world metadata: an edit that renames a room carries its exits,
 * description and launches along unchanged.
 */
import type { AuthoringState } from "./authoringState.ts";

type World = AuthoringState["world"];

/** Rename a room in place, keeping its exits, description and launches. */
export function renameRoomTitle(world: World, room: number, title: string): World {
  const next = JSON.parse(JSON.stringify(world)) as World;
  const key = String(room);
  const entry = next.rooms[key] ?? { title: "", description: "", exits: {} };
  delete entry.titleIsDefault;
  next.rooms[key] = { ...entry, title };
  return next;
}
