/**
 * The blank game's first room: Room 1 with a blank white PICTURE and a few
 * lines of LOGIC that show it, plus a minimal readable Start-up LOGIC 0 that
 * enters Room 1. No hero, menus, game over, flags, sound or LOGIC 255 — the
 * creator adds those as parts when they want them. The bindings stay empty so
 * Game state stays empty until the creator names something.
 *
 * LOGIC 0 enters Room 1 on the first cycle (current_room, the current room number, is
 * 0 before the first room) and runs the current room's LOGIC every cycle
 * after, so rooms added later need no registration.
 *
 * The compiled bytes are asserted by hand in test/first-room.test.ts.
 */
import type { ProjectChange } from "./projectContent.ts";

export const FIRST_STARTUP_LOGIC0_SOURCE = `// Start-up: the game begins in Room 1. Every cycle runs the current
// room's LOGIC; current_room holds the room number and is 0 before the first room.
if (equaln(current_room, 0)) {
  new.room(1);
}
call.v(current_room);
return;
`;

export const FIRST_ROOM_LOGIC_SOURCE = `// Room 1. The new_room block runs once when the player enters: it shows this
// room's PICTURE and hands control to the player. load.pic and draw.pic
// read the picture number from a variable (v50 here).
if (isset(new_room)) {
  assignn(v50, 1);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  accept.input();
}
return;
`;

export const FIRST_ROOM_PICTURE_SOURCE = `# Room 1: an empty picture. Draw on it or replace it.
end
`;

/** The complete editable document set for a blank game's first room. */
export function firstRoomChanges(): readonly ProjectChange[] {
  return [
    { key: "logic:0", content: FIRST_STARTUP_LOGIC0_SOURCE },
    { key: "logic:1", content: FIRST_ROOM_LOGIC_SOURCE },
    { key: "picture:1", content: FIRST_ROOM_PICTURE_SOURCE },
    {
      key: "world",
      content: JSON.stringify({
        rooms: { "1": { title: "Room 1", titleIsDefault: true, description: "", exits: {} } },
        facts: {},
        quests: {},
      }),
    },
    { key: "bindings", content: "{}" },
    { key: "words", content: "[]" },
    { key: "inventory", content: "[]" },
  ];
}
