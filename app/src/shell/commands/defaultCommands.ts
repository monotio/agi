import type { CommandContext, CommandRegistry, KeyBinding } from "./commandRegistry.ts";

interface CommandSpec extends KeyBinding {
  readonly id: string;
  readonly title: string;
  readonly when?: (context: CommandContext) => boolean;
}
const DEFAULTS = {
  quickOpen: { id: "parts.open", title: "Quick open", key: "Mod+P", textInput: true, game: true },
  palette: {
    id: "commands.open",
    title: "Command palette",
    key: "Mod+Shift+P",
    textInput: true,
    game: true,
  },
  parts: {
    id: "parts.toggle",
    title: "Toggle parts list",
    key: "Mod+B",
    textInput: true,
    game: true,
  },
  panel: {
    id: "panel.toggle",
    title: "Toggle Problems tab",
    key: "Mod+J",
    textInput: true,
    game: true,
  },
  agent: { id: "agent.focus", title: "Agent", key: "Mod+I", textInput: true, game: true },
  undo: {
    id: "edit.undo",
    title: "Undo",
    key: "Mod+Z",
    game: true,
    textInput: true,
    when: (c) => c.editorFocus || !c.textInputFocus,
  },
  redo: {
    id: "edit.redo",
    title: "Redo",
    key: "Mod+Shift+Z",
    game: true,
    textInput: true,
    when: (c) => c.editorFocus || !c.textInputFocus,
  },
  play: {
    id: "game.play",
    title: "Update and restart room",
    key: "Mod+Enter",
    textInput: true,
    game: true,
    when: (c) => !c.agentFocus,
  },
  run: {
    id: "debug.run",
    title: "Run or continue",
    key: "F5",
    textInput: true,
    when: (c) => !c.gameFocus,
  },
  stop: {
    id: "debug.stop",
    title: "Stop debugging",
    key: "Shift+F5",
    textInput: true,
    game: true,
    when: (c) => c.debugging,
  },
  breakpoint: {
    id: "debug.breakpoint",
    title: "Toggle breakpoint",
    key: "F9",
    textInput: true,
    game: true,
    when: (c) => c.editorFocus,
  },
  stepOver: {
    id: "debug.stepOver",
    title: "Step over",
    key: "F10",
    textInput: true,
    game: true,
    when: (c) => c.debugging,
  },
  stepInto: {
    id: "debug.stepInto",
    title: "Step into",
    key: "F11",
    textInput: true,
    game: true,
    when: (c) => c.debugging,
  },
  stepOut: {
    id: "debug.stepOut",
    title: "Step out",
    key: "Shift+F11",
    textInput: true,
    game: true,
    when: (c) => c.debugging,
  },
  focusGame: { id: "focus.game", title: "Focus game", key: "Ctrl+`", textInput: true, game: true },
  nextZone: { id: "focus.next", title: "Next focus zone", key: "F6", textInput: true },
  previousZone: {
    id: "focus.previous",
    title: "Previous focus zone",
    key: "Shift+F6",
    textInput: true,
    game: true,
  },
} satisfies Record<string, CommandSpec>;
export type DefaultCommandActions = Partial<Record<keyof typeof DEFAULTS, () => unknown>>;

export function registerDefaultCommands(
  registry: CommandRegistry,
  actions: DefaultCommandActions,
): () => void {
  const disposers = Object.entries(DEFAULTS).map(([action, entry]) => {
    const spec: CommandSpec = entry;
    const run = actions[action as keyof DefaultCommandActions];
    return registry.register({
      id: spec.id,
      title: spec.title,
      keys: [{ key: spec.key, textInput: spec.textInput ?? false, game: spec.game ?? false }],
      when: (context) => !context.dialogOpen && (spec.when?.(context) ?? true),
      ...(run ? { run } : {}),
    });
  });
  return () => disposers.forEach((dispose) => dispose());
}
