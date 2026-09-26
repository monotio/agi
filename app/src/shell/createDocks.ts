/**
 * The Create workspace's seam: panels register into the left or right dock
 * and the workspace renders them as tabs. The shell registers placeholders
 * for World (left) and Assistant (right); a later panel with the same id
 * replaces its placeholder, and new ids (Inspect, Activity, Resources…) add
 * tabs. Panels receive `readOnly` (catalog and installed editions: the first
 * edit forks a remix) as a prop.
 *
 *   registerCreatePanel({ id: "world", dock: "left", title: "World",
 *     icon: "map", order: 0, component: WorldPanel });
 *
 * The Assistant tab is special: the assistant that serves the Play drawer
 * stays mounted in the right dock across modes, so the shell draws it
 * whenever that tab is active and no component replaced it.
 */
import { markRaw, shallowReactive, type Component } from "vue";
import type { IconName } from "../ui/icons.ts";

export type DockSide = "left" | "right";

export interface CreatePanel {
  /** Stable id; the tab's test id is `dock-tab-<id>`. */
  readonly id: string;
  readonly dock: DockSide;
  readonly title: string;
  readonly icon?: IconName | undefined;
  /** Tabs sort by order, then registration. */
  readonly order?: number | undefined;
  /** The panel body. Without one the dock shows an empty placeholder. */
  readonly component?: Component | undefined;
}

const panels = shallowReactive(new Map<string, CreatePanel>());

/** Add (or replace, by id) a dock panel. Returns the unregister function. */
export function registerCreatePanel(panel: CreatePanel): () => void {
  const entry: CreatePanel = panel.component
    ? { ...panel, component: markRaw(panel.component) }
    : panel;
  panels.set(panel.id, entry);
  return () => {
    if (panels.get(panel.id) === entry) panels.delete(panel.id);
  };
}

/** The panels one dock shows, in tab order. */
export function createPanels(dock: DockSide): CreatePanel[] {
  return [...panels.values()]
    .filter((panel) => panel.dock === dock)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

registerCreatePanel({ id: "world", dock: "left", title: "World", icon: "map", order: 0 });
registerCreatePanel({
  id: "assistant",
  dock: "right",
  title: "Assistant",
  icon: "sparkles",
  order: 0,
});
