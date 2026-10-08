/**
 * The blank stage (a stored project without a boot LOGIC) never boots the
 * engine, so its actions and the agent drawer share one project session held
 * here. The session writes only while the stage still shows that project; the
 * drawer disposes it when the stage closes or the project boots for real.
 */
import { shallowRef } from "vue";
import { emptyProject } from "./emptyProjectRoute.ts";
import { loadAuthoredGameWithHistoryLifetime } from "../project/gameStorage.ts";
import { openProjectSession, type ProjectSession } from "../project/projectSession.ts";
import type { CachedGameData } from "../project/gameTypes.ts";
import type { EngineApi } from "../engine/engineContext.ts";
import type { GameLibrary } from "../library/useGameLibrary.ts";
import type { Shell } from "../shell/useShell.ts";
import type { ProjectId } from "../../../src/gameIdentity.ts";

/** Only the failed opening owned by this exact blank stage has a recovery notice. */
export const emptyStageBootFailure = shallowRef<CachedGameData | null>(null);

let held: { projectId: ProjectId; session: ProjectSession } | null = null;

export async function emptyStageSession(project: CachedGameData): Promise<ProjectSession | null> {
  if (held?.projectId === project.projectId) return held.session;
  held?.session.dispose();
  held = null;
  const loaded = await loadAuthoredGameWithHistoryLifetime(project.projectId);
  if (!loaded?.lifetime) return null;
  const session = openProjectSession({
    data: loaded.data,
    lifetime: loaded.lifetime,
    current: () => emptyProject.value?.projectId === project.projectId,
    admission: {
      runToken: `empty-${crypto.randomUUID()}`,
      async admit() {
        return { status: "unchanged", expected: null, current: null, patchGeneration: 0 };
      },
    },
  });
  // The stage moved on while storage answered: keep nothing behind.
  if (emptyProject.value?.projectId !== project.projectId) {
    session.dispose();
    return null;
  }
  held = { projectId: project.projectId, session };
  return session;
}

export function closeEmptyStageSession(): void {
  emptyStageBootFailure.value = null;
  held?.session.dispose();
  held = null;
}

let opening = false;
/**
 * The blank stage's project can boot now: save settled, so hand it to the
 * real Create workspace. Shared by the stage's own buttons and the drawer,
 * which notices when the agent's commit added the boot LOGIC.
 */
export async function openPlayableProject(deps: {
  engine: EngineApi;
  library: GameLibrary;
  shell: Shell;
  projectId: ProjectId;
}): Promise<void> {
  const project = emptyProject.value;
  if (opening || project?.projectId !== deps.projectId || deps.library.libraryActionBusy.value)
    return;
  opening = true;
  emptyStageBootFailure.value = null;
  const owner = held;
  const isCurrent = () =>
    emptyProject.value === project && project.projectId === deps.projectId && held === owner;
  try {
    deps.library.refreshLibrary(deps.projectId);
    deps.engine.setProjectMode("create");
    const accepted = await deps.library.onBootSavedGame(false, undefined, undefined, isCurrent);
    if (!isCurrent()) return;
    if (!accepted) {
      if (
        deps.library.libraryActionError.value ||
        (deps.engine.state.phase === "error" && deps.engine.state.error)
      )
        emptyStageBootFailure.value = project;
      return;
    }
    closeEmptyStageSession();
    deps.shell.expectCreate(deps.projectId);
    emptyProject.value = null;
  } finally {
    opening = false;
  }
}
