import { shallowRef } from "vue";
import { isApplePlatform } from "../../ui/keyLabel.ts";

export interface CommandContext {
  readonly editorFocus: boolean;
  readonly gameFocus: boolean;
  readonly textInputFocus: boolean;
  readonly dialogOpen: boolean;
  readonly debugging: boolean;
}

export interface KeyBinding {
  /** Mod means Command on Apple platforms and Control elsewhere. */
  readonly key: string;
  readonly textInput?: boolean;
  readonly game?: boolean;
}

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly keys?: readonly KeyBinding[];
  readonly when?: (context: CommandContext) => boolean;
  /** Omitted until the host implements the action. */
  readonly run?: () => unknown;
}

function matches(event: KeyboardEvent, binding: string, apple: boolean): boolean {
  const tokens = binding.split("+");
  const key = tokens.at(-1)?.toLowerCase();
  const ctrl = tokens.includes("Ctrl") || (!apple && tokens.includes("Mod"));
  const meta = apple && tokens.includes("Mod");
  return (
    event.key.toLowerCase() === key &&
    event.ctrlKey === ctrl &&
    event.metaKey === meta &&
    event.shiftKey === tokens.includes("Shift") &&
    event.altKey === tokens.includes("Alt")
  );
}

export function createCommandRegistry(
  context: () => CommandContext,
  apple = isApplePlatform(globalThis.navigator),
) {
  const commands = shallowRef<readonly Command[]>([]);
  let mounted = false;

  function register(command: Command): () => void {
    if (commands.value.some((entry) => entry.id === command.id))
      throw new Error(`Command already registered: ${command.id}`);
    commands.value = [...commands.value, command];
    return () => {
      commands.value = commands.value.filter((entry) => entry !== command);
    };
  }

  function enabled(id: string): boolean {
    const command = commands.value.find((entry) => entry.id === id);
    return !!command?.run && (command.when?.(context()) ?? true);
  }

  function execute(id: string): boolean {
    const command = commands.value.find((entry) => entry.id === id);
    if (!command?.run || !(command.when?.(context()) ?? true)) return false;
    command.run();
    return true;
  }

  function dispatch(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
    const ctx = context();
    for (const command of commands.value) {
      if (!command.run || !(command.when?.(ctx) ?? true)) continue;
      const binding = command.keys?.find(
        (candidate) =>
          matches(event, candidate.key, apple) &&
          (!ctx.textInputFocus || candidate.textInput) &&
          (!ctx.gameFocus || candidate.game),
      );
      if (!binding) continue;
      event.preventDefault();
      if (!event.repeat) command.run();
      return true;
    }
    return false;
  }

  /** Install one dispatcher; the host supplies its lifetime and focus context. */
  function mount(target: Pick<Window, "addEventListener" | "removeEventListener">): () => void {
    if (mounted) throw new Error("Command dispatcher already mounted");
    mounted = true;
    const onKey = (event: KeyboardEvent) => {
      if (dispatch(event)) event.stopImmediatePropagation();
    };
    target.addEventListener("keydown", onKey, true);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      target.removeEventListener("keydown", onKey, true);
      mounted = false;
    };
  }

  return { commands, register, enabled, execute, dispatch, mount };
}

export type CommandRegistry = ReturnType<typeof createCommandRegistry>;
