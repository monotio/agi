<script setup lang="ts">
/**
 * The one Download… dialog, titled with the game's name: the project file
 * (edits, saves and history) first, the playable game second. Both choices
 * disable while a download runs, with the progress named; the dialog closes
 * when the download finishes. Cancel and the × dismiss without downloading.
 */
import { watch, ref } from "vue";
import { loadAuthoredGame } from "../project/gameStorage.ts";
import { isLegacyAuthoredProject } from "../../../src/authoring/projectConventions.ts";
import { hasRoomMemoryDeclaration } from "../../../src/authoring/roomMemory.ts";
import type { ProjectId } from "../project/gameTypes.ts";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";

const {
  title,
  projectId = undefined,
  busy,
  workInProgress = false,
  testId = "game-download-dialog",
} = defineProps<{
  /** The game's name; the dialog is titled with it. */
  title: string;
  projectId?: ProjectId | undefined;
  /** A download is running: both choices disable until it finishes. */
  busy: boolean;
  /** An unfinished game: its playable download says so. */
  workInProgress?: boolean;
  /** The sheet's dialog takes its own test id so card and sheet never collide. */
  testId?: string;
}>();
const emit = defineEmits<{
  /** `project` picks the project file; otherwise the playable game. */
  choose: [project: boolean];
  closed: [];
}>();
const open = defineModel<boolean>("open", { required: true });

const legacyMemory = ref(false);
const checking = ref(false);
watch(
  () => [open.value, projectId] as const,
  async ([opened, id], _, onCleanup) => {
    let current = true;
    onCleanup(() => {
      current = false;
    });
    legacyMemory.value = false;
    checking.value = opened && id !== undefined;
    if (!opened || !id) return;
    try {
      const data = await loadAuthoredGame(id);
      if (current)
        legacyMemory.value =
          data !== null &&
          isLegacyAuthoredProject(data) &&
          hasRoomMemoryDeclaration(data.files) !== true;
    } finally {
      if (current) checking.value = false;
    }
  },
  { immediate: true },
);

// A started download closes the dialog when it finishes.
watch(
  () => busy,
  (now, before) => {
    if (before && !now) open.value = false;
  },
);
</script>

<template>
  <UiDialog v-model:open="open" :title size="sm" :data-testid="testId" @closed="emit('closed')">
    <p v-if="legacyMemory" data-testid="export-room-memory">
      Big rooms may stop working when this game runs elsewhere. Add room memory in Game updates
      first.
    </p>
    <div class="download-choices">
      <button
        type="button"
        class="download-choice download-choice--primary"
        data-testid="download-library-game"
        :disabled="busy || checking"
        autofocus
        @click="emit('choose', true)"
      >
        <strong>Project file</strong>
        <small>Your edits, saves and history. Open it here to carry on.</small>
      </button>
      <button
        type="button"
        class="download-choice"
        data-testid="export-library-game"
        :disabled="busy || checking"
        @click="emit('choose', false)"
      >
        <strong>Playable game</strong>
        <small v-if="workInProgress" data-testid="export-work-in-progress"
          >ZIP, work in progress: exits to unbuilt rooms stop the game</small
        >
        <small v-else>The game files, ready to share and play.</small>
      </button>
    </div>
    <p v-if="busy" role="status" class="download-progress">Preparing the download…</p>
    <template #footer>
      <UiButton data-testid="download-cancel" @click="open = false">Cancel</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.download-choices {
  display: grid;
  gap: var(--space-2);
}
.download-choice {
  display: block;
  width: 100%;
  min-height: var(--control-h-touch);
  box-sizing: border-box;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: transparent;
  font: var(--weight-semibold) var(--text-md) / 1.4 var(--font-sans);
  text-align: left;
  cursor: pointer;
}
.download-choice:hover:not(:disabled),
.download-choice:focus-visible {
  background: var(--surface-3);
}
.download-choice--primary {
  border-color: var(--action-line);
  color: var(--action);
}
.download-choice:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.download-choice small {
  display: block;
  color: var(--ink-3);
  font-size: var(--text-xs);
  font-weight: 400;
}
.download-progress {
  margin: var(--space-3) 0 0;
  color: var(--ink-2);
  font-size: var(--text-sm);
}
</style>
