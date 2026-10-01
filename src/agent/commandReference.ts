import { toolDescription, parameterDescriptions } from "../vocabulary.ts";
/** Agent command discovery uses the same profile-filtered tables as the assembler. */
import { commandReference, relatedCommands } from "../logic/commandReference.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import type { AgentToolResult } from "./agentState.ts";
import type { ToolDefinition } from "./tools.ts";

export {
  commandReference,
  relatedCommands,
  type CommandReference,
} from "../logic/commandReference.ts";

const REFERENCE_SOURCE = "https://peterkelly.github.io/agi-re/spec/";

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

export const COMMAND_REFERENCE_TOOL: ToolDefinition = {
  name: "read_command_reference",
  description: toolDescription(
    "read_command_reference",
    "Discover commands for the active interpreter profile. Null query lists signatures; text returns matching help. `kind` narrows to action or condition (null: both); `offset` pages the listing by 16. Variable operands are IDs. The compiler remains authoritative.",
  ),
  parameters: parameterDescriptions("read_command_reference", {
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
  }),
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
