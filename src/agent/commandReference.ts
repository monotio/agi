/** Agent command discovery uses the same profile-filtered tables as the assembler. */
import { ACTIONS, V3_ACTIONS, CONDITIONS, actionSpec, type OperandKind } from "../logic/opcodes.ts";
import { ACTION_HELP, CONDITION_HELP } from "./commandHelp.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import type { ToolDefinition, AgentToolResult } from "./tools.ts";

const REFERENCE_SOURCE = "https://peterkelly.github.io/agi-re/spec/";

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
};

export interface CommandReference {
  name: string;
  kind: "action" | "condition";
  code: number;
  operands: readonly OperandKind[];
  signature: string;
  help?: string;
}

export function commandReference(profile: AgiProfile): CommandReference[] {
  const result: CommandReference[] = [];
  for (const candidate of [...ACTIONS, ...V3_ACTIONS]) {
    const spec = actionSpec(candidate.code, profile);
    if (!spec) continue;
    result.push({
      ...spec,
      kind: "action",
      signature: `${spec.name}(${spec.operands.join(", ")})`,
      help: [ACTION_HELP[spec.code], HELP[spec.name]].filter(Boolean).join(" "),
    });
  }
  for (const spec of CONDITIONS.filter((spec) => spec.code <= profile.maxCondition))
    result.push({
      ...spec,
      kind: "condition",
      signature:
        spec.name === "said" ? "said(word, ...)" : `${spec.name}(${spec.operands.join(", ")})`,
      help: [CONDITION_HELP[spec.code], HELP[spec.name]].filter(Boolean).join(" "),
    });
  return result;
}

export function formatCommandCatalog(profile: AgiProfile): string {
  const all = commandReference(profile);
  return `Interpreter ${profile.id}: complete accepted command signatures.\nOperands: imm = literal byte; var = variable index (vN), read or written according to command semantics; flag = fN; object = screen object oN; item = inventory ID; resource = literal resource ID; message = message ID or quoted text; string = sN. Immediate operands are bytes 0..255.\nActions:\nreturn;\n${all
    .filter((c) => c.kind === "action")
    .map((c) => c.signature + ";")
    .join("\n")}\nConditions:\n${all
    .filter((c) => c.kind === "condition")
    .map((c) => c.signature)
    .join(
      "\n",
    )}\nUse read_command_reference for operation help and the active profile. Accepted commands may have profile-specific behavior, including documented no-op variants.`;
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

export const COMMAND_REFERENCE_TOOL: ToolDefinition = {
  name: "read_command_reference",
  description:
    "Discover commands for the active interpreter profile. Null query lists signatures; text returns matching help. `kind` narrows to action or condition (null: both); `offset` pages the listing by 16. Variable operands are IDs. The compiler remains authoritative.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: ["string", "null"],
        maxLength: 120,
      },
      kind: {
        type: ["string", "null"],
        enum: ["action", "condition", null],
      },
      offset: {
        type: ["integer", "null"],
        minimum: 0,
      },
    },
    required: ["query", "kind", "offset"],
  },
};

export function readCommandReference(
  profile: AgiProfile,
  args: Record<string, unknown>,
): AgentToolResult {
  const query = args["query"];
  const kind = args["kind"];
  const offset = args["offset"] ?? 0;
  if (query != null && (typeof query !== "string" || query.length > 120))
    return { success: false, error: "query must be null or text up to 120 characters." };
  if (kind != null && kind !== "action" && kind !== "condition")
    return { success: false, error: "kind must be action, condition, or null." };
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
    return { success: false, error: "offset must be a nonnegative integer." };
  const commands = commandReference(profile).filter(
    (command) => kind == null || command.kind === kind,
  );
  if (query == null)
    return {
      success: true,
      message:
        kind == null ? formatCommandCatalog(profile) : commands.map((c) => c.signature).join("\n"),
      details: { profile: profile.id, source: REFERENCE_SOURCE, count: commands.length },
    };
  const terms = String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const found = commands
    .filter((command) =>
      terms.some((term) => `${command.name} ${command.help ?? ""}`.toLowerCase().includes(term)),
    )
    .sort(
      (a, b) =>
        Number(b.name === String(query).toLowerCase()) -
        Number(a.name === String(query).toLowerCase()),
    );
  const matches = found.length
    ? found
    : relatedCommands(profile, String(query)).filter((c) => kind == null || c.kind === kind);
  return {
    success: true,
    message: `${matches.length} matching commands in profile ${profile.id}. Signatures come from the assembler's active table; operation help describes standard behavior.`,
    details: {
      profile: profile.id,
      source: REFERENCE_SOURCE,
      commands: matches.slice(offset, offset + 16),
      count: matches.length,
      nextOffset: offset + 16 < matches.length ? offset + 16 : null,
    },
  };
}
