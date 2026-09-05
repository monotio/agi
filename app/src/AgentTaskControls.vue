<script setup lang="ts">
import type { AgentRunState } from "./agent/agentRun.ts";
defineProps<{ task: AgentRunState | null }>();
defineEmits<{ stop: []; resume: []; discard: [] }>();
</script>

<template>
  <div
    v-if="task && (task.status !== 'idle' || task.requests > 0)"
    class="task-controls"
    data-testid="agent-task-controls"
  >
    <div class="task-row">
      <span
        :title="'Estimated from reported tokens and standard API rates. A response may cross the budget; interrupted requests may still be billed.'"
      >
        {{
          task.priceKnown
            ? task.status === "idle"
              ? `Last task: $${task.spent.toFixed(2)} est.`
              : `$${task.spent.toFixed(2)} est. / $${task.budget.toFixed(2)}`
            : "Usage estimate unavailable"
        }}
        <span v-if="task.usageIncomplete"> · partial usage</span>
      </span>
      <button
        v-if="task.status === 'running'"
        type="button"
        data-testid="agent-stop"
        @click="$emit('stop')"
      >
        Stop
      </button>
      <button
        v-else-if="task.status === 'paused'"
        type="button"
        data-testid="agent-continue"
        @click="$emit('resume')"
      >
        {{
          task.reason.startsWith("Budget")
            ? `Add $${task.allowance.toFixed(2)} & continue`
            : "Continue"
        }}
      </button>
    </div>
    <template v-if="task.status === 'paused'">
      <p role="status" data-testid="agent-pause-reason">{{ task.reason }}</p>
      <button type="button" class="discard" data-testid="agent-discard" @click="$emit('discard')">
        Discard this attempt
      </button>
    </template>
  </div>
</template>

<style scoped>
.task-controls {
  padding: 10px 0;
  color: #afc6ce;
  font:
    12px/1.5 system-ui,
    sans-serif;
}
.task-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
button {
  margin: 0;
  padding: 6px 12px;
  border: 1px solid #47636e;
  border-radius: 5px;
  background: #173039;
  color: #b7f7ff;
  cursor: pointer;
  font: inherit;
}
p {
  margin: 8px 0;
}
.discard {
  background: transparent;
  color: #d1b6b6;
}
</style>
