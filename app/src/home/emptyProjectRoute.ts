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
): Promise<boolean> {
  const project = await loadAuthoredGame(projectId);
  if (!project) return false;
  const { isPlayableProject } = await import("../../../src/authoring/starterProject.ts");
  if (isPlayableProject(new Map(Object.entries(project.files)))) return false;
  if (expectedHash !== undefined && location.hash !== expectedHash) return false;
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
  if (!id) return false;
  const opened = await openEmptyProject(id, hash);
  // A newer route owns the shared state; a stale resolution changes nothing.
  return opened && location.hash === hash;
}
