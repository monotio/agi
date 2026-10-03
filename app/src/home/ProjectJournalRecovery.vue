<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import type { ProjectId } from "../../../src/gameIdentity.ts";
import { readProjectSaveRecoveries } from "../project/projectSaveJournal.ts";
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
onMounted(() => window.addEventListener("storage", refresh));
onUnmounted(() => window.removeEventListener("storage", refresh));
function download(): void {
  const content = JSON.stringify({
    format: "monotio.agi.pending-edit-recovery",
    version: 1,
    projectId,
    journals: recoveries.value,
  });
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${projectId}-pending-edits.json`;
  link.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div v-if="recoveries.length" data-testid="pending-edit-recovery" role="status">
    <p>Pending edits need recovery. Download them before removing this game.</p>
    <UiButton size="sm" @click="download">Download edits</UiButton>
  </div>
</template>
