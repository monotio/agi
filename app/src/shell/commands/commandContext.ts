import { inject, provide, type InjectionKey } from "vue";
import type { CommandContext, CommandRegistry } from "./commandRegistry.ts";

const commandKey: InjectionKey<CommandRegistry> = Symbol("workspace-commands");
export function provideCommands(registry: CommandRegistry): void {
  provide(commandKey, registry);
}
export function useOptionalCommands(): CommandRegistry | null {
  return inject(commandKey, null);
}
export function emptyCommandContext(): CommandContext {
  return {
    editorFocus: false,
    gameFocus: false,
    textInputFocus: false,
    dialogOpen: false,
    debugging: false,
  };
}
