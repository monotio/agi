import { sameProjectContent, type ProjectContent } from "../../../src/authoring/projectContent.ts";

function world(content: ProjectContent | null | undefined): Record<string, unknown> {
  const value: unknown = JSON.parse(content == null ? "{}" : String(content));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected world JSON.");
  return value as Record<string, unknown>;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, ordered(entry)]),
    );
  return value;
}

/** Launch configurations are saved project metadata; the rest of the world needs Update. */
export function sameWorldGameContent(
  a: ProjectContent | null | undefined,
  b: ProjectContent | null | undefined,
): boolean {
  if (sameProjectContent(a, b)) return true;
  try {
    const before = world(a);
    const after = world(b);
    delete before["launches"];
    delete after["launches"];
    return JSON.stringify(ordered(before)) === JSON.stringify(ordered(after));
  } catch {
    return false;
  }
}

/** Copy only the edited Launches, keeping the accepted room plan. */
export function copyWorldLaunches(
  base: ProjectContent | null | undefined,
  edited: ProjectContent,
): string {
  const before = world(base);
  const after = world(edited);
  if (after["launches"] === undefined) delete before["launches"];
  else before["launches"] = after["launches"];
  return JSON.stringify(before);
}

/** Carry untouched world fields forward while retaining every local edit. */
export function rebaseWorldDraft(
  before: ProjectContent | undefined,
  after: ProjectContent | undefined,
  draft: ProjectContent | null,
): ProjectContent | null {
  if (typeof draft !== "string") return draft;
  function merge(base: unknown, next: unknown, local: unknown): unknown {
    if (JSON.stringify(ordered(base)) === JSON.stringify(ordered(local))) return next;
    if (
      [base, next, local].every(
        (value) => typeof value === "object" && value !== null && !Array.isArray(value),
      )
    ) {
      const b = base as Record<string, unknown>;
      const n = next as Record<string, unknown>;
      const l = local as Record<string, unknown>;
      return Object.fromEntries(
        [...new Set([...Object.keys(b), ...Object.keys(n), ...Object.keys(l)])]
          .map((key) => [key, merge(b[key], n[key], l[key])])
          .filter(([, value]) => value !== undefined),
      );
    }
    return local;
  }
  try {
    return JSON.stringify(merge(world(before), world(after), world(draft)));
  } catch {
    return draft;
  }
}
