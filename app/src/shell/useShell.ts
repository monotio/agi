/**
 * The in-game shell: which mode a loaded game is shown in (Play or Create),
 * the routes that name it, and the verbs that cross between the two. App.vue
 * creates one shell; the top bar, the settings sheet and the Create docks
 * inject it.
 */
import {
  computed,
  inject,
  provide,
  ref,
  watch,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from "vue";
import type { EngineApi } from "../engine/engineContext.ts";
import type { ShellBridge } from "./shellBridge.ts";
import type { ProjectId } from "../project/gameTypes.ts";
import { gameHash, parseGameHash, type ShellMode } from "./shellRoute.ts";
import type { StudioLeaveGuard } from "./useCreateWorkspace.ts";

export type { ShellMode };

export interface Shell {
  readonly mode: Readonly<Ref<ShellMode>>;
  /**
   * Show the game in another mode. The switch is a history entry, so Back
   * and Forward move between Play and Create.
   */
  setMode(mode: ShellMode): void;
  /** Create is unavailable while a walkthrough or the recorded tape owns the stage. */
  readonly createAvailable: ComputedRef<boolean>;
  /**
   * Catalog and installed editions open Create read-only: the first edit
   * forks a remix through the ordinary remix flow.
   */
  readonly readOnly: ComputedRef<boolean>;
  /** Open or close the Play mode's Ask drawer. */
  toggleAsk(): void;
  /** Move to Create and open the assistant on its Remix surface. */
  openRemix(): void;
  /**
   * Open Create once `projectId` is the running game. A boot still in its
   * loading phase cannot take `setMode("create")`, so the intent waits here —
   * the panel that asked unmounts with Home before the game runs. It lands
   * only for the named project: a failed boot, a different game in the slot,
   * or leaving the game clears it.
   */
  expectCreate(projectId: ProjectId): void;
  /** The route key of the running game, or null (walkthroughs have their own). */
  routeKey(): string | null;
  /** Re-assert the running game's route without adding a history entry. */
  markRoute(): void;
  /** Follow Back/Forward: adopt the mode the URL names for the running game. */
  followRoute(hash: string): void;
  /** Leaving the game: the next one opens in Play. */
  reset(): void;
}

const shellKey: InjectionKey<Shell> = Symbol("agi-shell");

export function createShell(deps: {
  engine: Pick<EngineApi, "state" | "currentGame">;
  bridge: ShellBridge;
  /** Library source of a stored project ("catalog", "remix", …), if known. */
  librarySource: (projectId: string) => string | undefined;
  initialMode?: ShellMode;
  /** Room Studio's unkept changes, settled before Create is left. */
  createGuard?: StudioLeaveGuard;
}): Shell {
  const { state, currentGame } = deps.engine;
  const mode = ref<ShellMode>(deps.initialMode ?? "play");

  const createAvailable = computed(
    () => state.phase === "running" && !state.walkthrough.active && !state.historyView.active,
  );

  const readOnly = computed(() => {
    void state.patchTick;
    const game = currentGame();
    if (!game) return true;
    if (game.installed) return true;
    return game.projectId !== undefined && deps.librarySource(game.projectId) === "catalog";
  });

  function routeKey(): string | null {
    const game = currentGame();
    if (!game || state.walkthrough.active) return null;
    return (game.installed ? (game.folder ?? game.hash ?? game.alias) : game.projectId) ?? null;
  }

  function markRoute(): void {
    const key = routeKey();
    if (!key) return;
    const target = gameHash(mode.value, key);
    if (location.hash !== target) history.replaceState(null, "", target);
  }

  /** Leaving Create for `next` would lose unkept Studio changes: they are settled first. */
  const guarded = (next: ShellMode): boolean =>
    mode.value === "create" && next !== "create" && deps.createGuard?.unkept() === true;

  function setMode(next: ShellMode): void {
    if (next === mode.value) return;
    if (next === "create" && !createAvailable.value) return;
    if (guarded(next)) {
      void deps.createGuard!.confirm().then((go) => {
        if (go && !guarded(next)) setMode(next);
      });
      return;
    }
    mode.value = next;
    const key = routeKey();
    if (key) history.pushState(null, "", gameHash(next, key));
  }

  function followRoute(hash: string): void {
    const route = parseGameHash(hash);
    if (!route || state.phase !== "running") return;
    if (route.mode === "create" && !createAvailable.value) return;
    if (guarded(route.mode)) {
      // The history moved already: the URL names Create again until the question is settled.
      markRoute();
      void deps.createGuard!.confirm().then((go) => {
        if (!go || guarded(route.mode) || state.phase !== "running") return;
        mode.value = route.mode;
        markRoute();
      });
      return;
    }
    mode.value = route.mode;
  }

  function toggleAsk(): void {
    deps.bridge.togglePowerUp("ask");
  }

  function openRemix(): void {
    setMode("create");
    if (mode.value !== "create") return;
    if (state.powerUp.open && state.powerUp.mode === "remix") return;
    deps.bridge.togglePowerUp("remix");
  }

  /**
   * A Create switch queued while its project finishes booting. The running
   * phase spends it, and only when the named project is the booted one — a
   * boot that failed or was replaced can never inherit it.
   */
  let pendingCreate: ProjectId | null = null;

  function settlePendingCreate(): void {
    if (pendingCreate === null || state.phase === "loading") return;
    const project = pendingCreate;
    pendingCreate = null;
    if (state.phase === "running" && currentGame()?.projectId === project) setMode("create");
  }

  // The shell owns the wait: the panel that queued the switch unmounts with
  // Home while the boot it started is still loading, and this watch lives
  // exactly as long as the shell itself.
  watch(() => state.phase, settlePendingCreate);

  function expectCreate(projectId: ProjectId): void {
    pendingCreate = projectId;
    settlePendingCreate();
  }

  function reset(): void {
    pendingCreate = null;
    mode.value = "play";
  }

  return {
    mode,
    setMode,
    createAvailable,
    readOnly,
    toggleAsk,
    openRemix,
    expectCreate,
    routeKey,
    markRoute,
    followRoute,
    reset,
  };
}

export function provideShell(shell: Shell): void {
  provide(shellKey, shell);
}

export function useShell(): Shell {
  const shell = inject(shellKey);
  if (!shell) throw new Error("useShell: App.vue did not provide the shell");
  return shell;
}
