/**
 * Cross-component verbs that are not engine calls. App.vue provides one
 * bridge object; the component that owns a verb registers its handler, and
 * siblings (or the shell's global key/hash routing) call it through the
 * injected bridge instead of reaching across templates.
 */
import { inject, provide, type InjectionKey } from "vue";
import type { ProjectId } from "../project/gameTypes.ts";

export interface ShellBridge {
  /**
   * Toggle the assistant bubble (registered by AgentBubble). `mode` selects
   * the surface the bubble opens on — "ask" for read-only help, "remix" for
   * the creator tools.
   */
  togglePowerUp(mode?: "ask" | "remix"): void;
  /** Start a playtest recording (registered by GameHeader). */
  startPlaytest(): void;
  /** Open the create-adventure section (registered by CreatePanel). */
  openCreateSection(updateHash?: boolean): void;
  /** Close the header's open nav menus (registered by GameHeader). */
  closeNavMenus(restoreFocus?: boolean): void;
  /** Start the recorded walkthrough for a game alias (registered by App.vue). */
  startWalkthrough(alias: string): void;
  /** The create pane's launch button (registered by CreatePanel). */
  createButtonEl(): HTMLElement | null | undefined;
  /** The assistant bubble's input (registered by AgentBubble). */
  assistantInputEl(): HTMLElement | null | undefined;
  /** Focus the game input (registered by PlayArea). */
  focusGameInput(): void;
  /**
   * Open the Help guide, optionally at a section id and a topic in it, which
   * it scrolls to and focuses (registered by GameHeader).
   */
  openHelp(section?: string, topic?: string): void;
  /**
   * Open Logic Studio on a stored project (registered by App.vue). The
   * workspace is independent of any running game: it boots no engine and
   * needs no provider or key.
   */
  openLogicProject(projectId: ProjectId): void;
  /**
   * Open Sound Studio on a stored project (registered by App.vue) — the same
   * stored-project mount as Logic Studio: no engine, no provider, no key.
   */
  openSoundProject(projectId: ProjectId): void;
}

/** Inject it with a null default where the shell may be absent (the Studio harness). */
export const shellBridgeKey: InjectionKey<ShellBridge> = Symbol("agi-shell-bridge");

export function createShellBridge(): ShellBridge {
  return {
    togglePowerUp: () => {},
    startPlaytest: () => {},
    openCreateSection: () => {},
    closeNavMenus: () => {},
    startWalkthrough: () => {},
    createButtonEl: () => null,
    assistantInputEl: () => null,
    focusGameInput: () => {},
    openHelp: () => {},
    openLogicProject: () => {},
    openSoundProject: () => {},
  };
}

export function provideShellBridge(bridge: ShellBridge): void {
  provide(shellBridgeKey, bridge);
}

export function useShellBridge(): ShellBridge {
  const bridge = inject(shellBridgeKey);
  if (!bridge) throw new Error("useShellBridge: App.vue did not provide the shell bridge");
  return bridge;
}
