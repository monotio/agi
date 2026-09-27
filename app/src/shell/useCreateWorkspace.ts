/**
 * The Create workspace's view state: which tab each dock shows, which docks
 * are folded to their icon rail, and what the centre shows — the live stage,
 * or a Studio (Room Studio on one picture, Sprite Studio on one VIEW) while
 * the game waits paused. Studio takes the
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
import type { ViewUsage } from "../../../src/studio/sprite/spriteUsage.ts";
import type { StudioRoomSource } from "../world/studioSource.ts";
import type { LessonSession } from "../lessons/lessonCheck.ts";
import { createPanels, type DockSide } from "./createDocks.ts";

export const DOCKS_STORAGE_KEY = "monotio_agi.createDocks";

/** What every Studio opens on: resource bytes read from the booted game at `baseRevision`. */
interface StudioRequestBase {
  readonly profile: AgiProfile;
  readonly title: string;
  readonly subtitle?: string | undefined;
  /** The booted game's resource revision the bytes were read at. */
  readonly baseRevision: ResourceRevision;
  /** The booted game's container files, read at the same revision (VIEWs, room pictures). */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The same resource read again from the running game, or null when it is gone. */
  readonly reload: () => StudioRequest | null;
  /**
   * Reload the game from browser storage, then the same resource read from
   * it (carrying a `notice` that says so); null when there is none.
   */
  readonly reloadFromStorage: () => Promise<StudioRequest | null>;
  /** A line Studio says as it opens on this request. */
  readonly notice?: string | undefined;
  /** The Help guide lesson Studio was opened from: its "Try this" card and challenge. */
  readonly lesson?: LessonSession | undefined;
}

/** Room Studio on one picture; RoomStudio edits it and keeps it against `baseRevision`. */
export interface PictureStudioRequest extends StudioRequestBase {
  readonly kind: "picture";
  readonly room: number;
  readonly pictureNumber: number;
  readonly bytes: Uint8Array;
  /** The agent's picture text, only while it compiles to `bytes`. */
  readonly authoredSource?: string | undefined;
  /** The Walk view's room: its logic (door rules), bindings, plan, tests and rooms. */
  readonly walk?: StudioRoomSource | null | undefined;
}

/** A room the in-room preview can stand a sprite in: its number and the picture it draws. */
export interface SpriteRoom {
  readonly room: number;
  readonly picture: number;
  readonly title?: string | undefined;
}

/** Sprite Studio on one VIEW (studio/sprite/SpriteStudio.vue). */
export interface SpriteStudioRequest extends StudioRequestBase {
  readonly kind: "sprite";
  readonly viewNumber: number;
  readonly bytes: Uint8Array;
  /** Rooms and logics whose bytecode names the view (spriteUsage.ts). */
  readonly usage: ViewUsage;
  /** Rooms with a picture to preview the sprite in, the room the game is in first. */
  readonly rooms: readonly SpriteRoom[];
  /** The game's cycle delay (v10) when Studio opened; the loop preview's pace. */
  readonly speed: number;
  /** The room's set.pri.base when known. */
  readonly priorityBase?: number | undefined;
  /** A staged character-sheet candidate: Keep goes through its reference's staged keep. */
  readonly stagedReference?: string | undefined;
}

export type StudioRequest = PictureStudioRequest | SpriteStudioRequest;

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
  /**
   * Studio again on the same resource after a refused Keep: read from the
   * running game, or with `fromStorage`, from the game reloaded from storage.
   */
  reopenStudio(fromStorage?: boolean): Promise<void>;
  /** An open Studio guards leaving while it is mounted; returns the release. */
  guardStudio(guard: StudioLeaveGuard): () => void;
  /** Leaving now would lose unkept Studio changes. */
  studioUnkept(): boolean;
  /** Settle unkept Studio changes before the game or Create is left; resolves whether to go on. */
  confirmStudioLeave(): Promise<boolean>;
  /**
   * The screen is large enough for a Studio; phone layouts are not. An
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

  async function reopenStudio(fromStorage = false): Promise<void> {
    const current = studio.value;
    if (!current) return;
    if (!fromStorage) {
      const next = current.reload();
      if (next) openStudio(next);
      else closeStudio();
      return;
    }
    // Studio leaves while the game reloads, and the old game stays paused
    // until its worker is gone: running on, it could checkpoint the bytes
    // storage no longer holds. The new game gets its own pause on reopen.
    studio.value = null;
    const next = await current.reloadFromStorage().finally(() => deps.resumeEngine("studio"));
    if (next && !studio.value) openStudio(next);
    if (!studio.value) deps.focusGame();
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

/** The centre seam where one is provided; Studio's harness runs without a workspace. */
export function useOptionalCreateCenter(): CreateCenter | null {
  return inject(workspaceKey, null);
}
