/**
 * The Create workspace's view state: which tab each dock shows, which docks
 * are folded to their icon rail, and what the centre shows — the live stage,
 * or Room Studio on one picture while the game waits paused. App.vue creates
 * one workspace; the docks, the panels and the centre inject it.
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
  shallowRef,
  type ComputedRef,
  type InjectionKey,
  type Ref,
  type ShallowRef,
} from "vue";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { createPanels, type DockSide } from "./createDocks.ts";

export const DOCKS_STORAGE_KEY = "monotio_agi.createDocks";

/** What Room Studio opens on. The placeholder shows it; RoomStudio edits it. */
export interface StudioRequest {
  readonly room: number;
  readonly pictureNumber: number;
  readonly bytes: Uint8Array;
  /** The agent's picture text, only while it compiles to `bytes`. */
  readonly authoredSource?: string | undefined;
  readonly profile: AgiProfile;
  readonly title: string;
  readonly subtitle?: string | undefined;
}

export interface CreateCenter {
  /** The open Studio, or null while the centre shows the live stage. */
  readonly studio: Readonly<ShallowRef<StudioRequest | null>>;
  /** Show Studio in the centre; the game pauses until it closes. */
  openStudio(request: StudioRequest): void;
  /** Back to the live stage: the game resumes and takes the keyboard. */
  closeStudio(): void;
}

export interface CreateWorkspace extends CreateCenter {
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
  pauseEngine(owner: string): void;
  resumeEngine(owner: string): void;
  /** Hand the keyboard back to the game after Studio closes. */
  focusGame(): void;
  viewOnly?: () => boolean;
  storage?: StorageLike | undefined;
}): CreateWorkspace {
  const storage = deps.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  const active = reactive({ left: "world", right: "assistant", sheet: "world" });
  const collapsed = reactive(readCollapsed(storage));
  const studio = shallowRef<StudioRequest | null>(null);
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
    active.sheet = id;
    sheetOpen.value = true;
    for (const side of ["left", "right"] as const) {
      if (!createPanels(side).some((panel) => panel.id === id)) continue;
      active[side] = id;
      if (collapsed[side]) toggleDock(side);
    }
  }

  function openStudio(request: StudioRequest): void {
    if (!studio.value) deps.pauseEngine("studio");
    studio.value = request;
  }

  function closeStudio(): void {
    if (!studio.value) return;
    studio.value = null;
    deps.resumeEngine("studio");
    deps.focusGame();
  }

  return {
    active,
    collapsed,
    sheetOpen,
    viewOnly: computed(() => deps.viewOnly?.() ?? false),
    toggleDock,
    showPanel,
    studio,
    openStudio,
    closeStudio,
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

/** The centre seam: open Room Studio on a picture, or return to the live stage. */
export function useCreateCenter(): CreateCenter {
  const { studio, openStudio, closeStudio } = useCreateWorkspace();
  return { studio, openStudio, closeStudio };
}
