import { ref } from "vue";

export type FocusZone = "parts" | "editor" | "game" | "panel" | "agent";
const ORDER: readonly FocusZone[] = ["parts", "editor", "game", "panel", "agent"];
const LABELS: Record<FocusZone, string> = {
  parts: "Parts",
  editor: "Editor",
  game: "Game",
  panel: "Panel",
  agent: "Agent",
};

/** Hosts supply currently visible roots, so folded and unmounted zones are skipped. */
export function useFocusZones(roots: () => ReadonlyMap<FocusZone, HTMLElement>) {
  const active = ref<FocusZone>();
  const announcement = ref("");
  let marked: HTMLElement | undefined;
  const addedTabindex = new Set<HTMLElement>();

  function zoneFor(target: Node | null): FocusZone | null {
    if (!target) return null;
    const available = roots();
    let nearest: FocusZone | null = null;
    for (const zone of ORDER) {
      const root = available.get(zone);
      if (root?.contains(target) && (nearest === null || available.get(nearest)?.contains(root)))
        nearest = zone;
    }
    return nearest;
  }

  function activate(zone: FocusZone | null): void {
    marked?.removeAttribute("data-focus-zone-active");
    marked = zone === null ? undefined : roots().get(zone);
    marked?.setAttribute("data-focus-zone-active", "");
    if (active.value !== zone) announcement.value = zone === null ? "" : `${LABELS[zone]} focused`;
    active.value = zone ?? undefined;
  }

  function track(target: Node | null): void {
    activate(zoneFor(target));
  }

  function focus(zone: FocusZone): boolean {
    const root = roots().get(zone);
    if (!root) return false;
    if (root.hasAttribute && !root.hasAttribute("tabindex")) {
      root.setAttribute("tabindex", "-1");
      addedTabindex.add(root);
    }
    root.focus({ preventScroll: true });
    activate(zone);
    return true;
  }

  function cycle(direction: 1 | -1 = 1): void {
    const current = roots();
    const available = ORDER.filter((zone) => current.has(zone));
    if (!available.length) return;
    const index = active.value === undefined ? -1 : available.indexOf(active.value);
    const next =
      index < 0
        ? direction === 1
          ? 0
          : available.length - 1
        : (index + direction + available.length) % available.length;
    focus(available[next]!);
  }

  function dispose(): void {
    activate(null);
    for (const root of addedTabindex) root.removeAttribute("tabindex");
    addedTabindex.clear();
  }

  return { active, announcement, focus, cycle, track, zoneFor, dispose };
}
