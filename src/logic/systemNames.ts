/**
 * Display names derived from agi-re, Core Runtime State (Byte variables, Flags,
 * Top-level cycle order), Rooms/Replay/Persistence (Room transition, Restart),
 * Opcode Contracts (motion, tracing, menus) and Input/Text/Menus/Inventory.
 * https://peterkelly.github.io/agi-re/spec/print.html#core-runtime-state
 * The spec supplies roles rather than source identifiers. Slots whose roles
 * are unspecified retain neutral system labels; these labels imply no behavior.
 */
import type { BindingInfo } from "./projectNames.ts";

export const SYSTEM_FLAGS: Readonly<Record<string, string>> = {
  "0": "system_flag_0",
  "1": "system_flag_1",
  "2": "system_flag_2",
  "3": "system_flag_3",
  "4": "system_flag_4",
  "5": "new_room",
  "6": "restarted",
  "7": "system_flag_7",
  "8": "system_flag_8",
  "9": "sound_on",
  "10": "trace_on",
  "11": "system_flag_11",
  "12": "system_flag_12",
  "13": "system_flag_13",
  "14": "menus_on",
  "15": "system_flag_15",
};
export const SYSTEM_VARIABLES: Readonly<Record<string, string>> = {
  "0": "current_room",
  "1": "prev_room",
  "2": "ego_edge",
  "3": "score",
  "4": "object_event_4",
  "5": "object_event_5",
  "6": "ego_direction",
  "7": "system_var_7",
  "8": "system_var_8",
  "9": "parser_status",
  "10": "cycle_speed",
  "11": "system_var_11",
  "12": "system_var_12",
  "13": "system_var_13",
  "14": "system_var_14",
  "15": "system_var_15",
  "16": "ego_view_num",
  "17": "system_var_17",
  "18": "system_var_18",
  "19": "key_pressed",
  "20": "system_var_20",
  "21": "system_var_21",
  "22": "system_var_22",
  "23": "system_var_23",
  "24": "system_var_24",
  "25": "selected_item",
  "26": "system_var_26",
};

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
