import type { CommandContext, CommandRegistry } from "./commandRegistry.ts";

export interface ChooserItem {
  readonly id: string;
  readonly title: string;
  readonly keys?: readonly string[];
  readonly disabled?: boolean;
  readonly run?: () => unknown;
}
export type PartsProvider = () => readonly ChooserItem[];

/** Evaluate availability against the focus that opened the chooser. */
export function commandItems(registry: CommandRegistry, context: CommandContext): ChooserItem[] {
  return registry.commands.value.map((command) => {
    const title = typeof command.title === "function" ? command.title(context) : command.title;
    return {
      id: command.id,
      title: command.category ? `${command.category}: ${title}` : title,
      keys: command.keys?.map((binding) => binding.key) ?? [],
      disabled: !command.run || !(command.when?.(context) ?? true),
      ...(command.run ? { run: command.run } : {}),
    };
  });
}
