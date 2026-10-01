<script setup lang="ts">
/** The existing Create shell's adapter; commands and choosers stay host-independent. */
import { nextTick, onMounted, onScopeDispose, shallowRef, ref, watch } from "vue";
import { useCreateWorkspace } from "../useCreateWorkspace.ts";
import { useShell } from "../useShell.ts";
import { useShellBridge } from "../shellBridge.ts";
import { useWorkspaceEditor } from "../workspaceEditor.ts";
import { openExplainer } from "../../ui/explain.ts";
import CommandPalette from "./CommandPalette.vue";
import QuickOpen from "./QuickOpen.vue";
import { emptyCommandContext } from "./commandContext.ts";
import type { CommandContext, CommandRegistry } from "./commandRegistry.ts";
import { registerDefaultCommands } from "./defaultCommands.ts";
import { useFocusZones, type FocusZone } from "./useFocusZones.ts";

const props = defineProps<{ registry: CommandRegistry }>();
const emit = defineEmits<{ "focus-game": []; "zone-change": [] }>();
const workspace = useCreateWorkspace();
const shell = useShell();
const editor = useWorkspaceEditor();
const bridge = useShellBridge();
const palette = ref(false);
const quickOpen = ref(false);
const origin = shallowRef<CommandContext>(emptyCommandContext());

const SELECTORS: Record<FocusZone, string> = {
  parts: '.parts-list, .create-dock--left, [data-testid="world-panel"]',
  editor: '[data-testid="workspace-editor"]',
  game: ".play-area",
  panel:
    '[data-testid="workspace-problems"], [data-testid="dock-panel-activity"], [data-testid="dock-panel-inspect"]',
  agent: ".assistant-host",
};
function roots(): ReadonlyMap<FocusZone, HTMLElement> {
  const zones = new Map<FocusZone, HTMLElement>();
  for (const [name, selector] of Object.entries(SELECTORS)) {
    const root = [...document.querySelectorAll<HTMLElement>(selector)].find(
      (element) => element.getClientRects().length > 0 && !element.closest("[inert]"),
    );
    if (root) zones.set(name as FocusZone, root);
  }
  return zones;
}
const zones = useFocusZones(roots);
watch(zones.active, () => emit("zone-change"));

function context(): CommandContext {
  const target = document.activeElement;
  const zone = zones.zoneFor(target);
  const textInputFocus =
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.matches("input, textarea, select, [role='textbox']") ||
      !!target.closest(".monaco-editor"));
  return {
    editorFocus: zone === "editor",
    gameFocus: zone === "game",
    textInputFocus,
    dialogOpen: !!document.querySelector("dialog[open]"),
    debugging: false,
  };
}
function blocksGame(event: KeyboardEvent): boolean {
  return (
    event.defaultPrevented ||
    event.key === "Tab" ||
    context().dialogOpen ||
    zones.zoneFor(document.activeElement) !== "game"
  );
}
function focusGame(): void {
  if (zones.focus("game")) emit("focus-game");
}
function showChooser(mode: "palette" | "parts"): void {
  origin.value = context();
  palette.value = mode === "palette";
  quickOpen.value = mode === "parts";
}
async function play(): Promise<void> {
  if (!(await workspace.confirmStudioLeave())) return;
  shell.setMode("play");
}
function agent(): void {
  workspace.showPanel("assistant");
  shell.openRemix();
  void nextTick().then(() => {
    zones.focus("agent");
    document.querySelector<HTMLElement>(".assistant-host textarea, .assistant-host input")?.focus();
  });
}
const offDefaults = registerDefaultCommands(props.registry, {
  quickOpen: () => showChooser("parts"),
  palette: () => showChooser("palette"),
  parts: () => workspace.toggleDock("left"),
  panel: () => {
    editor.panel.value = !editor.panel.value;
  },
  undo: () => editor.step("undo"),
  redo: () => editor.step("redo"),
  agent,
  play,
  focusGame,
  nextZone: () => zones.cycle(),
  previousZone: () => zones.cycle(-1),
});
const offHelp = props.registry.register({
  id: "help.shortcuts",
  title: "Keyboard shortcuts",
  category: "Help",
  when: (c) => !c.dialogOpen,
  run: () => bridge.openHelp("shortcuts"),
});
// Local popovers and nested dialogs keep Escape; the chooser is the only surface this adapter dismisses.
const offEscape = props.registry.register({
  id: "overlay.close",
  title: "Close popover",
  keys: [{ key: "Escape", textInput: true, game: true }],
  when: () =>
    (palette.value || quickOpen.value) &&
    openExplainer.value === null &&
    document.activeElement?.closest("dialog")?.classList.contains("keyboard-chooser") === true,
  run: () => {
    palette.value = false;
    quickOpen.value = false;
  },
});

const offFocus = props.registry.register({
  id: "editor.focus",
  title: "Focus",
  keys: [{ key: "Mod+K Z", textInput: true, game: true }],
  when: (c) => !c.dialogOpen && editor.selected.value !== undefined,
  run: editor.toggleFocus,
});
const provideParts = () => editor.parts.value;
let offDispatcher: (() => void) | undefined;
const onFocus = (event: FocusEvent): void =>
  zones.track(event.target instanceof Node ? event.target : null);
onMounted(() => {
  offDispatcher = props.registry.mount(window);
  document.addEventListener("focusin", onFocus);
  zones.track(document.activeElement);
});
onScopeDispose(() => {
  offDispatcher?.();
  document.removeEventListener("focusin", onFocus);
  offDefaults();
  offHelp();
  offFocus();
  offEscape();
  zones.dispose();
});
defineExpose({ context, blocksGame });
</script>

<template>
  <CommandPalette v-if="palette" v-model:open="palette" :registry="registry" :context="origin" />
  <QuickOpen
    v-if="quickOpen"
    v-model:open="quickOpen"
    :registry="registry"
    :context="origin"
    :provider="provideParts"
  />
  <span class="focus-zone-announcement" role="status" aria-live="polite" aria-atomic="true">{{
    zones.announcement.value
  }}</span>
</template>

<style scoped>
:global([data-focus-zone-active]) {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.focus-zone-announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
</style>
