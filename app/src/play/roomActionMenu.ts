import { shallowRef } from "vue";

/** Create arms right-click room actions on the game; the play area answers with a menu request. */
export const roomMenuArmed = shallowRef(false);

export interface GameRoomMenu {
  readonly x: number;
  readonly y: number;
  readonly room: number;
}

/** The open right-click menu on the game, retired on pick, Esc or outside click. */
export const gameRoomMenu = shallowRef<GameRoomMenu>();
