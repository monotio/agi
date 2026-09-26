/**
 * The Create workspace's view state: which tab each dock shows, which docks
 * are folded to their icon rail, and what the centre shows — the live stage,
 * or Room Studio on one picture while the game waits paused. Studio takes the
 * whole workspace: the docks stay mounted but hidden, and closing it brings
 * them back with the tabs and folds they had. App.vue creates one workspace;
 * the docks, the panels and the centre inject it.
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
import type { ResourceRevision } from "../../../src/gameIdentity.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { createPanels, type DockSide } from "./createDocks.ts";

export const DOCKS_STORAGE_KEY = "monotio_agi.createDocks";

/** What Room Studio opens on; RoomStudio edits it and keeps it against `baseRevision`. */
export interface StudioRequest {
  readonly room: number;
  readonly pictureNumber: number;
  readonly bytes: Uint8Array;
  /** The agent's picture text, only while it compiles to `bytes`. */
  readonly authoredSource?: string | undefined;
  readonly profile: AgiProfile;
  readonly title: string;
  readonly subtitle?: string | undefined;
  /** The booted game's resource revision the bytes were read at. */
  readonly baseRevision: ResourceRevision;
  /** The booted game's container files, read at the same revision (the actor probe's VIEWs). */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The same picture read again from the running game, or null when it is gone. */
  readonly reload: () => StudioRequest | null;
}

/** What an open Studio guards on the way out: its unkept changes, and the question that settles them. */
export interface StudioLeaveGuard {
  unkept(): boolean;
  /** Ask Keep / Discard / Cancel when changes are unkept; resolves whether to go on. */
  confirm(): Promise<boolean>;
}

export interface CreateCenter {
  /** The open Studio, or null while the centre shows the live stage. */
  readonly studio: Readonly<ShallowRef<StudioRequest | null>>;
  /** Show Studio in the centre; the game pauses until it closes. */
  openStudio(request: StudioRequest): void;
  /** Back to the live stage: the game resumes and takes the keyboard. */
  closeStudio(): void;
  /** Studio again on the same picture, read from the running game (after a stale Keep). */
  reopenStudio(): void;
  /** An open Studio guards leaving while it is mounted; returns the release. */
  guardStudio(guard: StudioLeaveGuard): () => void;
  /** Leaving now would lose unkept Studio changes. */
  studioUnkept(): boolean;
  /** Settle unkept Studio changes before the game or Create is left; resolves whether to go on. */
  confirmStudioLeave(): Promise<boolean>;
  /**
   * The screen is large enough for Room Studio; phone layouts are not. An
   * open Studio with unkept changes stays mounted where it does not fit,
   * covered by a notice, so a rotation or resize never loses its draft.
   */
  readonly studioFits: ComputedRef<boolean>;
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
  studioFits?: () => boolean;
  storage?: StorageLike | undefined;
}): CreateWorkspace {
  const storage = deps.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  const active = reactive({ left: "world", right: "assistant", sheet: "world" });
  const collapsed = reactive(readCollapsed(storage));
  const studio = shallowRef<StudioRequest | null>(null);
  const sheetOpen = ref(false);
  const studioFits = computed(() => deps.studioFits?.() ?? true);

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
    if (!studioFits.value) return;
    if (!studio.value) deps.pauseEngine("studio");
    studio.value = request;
  }

  function closeStudio(): void {
    if (!studio.value) return;
    studio.value = null;
    deps.resumeEngine("studio");
    deps.focusGame();
  }

  function reopenStudio(): void {
    const next = studio.value?.reload();
    if (next) openStudio(next);
    else closeStudio();
  }

  let guard: StudioLeaveGuard | null = null;
  function guardStudio(next: StudioLeaveGuard): () => void {
    guard = next;
    return () => {
      if (guard === next) guard = null;
    };
  }
  const studioUnkept = (): boolean => studio.value !== null && guard?.unkept() === true;
  const confirmStudioLeave = (): Promise<boolean> =>
    studioUnkept() ? guard!.confirm() : Promise.resolve(true);

  return {
    active,
    collapsed,
    sheetOpen,
    viewOnly: computed(() => deps.viewOnly?.() ?? false),
    studioFits,
    toggleDock,
    showPanel,
    studio,
    openStudio,
    closeStudio,
    reopenStudio,
    guardStudio,
    studioUnkept,
    confirmStudioLeave,
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
  const {
    studio,
    openStudio,
    closeStudio,
    reopenStudio,
    guardStudio,
    studioUnkept,
    confirmStudioLeave,
    studioFits,
  } = useCreateWorkspace();
  return {
    studio,
    openStudio,
    closeStudio,
    reopenStudio,
    guardStudio,
    studioUnkept,
    confirmStudioLeave,
    studioFits,
  };
}

/** The centre seam where one is provided; Studio's harness runs without a workspace. */
export function useOptionalCreateCenter(): CreateCenter | null {
  return inject(workspaceKey, null);
}
