<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import type { ProjectId } from "../../../src/gameIdentity.ts";
import {
  PROJECT_SAVE_JOURNAL_EVENT,
  discardProjectSaveRecoveries,
  readProjectSaveRecoveries,
} from "../project/projectSaveJournal.ts";
import UiButton from "../ui/UiButton.vue";

const { projectId } = defineProps<{ projectId: ProjectId | undefined }>();
const recoveries = ref<ReturnType<typeof readProjectSaveRecoveries>>([]);
function refresh(): void {
  try {
    recoveries.value = projectId ? readProjectSaveRecoveries(localStorage, projectId) : [];
  } catch {
    recoveries.value = [];
  }
}
watch(() => projectId, refresh, { immediate: true });
onMounted(() => {
  window.addEventListener("storage", refresh);
  window.addEventListener(PROJECT_SAVE_JOURNAL_EVENT, refresh);
});
onUnmounted(() => {
  window.removeEventListener("storage", refresh);
  window.removeEventListener(PROJECT_SAVE_JOURNAL_EVENT, refresh);
});
function discard(): void {
  if (projectId) discardProjectSaveRecoveries(localStorage, projectId, recoveries.value);
  refresh();
}
async function download(): Promise<void> {
  const entries = recoveries.value.map(({ raw }, index) => ({
    name: `recovery-data/journal-${index + 1}.json`,
    data: new TextEncoder().encode(raw),
  }));
  const { buildZip } = await import("../archive/zip.ts");
  const url = URL.createObjectURL(new Blob([buildZip(entries)], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "agi-recovery-data.zip";
  link.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div v-if="recoveries.length" data-testid="pending-edit-recovery" role="status">
    <p>Recovery data belongs to an earlier project version. Download it to keep a copy.</p>
    <UiButton size="sm" @click="download">Download recovery data</UiButton>
    <UiButton size="sm" @click="discard">Discard pending edits</UiButton>
  </div>
</template>
