<script setup lang="ts">
import { ref } from "vue";
import {
  downloadUnsupportedStoredProject,
  type UnsupportedStoredProject,
} from "../project/gameStorage.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";
import UiButton from "../ui/UiButton.vue";
import RemoveGameDialog from "./RemoveGameDialog.vue";

const { game, heading = false } = defineProps<{
  game: UnsupportedStoredProject;
  heading?: boolean;
}>();
const { selectedProjectId, onClearSavedGame, refreshUnsupportedProjects, libraryActionError } =
  useGameLibrary();
const confirmRemove = ref(false);
const busy = ref(false);
const error = ref("");

async function download(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    const json = await downloadUnsupportedStoredProject(game.projectId);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${game.projectId}-stored-project.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (cause) {
    error.value = `Download failed: ${String(cause).replace(/^Error: /, "")}`;
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  confirmRemove.value = false;
  busy.value = true;
  selectedProjectId.value = game.projectId;
  await onClearSavedGame();
  await refreshUnsupportedProjects();
  error.value = libraryActionError.value;
  busy.value = false;
}
</script>

<template>
  <div class="unsupported-project">
    <h2 v-if="heading">{{ game.title }}</h2>
    <p role="status">
      {{
        game.state === "corrupt"
          ? "Saved project needs recovery"
          : "Saved project format needs another app version"
      }}
    </p>
    <div class="unsupported-project__actions">
      <UiButton size="sm" :disabled="busy || !game.recoverable" @click="download"
        >Download</UiButton
      >
      <UiButton size="sm" variant="ghost" :disabled="busy" @click="confirmRemove = true"
        >Remove</UiButton
      >
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <RemoveGameDialog
      v-model:open="confirmRemove"
      :title="game.title"
      :download-disabled="busy || !game.recoverable"
      @download="download"
      @remove="remove"
    />
  </div>
</template>

<style scoped>
.unsupported-project p {
  margin: 0 0 var(--space-3);
  color: var(--ink-2);
  font-size: var(--text-sm);
}
.unsupported-project h2 {
  margin: 0 0 var(--space-3);
  font-size: var(--text-lg);
}
.unsupported-project__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
