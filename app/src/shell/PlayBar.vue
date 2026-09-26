<script setup lang="ts">
/**
 * The in-game top bar: back to Home, the game and its current room, the
 * Play | Create switch, and the player's tools — world map, the game's own
 * save and restore, help and the settings sheet. Dialogs live in GameHeader;
 * this bar only asks for them.
 */
import { computed } from "vue";
import ActionMenu from "../ActionMenu.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import { useEngineApi } from "../engineContext.ts";
import { gameShortcuts } from "../gameControls.ts";
import { hasWalkthrough } from "../walkthrough.ts";
import { useShell, type ShellMode } from "./useShell.ts";
import { useCreateWorkspace } from "./useCreateWorkspace.ts";

const { settingsOpen } = defineProps<{ settingsOpen: boolean }>();
const emit = defineEmits<{
  exit: [];
  settings: [trigger: HTMLElement];
  "help-guide": [];
  controls: [];
  "trigger-key": [code: number];
  "start-walkthrough": [alias: string];
}>();

const { state, currentGame, roomMap } = useEngineApi();
const shell = useShell();
const workspace = useCreateWorkspace();

/** Play opens the world-map window; Create shows its docked World panel. */
function showMap(): void {
  if (shell.mode.value === "create") workspace.showPanel("world");
  else roomMap.openMap({ experience: "play" });
}

const game = computed(() => {
  // A remix renames and re-identifies the running game without a phase change.
  void state.patchTick;
  void state.phase;
  return currentGame();
});
const roomLabel = computed(() => {
  const room = roomMap.currentRoom.value;
  return room !== null && room > 0 ? `Room ${room}` : "";
});

const mode = computed<ShellMode>({
  get: () => shell.mode.value,
  set: (next) => shell.setMode(next),
});
const modes = computed(() => [
  { value: "play" as const, label: "Play" },
  { value: "create" as const, label: "Create", disabled: !shell.createAvailable.value },
]);

/** The game's own save and restore, as it registered them (menu items or keys). */
const saveShortcuts = computed(() =>
  gameShortcuts(state.controls).filter((shortcut) => /\b(save|restore)\b/i.test(shortcut.label)),
);
const shortcutsBlocked = computed(
  () =>
    state.paused ||
    state.modal !== null ||
    state.prompt !== null ||
    state.textMode ||
    state.walkthrough.active ||
    state.historyView.active,
);
</script>

<template>
  <header class="play-bar" data-shell-keys>
    <nav class="play-bar__nav" aria-label="App options">
      <UiIconButton
        icon="chevron-left"
        :label="state.leaving ? 'Saving…' : 'Exit to game selection'"
        data-testid="btn-exit"
        :disabled="state.powerUp.busy || state.leaving"
        @click="emit('exit')"
      />
      <div class="play-bar__title">
        <h1 class="play-bar__game" data-testid="play-title">{{ game?.title ?? "AGI IS HERE" }}</h1>
        <span v-if="roomLabel" class="play-bar__room" data-testid="play-room">{{ roomLabel }}</span>
      </div>
      <UiSegmented v-model="mode" class="play-bar__modes" label="Mode" :options="modes" />
      <div class="play-bar__actions">
        <UiIconButton icon="map" label="World map" data-testid="btn-world-map" @click="showMap" />
        <ActionMenu label="Save or restore" test-id="save-menu" icon-only icon="save">
          <button
            v-for="shortcut in saveShortcuts"
            :key="shortcut.key"
            type="button"
            role="menuitem"
            :data-key="shortcut.key"
            :disabled="shortcut.disabled || shortcutsBlocked"
            @click="emit('trigger-key', shortcut.key)"
          >
            <span
              >{{ shortcut.label
              }}<small v-if="shortcut.keyLabel">{{ shortcut.keyLabel }}</small></span
            >
          </button>
          <button v-if="!saveShortcuts.length" type="button" role="menuitem" disabled>
            <span
              >No save shortcut<small>Use the game’s own command, such as “save game”</small></span
            >
          </button>
        </ActionMenu>
        <ActionMenu label="Help" test-id="help-menu" icon-only icon="help">
          <button
            type="button"
            role="menuitem"
            data-testid="btn-help-guide"
            @click="emit('help-guide')"
          >
            <span>Help guide<small>Playing, creating and your games</small></span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="btn-game-controls"
            @click="emit('controls')"
          >
            <span>Game controls<small>Movement, input and this game's keys</small></span>
          </button>
          <button
            v-if="hasWalkthrough(game?.revision ?? '') && !state.walkthrough.active && game?.alias"
            type="button"
            role="menuitem"
            data-testid="btn-run-walkthrough"
            @click="emit('start-walkthrough', game.alias)"
          >
            <span
              >Watch walkthrough<small
                >A recorded playthrough — it shows puzzle solutions</small
              ></span
            >
          </button>
        </ActionMenu>
        <UiIconButton
          icon="settings"
          label="Settings"
          data-testid="settings-menu"
          aria-haspopup="dialog"
          :aria-expanded="settingsOpen"
          @click="emit('settings', $event.currentTarget as HTMLElement)"
        />
      </div>
    </nav>
  </header>
</template>

<style scoped>
.play-bar {
  flex: none;
  height: var(--shell-bar-h);
  box-sizing: border-box;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface-0);
}
.play-bar__nav {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: var(--space-3);
  height: 100%;
}
.play-bar__title {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: var(--leading-tight);
}
.play-bar__game {
  margin: 0;
  overflow: hidden;
  color: var(--ink);
  font: var(--weight-semibold) var(--text-md) / var(--leading-tight) var(--font-sans);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.play-bar__room {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.play-bar__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-1);
}
/* A phone keeps the switch and tools on the first row; the title drops under. */
@media (max-width: 600px) {
  .play-bar {
    height: auto;
    padding: var(--space-1) var(--space-2);
  }
  .play-bar__nav {
    grid-template-columns: auto auto minmax(0, 1fr);
    row-gap: 0;
  }
  .play-bar__title {
    grid-row: 2;
    grid-column: 1 / -1;
    flex-direction: row;
    gap: var(--space-3);
    padding: 0 var(--space-2) var(--space-1);
  }
  .play-bar__actions {
    gap: 0;
  }
}
</style>
