<script setup lang="ts">
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
      <button
        type="button"
        class="ui-button ui-button--primary walkthrough-btn"
        data-testid="btn-walkthrough-take-control"
        title="Take control of the game right here"
        @click="emit('takeControl')"
      >
        Take control
      </button>
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
  border: 1px solid #1a5259;
  border-radius: 8px;
  background: #0f2428;
  color: #c9eff2;
  font-size: 13px;
}
.walkthrough-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: #5ce1e6;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.05em;
}
.walkthrough-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #5ce1e6;
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
  color: #ffffff;
  font-weight: 500;
}
.walkthrough-score {
  color: #9fe6a0;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
.walkthrough-completed-badge {
  color: #ffd700;
  font-weight: 600;
}
.walkthrough-actions {
  display: inline-flex;
  gap: 8px;
  margin-left: auto;
}
.walkthrough-room {
  color: #8da4ac;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
</style>
