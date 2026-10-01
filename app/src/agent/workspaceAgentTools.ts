/** Shared catalog without provider or browser dependencies. */
import { AGENT_TOOLS, type ToolDefinition } from "../../../src/agent/tools.ts";
import { STUDIO_ASSIST_TOOL_NAMES } from "../../../src/agent/studioAssistTools.ts";
import { parameterDescriptions, toolDescription } from "../../../src/vocabulary.ts";
import { PROJECT_ASSIST_TOOLS } from "./projectAssistTools.ts";

const NOTES_TOOL: ToolDefinition = {
  name: "write_notes",
  description: toolDescription(
    "write_notes",
    "Replace the game notes with one lesson per line. Update existing lessons rather than duplicating them. Include the notes in the coordinated change set.",
  ),
  parameters: parameterDescriptions("write_notes", {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string" } },
    required: ["text"],
  }),
};
export const WORKSPACE_AGENT_TOOLS: readonly ToolDefinition[] = [
  ...AGENT_TOOLS.filter(
    (tool) =>
      !STUDIO_ASSIST_TOOL_NAMES.includes(tool.name) &&
      !PROJECT_ASSIST_TOOLS.some((other) => other.name === tool.name),
  ),
  ...PROJECT_ASSIST_TOOLS.map((tool) =>
    tool.name === "propose_changes"
      ? {
          ...tool,
          description: toolDescription(
            "propose_changes",
            "Offer one coordinated change set of complete document replacements or deletions. Include all affected references. Native resource tools and game notes are combined with these changes and the whole project is validated. Review keeps the proposal for approval; Auto-approve admits each valid proposal immediately as its own History commit. Later tools read the admitted project.",
          ),
        }
      : tool,
  ),
  NOTES_TOOL,
];
