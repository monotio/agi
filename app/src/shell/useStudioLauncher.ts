/**
 * Open a resource's editor from the Help guide by number: the picture editor
 * on picture N, the VIEW editor on view N. The guide's lessons use it; it
 * switches to Create first and opens the workspace tab directly, like
 * choosing the part in the workspace. A lesson rides on the tab's request,
 * checked against the resource as it was when the guide opened the editor.
 */
import { computed } from "vue";
import { useEngineApi } from "../engine/engineContext.ts";
import type { LessonTarget, StudioLesson } from "../lessons/types.ts";
import { useWorkspaceEditor } from "./workspaceEditor.ts";
import { useShell } from "./useShell.ts";

export function useStudioLauncher() {
  const engine = useEngineApi();
  const { state } = engine;
  const shell = useShell();
  const editor = useWorkspaceEditor();

  /** An editor can open now: Create is available and the agent is ready. */
  const available = computed(() => shell.createAvailable.value && !state.powerUp.busy);

  /** Open `target` (for `lesson`, when given); resolves whether its editor opened. */
  async function open(target: LessonTarget, lesson?: StudioLesson): Promise<boolean> {
    if (!available.value) return false;
    shell.setMode("create");
    if (shell.mode.value !== "create") return false;
    // Lazy imports: the studio sources stay off the Play boot path (check:bundle).
    const request =
      target.studio === "room"
        ? (await import("../world/useRoomStudio.ts"))
            .useRoomStudio(engine)
            .requestPicture(target.picture, lesson)
        : (await import("../world/useSpriteStudio.ts"))
            .useSpriteStudio(engine, editor)
            .request(target.view, lesson);
    if (!request) return false;
    editor.studioRequests.value = {
      ...editor.studioRequests.value,
      [request.key]: request,
    };
    editor.open(request.key);
    return editor.selected.value === request.key;
  }

  return { available, open };
}
