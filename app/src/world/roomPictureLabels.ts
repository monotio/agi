/**
 * The World panel's words for room → picture facts (roomPictureUse): the
 * chip on a room row, the line on its detail card, and which pictures — if
 * any — "Open in Studio" can open. Honest by construction: a room number is
 * never offered as its picture number.
 */
import { numberedLabel, type NumberedLabelContext } from "../../../src/logic/numberedLabels.ts";
import type { RoomPictureUse } from "../../../src/agent/roomPictures.ts";

export interface RoomPictureLabels {
  readonly chip: string;
  readonly tone: "neutral" | "warn";
  /** The detail card's sentence, e.g. "PIC 5 · shared with room 6". */
  readonly detail: string;
  /**
   * The pictures Studio can open, in the order the room's logic names them:
   * a room that overlays one picture on another (the tutorial gallery's
   * mural) offers each.
   */
  readonly studioPictures: readonly number[];
  /** Why Studio cannot open, when it cannot. */
  readonly studioBlocked?: string | undefined;
}

const RUNTIME_PICTURE = "picture chosen at runtime";

function roomList(rooms: readonly number[], context: NumberedLabelContext): string {
  const names = rooms.map((num) => numberedLabel("room", num, context, "option"));
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function roomPictureLabels(
  use: RoomPictureUse,
  planned: boolean,
  context: NumberedLabelContext = {},
): RoomPictureLabels {
  if (!use.built)
    return {
      chip: planned ? "plan" : "no logic",
      tone: "warn",
      detail: "Not built yet: no picture to open.",
      studioPictures: [],
      studioBlocked: "This room is not built yet, so it has no picture to open.",
    };
  if (use.pictures.length > 0) {
    const shared = use.pictures.some((p) => p.sharedWith.length > 0);
    const parts = use.pictures.map((p) => {
      if (!p.exists)
        return `${numberedLabel("picture", p.picture, context, "option")} · not in this game's resources`;
      return p.sharedWith.length
        ? `${numberedLabel("picture", p.picture, context, "option")} · shared with ${roomList(p.sharedWith, context)}`
        : `${numberedLabel("picture", p.picture, context, "option")}`;
    });
    if (use.runtime) parts.push(`plus a ${RUNTIME_PICTURE}`);
    const studio = use.pictures.filter((p) => p.exists).map((p) => p.picture);
    return {
      chip: `${use.pictures.map((p) => `${numberedLabel("picture", p.picture, context, "option")}`).join(", ")}${shared ? " · shared" : ""}`,
      tone: "neutral",
      detail: parts.join(", "),
      studioPictures: studio,
      studioBlocked:
        studio.length === 0
          ? `${numberedLabel("picture", use.pictures[0]!.picture, context, "option")} is not in this game's resources.`
          : undefined,
    };
  }
  if (use.runtime)
    return {
      chip: "runtime",
      tone: "neutral",
      detail: RUNTIME_PICTURE,
      studioPictures: [],
      studioBlocked:
        "This room's picture is chosen at runtime, so there is no one picture to open.",
    };
  return {
    chip: "no picture",
    tone: "neutral",
    detail: "Its logic draws no picture.",
    studioPictures: [],
    studioBlocked: "This room's logic draws no picture.",
  };
}
