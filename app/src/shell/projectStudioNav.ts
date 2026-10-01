/**
 * Project Studio destinations: the overview or a named document inside the
 * shared project host. The host resolves each document's editing surface.
 */

/** Where an open lands inside the studio — a document key like `logic:3`. */
export interface StudioOpenTarget {
  readonly document?: string;
}

/**
 * Where the unified project frame lands: the overview, or one document key
 * like `logic:3`. The frame derives the editing surface from the key itself
 * — a caller names a place, never a family launcher.
 */
export type ProjectStudioDestination =
  { readonly kind: "overview" } | { readonly kind: "document"; readonly key: string };

/**
 * The destination an open target lands on: its named document, else the
 * project overview. A missing document name is not redirected to a first
 * resource — the frame resolves availability against the actual document set.
 */
export function projectStudioDestination(target?: StudioOpenTarget): ProjectStudioDestination {
  return target?.document !== undefined
    ? { kind: "document", key: target.document }
    : { kind: "overview" };
}

/** The document key a destination names; null on the overview. */
export function projectStudioDestinationKey(destination: ProjectStudioDestination): string | null {
  return destination.kind === "document" ? destination.key : null;
}

/** True when two destinations name the same place. */
export function sameProjectStudioDestination(
  left: ProjectStudioDestination,
  right: ProjectStudioDestination,
): boolean {
  if (left.kind === "overview") return right.kind === "overview";
  return right.kind === "document" && right.key === left.key;
}
