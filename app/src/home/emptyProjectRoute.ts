import { shallowRef } from "vue";
import { loadAuthoredGame } from "../project/gameStorage.ts";
import type { CachedGameData } from "../project/gameTypes.ts";
import type { ProjectId } from "../../../src/gameIdentity.ts";
import { parseGameHash } from "../shell/shellRoute.ts";

/** Temporary stage for stored projects whose boot LOGIC has yet to be authored. */
export const emptyProject = shallowRef<CachedGameData | null>(null);

export async function openEmptyProject(
  projectId: ProjectId,
  expectedHash?: string,
  isCurrent?: () => boolean,
): Promise<boolean> {
  if (isCurrent && !isCurrent()) return false;
  const project = await loadAuthoredGame(projectId);
  if (!project) return false;
  const { isPlayableProject } = await import("../../../src/authoring/starterProject.ts");
  if (isPlayableProject(new Map(Object.entries(project.files)))) return false;
  if (expectedHash !== undefined && location.hash !== expectedHash) return false;
  if (isCurrent && !isCurrent()) return false;
  emptyProject.value = project;
  const hash = `#create/${encodeURIComponent(projectId)}`;
  if (location.hash !== hash) history.pushState(null, "", hash);
  return true;
}

/** Resolve the stored body before sending a Create route through the engine. */
export async function followEmptyProjectRoute(): Promise<boolean> {
  const hash = location.hash;
  const route = parseGameHash(hash);
  if (route?.mode !== "create") {
    emptyProject.value = null;
    return false;
  }
  const { projectId } = await import("../../../src/gameIdentity.ts");
  const id = projectId(route.key);
  const opened = id ? await openEmptyProject(id, hash) : false;
  // A newer route owns the shared state; a stale resolution changes nothing.
  if (location.hash !== hash) return false;
  if (!opened) emptyProject.value = null;
  return opened;
}
