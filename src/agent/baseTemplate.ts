/**
 * The fixed base template a newly authored game starts from. The harness writes these resources at genesis, not the model: logic
 * 0 owns the menu bar, the parser fallbacks and the room dispatch; logic 255
 * is the shared death logic a room calls the way Sierra rooms called theirs;
 * sound 255 is the one death sound.
 *
 * Reserved slots a template game must not reuse: flags f200-f209, variables
 * v248-v255, controllers 200-219, string s11, logics 0 and 250-255, sounds
 * 250-255. The authoring guide documents them; the tools reject writes and
 * bindings into them while the template marker is on the authoring state.
 *
 * Every byte of the compiled logics is asserted hand-computed in
 * test/base-template.test.ts; keep the sources and that test in lockstep.
 */

import { assembleLogic } from "../logic/assembler.ts";
import { decodeLogicActions } from "../logic/disassembler.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { buildSound, type SoundTrackInput } from "./soundBuilder.ts";
import type { AgentSessionState } from "./tools.ts";

/** The shared death logic a room invokes with `call(255)`. */
export const TEMPLATE_DEATH_LOGIC = 255;
/** The template death sound `load.sound`/`sound` address. */
export const TEMPLATE_DEATH_SOUND = 255;
/** First controller number the template's menus and key bindings own. */
export const TEMPLATE_CONTROLLER_BASE = 200;
/** One past the last controller the template owns. */
export const TEMPLATE_CONTROLLER_LIMIT = 220;
/** First flag the template owns (f200 boot latch; f201 death-sound done; f202 dead; f203 death-choice scratch). */
export const TEMPLATE_FLAG_BASE = 200;
/** One past the last flag the template owns. */
export const TEMPLATE_FLAG_LIMIT = 210;
/** First variable the template owns (v250 death choice; v251-v255 scratch). */
export const TEMPLATE_VARIABLE_BASE = 248;
/** One past the last variable the template owns. */
export const TEMPLATE_VARIABLE_LIMIT = 256;
/** The scratch string the unknown-word fallback echoes through. */
export const TEMPLATE_STRING_BASE = 11;

/** True when this session carries the harness template (genesis-authored only). */
export function hasBaseTemplate(state: { authoring: { baseTemplate?: boolean } }): boolean {
  return state.authoring.baseTemplate === true;
}

/** Error when a write or binding would collide with a reserved template slot. */
export function templateSlotError(
  state: { authoring: { baseTemplate?: boolean } },
  kind: string,
  num: number,
): string | null {
  if (!hasBaseTemplate(state)) return null;
  const reserved =
    (kind === "logic" && (num === 0 || num >= 250)) ||
    (kind === "sound" && num >= 250) ||
    (kind === "flag" && num >= TEMPLATE_FLAG_BASE && num < TEMPLATE_FLAG_LIMIT) ||
    (kind === "variable" && num >= TEMPLATE_VARIABLE_BASE && num < TEMPLATE_VARIABLE_LIMIT);
  return reserved
    ? `${kind} ${num} belongs to the harness base template (logics 0 and 250-255, sounds 250-255, flags 200-209, variables 248-255, controllers 200-219, string 11). The boot, menu and death rituals live there — choose another number.`
    : null;
}

/**
 * The key pairs the template binds — ESC, F1, F5, F7, F9, Alt-Z, Tab. A room
 * rebinding one intercepts the menu/help/save/restore/restart/quit/inventory
 * surface, so compiled bytecode may not claim them.
 */
const TEMPLATE_KEYS: ReadonlySet<number> = new Set([
  (27 << 8) | 0, // ESC
  (0 << 8) | 59, // F1
  (0 << 8) | 63, // F5
  (0 << 8) | 65, // F7
  (0 << 8) | 67, // F9
  (0 << 8) | 44, // Alt-Z
  (9 << 8) | 0, // Tab
]);

/** Action operand positions that write a flag — direct writes and done-flags. */
const FLAG_WRITES: Readonly<Record<string, readonly number[]>> = {
  set: [0],
  reset: [0],
  toggle: [0],
  "end.of.loop": [1],
  "reverse.loop": [1],
  "move.obj": [4],
  "move.obj.v": [4],
  "follow.ego": [2],
  sound: [1],
};

/** Action operand positions that write a variable directly. */
const VAR_WRITES: Readonly<Record<string, readonly number[]>> = {
  increment: [0],
  decrement: [0],
  assignn: [0],
  assignv: [0],
  addn: [0],
  addv: [0],
  subn: [0],
  subv: [0],
  muln: [0],
  mulv: [0],
  divn: [0],
  divv: [0],
  rindirect: [0],
  random: [2],
  "get.posn": [1, 2],
  "last.cel": [1],
  "current.cel": [1],
  "current.loop": [1],
  "current.view": [1],
  "number.of.loops": [1],
  "get.priority": [1],
  "get.dir": [1],
  "get.room.v": [1],
  "get.num": [1],
  distance: [2],
};

/** Actions whose operand 0 writes a string slot. */
const STRING_WRITES: ReadonlySet<string> = new Set([
  "set.string",
  "get.string",
  "word.to.string",
  "parse",
  "set.simple",
]);

/**
 * Scan compiled room bytecode for writes into template-owned slots — the
 * bindings guard only stops a *named* reservation; source can reach the same
 * slots through raw numbers, and this check is the validator of last resort.
 * Literal `assignn`/`assignv` bindings are tracked so indirect writes
 * (set.v, lindirectn, call targets aside) are caught when the pointer var
 * provably holds a reserved index; an unprovable pointer is not a violation
 * on its own. call(255) and reads stay allowed — only writes are template
 * ownership.
 *
 * Returns the violation's message, or null when the payload is clean. A
 * payload that will not decode reports nothing — the assembler is the syntax
 * gate, this scan only interprets what assembled.
 */
export function templateWriteError(
  state: { authoring: { baseTemplate?: boolean } },
  payload: Uint8Array,
): string | null {
  if (!hasBaseTemplate(state)) return null;
  const reservedFlag = (n: number): boolean => n >= TEMPLATE_FLAG_BASE && n < TEMPLATE_FLAG_LIMIT;
  const reservedVar = (n: number): boolean =>
    n >= TEMPLATE_VARIABLE_BASE && n < TEMPLATE_VARIABLE_LIMIT;
  const describe = (what: string, at: number): string =>
    `${what} at bytecode offset ${at} belongs to the harness base template (flags 200-209, variables 248-255, controllers 200-219, string 11, its menu keys). The boot, menu and death rituals live there — choose another slot.`;
  let actions: ReturnType<typeof decodeLogicActions>;
  try {
    actions = decodeLogicActions(payload);
  } catch {
    return null;
  }
  // Literal var bindings, maintained in stream order: assignn binds, assignv
  // propagates, every other var-writing action clears. Indirect writes
  // through a var with a surviving literal resolve statically.
  const bound = new Map<number, number>();
  for (const action of actions) {
    for (const position of FLAG_WRITES[action.name] ?? []) {
      const flag = action.args[position];
      if (flag !== undefined && reservedFlag(flag))
        return describe(`write to flag ${flag}`, action.at);
    }
    for (const position of VAR_WRITES[action.name] ?? []) {
      const num = action.args[position];
      if (num !== undefined && reservedVar(num))
        return describe(`write to variable ${num}`, action.at);
    }
    if (STRING_WRITES.has(action.name)) {
      if (action.args[0] === TEMPLATE_STRING_BASE)
        return describe(`write to string ${TEMPLATE_STRING_BASE}`, action.at);
    }
    if (action.name === "set.key") {
      const key = ((action.args[0] ?? 0) << 8) | (action.args[1] ?? 0);
      const controller = action.args[2] ?? -1;
      if (controller >= TEMPLATE_CONTROLLER_BASE && controller < TEMPLATE_CONTROLLER_LIMIT)
        return describe(`key binding to controller ${controller}`, action.at);
      if (TEMPLATE_KEYS.has(key))
        return describe("key binding for a template-owned key", action.at);
    }
    // Indirect flag/var writes: the operand is a var holding the slot. A
    // reserved pointer var, or a literal surviving in the reserved range, is
    // a provable violation.
    for (const name of ["set.v", "reset.v", "toggle.v", "lindirectn", "lindirectv"]) {
      if (action.name !== name) continue;
      const pointer = action.args[0];
      if (pointer === undefined) continue;
      if (reservedVar(pointer))
        return describe(`${name} through reserved variable ${pointer}`, action.at);
      const literal = bound.get(pointer);
      const target = literal;
      if (
        target !== undefined &&
        (name === "lindirectn" || name === "lindirectv"
          ? reservedVar(target)
          : reservedFlag(target))
      )
        return describe(`${name} into reserved slot ${target}`, action.at);
    }
    if (action.name === "assignn") bound.set(action.args[0]!, action.args[1]!);
    else if (action.name === "assignv") {
      const source = bound.get(action.args[1]!);
      if (source !== undefined) bound.set(action.args[0]!, source);
      else bound.delete(action.args[0]!);
    } else {
      // Any var-writing action clears the literal it overwrites — a pointer
      // that survives is only a pointer the stream provably still holds.
      for (const position of VAR_WRITES[action.name] ?? []) {
        const overwritten = action.args[position];
        if (overwritten !== undefined) bound.delete(overwritten);
      }
    }
  }
  return null;
}

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
#message 17 "Type a command and press ENTER. Arrow keys walk. ESC opens the menu."
#message 18 "An adventure written with AGI IS HERE."
#message 19 "I don't know the word \\"%s11\\"."
#message 20 "I don't understand that."
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
  if (controller(C_HELP)) { print(m17); }
  if (controller(C_ABOUT)) { print(m18); }
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
    print(m19);
  } else {
    print(m20);
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

/** The one death sound: a short descending sting on two tone channels. */
export const BASE_TEMPLATE_DEATH_TRACKS: readonly SoundTrackInput[] = [
  {
    notes: [
      { note: "G4", duration: 6 },
      { note: "E4", duration: 6 },
      { note: "C4", duration: 6 },
      { note: "G3", duration: 24 },
    ],
  },
  {
    notes: [
      { note: "E4", duration: 6 },
      { note: "C4", duration: 6 },
      { note: "G3", duration: 6 },
      { note: "C3", duration: 24 },
    ],
  },
  { notes: [{ note: "rest", duration: 42 }] },
  { notes: [{ note: "rest", duration: 42 }] },
];

/**
 * Compile and install the fixed template into a fresh authoring session.
 * Genesis calls this before the first model turn; imported or older authored
 * games never pass through here and keep their own rituals.
 */
export function installBaseTemplate(state: AgentSessionState, profile: AgiProfile): void {
  const options = { dictionary: state.sources.words, profile };
  const logic0 = assembleLogic(BASE_TEMPLATE_LOGIC0_SOURCE, options);
  state.container.putResource("logic", 0, logic0.payload);
  state.sources.logics.set(0, BASE_TEMPLATE_LOGIC0_SOURCE);
  const death = assembleLogic(BASE_TEMPLATE_DEATH_LOGIC_SOURCE, options);
  state.container.putResource("logic", TEMPLATE_DEATH_LOGIC, death.payload);
  state.sources.logics.set(TEMPLATE_DEATH_LOGIC, BASE_TEMPLATE_DEATH_LOGIC_SOURCE);
  state.container.putResource(
    "sound",
    TEMPLATE_DEATH_SOUND,
    buildSound(BASE_TEMPLATE_DEATH_TRACKS),
  );
  state.authoring.baseTemplate = true;
}
