/**
 * Opening a picture's editor from a Help guide action: the workspace tab key
 * and the room that frames the picture — the room the game is in when it
 * draws the picture, else the lowest such room. A lesson rides on the
 * request, checked against the picture as it was when the guide opened the
 * editor.
 */
import { roomPictureUse } from "../../../src/agent/roomPictures.ts";
import { type EngineApi, useEngineApi } from "../engine/engineContext.ts";
import type { LessonSession } from "../lessons/lessonCheck.ts";
import type { StudioLesson } from "../lessons/types.ts";
import type { StudioRequest } from "../shell/workspaceEditor.ts";

import { studioPictureSource } from "./studioSource.ts";

export function useRoomStudio(engine: EngineApi = useEngineApi()) {
  const map = engine.roomMap;

  /**
   * The tab request for picture `picture`, framed by a room whose logic draws
   * it; null when the running game has no such picture.
   */
  function requestPicture(picture: number, lesson?: StudioLesson): StudioRequest | null {
    const game = engine.getBootedGame();
    const scan = map.resources.value;
    if (!game || scan.files !== game.files) return null;
    const source = studioPictureSource(
      scan,
      picture,
      engine.getAuthoringSession()?.state,
      game.authoredGame?.authoringState,
    );
    if (!source) return null;
    const drawers = [...scan.scans.keys()]
      .filter((room) =>
        roomPictureUse(room, {
          scans: scan.scans,
          shared: scan.shared,
          pictures: scan.picture,
        }).pictures.some((use) => use.picture === picture),
      )
      .sort((a, b) => a - b);
    const current = map.currentRoom.value;
    const room =
      current !== null && drawers.includes(current) ? current : (drawers[0] ?? current ?? 0);
    const session: LessonSession | undefined = lesson
      ? {
          lesson,
          before: source.bytes,
          ...(source.authoredSource !== undefined ? { beforeSource: source.authoredSource } : {}),
        }
      : undefined;
    return {
      key: `picture:${picture}`,
      room,
      ...(session ? { lesson: session } : {}),
    };
  }

  return { requestPicture };
}
