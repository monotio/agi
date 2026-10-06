/**
 * The Create workspace's dock state: which tab each dock shows, which docks
 * are folded to their icon rail, and the phone's single bottom sheet. The
 * centre's tabs and editors live in the workspace editor
 * (shell/workspaceEditor.ts), which also holds the dock panel registry this
 * state queries. App.vue creates one workspace; the docks, the panels and
 * the centre inject it.
 *
 * Folded docks are a per-viewer convenience kept in browser storage, never a
 * format: a blocked or corrupt entry falls back to open docks.
 */
import {
  computed,
  inject,
  provide,
  reactive,
  ref,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from "vue";
import type { DockSide } from "./workspaceEditor.ts";

export const DOCKS_STORAGE_KEY = "monotio_agi.createDocks";

export interface CreateWorkspace {
  /** The active tab per dock; `sheet` is the phone's single bottom sheet. */
  readonly active: Record<DockSide | "sheet", string>;
  /** Docks folded to their icon rail. */
  readonly collapsed: Record<DockSide, boolean>;
  /** The phone's sheet is open (not just its tab strip). */
  readonly sheetOpen: Ref<boolean>;
  /** A phone's Create: the panels show, nothing edits. */
  readonly viewOnly: ComputedRef<boolean>;
  toggleDock(side: DockSide): void;
  /** Select a panel's tab in whichever dock holds it, unfolding that dock. */
  showPanel(id: string): void;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function readCollapsed(storage: StorageLike | undefined): Record<DockSide, boolean> {
  try {
    const raw = JSON.parse(storage?.getItem(DOCKS_STORAGE_KEY) ?? "{}") as unknown;
    if (raw && typeof raw === "object") {
      const { left, right } = raw as Record<string, unknown>;
      return { left: left === true, right: right === true };
    }
  } catch {
    /* blocked or unreadable storage: docks open */
  }
  return { left: false, right: false };
}

export function createCreateWorkspace(deps: {
  /** Which dock a panel id sits in (the workspace editor's panel registry). */
  panelDock(id: string): DockSide | undefined;
  viewOnly?: () => boolean;
  storage?: StorageLike | undefined;
}): CreateWorkspace {
  const storage = deps.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  const active = reactive({ left: "world", right: "assistant", sheet: "world" });
  const collapsed = reactive(readCollapsed(storage));
  const sheetOpen = ref(false);

  function persist(): void {
    try {
      storage?.setItem(DOCKS_STORAGE_KEY, JSON.stringify(collapsed));
    } catch {
      /* the fold still applies for this page */
    }
  }

  function toggleDock(side: DockSide): void {
    collapsed[side] = !collapsed[side];
    persist();
  }

  function showPanel(id: string): void {
    const dock = deps.panelDock(id);
    if (!dock) return;
    active.sheet = id;
    sheetOpen.value = true;
    active[dock] = id;
    if (collapsed[dock]) toggleDock(dock);
  }

  return {
    active,
    collapsed,
    sheetOpen,
    viewOnly: computed(() => deps.viewOnly?.() ?? false),
    toggleDock,
    showPanel,
  };
}

const workspaceKey: InjectionKey<CreateWorkspace> = Symbol("agi-create-workspace");

export function provideCreateWorkspace(workspace: CreateWorkspace): void {
  provide(workspaceKey, workspace);
}

export function useCreateWorkspace(): CreateWorkspace {
  const workspace = inject(workspaceKey);
  if (!workspace) throw new Error("useCreateWorkspace: App.vue did not provide the workspace");
  return workspace;
}
