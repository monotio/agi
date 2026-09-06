<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { AgentRunState } from "./agent/agentRun.ts";
const props = withDefaults(defineProps<{ task: AgentRunState | null; showText?: boolean }>(), {
  showText: true,
});
defineEmits<{ stop: []; resume: []; discard: [] }>();
const now = ref(Date.now());
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
  write_actor: "a character",
  write_logic_source: "room behavior",
  write_words: "vocabulary",
  write_inventory_objects: "inventory",
  write_sound: "sound",
  write_music: "music",
  read_frames: "a scene inspection",
  read_state: "a game inspection",
  read_objects: "a character inspection",
  read_room_context: "a room inspection",
  playtest_room: "a playtest",
};
const activity = computed(() => {
  const progress = props.task?.progress;
  if (progress?.phase === "tool")
    return `Preparing ${TOOL_SUBJECTS[progress.tool ?? ""] ?? "a tool call"}…`;
  if (progress?.phase === "text") return "Writing…";
  if (progress?.phase === "thinking") return "Thinking…";
  return "Waiting for the model…";
});
const elapsed = computed(() =>
  Math.max(0, Math.floor((now.value - (props.task?.progress?.startedAt ?? now.value)) / 1000)),
);
const quiet = computed(() =>
  Math.max(0, Math.floor((now.value - (props.task?.progress?.lastEventAt ?? now.value)) / 1000)),
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
        class="ui-button ui-button--secondary"
        data-testid="agent-stop"
        @click="$emit('stop')"
      >
        Stop
      </button>
      <button
        v-else-if="task.status === 'paused'"
        type="button"
        class="ui-button ui-button--primary"
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
      <button
        type="button"
        class="ui-button ui-button--danger"
        data-testid="agent-discard"
        @click="$emit('discard')"
      >
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
.stream-progress {
  margin-bottom: 10px;
}
.stream-time {
  color: #8ca6af;
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
