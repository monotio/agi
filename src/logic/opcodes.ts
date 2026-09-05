/**
 * AGI logic opcode tables, AGI 2.936 profile (actions 0x01..0xaf,
 * conditions 0x00..0x12), from Peter Kelly's agi-re behavioral specification,
 * chapter "Logic Bytecode".
 *
 * Structural bytes (not actions): 0x00 return, 0xfe goto, 0xff if,
 * 0xfc OR-group marker, 0fd NOT marker (inside condition lists).
 */

import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";

export type OperandKind =
  | "imm" // immediate byte
  | "var" // variable index
  | "flag" // flag index
  | "item" // inventory item number
  | "object" // screen object number
  | "resource" // logic/picture/view/sound resource number
  | "message" // message number in current logic
  | "string"; // string slot number

export interface ActionSpec {
  readonly code: number;
  readonly name: string;
  readonly operands: readonly OperandKind[];
}

export interface ConditionSpec {
  readonly code: number;
  readonly name: string;
  /** Operand kinds; "said" is variable-length: count byte then count u16le word ids. */
  readonly operands: readonly OperandKind[];
}

/** Action opcodes 0x01..0xaf in code order. Names follow the classic AGI syntax. */
export const ACTIONS: readonly ActionSpec[] = [
  { code: 0x01, name: "increment", operands: ["var"] },
  { code: 0x02, name: "decrement", operands: ["var"] },
  { code: 0x03, name: "assignn", operands: ["var", "imm"] },
  { code: 0x04, name: "assignv", operands: ["var", "var"] },
  { code: 0x05, name: "addn", operands: ["var", "imm"] },
  { code: 0x06, name: "addv", operands: ["var", "var"] },
  { code: 0x07, name: "subn", operands: ["var", "imm"] },
  { code: 0x08, name: "subv", operands: ["var", "var"] },
  { code: 0x09, name: "lindirectv", operands: ["var", "var"] },
  { code: 0x0a, name: "rindirect", operands: ["var", "var"] },
  { code: 0x0b, name: "lindirectn", operands: ["var", "imm"] },
  { code: 0x0c, name: "set", operands: ["flag"] },
  { code: 0x0d, name: "reset", operands: ["flag"] },
  { code: 0x0e, name: "toggle", operands: ["flag"] },
  { code: 0x0f, name: "set.v", operands: ["var"] },
  { code: 0x10, name: "reset.v", operands: ["var"] },
  { code: 0x11, name: "toggle.v", operands: ["var"] },
  { code: 0x12, name: "new.room", operands: ["resource"] },
  { code: 0x13, name: "new.room.v", operands: ["var"] },
  { code: 0x14, name: "load.logics", operands: ["resource"] },
  { code: 0x15, name: "load.logics.v", operands: ["var"] },
  { code: 0x16, name: "call", operands: ["resource"] },
  { code: 0x17, name: "call.v", operands: ["var"] },
  { code: 0x18, name: "load.pic", operands: ["var"] },
  { code: 0x19, name: "draw.pic", operands: ["var"] },
  { code: 0x1a, name: "show.pic", operands: [] },
  { code: 0x1b, name: "discard.pic", operands: ["var"] },
  { code: 0x1c, name: "overlay.pic", operands: ["var"] },
  { code: 0x1d, name: "show.pri.screen", operands: [] },
  { code: 0x1e, name: "load.view", operands: ["resource"] },
  { code: 0x1f, name: "load.view.v", operands: ["var"] },
  { code: 0x20, name: "discard.view", operands: ["resource"] },
  { code: 0x21, name: "animate.obj", operands: ["object"] },
  { code: 0x22, name: "unanimate.all", operands: [] },
  { code: 0x23, name: "draw", operands: ["object"] },
  { code: 0x24, name: "erase", operands: ["object"] },
  { code: 0x25, name: "position", operands: ["object", "imm", "imm"] },
  { code: 0x26, name: "position.v", operands: ["object", "var", "var"] },
  { code: 0x27, name: "get.posn", operands: ["object", "var", "var"] },
  { code: 0x28, name: "reposition", operands: ["object", "var", "var"] },
  { code: 0x29, name: "set.view", operands: ["object", "resource"] },
  { code: 0x2a, name: "set.view.v", operands: ["object", "var"] },
  { code: 0x2b, name: "set.loop", operands: ["object", "imm"] },
  { code: 0x2c, name: "set.loop.v", operands: ["object", "var"] },
  { code: 0x2d, name: "fix.loop", operands: ["object"] },
  { code: 0x2e, name: "release.loop", operands: ["object"] },
  { code: 0x2f, name: "set.cel", operands: ["object", "imm"] },
  { code: 0x30, name: "set.cel.v", operands: ["object", "var"] },
  { code: 0x31, name: "last.cel", operands: ["object", "var"] },
  { code: 0x32, name: "current.cel", operands: ["object", "var"] },
  { code: 0x33, name: "current.loop", operands: ["object", "var"] },
  { code: 0x34, name: "current.view", operands: ["object", "var"] },
  { code: 0x35, name: "number.of.loops", operands: ["object", "var"] },
  { code: 0x36, name: "set.priority", operands: ["object", "imm"] },
  { code: 0x37, name: "set.priority.v", operands: ["object", "var"] },
  { code: 0x38, name: "release.priority", operands: ["object"] },
  { code: 0x39, name: "get.priority", operands: ["object", "var"] },
  { code: 0x3a, name: "stop.update", operands: ["object"] },
  { code: 0x3b, name: "start.update", operands: ["object"] },
  { code: 0x3c, name: "force.update", operands: ["object"] },
  { code: 0x3d, name: "ignore.horizon", operands: ["object"] },
  { code: 0x3e, name: "observe.horizon", operands: ["object"] },
  { code: 0x3f, name: "set.horizon", operands: ["imm"] },
  { code: 0x40, name: "obj.on.water", operands: ["object"] },
  { code: 0x41, name: "obj.on.land", operands: ["object"] },
  { code: 0x42, name: "obj.on.anything", operands: ["object"] },
  { code: 0x43, name: "ignore.objs", operands: ["object"] },
  { code: 0x44, name: "observe.objs", operands: ["object"] },
  { code: 0x45, name: "distance", operands: ["object", "object", "var"] },
  { code: 0x46, name: "stop.cycling", operands: ["object"] },
  { code: 0x47, name: "start.cycling", operands: ["object"] },
  { code: 0x48, name: "normal.cycle", operands: ["object"] },
  { code: 0x49, name: "end.of.loop", operands: ["object", "flag"] },
  { code: 0x4a, name: "reverse.cycle", operands: ["object"] },
  { code: 0x4b, name: "reverse.loop", operands: ["object", "flag"] },
  { code: 0x4c, name: "cycle.time", operands: ["object", "var"] },
  { code: 0x4d, name: "stop.motion", operands: ["object"] },
  { code: 0x4e, name: "start.motion", operands: ["object"] },
  { code: 0x4f, name: "step.size", operands: ["object", "var"] },
  { code: 0x50, name: "step.time", operands: ["object", "var"] },
  { code: 0x51, name: "move.obj", operands: ["object", "imm", "imm", "imm", "flag"] },
  { code: 0x52, name: "move.obj.v", operands: ["object", "var", "var", "var", "flag"] },
  { code: 0x53, name: "follow.ego", operands: ["object", "imm", "flag"] },
  { code: 0x54, name: "wander", operands: ["object"] },
  { code: 0x55, name: "normal.motion", operands: ["object"] },
  { code: 0x56, name: "set.dir", operands: ["object", "var"] },
  { code: 0x57, name: "get.dir", operands: ["object", "var"] },
  { code: 0x58, name: "ignore.blocks", operands: ["object"] },
  { code: 0x59, name: "observe.blocks", operands: ["object"] },
  { code: 0x5a, name: "block", operands: ["imm", "imm", "imm", "imm"] },
  { code: 0x5b, name: "unblock", operands: [] },
  { code: 0x5c, name: "get", operands: ["item"] },
  { code: 0x5d, name: "get.v", operands: ["var"] },
  { code: 0x5e, name: "drop", operands: ["item"] },
  { code: 0x5f, name: "put", operands: ["item", "var"] },
  { code: 0x60, name: "put.v", operands: ["var", "var"] },
  { code: 0x61, name: "get.room.v", operands: ["var", "var"] },
  { code: 0x62, name: "load.sound", operands: ["resource"] },
  { code: 0x63, name: "sound", operands: ["resource", "flag"] },
  { code: 0x64, name: "stop.sound", operands: [] },
  { code: 0x65, name: "print", operands: ["message"] },
  { code: 0x66, name: "print.v", operands: ["var"] },
  { code: 0x67, name: "display", operands: ["imm", "imm", "message"] },
  { code: 0x68, name: "display.v", operands: ["var", "var", "var"] },
  { code: 0x69, name: "clear.lines", operands: ["imm", "imm", "imm"] },
  { code: 0x6a, name: "text.screen", operands: [] },
  { code: 0x6b, name: "graphics", operands: [] },
  { code: 0x6c, name: "set.cursor.char", operands: ["message"] },
  { code: 0x6d, name: "set.text.attribute", operands: ["imm", "imm"] },
  { code: 0x6e, name: "shake.screen", operands: ["imm"] },
  { code: 0x6f, name: "configure.screen", operands: ["imm", "imm", "imm"] },
  { code: 0x70, name: "status.line.on", operands: [] },
  { code: 0x71, name: "status.line.off", operands: [] },
  { code: 0x72, name: "set.string", operands: ["string", "message"] },
  { code: 0x73, name: "get.string", operands: ["string", "message", "imm", "imm", "imm"] },
  { code: 0x74, name: "word.to.string", operands: ["string", "imm"] },
  { code: 0x75, name: "parse", operands: ["string"] },
  { code: 0x76, name: "get.num", operands: ["message", "var"] },
  { code: 0x77, name: "prevent.input", operands: [] },
  { code: 0x78, name: "accept.input", operands: [] },
  { code: 0x79, name: "set.key", operands: ["imm", "imm", "imm"] },
  {
    code: 0x7a,
    name: "add.to.pic",
    operands: ["resource", "imm", "imm", "imm", "imm", "imm", "imm"],
  },
  { code: 0x7b, name: "add.to.pic.v", operands: ["var", "var", "var", "var", "var", "var", "var"] },
  { code: 0x7c, name: "status", operands: [] },
  { code: 0x7d, name: "save.game", operands: [] },
  { code: 0x7e, name: "restore.game", operands: [] },
  { code: 0x7f, name: "init.disk", operands: [] },
  { code: 0x80, name: "restart.game", operands: [] },
  { code: 0x81, name: "show.obj", operands: ["resource"] },
  { code: 0x82, name: "random", operands: ["imm", "imm", "var"] },
  { code: 0x83, name: "program.control", operands: [] },
  { code: 0x84, name: "player.control", operands: [] },
  { code: 0x85, name: "obj.status.v", operands: ["var"] },
  { code: 0x86, name: "quit", operands: ["imm"] },
  { code: 0x87, name: "show.mem", operands: [] },
  { code: 0x88, name: "pause", operands: [] },
  { code: 0x89, name: "echo.line", operands: [] },
  { code: 0x8a, name: "cancel.line", operands: [] },
  { code: 0x8b, name: "init.joy", operands: [] },
  { code: 0x8c, name: "toggle.monitor", operands: [] },
  { code: 0x8d, name: "version", operands: [] },
  { code: 0x8e, name: "script.size", operands: ["imm"] },
  { code: 0x8f, name: "set.game.id", operands: ["message"] },
  { code: 0x90, name: "log", operands: ["message"] },
  { code: 0x91, name: "set.scan.start", operands: [] },
  { code: 0x92, name: "reset.scan.start", operands: [] },
  { code: 0x93, name: "reposition.to", operands: ["object", "imm", "imm"] },
  { code: 0x94, name: "reposition.to.v", operands: ["object", "var", "var"] },
  { code: 0x95, name: "trace.on", operands: [] },
  { code: 0x96, name: "trace.info", operands: ["resource", "imm", "imm"] },
  { code: 0x97, name: "print.at", operands: ["message", "imm", "imm", "imm"] },
  { code: 0x98, name: "print.at.v", operands: ["var", "imm", "imm", "imm"] },
  { code: 0x99, name: "discard.view.v", operands: ["var"] },
  { code: 0x9a, name: "clear.text.rect", operands: ["imm", "imm", "imm", "imm", "imm"] },
  { code: 0x9b, name: "set.upper.left", operands: ["imm", "imm"] },
  { code: 0x9c, name: "set.menu", operands: ["message"] },
  { code: 0x9d, name: "set.menu.item", operands: ["message", "imm"] },
  { code: 0x9e, name: "submit.menu", operands: [] },
  { code: 0x9f, name: "enable.item", operands: ["imm"] },
  { code: 0xa0, name: "disable.item", operands: ["imm"] },
  { code: 0xa1, name: "menu.input", operands: [] },
  { code: 0xa2, name: "show.obj.v", operands: ["var"] },
  { code: 0xa3, name: "open.dialogue", operands: [] },
  { code: 0xa4, name: "close.dialogue", operands: [] },
  { code: 0xa5, name: "muln", operands: ["var", "imm"] },
  { code: 0xa6, name: "mulv", operands: ["var", "var"] },
  { code: 0xa7, name: "divn", operands: ["var", "imm"] },
  { code: 0xa8, name: "divv", operands: ["var", "var"] },
  { code: 0xa9, name: "close.window", operands: [] },
  { code: 0xaa, name: "set.simple", operands: ["string"] },
  { code: 0xab, name: "push.script", operands: [] },
  { code: 0xac, name: "pop.script", operands: [] },
  { code: 0xad, name: "hold.key", operands: [] },
  { code: 0xae, name: "set.pri.base", operands: ["imm"] },
  { code: 0xaf, name: "discard.sound", operands: [] },
] as const;

/** Condition (test) opcodes 0x00..0x12 in code order. */
export const CONDITIONS: readonly ConditionSpec[] = [
  { code: 0x00, name: "false", operands: [] },
  { code: 0x01, name: "equaln", operands: ["var", "imm"] },
  { code: 0x02, name: "equalv", operands: ["var", "var"] },
  { code: 0x03, name: "lessn", operands: ["var", "imm"] },
  { code: 0x04, name: "lessv", operands: ["var", "var"] },
  { code: 0x05, name: "greatern", operands: ["var", "imm"] },
  { code: 0x06, name: "greaterv", operands: ["var", "var"] },
  { code: 0x07, name: "isset", operands: ["flag"] },
  { code: 0x08, name: "isset.v", operands: ["var"] },
  { code: 0x09, name: "has", operands: ["item"] },
  { code: 0x0a, name: "obj.in.room", operands: ["item", "var"] },
  { code: 0x0b, name: "posn", operands: ["object", "imm", "imm", "imm", "imm"] },
  { code: 0x0c, name: "controller", operands: ["imm"] },
  { code: 0x0d, name: "have.key", operands: [] },
  { code: 0x0e, name: "said", operands: [] }, // variable length: count u8, then count * u16le word ids
  { code: 0x0f, name: "compare.strings", operands: ["string", "string"] },
  { code: 0x10, name: "obj.in.box", operands: ["object", "imm", "imm", "imm", "imm"] },
  { code: 0x11, name: "center.posn", operands: ["object", "imm", "imm", "imm", "imm"] },
  { code: 0x12, name: "right.posn", operands: ["object", "imm", "imm", "imm", "imm"] },
] as const;

/** Structural bytes in the bytecode stream. */
export const RETURN = 0x00;
export const GOTO = 0xfe;
export const IF = 0xff;
export const OR = 0xfc;
export const NOT = 0xfd;

/** said() wildcard: matches any one parsed word. */
export const SAID_ANY_WORD = 0x0001;
/** said() terminator: matches remaining words / rol. */
export const SAID_REST = 0x270f;

/** Numeric-keyed lookups (assembler + interpreter dispatch). */
export const ACTION_BY_CODE = new Map(ACTIONS.map((a) => [a.code, a]));
export const CONDITION_BY_CODE = new Map(CONDITIONS.map((c) => [c.code, c]));

/** Static name-keyed lookups for the assembler. */
export const ACTION_BY_NAME: Record<string, ActionSpec> = Object.fromEntries(
  ACTIONS.map((a) => [a.name, a]),
);
export const CONDITION_BY_NAME: Record<string, ConditionSpec> = Object.fromEntries(
  CONDITIONS.map((c) => [c.name, c]),
);

/** V3 action names use the conventional AGI vocabulary; behaviors and widths
 * follow agi-re's "Version 3 extension actions", including its no-op slots. */
export const V3_ACTIONS: readonly ActionSpec[] = [
  { code: 0xb0, name: "hide.mouse", operands: [] },
  { code: 0xb1, name: "allow.menu", operands: ["imm"] },
  { code: 0xb2, name: "show.mouse", operands: [] },
  { code: 0xb3, name: "fence.mouse", operands: ["imm", "imm", "imm", "imm"] },
  { code: 0xb4, name: "mouse.posn", operands: ["var", "var"] },
  { code: 0xb5, name: "release.key", operands: [] },
];
const V3_BY_CODE = new Map(V3_ACTIONS.map((action) => [action.code, action]));
const V3_BY_NAME: Record<string, ActionSpec> = Object.fromEntries(
  V3_ACTIONS.map((action) => [action.name, action]),
);

/** Runtime instruction shape for the selected profile, excluding scanner metadata. */
export function actionSpec(
  opcode: number | string,
  profile: AgiProfile = DEFAULT_V2_PROFILE,
): ActionSpec | undefined {
  const spec =
    typeof opcode === "number"
      ? (ACTION_BY_CODE.get(opcode) ?? V3_BY_CODE.get(opcode))
      : (ACTION_BY_NAME[opcode] ?? V3_BY_NAME[opcode]);
  if (!spec || spec.code > profile.maxAction) return undefined;
  if (spec.code === 0x86 && profile.exitOperandBytes === 0) return { ...spec, operands: [] };
  if (spec.code >= 0xb0 && profile.extraActions === "none") return undefined;
  if (spec.code === 0xb0 && profile.extraActions === "v3-086")
    return { ...spec, operands: ["imm"] };
  return spec;
}
