import type { AgentLogEntry } from "../agent/agentLog.ts";

const ACTIVITY: Record<string, string> = {
  read_state: "Inspecting the game…",
  read_objects: "Inspecting the characters…",
  read_frames: "Looking at the scene…",
  read_logic: "Reading the room’s behavior…",
  read_picture: "Examining the scenery…",
  read_words: "Reading the vocabulary…",
  list_resources: "Exploring the game’s resources…",
  read_plan: "Checking the world…",
  write_view: "Drawing sprites…",
  write_picture: "Drawing the room…",
  write_logic: "Building the next room…",
  write_words: "Adding vocabulary…",
  write_objects: "Updating inventory…",
  write_sound: "Composing sound…",
  playtest_room: "Checking the updated room…",
};

export function agentActivity(
  entry: AgentLogEntry | undefined,
  fallback: string,
  activeTool?: string | null,
): string {
  const tool = activeTool ?? (entry?.data as { tool?: string } | undefined)?.tool;
  if (entry?.kind === "error" && !activeTool) return "Adjusting after a problem…";
  if (tool && (activeTool || entry?.kind === "request")) return ACTIVITY[tool] ?? fallback;
  if (tool && entry?.kind === "response") return "Reviewing results…";
  return fallback;
}
