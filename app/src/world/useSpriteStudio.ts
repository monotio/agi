/**
 * Opening a VIEW editor from outside the workspace: a Help guide lesson, or
 * a staged character-sheet candidate from reference art ("Open VIEW
 * editor"). Each opens the workspace tab directly; a lesson rides on the
 * request, checked against the VIEW as it was when the guide opened the
 * editor.
 */
import { base64ToBytes } from "../project/bytes.ts";
import { type EngineApi, useEngineApi } from "../engine/engineContext.ts";
import { stagedRefusal } from "../references/referenceArt.ts";
import type { StoredReference } from "../references/referenceArt.ts";
import type { LessonSession } from "../lessons/lessonCheck.ts";
import type { StudioLesson } from "../lessons/types.ts";
import { useWorkspaceEditor, type StudioRequest } from "../shell/workspaceEditor.ts";

import { studioSpriteSource } from "./studioSource.ts";

export function useSpriteStudio(engine: EngineApi = useEngineApi(), editor = useWorkspaceEditor()) {
  const map = engine.roomMap;

  /** The tab request for VIEW `view`; null when the running game has no such view. */
  function request(view: number, lesson?: StudioLesson): StudioRequest | null {
    const game = engine.getBootedGame();
    const scan = map.resources.value;
    if (!game || scan.files !== game.files) return null;
    const source = studioSpriteSource(scan, view, map.currentRoom.value ?? undefined);
    if (!source) return null;
    const session: LessonSession | undefined = lesson
      ? { lesson, before: source.bytes }
      : undefined;
    return { key: `view:${view}`, ...(session ? { lesson: session } : {}) };
  }

  /** Open a staged character-sheet candidate to repair it before keeping. */
  function openStaged(reference: StoredReference): void {
    const staged = reference.staged;
    if (!staged) return;
    const game = engine.getBootedGame();
    if (!game) throw new Error("Open a game before repairing this sheet.");
    const refusal = stagedRefusal(reference, {
      project: game.projectId!,
      revision: game.revision,
    });
    if (refusal) throw new Error(refusal);
    if (map.resources.value.files !== game.files)
      throw new Error("This sheet could not open. Attach the sheet again.");
    const key = `view:${staged.num}`;
    editor.studioRequests.value = {
      ...editor.studioRequests.value,
      [key]: {
        key,
        staged: {
          reference: reference.id,
          bytes: new Uint8Array(base64ToBytes(staged.payload)),
          baseRevision: game.revision,
        },
      },
    };
    editor.open(key);
  }

  return { request, openStaged };
}
