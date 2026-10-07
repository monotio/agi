<script setup lang="ts">
import { VOCABULARY } from "../../../src/vocabulary.ts";
/**
 * The in-game top bar: back to Home, the game and its current room, the
 * Play | Create switch, and the player's tools — world map, the game's own
 * save and restore, help and the settings sheet. Dialogs live in GameHeader;
 * this bar only asks for them. A blank game (no start-up LOGIC yet) shows the
 * same bar in Create, with the tools that need a running game disabled.
 */
import { computed } from "vue";
import WorkspaceAction from "./WorkspaceAction.vue";
import ActionMenu from "../ui/ActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import UiChip from "../ui/UiChip.vue";
import { useWorkspaceEditor } from "./workspaceEditor.ts";
import UiIconButton from "../ui/UiIconButton.vue";
import { useOptionalCommands } from "./commands/commandContext.ts";
import UiSegmented from "../ui/UiSegmented.vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { gameShortcuts } from "../play/gameControls.ts";
import { hasWalkthrough } from "../walkthrough/walkthrough.ts";
import { useShell, type ShellMode } from "./useShell.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";

const { settingsOpen, blank = undefined } = defineProps<{
  settingsOpen: boolean;
  /** The title of a game with no start-up LOGIC yet: Create shows it with nothing to run. */
  blank?: string | undefined;
}>();
const emit = defineEmits<{
  exit: [];
  agent: [];
  settings: [trigger: HTMLElement];
  "help-guide": [];
  "keyboard-shortcuts": [];
  controls: [];
  "trigger-key": [code: number];
  "start-walkthrough": [alias: string];
}>();

const { state, currentGame, getBootedGame, roomMap, closePowerUp } = useEngineApi();
const { identityTitle } = useGameLibrary();
const shell = useShell();
const commands = useOptionalCommands();
const editor = useWorkspaceEditor();
function toggleParts(): void {
  if (state.powerUp.open) closePowerUp();
  editor.focus.value = false;
  editor.partsOpen.value = !editor.partsOpen.value;
}

function showMap(): void {
  roomMap.openMap({ experience: shell.mode.value });
}

const game = computed(() => {
  // A remix renames and re-identifies the running game without a phase change.
  void state.patchTick;
  void state.phase;
  return currentGame();
});
const roomLabel = computed(() => {
  // A blank game has no running engine, so no room map yet.
  if (blank !== undefined) return "";
  const room = roomMap.currentRoom.value;
  return room !== null && room > 0 ? `Room ${room}` : "";
});
const originLabel = computed(() => {
  void state.patchTick;
  void state.phase;
  const library = getBootedGame()?.authoredGame?.library;
  const parent = library?.source === "remix" ? library.parent : game.value?.parent;
  return parent ? `Your copy of ${identityTitle(parent)}` : "";
});

const mode = computed<ShellMode>({
  get: () => (blank === undefined ? shell.mode.value : "create"),
  set: (next) => shell.setMode(next),
});
const modes = computed(() => [
  {
    value: "play" as const,
    label: "Play",
    disabled: blank !== undefined || state.walkthrough.active || state.historyView.active,
  },
  {
    value: "create" as const,
    label: "Create",
    disabled:
      blank === undefined &&
      (!shell.createAvailable.value ||
        state.powerUp.busy ||
        state.walkthrough.active ||
        state.historyView.active),
  },
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
        :label="state.leaving ? 'Saving…' : 'Back to library'"
        data-testid="btn-exit"
        :disabled="state.powerUp.busy || state.leaving"
        @click="emit('exit')"
      />
      <div class="play-bar__title">
        <h1 class="play-bar__game">{{ blank ?? game?.title ?? "AGI IS HERE" }}</h1>
        <span v-if="originLabel" class="play-bar__room" data-testid="play-origin">{{
          originLabel
        }}</span>
        <span v-else-if="roomLabel" class="play-bar__room" data-testid="play-room">{{
          roomLabel
        }}</span>
      </div>
      <UiButton
        v-if="mode === 'create'"
        size="sm"
        variant="ghost"
        data-testid="workspace-saved"
        :title="
          blank === undefined && editor.readOnly.value
            ? editor.save.value
            : editor.save.value.startsWith('Draft')
              ? 'Your draft saves in this browser.'
              : VOCABULARY.saved.help
        "
        @click="
          blank !== undefined
            ? undefined
            : editor.save.value === 'Could not save. Retry'
              ? editor.retry.value?.().catch(() => {})
              : (editor.history.value = !editor.history.value)
        "
        ><UiChip
          :tone="
            blank !== undefined ||
            editor.save.value === 'Saved' ||
            editor.save.value === 'Draft saved'
              ? 'ok'
              : 'warn'
          "
          dot
          >{{
            blank !== undefined
              ? "Saved"
              : state.projectRemoved || editor.save.value.startsWith("This project was removed")
                ? "Project removed"
                : state.staleTab || editor.save.value.startsWith("Changed in another tab")
                  ? "Changed in another tab"
                  : editor.readOnly.value
                    ? "Read-only"
                    : editor.save.value
          }}</UiChip
        ></UiButton
      >
      <span
        v-if="editor.changeCount.value"
        class="play-bar__pending"
        data-testid="workspace-pending"
        >{{ editor.changeCount.value }}
        {{ editor.changeCount.value === 1 ? "change" : "changes" }} not in the game yet</span
      >
      <span
        v-else-if="editor.updateResult.value && mode === 'create'"
        class="play-bar__pending"
        data-testid="workspace-updated"
        >{{ editor.updateResult.value }} ·
        <button type="button" aria-label="Undo update" @click="editor.step('undo')">
          Undo
        </button></span
      >
      <WorkspaceAction
        v-if="blank === undefined && (mode === 'create' || editor.changeCount.value)"
        class="play-bar__update"
      />
      <UiSegmented v-model="mode" class="play-bar__modes" label="Mode" :options="modes" />
      <div class="play-bar__actions">
        <template v-if="mode === 'create'">
          <UiButton
            size="sm"
            variant="ghost"
            class="play-bar__parts"
            data-testid="workspace-parts"
            :aria-pressed="editor.partsOpen.value"
            @click="toggleParts"
            >Parts</UiButton
          >
          <UiIconButton
            icon="undo"
            label="Undo"
            :title="VOCABULARY.undo.help"
            data-testid="workspace-undo"
            :disabled="blank !== undefined || !editor.canUndo.value || editor.busy.value"
            @click="editor.step('undo')"
          />
          <UiIconButton
            icon="redo"
            label="Redo"
            :title="VOCABULARY.redo.help"
            data-testid="workspace-redo"
            :disabled="blank !== undefined || !editor.canRedo.value || editor.busy.value"
            @click="editor.step('redo')"
          />
          <UiButton
            size="sm"
            variant="ghost"
            icon="sparkles"
            aria-label="Agent"
            :aria-pressed="state.powerUp.open"
            data-testid="workspace-agent"
            :title="`${VOCABULARY.agent.help} (⌘I)`"
            :disabled="
              blank === undefined &&
              !commands?.commands.value.some((command) => command.id === 'agent.focus')
            "
            @click="blank === undefined ? commands?.execute('agent.focus') : emit('agent')"
            >Agent</UiButton
          >
        </template>
        <UiIconButton
          icon="map"
          label="World map"
          data-testid="btn-world-map"
          :disabled="blank !== undefined"
          @click="showMap"
        />
        <ActionMenu label="Save or restore" icon-only icon="save" :disabled="blank !== undefined">
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
            v-if="commands?.commands.value.length"
            type="button"
            role="menuitem"
            data-testid="btn-keyboard-shortcuts"
            @click="emit('keyboard-shortcuts')"
          >
            <span>Keyboard shortcuts</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="btn-game-controls"
            :disabled="blank !== undefined"
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
                >A recorded playthrough that shows puzzle solutions</small
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
.play-bar__pending {
  color: var(--ink-3);
  font: var(--text-xs) var(--font-sans);
}
.play-bar__pending button {
  color: var(--action);
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.play-bar__update {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
@media (max-width: 600px) {
  .play-bar__pending {
    grid-column: 1 / -1;
    grid-row: 3;
    justify-self: end;
    max-width: 65%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.play-bar {
  flex: none;
  height: var(--shell-bar-h);
  box-sizing: border-box;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface-0);
}
.play-bar__parts {
  display: none;
}
.play-bar__nav {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: 100%;
}
.play-bar__title {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  line-height: var(--leading-tight);
}
/* The game's name keeps a few letters beside a long action and its pending note. */
@media (min-width: 601px) {
  .play-bar__title {
    min-width: 5rem;
  }
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.play-bar__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-1);
}
/* Identity and Update, tools, then draft status. */
@media (max-width: 600px) {
  .play-bar {
    height: auto;
    padding: var(--space-1) var(--space-2);
  }
  .play-bar__nav {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    gap: var(--space-1);
  }
  .play-bar__title {
    grid-column: 2;
  }
  .play-bar__nav:has([data-testid="workspace-saved"]) {
    grid-template-rows: auto auto minmax(var(--control-h-touch), auto);
  }
  .play-bar__modes {
    grid-column: 4;
    grid-row: 1;
  }
  [data-testid="workspace-saved"] {
    grid-column: 1 / -1;
    grid-row: 3;
    justify-self: start;
    max-width: 35%;
    overflow: hidden;
  }
  .play-bar__update {
    grid-column: 3;
    grid-row: 1;
  }
  .play-bar__parts {
    display: inline-flex;
  }
  .play-bar__actions {
    grid-column: 1 / -1;
    grid-row: 2;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0;
  }
}
@media (max-width: 420px) {
  [data-testid="workspace-agent"] {
    width: var(--control-h-touch);
    padding: 0;
  }
  [data-testid="workspace-agent"] :deep(.ui-btn__label) {
    display: none;
  }
}
</style>
