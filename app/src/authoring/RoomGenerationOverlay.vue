<script setup lang="ts">
import { computed } from "vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { useAiSettings } from "../settings/useAiSettings.ts";
import { formatSpent } from "../agent/reportedSpend.ts";
import { agentActivity } from "./agentActivity.ts";
import UiButton from "../ui/UiButton.vue";

const engine = useEngineApi();
const { state, stopRoomGeneration, retryRoomGeneration, continueAgent } = engine;
const { taskBudget } = useAiSettings();
const generation = computed(() => state.roomGeneration);
const visible = computed(
  () =>
    generation.value &&
    (generation.value.busy ||
      generation.value.error ||
      engine.roomMap.currentRoom.value !== generation.value.room),
);
const activity = computed(() => {
  const latest = state.agentLog.findLast(
    (entry) => (entry.seq ?? 0) >= (generation.value?.feedStartSeq ?? 0),
  );
  return agentActivity(latest, "Building the next room…", state.agentTask?.progress?.tool);
});
const spend = computed(() => {
  const task = state.agentTask;
  return formatSpent({
    amount: task?.spent ?? 0,
    budget: task?.budget ?? taskBudget.value,
    priceKnown: task?.priceKnown ?? true,
    incomplete: task?.usageIncomplete ?? false,
  });
});
</script>

<template>
  <section
    v-if="visible"
    class="room-generation"
    data-testid="room-generation"
    aria-label="Room generation"
    @click.stop
    @pointerdown.stop
    @keydown.stop
  >
    <div class="room-generation__card">
      <h2>Creating the next room</h2>
      <p v-if="generation?.error" role="alert" data-testid="room-generation-error">
        {{ generation.error }}
      </p>
      <p v-else role="status" aria-live="polite" data-testid="room-generation-step">
        {{ state.agentTask?.status === "paused" ? state.agentTask.reason : activity }}
      </p>
      <progress
        v-if="generation?.busy && state.agentTask?.status !== 'paused'"
        aria-label="Room generation in progress"
      ></progress>
      <p class="room-generation__spend" data-testid="room-generation-spent">{{ spend }}</p>
      <div class="room-generation__actions">
        <UiButton
          v-if="generation?.error"
          variant="primary"
          data-testid="room-generation-retry"
          @click="retryRoomGeneration"
          >Retry</UiButton
        >
        <UiButton
          v-else-if="state.agentTask?.status === 'paused'"
          variant="primary"
          data-testid="room-generation-continue"
          @click="continueAgent()"
          >Continue</UiButton
        >
        <UiButton data-testid="room-generation-stop" @click="stopRoomGeneration">Stop</UiButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.room-generation {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: grid;
  place-items: center;
  padding: var(--space-4);
  box-sizing: border-box;
  background: var(--scrim);
  color: var(--ink);
  overflow: auto;
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.room-generation__card {
  width: min(100%, 360px);
  box-sizing: border-box;
  padding: var(--space-5);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  text-align: center;
}
h2 {
  margin: 0;
  font: var(--weight-semibold) var(--text-lg) / var(--leading-tight) var(--font-sans);
}
p {
  margin: var(--space-3) 0;
}
progress {
  width: 100%;
  accent-color: var(--action);
}
.room-generation__spend {
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
}
.room-generation__actions {
  display: flex;
  justify-content: center;
  gap: var(--space-3);
}
</style>
