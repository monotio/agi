<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import UiButton from "../ui/UiButton.vue";
import { formatSpent } from "../agent/reportedSpend.ts";
import type { AgentRunState } from "../agent/agentRun.ts";
const { task, showText = true } = defineProps<{ task: AgentRunState | null; showText?: boolean }>();
defineEmits<{ stop: []; resume: [requestLimit?: number]; discard: [] }>();
const now = ref(Date.now());
const requestLimit = ref(5);
let clock: ReturnType<typeof setInterval>;
onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => clearInterval(clock));
const TOOL_SUBJECTS: Record<string, string> = {
  write_picture: "scenery",
  write_view: "sprites",
  write_logic: "room behavior",
  write_words: "vocabulary",
  write_objects: "inventory",
  write_sound: "sound",
  write_music: "music",
  read_room: "a room inspection",
  playtest_room: "a playtest",
};
const activity = computed(() => {
  const progress = task?.progress;
  if (progress?.phase === "tool")
    return `Preparing ${TOOL_SUBJECTS[progress.tool ?? ""] ?? "a tool call"}…`;
  if (progress?.phase === "text") return "Writing…";
  if (progress?.phase === "thinking") return "Thinking…";
  return "Waiting for the model…";
});
const elapsed = computed(() =>
  Math.max(0, Math.floor((now.value - (task?.progress?.startedAt ?? now.value)) / 1000)),
);
const quiet = computed(() =>
  Math.max(0, Math.floor((now.value - (task?.progress?.lastEventAt ?? now.value)) / 1000)),
);
</script>

<template>
  <div
    v-if="task && (task.status !== 'idle' || task.requests > 0)"
    class="task-controls"
    data-testid="agent-task-controls"
  >
    <div
      v-if="task.progress && task.status === 'running'"
      class="stream-progress"
      data-testid="agent-stream-progress"
    >
      <div class="task-row">
        <span role="status" aria-live="polite" data-testid="agent-stream-status">{{
          activity
        }}</span>
        <span class="stream-time"
          >{{ elapsed }}s<span v-if="quiet >= 15"> · Last update {{ quiet }}s ago</span></span
        >
      </div>
      <p v-if="showText && task.progress.text" class="stream-text" data-testid="agent-stream-text">
        {{ task.progress.text }}
      </p>
    </div>
    <p
      v-if="task.status !== 'running' && task.requests > 0"
      class="task-spent"
      data-testid="agent-spent"
    >
      {{
        formatSpent({
          amount: task.reportedSpent,
          priceKnown: task.priceKnown,
          incomplete: task.usageIncomplete,
          budget: task.budget,
        })
      }}
    </p>
    <div class="task-row">
      <span>Budget ${{ task.budget.toFixed(2) }}</span>
      <a :href="task.usageUrl ?? 'https://platform.openai.com/usage'" target="_blank" rel="noopener"
        >See your usage</a
      >
      <UiButton v-if="task.status === 'running'" data-testid="agent-stop" @click="$emit('stop')">
        Stop
      </UiButton>
      <UiButton
        v-else-if="task.status === 'paused'"
        variant="primary"
        data-testid="agent-continue"
        @click="$emit('resume', task.priceKnown ? undefined : requestLimit)"
      >
        Continue
      </UiButton>
    </div>
    <template v-if="task.status === 'paused'">
      <label v-if="!task.priceKnown">
        Requests
        <input
          v-model.number="requestLimit"
          type="number"
          min="1"
          step="1"
          data-testid="agent-request-limit"
        />
      </label>
      <p role="status" data-testid="agent-pause-reason">{{ task.reason }}</p>
      <UiButton variant="danger" data-testid="agent-discard" @click="$emit('discard')">
        Discard this attempt
      </UiButton>
    </template>
  </div>
</template>

<style scoped>
.task-controls {
  padding: 10px 12px;
  color: var(--ink-2);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.task-spent,
.task-row {
  font-variant-numeric: tabular-nums;
}
.task-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.task-row a {
  color: var(--action);
}
.stream-progress {
  margin-bottom: 10px;
}
.stream-time {
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.stream-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 180px;
  overflow-y: auto;
  text-align: left;
}
p {
  margin: 8px 0;
}
</style>
