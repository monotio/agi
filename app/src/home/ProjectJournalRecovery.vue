<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import type { ProjectId } from "../../../src/gameIdentity.ts";
import {
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
onMounted(() => window.addEventListener("storage", refresh));
onUnmounted(() => window.removeEventListener("storage", refresh));
function discard(): void {
  if (projectId) discardProjectSaveRecoveries(localStorage, projectId, recoveries.value);
  refresh();
}
</script>

<template>
  <div v-if="recoveries.length" data-testid="pending-edit-recovery" role="status">
    <p>Pending edits belong to an earlier project version. Discard them to clear this notice.</p>
    <UiButton size="sm" @click="discard">Discard pending edits</UiButton>
  </div>
</template>
