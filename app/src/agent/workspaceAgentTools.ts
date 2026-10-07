/** Shared catalog without provider or browser dependencies. */
import { AGENT_TOOLS, type ToolDefinition } from "../../../src/agent/tools.ts";
import { NAMING_TOOL } from "../../../src/agent/namingTools.ts";
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
const IMAGE_TOOLS: readonly ToolDefinition[] = [
  {
    name: "trace_an_image",
    description: toolDescription(
      "trace_an_image",
      "Reuse an image attached to this project as a PICTURE tracing layer. Read the images document for its encoded SHA-256 handle. Supply target picture:N and opacity from 0 to 1. The complete attachment/reference change joins the coordinated proposal for review and one History commit.",
    ),
    parameters: parameterDescriptions("trace_an_image", {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string", pattern: "^picture:(0|[1-9][0-9]{0,2})$" },
        image: { type: "string", pattern: "^[a-f0-9]{64}$" },
        opacity: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["target", "image", "opacity"],
    }),
  },
  {
    name: "make_cels_from_an_image",
    description: toolDescription(
      "make_cels_from_an_image",
      "Reuse an image attached to this project to append native VIEW cels while retaining existing loops and cels. Read the images document for its encoded SHA-256 handle. Supply target view:N and explicit frame regions, output sizes and loop numbers; frames null suggests separated strips or a four-column grid. The complete art/attachment change joins the coordinated proposal for review and one History commit.",
    ),
    parameters: parameterDescriptions("make_cels_from_an_image", {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string", pattern: "^view:(0|[1-9][0-9]{0,2})$" },
        image: { type: "string", pattern: "^[a-f0-9]{64}$" },
        frames: {
          type: ["array", "null"],
          minItems: 1,
          maxItems: 256,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              region: {
                type: "object",
                additionalProperties: false,
                properties: {
                  x: { type: "integer", minimum: 0 },
                  y: { type: "integer", minimum: 0 },
                  width: { type: "integer", minimum: 1 },
                  height: { type: "integer", minimum: 1 },
                },
                required: ["x", "y", "width", "height"],
              },
              width: { type: "integer", minimum: 1, maximum: 160 },
              height: { type: "integer", minimum: 1, maximum: 168 },
              loop: { type: "integer", minimum: 0, maximum: 254 },
            },
            required: ["region", "width", "height", "loop"],
          },
        },
      },
      required: ["target", "image", "frames"],
    }),
  },
];
export const WORKSPACE_AGENT_TOOLS: readonly ToolDefinition[] = [
  ...AGENT_TOOLS.filter(
    (tool) =>
      !(["withdraw_selection"] as readonly string[]).includes(tool.name) &&
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
  NAMING_TOOL,
  NOTES_TOOL,
  ...IMAGE_TOOLS,
];
