/**
 * The World panel's words for room → picture facts (roomPictureUse): the
 * chip on a room row, the line on its detail card, and which picture — if
 * any — "Open in Studio" can open. Honest by construction: a room number is
 * never offered as its picture number.
 */
import type { RoomPictureUse } from "../../../src/agent/roomPictures.ts";

export interface RoomPictureLabels {
  readonly chip: string;
  readonly tone: "neutral" | "warn";
  /** The detail card's sentence, e.g. "PIC 5 · shared with room 6". */
  readonly detail: string;
  /** The picture Studio opens: the first one the room draws that exists. */
  readonly studioPicture?: number | undefined;
  /** Why Studio cannot open, when it cannot. */
  readonly studioBlocked?: string | undefined;
}

export const RUNTIME_PICTURE = "picture chosen at runtime";

function roomList(rooms: readonly number[]): string {
  if (rooms.length === 1) return `room ${rooms[0]}`;
  return `rooms ${rooms.slice(0, -1).join(", ")} and ${rooms.at(-1)}`;
}

export function roomPictureLabels(use: RoomPictureUse, planned: boolean): RoomPictureLabels {
  if (!use.built)
    return {
      chip: planned ? "plan" : "no logic",
      tone: "warn",
      detail: "Not built yet: no picture to open.",
      studioBlocked: "This room is not built yet, so it has no picture to open.",
    };
  if (use.pictures.length > 0) {
    const shared = use.pictures.some((p) => p.sharedWith.length > 0);
    const parts = use.pictures.map((p) => {
      if (!p.exists) return `PIC ${p.picture} · not in this game's resources`;
      return p.sharedWith.length
        ? `PIC ${p.picture} · shared with ${roomList(p.sharedWith)}`
        : `PIC ${p.picture}`;
    });
    if (use.runtime) parts.push(`plus a ${RUNTIME_PICTURE}`);
    const studio = use.pictures.find((p) => p.exists)?.picture;
    return {
      chip: `${use.pictures.map((p) => `PIC ${p.picture}`).join(", ")}${shared ? " · shared" : ""}`,
      tone: "neutral",
      detail: parts.join(", "),
      studioPicture: studio,
      studioBlocked:
        studio === undefined
          ? `PIC ${use.pictures[0]!.picture} is not in this game's resources.`
          : undefined,
    };
  }
  if (use.runtime)
    return {
      chip: "runtime",
      tone: "neutral",
      detail: RUNTIME_PICTURE,
      studioBlocked:
        "This room's picture is chosen at runtime, so there is no one picture to open.",
    };
  return {
    chip: "no picture",
    tone: "neutral",
    detail: "Its logic draws no picture.",
    studioBlocked: "This room's logic draws no picture.",
  };
}
