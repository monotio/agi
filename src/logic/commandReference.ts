/** Profile-filtered AGI command signatures and help shared by language tooling. */
import {
  ACTIONS,
  V3_ACTIONS,
  IIGS_ACTIONS,
  AMIGA_ACTIONS,
  CONDITIONS,
  actionSpec,
  type OperandKind,
} from "./opcodes.ts";
import { ACTION_HELP, CONDITION_HELP } from "./commandHelp.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import type { ResourceKind } from "../types.ts";

export interface ResourceOperand {
  readonly kind: ResourceKind | "item";
  readonly operand: number;
  readonly variable?: true;
}

// Names are resolved through the selected profile's decoder before this table
// is consulted. These describe the referenced family, not opcode execution.
const RESOURCE_REFERENCE_OPERANDS: Readonly<Record<string, ResourceOperand>> = {
  "new.room": { kind: "logic", operand: 0 },
  "new.room.v": { kind: "logic", operand: 0, variable: true },
  "load.logics": { kind: "logic", operand: 0 },
  "load.logics.v": { kind: "logic", operand: 0, variable: true },
  call: { kind: "logic", operand: 0 },
  "call.v": { kind: "logic", operand: 0, variable: true },
  "trace.info": { kind: "logic", operand: 0 },
  "load.pic": { kind: "picture", operand: 0, variable: true },
  "draw.pic": { kind: "picture", operand: 0, variable: true },
  "discard.pic": { kind: "picture", operand: 0, variable: true },
  "overlay.pic": { kind: "picture", operand: 0, variable: true },
  "load.view": { kind: "view", operand: 0 },
  "load.view.v": { kind: "view", operand: 0, variable: true },
  "discard.view": { kind: "view", operand: 0 },
  "discard.view.v": { kind: "view", operand: 0, variable: true },
  "set.view": { kind: "view", operand: 1 },
  "set.view.v": { kind: "view", operand: 1, variable: true },
  "add.to.pic": { kind: "view", operand: 0 },
  "add.to.pic.v": { kind: "view", operand: 0, variable: true },
  "show.obj": { kind: "view", operand: 0 },
  "show.obj.v": { kind: "view", operand: 0, variable: true },
  "load.sound": { kind: "sound", operand: 0 },
  sound: { kind: "sound", operand: 0 },
  "discard.sound": { kind: "sound", operand: 0 },
  "get.v": { kind: "item", operand: 0, variable: true },
  "put.v": { kind: "item", operand: 0, variable: true },
  "get.room.v": { kind: "item", operand: 0, variable: true },
};

/** Sound discard is a real resource use only on IIgs; see fidelity.md "Apple IIgs sound discard". */
export function resourceReferenceOperand(
  command: string,
  profile: AgiProfile,
): ResourceOperand | undefined {
  if (command === "discard.sound" && profile.extraActions !== "iigs") return undefined;
  return RESOURCE_REFERENCE_OPERANDS[command];
}

const HELP: Record<string, string> = {
  "set.priority":
    "Sets a literal priority and already fixes object depth. release.priority restores automatic baseline depth.",
  "set.priority.v": "Sets fixed object depth from a variable value.",
  "release.priority": "Restores automatic depth from the object baseline.",
  "get.priority": "Writes the object priority into the destination variable.",
  "cycle.time":
    "Sets animation cel interval AND resets its countdown from the variable value. Initialize once on room entry; 1 advances each logic cycle. Global v10 controls cycle pacing. This changes animation, not movement.",
  "step.time":
    "Sets movement interval and countdown from a variable. Animation uses cycle.time independently.",
  "step.size": "Sets movement distance in logical pixels from a variable.",
  "stop.cycling": "Pauses automatic animation while keeping the current cel.",
  "start.cycling": "Enables automatic cel animation.",
  "normal.cycle": "Selects forward wrapping cel animation.",
  "reverse.cycle": "Selects backward wrapping cel animation.",
  "end.of.loop":
    "Plays forward to the last cel, stops cycling and sets the completion flag; installs an initial one-callback delay.",
  "reverse.loop":
    "Plays backward to cel zero, stops cycling and sets the completion flag; installs an initial one-callback delay.",
  position:
    "Places the left edge and bottom baseline at literal x,y; increasing sprite height extends upward.",
  "position.v": "Places left edge and bottom baseline using x,y variable values.",
  "set.loop":
    "Selects a literal view loop and keeps the current cel when the loop has it; automatic direction selection may subsequently change the loop.",
  "fix.loop": "Disables automatic direction-based loop selection.",
  "release.loop": "Restores automatic direction-based loop selection.",
  "set.cel": "Selects a literal cel and clears the one-callback cycle delay.",
  "set.view":
    "Selects a literal VIEW resource number, keeping an in-range loop and cel; artwork carries no animation timing or world position.",
  draw: "Makes an animated screen object visible at its baseline.",
  "animate.obj":
    "Initializes a screen object for animation; select its view and position before drawing.",
  "load.pic":
    "Loads the picture number stored in a variable. Use a reserved scratch variable, not global pacing variable v10.",
  "draw.pic": "Draws the picture number in a variable; show.pic presents it.",
  "new.room": "Switches to a literal room number with room initialization semantics.",
  "new.room.v": "Switches to the room number stored in a variable.",
  assignn: "Stores a literal byte value in a variable.",
  assignv: "Copies the source variable value into the destination variable.",
  said: "Matches registered parser word groups; operands are quoted vocabulary or word IDs, including wildcard 1 and tail 9999 where the profile supports it.",
  sound:
    "Starts a SOUND resource and sets the completion flag when it ends; sound has an independent 60 Hz clock.",
  "fade.sound":
    "Apple IIgs only: arm the heartbeat volume fade on the playing sound, stepping the latched volume down every pace beats until it completes.",
  "fade.sound.v": "Apple IIgs only: same as fade.sound with the pace taken from the variable.",
  terminate:
    "Apple IIgs only: the dispatcher reads past the action table into the quit routine; the action ends the interpreter session.",
};

/**
 * Amiga action slots whose dispatch-table entry is a shared stub that only
 * steps over its operand bytes (docs/fidelity.md "Amiga interpreter
 * profiles"): the PC help for these codes describes effects those builds lack.
 */
const AMIGA_STUB_SLOTS = new Set([
  0xa1, 0xa3, 0xa4, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, 0xb5,
]);
const AMIGA_STUB_HELP =
  "Amiga stub: the interpreter steps over the operand bytes and does nothing else.";

function actionHelp(profile: AgiProfile, code: number, name: string): string {
  // Code-keyed help describes the shared/PC meaning of a slot; the IIgs tail
  // carries different actions at the same codes, so only the name-keyed help
  // applies there.
  if (profile.extraActions === "iigs" && code >= 0xaf) return HELP[name] ?? "";
  if (profile.id.startsWith("amiga-") && AMIGA_STUB_SLOTS.has(code)) return AMIGA_STUB_HELP;
  return [ACTION_HELP[code], HELP[name]].filter(Boolean).join(" ");
}

export interface CommandReference {
  name: string;
  kind: "action" | "condition";
  code: number;
  operands: readonly OperandKind[];
  resourceOperand?: ResourceOperand;
  signature: string;
  help?: string;
}

export function commandReference(profile: AgiProfile): CommandReference[] {
  const result: CommandReference[] = [];
  const seen = new Set<number>();
  for (const candidate of [...ACTIONS, ...V3_ACTIONS, ...IIGS_ACTIONS, ...AMIGA_ACTIONS]) {
    const spec = actionSpec(candidate.code, profile);
    if (!spec || seen.has(spec.code)) continue;
    seen.add(spec.code);
    // Controller identities use the conventional immediate-byte signature notation.
    const signatureOperands = spec.operands.map((kind) => (kind === "controller" ? "imm" : kind));
    result.push({
      ...spec,
      kind: "action",
      ...(resourceReferenceOperand(spec.name, profile)
        ? { resourceOperand: resourceReferenceOperand(spec.name, profile)! }
        : {}),
      signature: `${spec.name}(${signatureOperands.join(", ")})`,
      help: actionHelp(profile, spec.code, spec.name),
    });
  }
  // The IIgs condition 0x13 slot overruns its handler table: the assembler
  // rejects it, so it is not an accepted command.
  const conditions = CONDITIONS.filter(
    (spec) =>
      spec.code <= profile.maxCondition &&
      !(spec.code === 0x13 && profile.condition0x13 === "wild-dispatch"),
  );
  for (const spec of conditions) {
    const signatureOperands = spec.operands.map((kind) => (kind === "controller" ? "imm" : kind));
    result.push({
      ...spec,
      kind: "condition",
      signature:
        spec.name === "said" ? "said(word, ...)" : `${spec.name}(${signatureOperands.join(", ")})`,
      help: [CONDITION_HELP[spec.code], HELP[spec.name]].filter(Boolean).join(" "),
    });
  }
  return result;
}

/** Bounded edit distance includes adjacent transpositions common in misspelled opcodes. */
function spellingDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        rows[i]![j] = Math.min(rows[i]![j]!, rows[i - 2]![j - 2]! + 1);
    }
  return rows[a.length]![b.length]!;
}

export function relatedCommands(
  profile: AgiProfile,
  query: string,
  kind?: "action" | "condition",
): CommandReference[] {
  const name = query.toLowerCase().slice(0, 120);
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  return commandReference(profile)
    .filter((command) => !kind || command.kind === kind)
    .map((command) => {
      const tokens = command.name.split(".");
      const overlap = words.reduce(
        (total, word) => total + (tokens.includes(word) ? word.length * 3 : 0),
        0,
      );
      const distance = spellingDistance(name, command.name);
      const spelling =
        distance <= Math.max(2, Math.floor(command.name.length / 3)) ? 30 - distance * 4 : 0;
      return { command, score: command.name === name ? 1000 : overlap + spelling };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.command.code - b.command.code)
    .slice(0, 5)
    .map((entry) => entry.command);
}
