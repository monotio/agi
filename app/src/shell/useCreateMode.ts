/**
 * Create mode's wiring in the shell root: the real panels behind the dock
 * placeholders, the inspector and the assistant following their tabs, Room
 * Studio closing whenever the live stage has to come back, and the `[` / `]`
 * dock keys. App.vue calls it once, beside the workspace it provides.
 */
import { defineAsyncComponent, onScopeDispose, watch, type ComputedRef, type Ref } from "vue";
import ActivityPanel from "./ActivityPanel.vue";
import InspectPanel from "../inspector/InspectPanel.vue";
import { registerCreatePanel } from "./createDocks.ts";
import type { CreateWorkspace } from "./useCreateWorkspace.ts";
import type { EngineState } from "../useEngineTypes.ts";

/** Keys typed here are text, never dock shortcuts. */
function isTextEntry(target: EventTarget | null, gameInput: Element | null | undefined): boolean {
  if (!(target instanceof Element) || target === gameInput) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement)
    return !["checkbox", "radio", "button", "submit", "range"].includes(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}

export function useCreateMode(deps: {
  state: EngineState;
  workspace: CreateWorkspace;
  /** A game is running in Create mode. */
  creating: ComputedRef<boolean>;
  /** The phone's portrait touch layout: one view-only sheet instead of docks. */
  phone: ComputedRef<boolean>;
  debugOpen: Ref<boolean>;
  gameInput: () => Element | null | undefined;
}) {
  const { state, workspace, creating, phone, debugOpen } = deps;

  // The map's graph code loads only when the World panel first shows.
  const offs = [
    registerCreatePanel({
      id: "world",
      dock: "left",
      title: "World",
      icon: "map",
      order: 0,
      component: defineAsyncComponent(() => import("../world/WorldPanel.vue")),
    }),
    registerCreatePanel({
      id: "inspect",
      dock: "right",
      title: "Inspect",
      icon: "inspect",
      order: 1,
      component: InspectPanel,
    }),
    registerCreatePanel({
      id: "activity",
      dock: "right",
      title: "Activity",
      icon: "history",
      order: 2,
      component: ActivityPanel,
    }),
  ];
  onScopeDispose(() => offs.forEach((off) => off()));

  /** The Inspect tab is showing: its controls are docked, not floating. */
  const inspectShown = (): boolean =>
    creating.value &&
    (phone.value
      ? workspace.active.sheet === "inspect"
      : workspace.active.right === "inspect" && !workspace.collapsed.right);

  // In Create the inspector is on exactly while its tab shows; entering
  // Create with it on opens the tab, leaving Create turns it off.
  watch(
    () => [creating.value, inspectShown()] as const,
    ([inCreate, shown], previous) => {
      if (inCreate && !previous?.[0] && debugOpen.value && !shown) {
        workspace.showPanel("inspect");
        return;
      }
      if (inCreate) debugOpen.value = shown;
      else if (previous?.[0]) debugOpen.value = false;
    },
  );

  // Switching the inspector on or off elsewhere (Settings → Inspector, the
  // assistant's Inspect button) moves to or away from its tab in Create.
  watch(debugOpen, (on) => {
    if (!creating.value || on === inspectShown()) return;
    workspace.showPanel(on ? "inspect" : "assistant");
  });

  // An assistant turn that opens in Create shows its tab.
  watch(
    () => state.powerUp.open,
    (open) => {
      if (open && creating.value) workspace.showPanel("assistant");
    },
  );

  // The live stage comes back whenever Create is left or the game stops.
  watch(
    () => [creating.value, state.phase, state.walkthrough.active] as const,
    ([inCreate, phase, watching]) => {
      if (!inCreate || phase !== "running" || watching) workspace.closeStudio();
    },
  );

  /**
   * `[` and `]` fold the left and right docks. They are consumed before the
   * game sees them — Create never lets a bracket reach the parser — except
   * where the key is text: the assistant's composer, a note, a field.
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
