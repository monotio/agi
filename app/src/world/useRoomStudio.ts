/**
 * Opening Room Studio from Create: a room's picture from its card in the
 * World panel, or a picture by number (a Help guide action). Each builds the
 * centre's request from the running game's booted files (the room map's
 * scan) and reads the same picture again when a refused Keep reopens it.
 */
import { roomPictureUse } from "../../../src/agent/roomPictures.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import type { PictureStudioRequest } from "../shell/useCreateWorkspace.ts";

const RELOADED = "Loaded the latest saved version of this game.";

export function useRoomStudio() {
  const engine = useEngineApi();
  const map = engine.roomMap;

  /** Room Studio's request for one room's picture, read from the running game each time it is asked. */
  function request(
    room: number,
    title: string,
    picture: number,
    notice?: string,
  ): PictureStudioRequest | null {
    const source = map.studioSource(picture);
    if (!source) return null;
    return {
      kind: "picture",
      room,
      pictureNumber: picture,
      ...source,
      walk: room > 0 ? map.studioRoom(room) : null,
      // A picture can serve several rooms: an untitled room is named by what Studio edits.
      title: title || `PIC ${picture}`,
      subtitle: `Room ${room} · PIC ${picture}`,
      notice,
      reload: () => request(room, title, picture),
      reloadFromStorage: async () =>
        (await engine.reloadFromStorage()) && engine.state.phase !== "error"
          ? request(room, title, picture, RELOADED)
          : null,
    };
  }

  /**
   * Room Studio on picture `picture`, framed by a room whose logic draws it:
   * the room the game is in when it does, else the lowest such room.
   */
  function requestPicture(picture: number): PictureStudioRequest | null {
    const scan = map.resources.value;
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
    const title = map.graph.value.nodes.find((node) => node.room === room)?.title ?? "";
    return request(room, title, picture);
  }

  return { request, requestPicture };
}
