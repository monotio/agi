/**
 * Editable boilerplate supplied before genesis: logic 0 provides menus, parser
 * fallbacks and room dispatch; logic 255 and sound 255 provide a death sequence.
 * These are ordinary AGI resources. Authors may use, extend or replace them
 * and their state conventions as the game requires.
 *
 * The default bytecode is asserted by hand in test/base-template.test.ts.
 */

import { assembleLogic, type AssembleResult } from "../logic/assembler.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { buildSound, type SoundTrackInput } from "../sound/build.ts";

/** The shared death logic a room invokes with `call(255)`. */
export const TEMPLATE_DEATH_LOGIC = 255;
/** The template death sound `load.sound`/`sound` address. */
export const TEMPLATE_DEATH_SOUND = 255;
/**
 * Template logic 0: first-cycle boot builds the menu bar and key bindings and
 * enters room 1; every later cycle runs the room first, then the menu and key
 * dispatch, then the parser fallbacks — exactly one reply for an unhandled
 * line, none while a menu or prompt owns input.
 *
 * Controller map: 200 ESC->menu; 201 save/F5; 202 restore/F7; 203 restart/F9;
 * 204 quit/Alt-Z; 205-208 speed; 209-210 sound; 211 help/F1; 212 about;
 * 213 Tab -> inventory. While f202 (dead) is set, logic 0 re-calls logic 255
 * every cycle for the death-box poll and skips the menu/key dispatch — the
 * F7/F9/Alt-Z controllers are read inside logic 255 instead.
 */
export const BASE_TEMPLATE_LOGIC0_SOURCE = `#define C_MENU 200
#define C_SAVE 201
#define C_RESTORE 202
#define C_RESTART 203
#define C_QUIT 204
#define C_SLOW 205
#define C_NORMAL 206
#define C_FAST 207
#define C_FASTEST 208
#define C_SOUND_ON 209
#define C_SOUND_OFF 210
#define C_HELP 211
#define C_ABOUT 212
#define C_INVENTORY 213
#message 1 "File"
#message 2 "Save Game      F5"
#message 3 "Restore Game   F7"
#message 4 "Restart Game   F9"
#message 5 "Quit          Alt+Z"
#message 6 "Speed"
#message 7 "Slow"
#message 8 "Normal"
#message 9 "Fast"
#message 10 "Fastest"
#message 11 "Sound"
#message 12 "On"
#message 13 "Off"
#message 14 "Help"
#message 15 "Help           F1"
#message 16 "About"
if (!isset(f200)) {
  set(f200);
  configure.screen(1, 22, 0);
  status.line.on();
  set(f9);
  assignn(v10, 2);
  set.menu(m1);
  set.menu.item(m2, C_SAVE);
  set.menu.item(m3, C_RESTORE);
  set.menu.item(m4, C_RESTART);
  set.menu.item(m5, C_QUIT);
  set.menu(m6);
  set.menu.item(m7, C_SLOW);
  set.menu.item(m8, C_NORMAL);
  set.menu.item(m9, C_FAST);
  set.menu.item(m10, C_FASTEST);
  set.menu(m11);
  set.menu.item(m12, C_SOUND_ON);
  set.menu.item(m13, C_SOUND_OFF);
  set.menu(m14);
  set.menu.item(m15, C_HELP);
  set.menu.item(m16, C_ABOUT);
  submit.menu();
  set(f14);
  set.key(27, 0, C_MENU);
  set.key(0, 59, C_HELP);
  set.key(0, 63, C_SAVE);
  set.key(0, 65, C_RESTORE);
  set.key(0, 67, C_RESTART);
  set.key(0, 44, C_QUIT);
  set.key(9, 0, C_INVENTORY);
  assignn(v0, 1);
  new.room.v(v0);
}
call.v(v0);
if (isset(f202)) { call(255); }
if (!isset(f202)) {
  if (controller(C_MENU)) { menu.input(); }
  if (controller(C_SAVE)) { save.game(); }
  if (controller(C_RESTORE)) { restore.game(); }
  if (controller(C_RESTART)) { restart.game(); }
  if (controller(C_QUIT)) { quit(0); }
  if (controller(C_SLOW)) { assignn(v10, 4); }
  if (controller(C_NORMAL)) { assignn(v10, 2); }
  if (controller(C_FAST)) { assignn(v10, 1); }
  if (controller(C_FASTEST)) { assignn(v10, 0); }
  if (controller(C_SOUND_ON)) { set(f9); }
  if (controller(C_SOUND_OFF)) { reset(f9); }
  if (controller(C_HELP)) { print("Type a command and press ENTER. Arrow keys walk. ESC opens the menu."); }
  if (controller(C_ABOUT)) { print("An adventure written with AGI IS HERE."); }
  if (controller(C_INVENTORY)) { status(); }
}
if (isset(f2) && !isset(f4) && !isset(f202)) {
  if (greatern(v9, 0)) {
    if (equaln(v9, 1)) { word.to.string(s11, 1); }
    if (equaln(v9, 2)) { word.to.string(s11, 2); }
    if (equaln(v9, 3)) { word.to.string(s11, 3); }
    if (equaln(v9, 4)) { word.to.string(s11, 4); }
    if (equaln(v9, 5)) { word.to.string(s11, 5); }
    if (equaln(v9, 6)) { word.to.string(s11, 6); }
    if (equaln(v9, 7)) { word.to.string(s11, 7); }
    if (equaln(v9, 8)) { word.to.string(s11, 8); }
    if (equaln(v9, 9)) { word.to.string(s11, 9); }
    if (equaln(v9, 10)) { word.to.string(s11, 10); }
    if (equaln(v9, 11)) { word.to.string(s11, 11); }
    print("I don't know the word \\"%s11\\".");
  } else {
    print("I don't understand that.");
  }
}
return;
`;

/**
 * Template logic 255, the shared death handler. A room prints its own death
 * line first, then `call(255)`: the first call stops movement, silences the
 * parser and menu, plays the death sound and draws the choice box; while f202
 * stays set logic 0 re-calls this logic every cycle, which is how the box
 * polls — v19 carries the raw key, F7/F9/Alt-Z arrive as controllers, and the
 * box redraws each pass so a cancelled selector never leaves a broken screen.
 * SPACE steps the choice down, ENTER takes it, 1-3 choose directly. Restore,
 * restart and quit all run through the ordinary engine flows: a successful
 * restore or an accepted restart aborts this pass outright, while a cancelled
 * or failed restore falls through to the redraw — the player stays dead,
 * never walking in a broken control mode.
 */
export const BASE_TEMPLATE_DEATH_LOGIC_SOURCE = `#define C_RESTORE 202
#define C_RESTART 203
#define C_QUIT 204
#message 1 ">"
#message 2 " "
#message 3 "You have died."
#message 4 "Restore"
#message 5 "Restart"
#message 6 "Quit"
#message 7 "1-3, SPACE, ENTER"
if (!isset(f202)) {
  set(f202);
  assignn(v250, 0);
  program.control();
  prevent.input();
  stop.motion(o0);
  stop.cycling(o0);
  reset(f14);
  load.sound(255);
  sound(255, f201);
}
reset(f203);
if (equaln(v19, 32)) {
  increment(v250);
  if (equaln(v250, 3)) { assignn(v250, 0); }
}
if (equaln(v19, 49)) { assignn(v250, 0); set(f203); }
if (equaln(v19, 50)) { assignn(v250, 1); set(f203); }
if (equaln(v19, 51)) { assignn(v250, 2); set(f203); }
if (equaln(v19, 13)) { set(f203); }
if (controller(C_RESTORE)) { assignn(v250, 0); set(f203); }
if (controller(C_RESTART)) { assignn(v250, 1); set(f203); }
if (controller(C_QUIT)) { assignn(v250, 2); set(f203); }
if (isset(f203)) {
  if (equaln(v250, 0)) { restore.game(); }
  if (equaln(v250, 1)) { set(f16); restart.game(); }
  if (equaln(v250, 2)) { quit(0); }
}
set.text.attribute(0, 15);
clear.text.rect(9, 10, 16, 30, 15);
display(10, 14, m3);
display(12, 15, m4);
display(13, 15, m5);
display(14, 15, m6);
display(15, 12, m7);
if (equaln(v250, 0)) { display(12, 13, m1); display(13, 13, m2); display(14, 13, m2); }
if (equaln(v250, 1)) { display(12, 13, m2); display(13, 13, m1); display(14, 13, m2); }
if (equaln(v250, 2)) { display(12, 13, m2); display(13, 13, m2); display(14, 13, m1); }
set.text.attribute(15, 0);
return;
`;

/** A descending sting; stored divisors preserve the released resource bytes. */
export const BASE_TEMPLATE_DEATH_TRACKS: readonly SoundTrackInput[] = [
  {
    notes: [
      { freqDivisor: 254, duration: 6 },
      { freqDivisor: 302, duration: 6 },
      { freqDivisor: 380, duration: 6 },
      { freqDivisor: 507, duration: 24 },
    ],
  },
  {
    notes: [
      { freqDivisor: 302, duration: 6 },
      { freqDivisor: 380, duration: 6 },
      { freqDivisor: 507, duration: 6 },
      { freqDivisor: 760, duration: 24 },
    ],
  },
  { notes: [{ note: "rest", duration: 42 }] },
  { notes: [{ note: "rest", duration: 42 }] },
];

export interface BaseTemplateBuild {
  readonly logic0: AssembleResult;
  readonly deathLogic: AssembleResult;
  readonly deathSound: Uint8Array;
}

/**
 * Compile the boilerplate resources for one dictionary/profile pair. Pure:
 * same inputs give the same payloads; nothing is stored or mutated here.
 */
export function compileBaseTemplate(options: {
  dictionary: ReadonlyMap<string, number>;
  profile: AgiProfile;
}): BaseTemplateBuild {
  return {
    logic0: assembleLogic(BASE_TEMPLATE_LOGIC0_SOURCE, options),
    deathLogic: assembleLogic(BASE_TEMPLATE_DEATH_LOGIC_SOURCE, options),
    deathSound: buildSound(BASE_TEMPLATE_DEATH_TRACKS),
  };
}
