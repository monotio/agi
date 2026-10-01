<script setup lang="ts">
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import type { WorkspaceDebug } from "./workspaceDebug.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import UiButton from "../../ui/UiButton.vue";
const props = defineProps<{ debug: WorkspaceDebug }>();
const engine = useEngineApi();
const steps = [
  { action: "over", vocabulary: VOCABULARY.stepOver, key: "F10" },
  { action: "into", vocabulary: VOCABULARY.stepInto, key: "F11" },
  { action: "out", vocabulary: VOCABULARY.stepOut, key: "Shift+F11" },
] as const;
async function pause(): Promise<void> {
  await engine.executionDebug.query("debugPause", { epoch: props.debug.state.epoch });
}
</script>
<template>
  <div class="workspace-debug-controls">
    <UiButton
      v-if="!debug.stopped.value"
      size="sm"
      variant="ghost"
      :disabled="debug.state.busy"
      @click="debug.run(pause)"
      >Pause</UiButton
    >
    <UiButton
      size="sm"
      variant="ghost"
      data-testid="debug-stop"
      :disabled="debug.state.busy"
      title="Stop debugging (Shift+F5)"
      @click="debug.run(debug.stop)"
      >Stop</UiButton
    >
    <UiButton
      v-for="step in steps"
      :key="step.action"
      size="sm"
      variant="ghost"
      :disabled="!debug.stopped.value || debug.state.busy"
      :title="`${step.vocabulary.help} (${step.key})`"
      @click="debug.run(() => debug.resume(step.action))"
      >{{ step.vocabulary.label }}</UiButton
    >
  </div>
</template>
<style scoped>
.workspace-debug-controls {
  flex-basis: 100%;
  order: 1;
  padding-left: var(--space-2);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
}
</style>
