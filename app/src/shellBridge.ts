/**
 * Cross-component verbs that are not engine calls. App.vue provides one
 * bridge object; the component that owns a verb registers its handler, and
 * siblings (or the shell's global key/hash routing) call it through the
 * injected bridge instead of reaching across templates.
 */
import { inject, provide, type InjectionKey } from "vue";

export interface ShellBridge {
  /** Toggle the assistant bubble (registered by AgentBubble). */
  togglePowerUp(): void;
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
}

export const shellBridgeKey: InjectionKey<ShellBridge> = Symbol("agi-shell-bridge");

export function createShellBridge(): ShellBridge {
  return {
    togglePowerUp: () => {},
    openCreateSection: () => {},
    closeNavMenus: () => {},
    startWalkthrough: () => {},
    createButtonEl: () => null,
    assistantInputEl: () => null,
    focusGameInput: () => {},
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
