<script setup lang="ts">
import UiButton from "./ui/UiButton.vue";
import type { WalkthroughUiState } from "./useWalkthroughController.ts";

defineProps<{ walkthrough: WalkthroughUiState }>();
const emit = defineEmits<{ takeControl: [] }>();
</script>

<template>
  <div class="walkthrough-bar" data-testid="walkthrough-bar" role="status">
    <span class="walkthrough-badge">
      <span class="walkthrough-dot" aria-hidden="true"></span>
      Walkthrough
    </span>
    <span v-if="walkthrough.label" class="walkthrough-label" data-testid="walkthrough-label">
      {{ walkthrough.label }}
    </span>
    <span
      v-if="typeof walkthrough.score === 'number'"
      class="walkthrough-score"
      data-testid="walkthrough-score"
    >
      Score: {{ walkthrough.score }}
    </span>
    <span
      v-if="typeof walkthrough.room === 'number'"
      class="walkthrough-room"
      data-testid="walkthrough-room"
    >
      Room {{ walkthrough.room }}
    </span>
    <span v-if="walkthrough.status === 'completed'" class="walkthrough-completed-badge">
      Completed!
    </span>
    <div class="walkthrough-actions">
      <UiButton
        variant="primary"
        class="walkthrough-btn"
        data-testid="btn-walkthrough-take-control"
        title="Take control of the game right here"
        @click="emit('takeControl')"
      >
        Take control
      </UiButton>
    </div>
  </div>
  <p v-if="walkthrough.error" class="export-refusal" data-testid="walkthrough-error" role="alert">
    {{ walkthrough.error }}
  </p>
</template>

<style scoped>
.walkthrough-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  width: var(--game-width);
  box-sizing: border-box;
  margin: 6px 0 0;
  padding: 6px 12px;
  border: 1px solid var(--action-line);
  border-radius: var(--radius-lg);
  background: var(--action-soft);
  color: var(--ink);
  font-size: var(--text-sm);
}
.walkthrough-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--action);
  text-transform: uppercase;
  font-size: var(--text-2xs);
  letter-spacing: 0.05em;
}
.walkthrough-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--action);
  animation: walkthrough-pulse 1.5s ease-in-out infinite;
}
@keyframes walkthrough-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.85);
  }
}
.walkthrough-label {
  color: var(--ink);
  font-weight: 500;
}
.walkthrough-score {
  color: var(--ok);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.walkthrough-completed-badge {
  color: var(--warn);
  font-weight: 600;
}
.walkthrough-actions {
  display: inline-flex;
  gap: 8px;
  margin-left: auto;
}
.walkthrough-room {
  color: var(--ink-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
</style>
