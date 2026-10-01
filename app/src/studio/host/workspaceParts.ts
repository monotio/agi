import { VOCABULARY } from "../../../../src/vocabulary.ts";
/** Resource rows shared by the parts list and Quick open. */
interface WorkspacePart {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly child: boolean;
  readonly live: boolean;
  readonly room?: number;
}
export interface WorkspacePartGroup {
  readonly label: string;
  readonly help: string;
  readonly entries: readonly WorkspacePart[];
}
const HELP: Record<string, string> = {
  GAME: "Notes hold your game’s style, tone and rules.",
  ROOMS: VOCABULARY.room.help,
  "SHARED LOGIC": VOCABULARY.sharedLogic.help,
  PICTURES: VOCABULARY.picture.help,
  VIEWS: VOCABULARY.view.help,
  SOUNDS: VOCABULARY.sound.help,
  OBJECTS: VOCABULARY.objects.help,
  WORDS: VOCABULARY.words.help,
};
export function workspaceParts(input: {
  readonly keys: readonly string[];
  readonly rooms: readonly {
    readonly room: number;
    readonly title?: string;
    readonly pictures: readonly number[];
  }[];
  readonly names?: Readonly<Record<string, string>>;
  readonly currentRoom: number | null;
}): readonly WorkspacePartGroup[] {
  const keys = new Set(input.keys);
  const owned = new Set<number>();
  const rooms = new Set<number>();
  const group = (label: string, entries: WorkspacePart[]): WorkspacePartGroup => ({
    label,
    help: HELP[label]!,
    entries,
  });
  const row = (key: string, label: string, extra: Partial<WorkspacePart> = {}): WorkspacePart => ({
    key,
    id: key,
    label,
    child: false,
    live: false,
    ...extra,
  });
  const roomRows: WorkspacePart[] = [];
  for (const room of [...input.rooms].sort((a, b) => a.room - b.room)) {
    if (!keys.has(`logic:${room.room}`)) continue;
    rooms.add(room.room);
    roomRows.push(
      row(
        `logic:${room.room}`,
        room.title ? `${room.title} · ROOM ${room.room}` : `ROOM ${room.room}`,
        { id: `room:${room.room}`, room: room.room, live: room.room === input.currentRoom },
      ),
    );
    for (const pic of room.pictures) {
      if (!keys.has(`picture:${pic}`)) continue;
      owned.add(pic);
      roomRows.push(
        row(`picture:${pic}`, `PICTURE ${pic}`, {
          id: `room:${room.room}:picture:${pic}`,
          room: room.room,
          child: true,
        }),
      );
    }
    roomRows.push(
      row(`logic:${room.room}`, `LOGIC ${room.room}`, {
        id: `room:${room.room}:logic`,
        child: true,
      }),
    );
  }
  const resources = (kind: string, label: string, accept: (num: number) => boolean = () => true) =>
    input.keys
      .filter((key) => key.startsWith(`${kind}:`) && accept(Number(key.split(":")[1])))
      .sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]))
      .map((key) => {
        const num = Number(key.split(":")[1]);
        const name =
          input.names?.[key] ??
          (kind === "logic"
            ? num === 0
              ? "Start-up and menus"
              : num === 255
                ? "Game over"
                : undefined
            : undefined);
        return row(key, name ? `${name} · ${label} ${num}` : `${label} ${num}`);
      });
  return [
    group("GAME", [row("notes", "Notes")]),
    group("ROOMS", roomRows),
    group(
      "SHARED LOGIC",
      resources("logic", "LOGIC", (n) => !rooms.has(n)),
    ),
    group(
      "PICTURES",
      resources("picture", "PICTURE", (n) => !owned.has(n)),
    ),
    group("VIEWS", resources("view", "VIEW")),
    group("SOUNDS", resources("sound", "SOUND")),
    group("OBJECTS", keys.has("inventory") ? [row("inventory", "OBJECTS")] : []),
    group("WORDS", keys.has("words") ? [row("words", "WORDS")] : []),
  ];
}

/** A resource has one Quick open result; room results retain both searchable IDs. */
export function workspaceOpenParts(
  groups: readonly WorkspacePartGroup[],
): readonly { key: string; label: string }[] {
  const seen = new Set<string>();
  const result: { key: string; label: string }[] = [];
  for (const row of groups.flatMap((group) => group.entries)) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    result.push({
      key: row.key,
      label:
        row.room !== undefined && !row.child
          ? `${row.label} · ${row.key.replace(":", " ").toUpperCase()}`
          : row.label,
    });
  }
  return result;
}
