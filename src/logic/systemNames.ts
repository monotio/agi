/**
 * Source names derived from agi-re, Core Runtime State (Byte variables, Flags,
 * Top-level cycle order), Rooms/Replay/Persistence (Room transition, Restart),
 * Opcode Contracts (motion, tracing, menus) and Input/Text/Menus/Inventory.
 * https://peterkelly.github.io/agi-re/spec/print.html#core-runtime-state
 * The spec supplies roles rather than source identifiers. Slots whose roles
 * are unspecified retain reserved labels; these labels imply no behavior.
 */
import type { BindingInfo } from "./projectNames.ts";

export const SYSTEM_FLAGS: Readonly<Record<string, string>> = {
  "0": "ego_in_water",
  "1": "ego_hidden",
  "2": "input_received",
  "3": "ego_on_trigger",
  "4": "input_handled",
  "5": "new_room",
  "6": "restarted",
  "7": "no_save_loads",
  "8": "reserved_flag_8",
  "9": "sound_on",
  "10": "trace_on",
  "11": "reserved_flag_11",
  "12": "restored",
  "13": "inventory_select",
  "14": "menus_on",
  "15": "message_no_wait",
};
export const SYSTEM_VARIABLES: Readonly<Record<string, string>> = {
  "0": "current_room",
  "1": "prev_room",
  "2": "ego_edge",
  "3": "score",
  "4": "edge_object",
  "5": "edge_object_edge",
  "6": "ego_direction",
  "7": "max_score",
  "8": "free_memory",
  "9": "parser_status",
  "10": "cycle_speed",
  "11": "clock_seconds",
  "12": "clock_minutes",
  "13": "clock_hours",
  "14": "clock_days",
  "15": "reserved_var_15",
  "16": "ego_view",
  "17": "reserved_var_17",
  "18": "reserved_var_18",
  "19": "key_pressed",
  "20": "computer_type",
  "21": "message_time",
  "22": "sound_type",
  "23": "sound_volume",
  "24": "input_length",
  "25": "selected_item",
  "26": "monitor_type",
};

/**
 * Plain meanings for the Game state list. They follow the spec sections above
 * and the engine's own handling of each slot (docs/fidelity.md: "Footprint
 * class flags", "Clocks, pacing and waiting", "Text on screen", "Saving,
 * restoring and restarting", "The memory report"). A slot with neither keeps
 * the interpreter's note.
 */
const FLAG_MEANINGS: Readonly<Record<string, string>> = {
  "0": "The hero is in water.",
  "1": "The hero is out of sight.",
  "2": "The player typed a sentence for the game to check.",
  "3": "The hero is touching a trigger.",
  "4": "The game has answered the player's sentence.",
  "5": "The game has just entered a room.",
  "6": "The game has just restarted.",
  "7": "While set, saved games skip what the game loads.",
  "9": "Sound is on.",
  "10": "Lets the trace window open.",
  "12": "The game was just restored from a save.",
  "13": "Lets the player pick an item from the inventory.",
  "14": "Lets the player use the menu.",
  "15": "The next message window opens without waiting for a key.",
};
const VARIABLE_MEANINGS: Readonly<Record<string, string>> = {
  "0": "The room the player is in.",
  "1": "The room the player came from.",
  "2": "The screen edge the hero touched.",
  "3": "The score.",
  "4": "The object that touched a screen edge.",
  "5": "The screen edge that object touched.",
  "6": "The way the hero is walking.",
  "7": "The highest score, shown on the status line.",
  "8": "Free memory; 255 means plenty.",
  "9": "How many words the player typed, or which word the game did not know.",
  "10": "The wait between game cycles, in twentieths of a second.",
  "11": "Seconds on the game clock.",
  "12": "Minutes on the game clock.",
  "13": "Hours on the game clock.",
  "14": "Days on the game clock.",
  "16": "The hero's VIEW number.",
  "19": "The last key pressed.",
  "20": "The kind of computer; 0 means a PC.",
  "21": "How long a message stays open, in half-seconds.",
  "22": "The kind of sound the computer plays.",
  "23": "Turns the sound down; 0 is loudest.",
  "24": "The longest sentence the player can type.",
  "25": "The item the player picked from the inventory, or 255 for Cancel.",
  "26": "The kind of screen; 3 means EGA.",
};

export function systemMeaning(kind: string, num: number): string | undefined {
  if (systemName(kind, num) === undefined) return undefined;
  const meanings = kind === "f" || kind === "flag" ? FLAG_MEANINGS : VARIABLE_MEANINGS;
  return meanings[String(num)] ?? "Kept for the interpreter.";
}

export function systemName(kind: string, num: number): string | undefined {
  return kind === "f" || kind === "flag"
    ? SYSTEM_FLAGS[String(num)]
    : kind === "v" || kind === "variable"
      ? SYSTEM_VARIABLES[String(num)]
      : undefined;
}

export function systemBindingInfos(): BindingInfo[] {
  const result: BindingInfo[] = [];
  for (const [kind, names] of [
    ["flag", SYSTEM_FLAGS],
    ["variable", SYSTEM_VARIABLES],
  ] as const)
    for (const [num, name] of Object.entries(names))
      result.push({ name, num: Number(num), kind, uses: [] });
  return result;
}

export interface SystemBinding {
  readonly kind: "v" | "f";
  readonly num: number;
}

/** Creator names and named slots take precedence over interpreter defaults. */
export function systemBindings(
  bindings: Readonly<Record<string, { readonly kind?: string; readonly num: number }>> = {},
): Readonly<Record<string, SystemBinding>> {
  return Object.fromEntries(
    systemBindingInfos()
      .filter(
        (info) =>
          !Object.hasOwn(bindings, info.name) &&
          !Object.values(bindings).some(
            (binding) => binding.kind === info.kind && binding.num === info.num,
          ),
      )
      .map((info) => [info.name, { kind: info.kind === "flag" ? "f" : "v", num: info.num }]),
  );
}

/** A generated operand follows creator names while retaining its AGI slot. */
export function systemOperand(
  kind: "flag" | "variable",
  num: number,
  bindings: Parameters<typeof systemBindings>[0] = {},
): string {
  const names = Object.entries(bindings)
    .filter(([, binding]) => binding.kind === kind && binding.num === num)
    .map(([name]) => name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (names[0]) return names[0];
  const builtin = systemName(kind, num);
  return builtin && Object.hasOwn(systemBindings(bindings), builtin)
    ? builtin
    : `${kind === "flag" ? "f" : "v"}${num}`;
}
