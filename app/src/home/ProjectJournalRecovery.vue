<script setup lang="ts">
import { buildZip } from "../archive/zip.ts";
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import type { ProjectId } from "../../../src/gameIdentity.ts";
import {
  PROJECT_SAVE_JOURNAL_EVENT,
  discardProjectSaveRecoveries,
  readProjectSaveRecoveries,
} from "../project/projectSaveJournal.ts";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";

const { projectId } = defineProps<{ projectId: ProjectId | undefined }>();
const error = ref("");
const discardOpen = ref(false);
const discardError = ref("");
const discardEntries = ref<ReturnType<typeof readProjectSaveRecoveries>>([]);
const recoveries = ref<ReturnType<typeof readProjectSaveRecoveries>>([]);
const notices = computed(() => [
  ...new Set(
    recoveries.value.map(({ reason }) => {
      if (/another (tab|window)|Project changed|already exists/i.test(reason))
        return "Some edits were not saved because this game changed in another tab or window.";
      if (/working documents are missing from History/.test(reason))
        return "These edits were made in an older version and can’t be added back automatically.";
      if (/version.*not supported/.test(reason))
        return "This version of the saved edits cannot be read by this app.";
      if (/Invalid pending project write/.test(reason))
        return "The saved edits contain unreadable data.";
      return "These edits could not be rebuilt automatically.";
    }),
  ),
]);
function refresh(): void {
  try {
    recoveries.value = projectId ? readProjectSaveRecoveries(localStorage, projectId) : [];
  } catch {
    recoveries.value = [];
  }
}
watch(
  () => projectId,
  () => {
    discardOpen.value = false;
    refresh();
  },
  { immediate: true },
);
onMounted(() => {
  window.addEventListener("storage", refresh);
  window.addEventListener(PROJECT_SAVE_JOURNAL_EVENT, refresh);
});
onUnmounted(() => {
  window.removeEventListener("storage", refresh);
  window.removeEventListener(PROJECT_SAVE_JOURNAL_EVENT, refresh);
});
function askDiscard(): void {
  discardEntries.value = [...recoveries.value];
  discardError.value = "";
  discardOpen.value = true;
}
function discard(): void {
  try {
    if (projectId) discardProjectSaveRecoveries(localStorage, projectId, discardEntries.value);
    discardOpen.value = false;
    refresh();
  } catch {
    discardError.value = "Browser storage could not discard these edits. Try Discard edits again.";
  }
}
async function download(entries = recoveries.value): Promise<void> {
  error.value = "";
  try {
    const files = entries.map(({ raw }, index) => ({
      name: `recovery-data/journal-${index + 1}.json`,
      data: new TextEncoder().encode(raw),
    }));
    const url = URL.createObjectURL(new Blob([buildZip(files)], { type: "application/zip" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "agi-unsaved-edits.zip";
    link.click();
    URL.revokeObjectURL(url);
  } catch (cause) {
    const message = (cause instanceof Error ? cause.message : String(cause)).replace(/[.]+$/, "");
    error.value = `Could not download pending edits: ${message}. Try Download pending edits again.`;
  }
}
</script>

<template>
  <div v-if="recoveries.length" data-testid="pending-edit-recovery" role="status">
    <p v-for="notice in notices" :key="notice">{{ notice }}</p>
    <p>
      Download pending edits to keep a copy. Add the ZIP on Home to restore it to the unchanged
      original project.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <UiButton size="sm" @click="download()">Download pending edits</UiButton>
    <UiButton size="sm" @click="askDiscard">Discard edits</UiButton>
  </div>
  <UiDialog v-model:open="discardOpen" title="Discard edits?" data-testid="discard-edits-dialog">
    <p>
      These pending edits will be removed from this browser. They may be your only copy. This cannot
      be undone.
    </p>
    <p v-if="discardError" role="alert">{{ discardError }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template #footer>
      <UiButton autofocus @click="discardOpen = false">Cancel</UiButton>
      <UiButton variant="ghost" icon="download" @click="download(discardEntries)"
        >Download pending edits first</UiButton
      >
      <UiButton variant="danger" @click="discard">Discard edits</UiButton>
    </template>
  </UiDialog>
</template>
