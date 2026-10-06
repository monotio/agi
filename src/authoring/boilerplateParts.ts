/**
 * Ready shared-code parts offered next to SHARED LOGIC: menus and
 * Save/Restore, game over and a score screen. Each part is one ordinary
 * readable LOGIC the creator calls from their own code; the header comment
 * says where. State the part needs is allocated by the caller and named here,
 * so the sources below interpolate the issued binding names.
 */

export type BoilerplatePart = "menus" | "game-over" | "score";

export const BOILERPLATE_PART_LABEL: Record<BoilerplatePart, string> = {
  menus: "Menus and Save/Restore",
  "game-over": "game over",
  score: "score screen",
};

/** Binding name stems per part; the caller suffixes taken names. */
export const BOILERPLATE_PART_STEMS: Record<BoilerplatePart, readonly string[]> = {
  menus: ["menus_logic", "menus_ready"],
  "game-over": ["game_over_logic", "dead", "game_over_chosen", "game_over_cursor"],
  score: ["score_logic"],
};

export function menusSource(names: { menusLogic: string; menusReady: string }): string {
  return `// Menus and Save/Restore. LOGIC 0 calls this every cycle, after the room:
//   call.v(v0);
//   call(${names.menusLogic});
// The first call builds the menu bar and keys; every call answers them.
#define C_MENU 200
#define C_SAVE 201
#define C_RESTORE 202
#define C_RESTART 203
#define C_QUIT 204
#define C_SOUND_ON 209
#define C_SOUND_OFF 210
#define C_HELP 211
#define C_ABOUT 212
#message 1 "File"
#message 2 "Save Game      F5"
#message 3 "Restore Game   F7"
#message 4 "Restart Game   F9"
#message 5 "Quit          Alt+Z"
#message 6 "Sound"
#message 7 "On"
#message 8 "Off"
#message 9 "Help"
#message 10 "Help           F1"
#message 11 "About"
if (!isset(${names.menusReady})) {
  set(${names.menusReady});
  status.line.on();
  set(f9);
  set.menu(m1);
  set.menu.item(m2, C_SAVE);
  set.menu.item(m3, C_RESTORE);
  set.menu.item(m4, C_RESTART);
  set.menu.item(m5, C_QUIT);
  set.menu(m6);
  set.menu.item(m7, C_SOUND_ON);
  set.menu.item(m8, C_SOUND_OFF);
  set.menu(m9);
  set.menu.item(m10, C_HELP);
  set.menu.item(m11, C_ABOUT);
  submit.menu();
  set.key(27, 0, C_MENU);
  set.key(0, 59, C_HELP);
  set.key(0, 63, C_SAVE);
  set.key(0, 65, C_RESTORE);
  set.key(0, 67, C_RESTART);
  set.key(0, 44, C_QUIT);
}
if (controller(C_MENU)) { menu.input(); }
if (controller(C_SAVE)) { save.game(); }
if (controller(C_RESTORE)) { restore.game(); }
if (controller(C_RESTART)) { restart.game(); }
if (controller(C_QUIT)) { quit(0); }
if (controller(C_SOUND_ON)) { set(f9); }
if (controller(C_SOUND_OFF)) { reset(f9); }
if (controller(C_HELP)) { print("Type a command and press ENTER. Arrow keys walk. ESC opens the menu."); }
if (controller(C_ABOUT)) { print("An adventure written with AGI IS HERE."); }
return;
`;
}

export function gameOverSource(names: {
  gameOverLogic: string;
  dead: string;
  chosen: string;
  cursor: string;
}): string {
  return `// Game over. A room calls this when the player dies: call(${names.gameOverLogic});
// LOGIC 0 re-calls it every cycle while the player is dead, so the box can
// answer keys:
//   if (isset(${names.dead})) { call(${names.gameOverLogic}); }
// SPACE steps the choice, ENTER takes it, 1-3 choose directly. The Menus and
// Save/Restore part binds F7, F9 and Alt+Z to the same choices.
#define C_RESTORE 202
#define C_RESTART 203
#define C_QUIT 204
#message 1 ">"
#message 2 " "
#message 3 "You have died."
#message 4 "Restore"
#message 5 "Restart"
#message 6 "Quit"
#message 7 "1-3, SPACE, ENTER"
if (!isset(${names.dead})) {
  set(${names.dead});
  assignn(${names.cursor}, 0);
  program.control();
  prevent.input();
  stop.motion(o0);
  stop.cycling(o0);
}
reset(${names.chosen});
if (equaln(v19, 32)) {
  increment(${names.cursor});
  if (equaln(${names.cursor}, 3)) { assignn(${names.cursor}, 0); }
}
if (equaln(v19, 49)) { assignn(${names.cursor}, 0); set(${names.chosen}); }
if (equaln(v19, 50)) { assignn(${names.cursor}, 1); set(${names.chosen}); }
if (equaln(v19, 51)) { assignn(${names.cursor}, 2); set(${names.chosen}); }
if (equaln(v19, 13)) { set(${names.chosen}); }
if (controller(C_RESTORE)) { assignn(${names.cursor}, 0); set(${names.chosen}); }
if (controller(C_RESTART)) { assignn(${names.cursor}, 1); set(${names.chosen}); }
if (controller(C_QUIT)) { assignn(${names.cursor}, 2); set(${names.chosen}); }
if (isset(${names.chosen})) {
  if (equaln(${names.cursor}, 0)) { restore.game(); }
  if (equaln(${names.cursor}, 1)) { set(f16); restart.game(); }
  if (equaln(${names.cursor}, 2)) { quit(0); }
}
set.text.attribute(0, 15);
clear.text.rect(9, 10, 16, 30, 15);
display(10, 14, m3);
display(12, 15, m4);
display(13, 15, m5);
display(14, 15, m6);
display(15, 12, m7);
if (equaln(${names.cursor}, 0)) { display(12, 13, m1); display(13, 13, m2); display(14, 13, m2); }
if (equaln(${names.cursor}, 1)) { display(12, 13, m2); display(13, 13, m1); display(14, 13, m2); }
if (equaln(${names.cursor}, 2)) { display(12, 13, m2); display(13, 13, m2); display(14, 13, m1); }
set.text.attribute(15, 0);
return;
`;
}

export function scoreSource(scoreLogic: string): string {
  return `// Score screen. Call it to show the score and wait for a key:
//   call(${scoreLogic});
// v3 holds the score and v7 the maximum, as the status line shows.
#message 1 "Score: %v3 of %v7"
print(m1);
return;
`;
}
