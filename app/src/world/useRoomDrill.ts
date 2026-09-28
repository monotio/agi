/**
 * The room list's drill-in, shared by Create's World panel and the map
 * window: with a room selected its card takes the list's place, and "All
 * rooms" (or Esc inside the card) returns to the list where it was, the room
 * just shown in view and focused. A list pick moves focus to the card's
 * heading, since the row it came from is gone.
 */
import { computed, nextTick, watch, type ShallowRef } from "vue";
import type { RoomMap } from "./useRoomMap.ts";

export function useRoomDrill(deps: {
  map: Pick<RoomMap, "selected" | "graph" | "select">;
  /** The element holding the list; the nearest scrolling ancestor (or itself) keeps its place. */
  root: Readonly<ShallowRef<HTMLElement | null>>;
  /** The card, once shown. */
  detail: Readonly<ShallowRef<{ focusHeading(): void } | null>>;
  /** Select a room the way the caller's graph does (it also centres it). */
  pick: (room: number) => void;
}) {
  const { map, root, detail } = deps;

  const selectedNode = computed(
    () => map.graph.value.nodes.find((n) => n.room === map.selected.value) ?? null,
  );

  function scroller(): HTMLElement | null {
    for (let el = root.value; el; el = el.parentElement)
      if (/auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
    return null;
  }

  let listScroll = 0;
  // Pre-flush: the list is still laid out when the card is about to replace it.
  watch(
    () => selectedNode.value !== null,
    (showing) => {
      if (showing) listScroll = scroller()?.scrollTop ?? 0;
    },
  );

  /** A list pick: the card takes the row's place, so focus moves to its heading. */
  function pickFromList(room: number): void {
    deps.pick(room);
    void nextTick(() => detail.value?.focusHeading());
  }

  /** Back to the list where it was, the room just shown in view and focused. */
  async function showAllRooms(): Promise<void> {
    const room = map.selected.value;
    map.select(undefined);
    await nextTick();
    const el = scroller();
    if (el) el.scrollTop = listScroll;
    const row = root.value?.querySelector<HTMLElement>(`[data-room="${room}"] button`);
    row?.scrollIntoView({ block: "nearest" });
    row?.focus({ preventScroll: true });
  }

  /** Esc inside the card returns to the list; a menu inside it takes Esc first. */
  function onDetailKeydown(ev: KeyboardEvent): void {
    if (ev.key !== "Escape" || ev.defaultPrevented) return;
    ev.preventDefault();
    ev.stopPropagation();
    // A field being edited commits on change, which a blur fires before it goes.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    void showAllRooms();
  }

  return { selectedNode, pickFromList, showAllRooms, onDetailKeydown };
}
