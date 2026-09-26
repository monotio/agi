<script setup lang="ts">
/**
 * A card's notice for a stored copy this release cannot read, with the
 * "Start fresh…" confirmation that removes only that project's local records.
 */
import { ref } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import type { ProjectId } from "../../../src/gameIdentity.ts";
import { UNREADABLE_PROJECT_MESSAGE, useProjectRecovery } from "./projectRecovery.ts";

const { projectId, title } = defineProps<{ projectId: ProjectId; title: string }>();
const emit = defineEmits<{ cleared: [] }>();
const { startFresh } = useProjectRecovery();
const open = ref(false);
const busy = ref(false);
const error = ref("");

async function confirm(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await startFresh(projectId);
    open.value = false;
    emit("cleared");
  } catch (reason) {
    error.value = String(reason).replace(/^Error: /, "");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="start-fresh">
    <p class="game-card__alert" role="alert">{{ UNREADABLE_PROJECT_MESSAGE }}</p>
    <UiButton
      variant="danger"
      class="start-fresh__open"
      data-testid="start-fresh"
      @click="open = true"
    >
      Start fresh…
    </UiButton>
    <UiDialog v-model:open="open" title="Start fresh?" size="sm" data-testid="start-fresh-dialog">
      <p class="start-fresh__copy">
        The copy of <strong>{{ title }}</strong> stored in this browser was saved in a format this
        version of the app cannot read. This unreadable local copy will be removed, with the
        progress and history stored alongside it, so the game can be added again.
      </p>
      <p class="start-fresh__copy">Games you exported or downloaded as files are not affected.</p>
      <p v-if="error" class="start-fresh__error" role="alert">{{ error }}</p>
      <template #footer>
        <UiButton data-testid="start-fresh-cancel" @click="open = false">Cancel</UiButton>
        <UiButton
          variant="danger"
          data-testid="start-fresh-confirm"
          :disabled="busy"
          @click="confirm"
        >
          Start fresh
        </UiButton>
      </template>
    </UiDialog>
  </div>
</template>

<style scoped>
.start-fresh {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-3);
}
.start-fresh .game-card__alert {
  margin: var(--space-1) 0 0;
  color: var(--danger);
  font-size: var(--text-xs);
  line-height: 1.4;
}
.start-fresh__copy {
  margin: 0 0 var(--space-4);
  color: var(--ink-2);
}
.start-fresh__error {
  margin: 0;
  color: var(--danger);
  font-size: var(--text-sm);
}
</style>
