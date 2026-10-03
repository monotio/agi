import { createStarterProject } from "../../../../src/authoring/starterProject.ts";
import type { ProjectChange } from "../../../../src/authoring/projectContent.ts";

/** The complete editable boot image for the empty workspace's first change. */
export function emptyWorkspaceChanges(action: "room" | "boilerplate"): readonly ProjectChange[] {
  const seed = createStarterProject("boilerplate");
  const documents: Record<string, string> = {
    bindings: JSON.stringify(seed.bindings),
    words: JSON.stringify([...seed.sources.words]),
    inventory: JSON.stringify(seed.sources.objects),
  };
  for (const [num, source] of seed.sources.logics) documents[`logic:${num}`] = source;
  for (const [num, source] of seed.sources.pictures) documents[`picture:${num}`] = source;
  for (const [num, source] of seed.sources.sounds)
    documents[`sound:${num}`] = JSON.stringify(source);
  documents["world"] = JSON.stringify({
    rooms: {
      "1": { title: action === "room" ? "Room 1" : "Your first room", description: "", exits: {} },
    },
    facts: {},
    quests: {},
  });
  return Object.entries(documents).map(([key, content]) => ({ key, content }));
}
