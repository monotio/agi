/** Create mode follows the room the player is in and owns the dock keys. */
import { watch, type ComputedRef, type Ref } from "vue";
import type { CreateWorkspace } from "./useCreateWorkspace.ts";
import type { EngineState } from "../engine/useEngineTypes.ts";
import type { RoomMap } from "../world/useRoomMap.ts";

/** Keys typed here are text, never dock shortcuts: the game's input line included. */
function isTextEntry(target: EventTarget | null, gameInput: Element | null | undefined): boolean {
  if (!(target instanceof Element)) return false;
  if (target === gameInput) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement)
    return !["checkbox", "radio", "button", "submit", "range"].includes(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}

export function useCreateMode(deps: {
  state: EngineState;
  workspace: CreateWorkspace;
  roomMap: () => Pick<RoomMap, "followsPlayer"> | null;
  /** A game is running in Create mode. */
  creating: ComputedRef<boolean>;
  /** The phone's portrait touch layout: one view-only sheet instead of docks. */
  phone: ComputedRef<boolean>;
  debugOpen: Ref<boolean>;
  gameInput: () => Element | null | undefined;
}) {
  const { state, workspace, creating, phone } = deps;

  // Each entry to Create follows the room the player is in.
  watch(creating, (inCreate) => {
    const map = deps.roomMap();
    if (inCreate && map) map.followsPlayer.value = true;
  });

  // An assistant turn that opens in Create shows its tab.
  watch(
    () => state.powerUp.open,
    (open) => {
      if (open && creating.value) workspace.showPanel("assistant");
    },
  );

  /**
   * `[` and `]` fold the left and right docks, but only where the key is not
   * text: typed into the game's input line (or the assistant's composer, a
   * note, a field) a bracket is a character, and reaches the parser in
   * Create just as it does in Play.
   */
  function onDockKey(ev: KeyboardEvent): boolean {
    if (!creating.value || (ev.key !== "[" && ev.key !== "]")) return false;
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return false;
    if (ev.target instanceof Element && ev.target.closest("dialog[open]")) return false;
    if (isTextEntry(ev.target, deps.gameInput())) return false;
    ev.preventDefault();
    if (!phone.value) workspace.toggleDock(ev.key === "[" ? "left" : "right");
    return true;
  }

  return { onDockKey };
}
