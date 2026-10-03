<script setup lang="ts">
/**
 * Read-only actions live in the shell so Focus and phone layouts keep them
 * visible while the game stage is hidden.
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
    data-testid="removed-tab-note"
  >
    <span class="read-only-message">{{ PROJECT_REMOVED_MESSAGE }}</span>
    <UiButton size="sm" @click="editor.downloadUnsavedEdits">Download unsaved edits</UiButton>
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
    data-testid="stale-tab-note"
  >
    <span class="read-only-message">
      Changed in another tab. Editing is paused. Download your unsaved edits, then reload.
    </span>
    <UiButton size="sm" @click="editor.downloadUnsavedEdits">Download unsaved edits</UiButton>
    <UiButton size="sm" @click="onExportAgiZip(true, true)">Download game</UiButton>
    <UiButton size="sm" @click="reload">Reload</UiButton>
    <UiButton size="sm" @click="engine.ejectGame()">Exit</UiButton>
  </UiToast>
</template>

<style scoped>
.ui-toast {
  max-width: 100%;
  box-sizing: border-box;
  margin: 0;
}
.read-only-message {
  flex-basis: 100%;
}
</style>
