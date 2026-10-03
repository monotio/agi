<script setup lang="ts">
/**
 * The stage's note that storage moved past the running game — another tab
 * kept an edit or asked the assistant — shown once per stale event while the
 * Assistant (which says the same) may be closed. Never modal: the player can
 * keep playing; nothing writes the game's files until it reloads.
 *
 * When another tab removed the game, no reload brings it back: the note says
 * so instead, with Download game (the running game, from memory) and Back to
 * games. Nothing is stored for the game from then on.
 */
import { useWorkspaceEditor } from "../shell/workspaceEditor.ts";
import UiButton from "../ui/UiButton.vue";
import UiToast from "../ui/UiToast.vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";
import { PROJECT_REMOVED_MESSAGE } from "../project/projectTransaction.ts";

const engine = useEngineApi();
const editor = useWorkspaceEditor();
const { state } = engine;
const { exportBusy, onExportAgiZip } = useGameLibrary();

async function reload(): Promise<void> {
  state.staleTab = false;
  state.powerUp.offerReload = false;
  await engine.reloadFromStorage();
}
</script>

<template>
  <UiToast
    v-if="state.projectRemoved && state.phase === 'running'"
    tone="warn"
    dismissible
    data-testid="removed-tab-note"
    @dismiss="state.projectRemoved = false"
  >
    {{ PROJECT_REMOVED_MESSAGE }}
    <UiButton size="sm" @click="editor.downloadUnsavedEdits">Unsaved edits</UiButton>
    <UiButton
      size="sm"
      data-testid="removed-tab-download"
      :disabled="exportBusy"
      @click="onExportAgiZip(true, true)"
    >
      Download game
    </UiButton>
    <UiButton size="sm" @click="reload">Reload</UiButton>
    <UiButton size="sm" data-testid="removed-tab-leave" @click="engine.ejectGame()">
      Exit
    </UiButton>
  </UiToast>
  <UiToast
    v-else-if="state.staleTab && state.phase === 'running'"
    tone="warn"
    dismissible
    data-testid="stale-tab-note"
    @dismiss="state.staleTab = false"
  >
    Changed in another tab. Editing is paused. Download your unsaved edits, then reload.
    <UiButton size="sm" @click="editor.downloadUnsavedEdits">Unsaved edits</UiButton>
    <UiButton size="sm" @click="onExportAgiZip(true, true)">Download game</UiButton>
    <UiButton size="sm" @click="reload">Reload</UiButton>
    <UiButton size="sm" @click="engine.ejectGame()">Exit</UiButton>
  </UiToast>
</template>
