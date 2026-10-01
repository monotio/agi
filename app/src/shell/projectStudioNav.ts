/**
 * The project Studio navigation model: which stored-project sibling a request
 * activates, and the destinations one project offers. The shell mounts one
 * lazy host for the stored-project studios: a request names the project the
 * shared session serves and the sibling view that should take input. Views
 * visited once stay mounted behind the host, so a same-project sibling move
 * reselects the visible workspace — it never unmounts the other, never
 * reopens the project from storage, and never ends its preview or draft.
 *
 * Requests carry a monotonic epoch: App.vue publishes the latest one and the
 * host applies only the newest request's activation, so a late observer or a
 * stale replay never retargets an open editor.
 */
import { inject, provide, type InjectionKey } from "vue";
import type { ProjectId } from "../project/gameTypes.ts";

/** The stored-project studios the overlay slot can hold. */
type ProjectStudioKind = "logic" | "sound";

/** Where an open lands inside the studio — a document key like `logic:3`. */
export interface StudioOpenTarget {
  readonly document?: string;
}

/**
 * The latest open request, published by App.vue. `document` names the
 * document to focus once the studio is open; `epoch` is minted per request
 * so a later request always supersedes an earlier one, never the reverse.
 */
interface ProjectStudioRequest extends StudioOpenTarget {
  readonly studio: ProjectStudioKind;
  readonly projectId: ProjectId;
  readonly epoch: number;
}

/**
 * The host mount one request resolves to: the project the shared session
 * must serve and the sibling view that takes input. `document` names where
 * the activated view lands; a same-project sibling move changes only
 * `studio` (and `document`) — the host and its project session stay.
 */
interface ProjectStudioMount {
  readonly projectId: ProjectId;
  readonly studio: ProjectStudioKind;
  readonly document?: string;
}

/** Resolve a request to the host's mount, or null when nothing is open. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function projectStudioMount(request: ProjectStudioRequest | null): ProjectStudioMount | null {
  if (request === null) return null;
  return {
    projectId: request.projectId,
    studio: request.studio,
    ...(request.document !== undefined ? { document: request.document } : {}),
  };
}

/** One sibling editor destination the nav shows for the open project. */
interface StudioRoute {
  readonly kind: "logic" | "picture" | "view" | "sound";
  readonly label: string;
  /** The document the route lands on, when the route names one. */
  readonly document?: string;
  /**
   * Unavailable routes stay visible but marked, so the destination set does
   * not change shape under the cursor.
   */
  readonly available: boolean;
}

const ROUTE_ORDER = ["logic", "picture", "view", "sound"] as const;

/**
 * The project's sibling destinations in nav order. Code and Sound are whole
 * workspaces; Pictures and Views land on the first resource of their kind
 * (deeper navigation stays inside the host editor). A project with no
 * picture or view keeps the route visible but unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function projectStudioRoutes(input: {
  readonly pictures?: readonly number[];
  readonly views?: readonly number[];
  readonly sounds?: readonly number[];
}): readonly StudioRoute[] {
  const picture = input.pictures?.[0];
  const view = input.views?.[0];
  return Object.freeze(
    ROUTE_ORDER.map((kind): StudioRoute => {
      switch (kind) {
        case "logic":
          return { kind, label: "Code", available: true };
        case "sound":
          return { kind, label: "Sound", available: true };
        case "picture":
          return {
            kind,
            label: "Pictures",
            available: picture !== undefined,
            ...(picture !== undefined ? { document: `picture:${picture}` } : {}),
          };
        case "view":
          return {
            kind,
            label: "Views",
            available: view !== undefined,
            ...(view !== undefined ? { document: `view:${view}` } : {}),
          };
      }
    }),
  );
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

/**
 * Ask the shell to open a sibling studio — the same verb the bridge verbs
 * resolve to. A same-project request activates the retained sibling inside
 * the mounted host; a different project keeps the host while the session
 * runs its guarded switch.
 */
type ProjectStudioOpen = (
  kind: ProjectStudioKind,
  projectId: ProjectId,
  target?: StudioOpenTarget,
) => void;

const projectStudioOpenKey: InjectionKey<ProjectStudioOpen> = Symbol("agi-project-studio-open");

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function provideProjectStudioOpen(open: ProjectStudioOpen): void {
  provide(projectStudioOpenKey, open);
}

/** The shell's studio opener, or null outside the app shell. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function useProjectStudioOpen(): ProjectStudioOpen | null {
  return inject(projectStudioOpenKey, null);
}
