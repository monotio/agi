<script setup lang="ts">
/** The existing Create shell's adapter; commands and choosers stay host-independent. */
import { computed, nextTick, onMounted, onScopeDispose, shallowRef, ref, watch } from "vue";
import { openContainer } from "../../../../src/container/container.ts";
import { roomPictureUse } from "../../../../src/agent/roomPictures.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import { useCreateWorkspace } from "../useCreateWorkspace.ts";
import { useShell } from "../useShell.ts";
import { useShellBridge } from "../shellBridge.ts";
import { useStudioLauncher } from "../useStudioLauncher.ts";
import { useRoomStudio } from "../../world/useRoomStudio.ts";
import { viewScan } from "../../world/studioSource.ts";
import { openExplainer } from "../../ui/explain.ts";
import CommandPalette from "./CommandPalette.vue";
import QuickOpen from "./QuickOpen.vue";
import { emptyCommandContext } from "./commandContext.ts";
import type { CommandContext, CommandRegistry } from "./commandRegistry.ts";
import { registerDefaultCommands } from "./defaultCommands.ts";
import { useFocusZones, type FocusZone } from "./useFocusZones.ts";
import type { ChooserItem } from "./chooserItems.ts";

const props = defineProps<{ registry: CommandRegistry }>();
const emit = defineEmits<{ "focus-game": []; "zone-change": [] }>();
const engine = useEngineApi();
const workspace = useCreateWorkspace();
const shell = useShell();
const bridge = useShellBridge();
const studios = useStudioLauncher();
const rooms = useRoomStudio();
const palette = ref(false);
const quickOpen = ref(false);
const origin = shallowRef<CommandContext>(emptyCommandContext());

const SELECTORS: Record<FocusZone, string> = {
  parts: '.create-dock--left, [data-testid="world-panel"]',
  editor: '[data-testid="room-studio"], [data-testid="sprite-studio"]',
  game: ".play-area",
  panel: '[data-testid="dock-panel-activity"], [data-testid="dock-panel-inspect"]',
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
  workspace.closeStudio();
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

async function openRoom(room: number, title: string, picture: number): Promise<void> {
  if (!studios.available.value || !(await workspace.confirmStudioLeave())) return;
  const request = rooms.request(room, title, picture);
  if (request) workspace.openStudio(request);
}
const parts = computed<ChooserItem[]>(() => {
  const scan = engine.roomMap.resources.value;
  const available = studios.available.value;
  const entries: ChooserItem[] = engine.roomMap.graph.value.nodes.map((node) => {
    const uses = roomPictureUse(node.room, {
      scans: scan.scans,
      shared: scan.shared,
      pictures: scan.picture,
    });
    const picture = uses.pictures.find((use) => use.exists)?.picture;
    const title = `ROOM ${node.room}${node.title ? ` ${node.title}` : ""}`;
    return {
      id: `room-${node.room}`,
      title,
      disabled: !available || picture === undefined,
      ...(picture === undefined
        ? {}
        : { run: () => openRoom(node.room, node.title ?? title, picture) }),
    };
  });
  for (const num of [...scan.logic].sort((a, b) => a - b))
    entries.push({ id: `logic-${num}`, title: `LOGIC ${num}`, disabled: true });
  for (const num of [...scan.picture].sort((a, b) => a - b))
    entries.push({
      id: `picture-${num}`,
      title: `PICTURE ${num}`,
      disabled: !available,
      run: () => studios.open({ studio: "room", picture: num }),
    });
  for (const view of viewScan(scan).views)
    entries.push({
      id: `view-${view.view}`,
      title: `VIEW ${view.view}${view.description ? ` ${view.description}` : ""}`,
      disabled: !available || !view.thumb,
      run: () => studios.open({ studio: "sprite", view: view.view }),
    });
  try {
    const container = openContainer(new Map(Object.entries(scan.files)), {
      ...(scan.profile ? { profile: scan.profile } : {}),
    });
    for (let num = 0; num < 256; num++)
      if (container.getResource("sound", num))
        entries.push({ id: `sound-${num}`, title: `SOUND ${num}`, disabled: true });
  } catch {
    // Rooms and scanned resources remain searchable when a container cannot enumerate sounds.
  }
  for (const name of ["OBJECT", "WORDS.TOK"])
    if (scan.files[name])
      entries.push({ id: name, title: name === "OBJECT" ? "OBJECTS" : "WORDS", disabled: true });
  return entries;
});
const provideParts = (): readonly ChooserItem[] => parts.value;
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
