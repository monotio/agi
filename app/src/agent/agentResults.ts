import type { AgentToolResult } from "../../../src/agent/agentState.ts";

/** Resource identities come from tool arguments and validated tool results, never prose. */
export function inspectedResourceKeys(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  result: AgentToolResult,
): string[] {
  if (!result.success) return [];
  if (tool === "read_document" && typeof input["key"] === "string") return [input["key"]];
  const native: Record<string, string> = {
    read_logic: "logic",
    read_picture: "picture",
    read_view: "view",
    read_sound: "sound",
  };
  if (native[tool] && Number.isInteger(input["num"])) return [`${native[tool]}:${input["num"]}`];
  const metadata: Record<string, string> = {
    read_words: "words",
    read_objects: "inventory",
    read_game_tests: "tests",
  };
  if (metadata[tool]) return [metadata[tool]];
  return [];
}
