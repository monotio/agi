import { shallowRef } from "vue";

export interface GameRoomMenu {
  readonly x: number;
  readonly y: number;
  readonly room: number;
}

/**
 * The open right-click menu on the game, retired on pick, Esc or outside
 * click. The play area decides the right button's owner from the mode
 * itself — Create owns it from the moment it is on stage, before a lazily
 * mounted workspace could answer — and asks for the menu through this state.
 */
export const gameRoomMenu = shallowRef<GameRoomMenu>();
