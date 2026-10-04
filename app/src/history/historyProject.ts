/** Play rewind restores native sources while authoring materials remain in the saved project. */
import type { ProjectContent } from "../../../src/authoring/projectContent.ts";
export function historyProjectDocuments(
  recorded: Readonly<Record<string, ProjectContent>>,
  saved: Readonly<Record<string, ProjectContent>>,
): Readonly<Record<string, ProjectContent>> {
  const authoring = Object.fromEntries(
    Object.entries(saved).filter(
      ([key]) =>
        key.startsWith("attachment:") ||
        ["images", "notes", "world", "tests", "references", "music"].includes(key),
    ),
  );
  return { ...authoring, ...recorded };
}
