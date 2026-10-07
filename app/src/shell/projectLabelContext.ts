/** Load authored names once for the shared numbered-label presentation contract. */
import { readBindingsDocument } from "../../../src/authoring/projectBindings.ts";
import { readInventoryObjects } from "../../../src/authoring/inventory.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import type { NumberedLabelContext } from "../../../src/logic/numberedLabels.ts";
import type { ProjectContent } from "../../../src/authoring/projectContent.ts";
import { DEFAULT_V2_PROFILE, type AgiProfile } from "../../../src/runtime/profile.ts";

/** Authored picture headings can name a room whose picture association is known. */
export function pictureRoomTitle(content: ProjectContent | undefined): string | undefined {
  if (typeof content !== "string") return undefined;
  return /^#\s*([^:\n—]+)(?::|—)/.exec(content)?.[1]?.trim();
}

interface RoomLabelSource {
  readonly room: number;
  readonly title?: string | undefined;
  readonly pictures?: readonly number[];
}

export function projectLabelContext(
  documents: Readonly<Record<string, ProjectContent>>,
  profile: AgiProfile = DEFAULT_V2_PROFILE,
  roomSources: readonly RoomLabelSource[] = [],
): NumberedLabelContext {
  const context: { -readonly [K in keyof NumberedLabelContext]: NumberedLabelContext[K] } = {};
  const bindings = documents["bindings"];
  const inventory = documents["inventory"];
  const words = documents["words"];
  const world = documents["world"];
  // A partial document must not hide the names in other valid documents.
  try {
    if (typeof bindings === "string") context.bindings = readBindingsDocument(bindings);
  } catch {
    /* Use system names and slots. */
  }
  try {
    if (inventory) {
      const entries: unknown =
        typeof inventory === "string"
          ? JSON.parse(inventory)
          : readInventoryObjects(inventory, profile);
      if (Array.isArray(entries))
        context.inventory = entries.map((entry: unknown) =>
          entry !== null &&
          typeof entry === "object" &&
          "name" in entry &&
          typeof entry.name === "string"
            ? { name: entry.name }
            : { name: "" },
        );
    }
  } catch {
    /* Keep item identities. */
  }
  try {
    if (words) {
      const entries: unknown =
        typeof words === "string"
          ? JSON.parse(words)
          : parseWordsTok(words).map(({ word, id }) => [word, id]);
      if (Array.isArray(entries))
        context.words = entries.filter(
          (entry: unknown): entry is [string, number] =>
            Array.isArray(entry) && typeof entry[0] === "string" && Number.isInteger(entry[1]),
        );
    }
  } catch {
    /* Keep word groups. */
  }
  try {
    if (typeof world === "string") {
      const rooms =
        (JSON.parse(world) as { rooms?: Record<string, { title?: string }> }).rooms ?? {};
      context.rooms = Object.entries(rooms).map(([room, entry]) => ({
        room: Number(room),
        ...(entry.title ? { title: entry.title } : {}),
      }));
    }
  } catch {
    /* Keep room identities. */
  }
  if (roomSources.length) {
    const rooms = new Map((context.rooms ?? []).map((room) => [room.room, room]));
    for (const source of roomSources) {
      const heading = source.pictures
        ?.map((num) => pictureRoomTitle(documents[`picture:${num}`]))
        .find((title) => title);
      const title = rooms.get(source.room)?.title || heading || source.title;
      rooms.set(source.room, { room: source.room, ...(title ? { title } : {}) });
    }
    context.rooms = [...rooms.values()].sort((a, b) => a.room - b.room);
  }
  return context;
}
