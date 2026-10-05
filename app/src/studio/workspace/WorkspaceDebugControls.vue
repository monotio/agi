<script setup lang="ts">
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import type { WorkspaceDebug } from "./workspaceDebug.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import UiButton from "../../ui/UiButton.vue";
import UiIcon from "../../ui/UiIcon.vue";
const props = defineProps<{ debug: WorkspaceDebug }>();
const engine = useEngineApi();
const steps = [
  { action: "over", vocabulary: VOCABULARY.stepOver, key: "F10" },
  { action: "into", vocabulary: VOCABULARY.stepInto, key: "F11" },
  { action: "out", vocabulary: VOCABULARY.stepOut, key: "⇧F11" },
] as const;
async function pause(): Promise<void> {
  await engine.executionDebug.query("debugPause", { epoch: props.debug.state.epoch });
}
</script>
<template>
  <div class="workspace-debug-controls" role="group" aria-label="Debug controls">
    <UiButton
      size="sm"
      variant="ghost"
      :disabled="debug.state.busy"
      :title="debug.stopped.value ? 'Continue' : 'Pause'"
      :aria-label="debug.stopped.value ? 'Continue' : 'Pause'"
      @click="debug.run(debug.stopped.value ? () => debug.resume('continue') : pause)"
      ><UiIcon :name="debug.stopped.value ? 'play' : 'pause'" :size="16"
    /></UiButton>
    <UiButton
      v-for="step in steps"
      :key="step.action"
      size="sm"
      variant="ghost"
      :disabled="!debug.stopped.value || debug.state.busy"
      :aria-label="`${step.vocabulary.label} (${step.key})`"
      :title="`${step.vocabulary.label} (${step.key}). ${step.vocabulary.help}`"
      @click="debug.run(() => debug.resume(step.action))"
      ><svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <template v-if="step.action === 'over'">
          <path d="M2 8a5 5 0 0 1 10 0v1m-3-3 3 3 3-3" />
          <circle cx="8" cy="13" r="1" fill="currentColor" stroke="none" />
        </template>
        <template v-else-if="step.action === 'into'">
          <path d="M8 1v9m-3-3 3 3 3-3" />
          <circle cx="8" cy="14" r="1" fill="currentColor" stroke="none" />
        </template>
        <template v-else>
          <path d="M8 10V1M5 4l3-3 3 3" />
          <circle cx="8" cy="14" r="1" fill="currentColor" stroke="none" />
        </template></svg
    ></UiButton>
    <UiButton
      size="sm"
      variant="ghost"
      data-testid="debug-stop"
      :disabled="debug.state.busy"
      title="Stop (⇧F5)"
      aria-label="Stop (⇧F5)"
      @click="debug.run(debug.stop)"
      ><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <rect x="3" y="3" width="10" height="10" rx="1" /></svg
    ></UiButton>
  </div>
</template>
<style scoped>
.workspace-debug-controls {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: var(--space-1);
}
</style>
