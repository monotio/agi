/**
 * Open a Studio on one resource of the running game by number: Room Studio
 * on picture N, Sprite Studio on view N. The Help guide's actions and its
 * lessons use it; it switches to Create first (a catalog game opens there
 * read-only until its first Keep forks a remix) and opens through the Create
 * centre like the World panel does. A lesson rides on the request, with the
 * resource as Studio first opened on it, through every reopen.
 */
import { computed } from "vue";
import { useEngineApi } from "../engine/engineContext.ts";
import type { LessonSession } from "../lessons/lessonCheck.ts";
import type { LessonTarget, StudioLesson } from "../lessons/types.ts";
import { useRoomStudio } from "../world/useRoomStudio.ts";
import { useSpriteStudio } from "../world/useSpriteStudio.ts";
import { useCreateWorkspace, type StudioRequest } from "./useCreateWorkspace.ts";
import { useShell } from "./useShell.ts";

function withLesson(request: StudioRequest, lesson: LessonSession): StudioRequest {
  const attach = (next: StudioRequest | null) => next && withLesson(next, lesson);
  return {
    ...request,
    lesson,
    reload: () => attach(request.reload()),
    reloadFromStorage: async () => attach(await request.reloadFromStorage()),
  };
}

export function useStudioLauncher() {
  const { state } = useEngineApi();
  const shell = useShell();
  const workspace = useCreateWorkspace();
  const rooms = useRoomStudio();
  const sprites = useSpriteStudio();

  /** A Studio can open now: Create is available and the screen fits one. */
  const available = computed(
    () => shell.createAvailable.value && workspace.studioFits.value && !state.powerUp.busy,
  );

  /** Open `target` (for `lesson`, when given); resolves whether a Studio opened on it. */
  async function open(target: LessonTarget, lesson?: StudioLesson): Promise<boolean> {
    if (!available.value) return false;
    if (workspace.studio.value) {
      if (!(await workspace.confirmStudioLeave())) return false;
      workspace.closeStudio();
    }
    shell.setMode("create");
    if (shell.mode.value !== "create") return false;
    const request =
      target.studio === "room"
        ? rooms.requestPicture(target.picture)
        : await sprites.request(target.view);
    if (!request) return false;
    workspace.openStudio(
      lesson
        ? withLesson(request, {
            lesson,
            before: request.bytes.slice(),
            beforeSource: request.kind === "picture" ? request.authoredSource : undefined,
          })
        : request,
    );
    return workspace.studio.value !== null;
  }

  return { available, open };
}
