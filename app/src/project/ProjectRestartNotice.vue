<script setup lang="ts">
import { ref } from "vue";
import { useEngineApi } from "../engine/engineContext.ts";
import UiToast from "../ui/UiToast.vue";
import UiButton from "../ui/UiButton.vue";

const engine = useEngineApi();
const busy = ref(false);
const error = ref("");
async function restart(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    const result =
      engine.pendingProjectRestart.value?.action === "reenter"
        ? await engine.reenterRoom()
        : await engine.restartWithChanges();
    if (result?.status === "diagnostics") error.value = "Fix the source errors, then try again.";
    else if (result?.status === "refused")
      error.value = result.reason ?? "Check your changes, then retry.";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiToast
    v-if="engine.pendingProjectRestart.value"
    tone="warn"
    data-testid="project-restart-notice"
  >
    <span v-if="engine.pendingProjectRestart.value.action === 'reenter'"
      >This change needs a fresh start of the room.</span
    >
    <span v-else>This change needs the game to restart.</span>
    <span>{{ engine.pendingProjectRestart.value.reason }}</span>
    <UiButton size="sm" :disabled="busy" @click="restart">{{
      engine.pendingProjectRestart.value.action === "reenter"
        ? "Re-enter room"
        : "Restart with your changes"
    }}</UiButton>
    <span v-if="error">{{ error }}</span>
  </UiToast>
</template>
