<script setup lang="ts">
import { ref } from "vue";
import SoundPreview from "./SoundPreview.vue";
import UiButton from "./ui/UiButton.vue";
import { useEngineApi } from "./engineContext.ts";
import { usePresentation } from "./usePresentation.ts";
import { useAiSettings } from "./useAiSettings.ts";
import { useGameLibrary } from "./useGameLibrary.ts";

const engine = useEngineApi();
const { state, clearAgentLog, resumeAudio, bootAgentGame, currentGame } = engine;
const { gpuBackend, testMode } = usePresentation();
const { provider, model, taskBudget } = useAiSettings();
const { activeTemplate } = useGameLibrary();

const expandedLogIds = ref<Set<string>>(new Set());
const copyFeedback = ref<string>("");

function toggleLogEntry(id: string): void {
  if (expandedLogIds.value.has(id)) {
    expandedLogIds.value.delete(id);
  } else {
    expandedLogIds.value.add(id);
  }
}

async function copyDebugBundle(): Promise<void> {
  const current = currentGame();
  const bundle = {
    exportedAt: new Date().toISOString(),
    game: current
      ? {
          projectId: current.projectId,
          alias: current.alias,
          hash: current.hash,
          title: current.title,
          revision: current.revision,
          source: current.installed ? "installed" : "authored",
        }
      : {
          projectId: activeTemplate.value.id,
          title: activeTemplate.value.title,
          source: "draft",
        },
    mode: state.walkthrough.active ? "walkthrough" : current ? "play" : "authoring",
    provider: provider.value,
    model: model.value,
    budgetUsd: taskBudget.value,
    phase: state.phase,
    error: state.error || null,
    textRows: state.rows,
    agentLog: state.agentLog.map((entry) => {
      const copy = { ...entry };
      delete copy.audio;
      return copy;
    }),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    copyFeedback.value = "Copied!";
    setTimeout(() => {
      copyFeedback.value = "";
    }, 2500);
  } catch {
    copyFeedback.value = "Copy failed";
    setTimeout(() => {
      copyFeedback.value = "";
    }, 2500);
  }
}
</script>

<template>
  <!-- Live Agent Debug Activity Panel -->
  <details v-if="state.agentLog.length || testMode" class="agent-panel" data-testid="agent-panel">
    <summary data-testid="developer-activity-summary">Developer activity</summary>
    <div class="agent-panel-header">
      <span class="backend-tag" data-testid="gpu-backend">{{ gpuBackend || "canvas2d" }}</span>
      <div class="agent-panel-actions">
        <button
          type="button"
          class="telemetry-btn"
          data-testid="btn-copy-trace"
          title="Copy entire debug trace to clipboard"
          @click="copyDebugBundle"
        >
          📋 Copy Debug Bundle
        </button>
        <button
          type="button"
          class="telemetry-btn secondary"
          data-testid="btn-clear-trace"
          title="Clear telemetry logs"
          @click="clearAgentLog"
        >
          Clear
        </button>
        <span v-if="copyFeedback" class="copy-feedback">{{ copyFeedback }}</span>
      </div>
    </div>
    <UiButton
      v-if="testMode && (state.phase === 'idle' || state.phase === 'error')"
      data-testid="boot-agent"
      @click="
        resumeAudio();
        bootAgentGame();
      "
    >
      Run test game
    </UiButton>
    <div class="agent-entries">
      <div
        v-for="entry in state.agentLog.slice(-50)"
        :key="entry.id"
        class="agent-entry"
        :class="[entry.kind, { expandable: Boolean(entry.data) }]"
        @click="entry.data ? toggleLogEntry(entry.id) : null"
      >
        <div class="agent-entry-row">
          <span class="agent-kind">{{ entry.kind }}</span>
          <span class="agent-detail">{{ entry.detail }}</span>
          <span v-if="entry.data" class="agent-expand-toggle">
            {{ expandedLogIds.has(entry.id) ? "▲ collapse" : "▼ inspect" }}
          </span>
        </div>
        <pre v-if="entry.data && expandedLogIds.has(entry.id)" class="agent-data-preview">{{
          JSON.stringify(entry.data, null, 2)
        }}</pre>
        <SoundPreview v-if="entry.audio?.length" :audio="entry.audio" />
      </div>
    </div>
  </details>
</template>

<style scoped>
.backend-tag {
  font-size: var(--text-2xs);
  color: var(--ink-3);
  letter-spacing: 0.15em;
}

.agent-panel {
  width: var(--shell-width);
  margin-top: 1rem;
  border-top: 1px solid var(--hairline);
  max-height: 280px;
  overflow-y: auto;
  font-size: var(--text-xs);
}

.agent-panel summary {
  cursor: pointer;
  padding: 12px 0;
  color: var(--ink-2);
  font-size: var(--text-xs);
}

.agent-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.5rem 0;
}

.agent-panel-actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.telemetry-btn {
  font-size: var(--text-2xs);
  padding: 0.2rem 0.5rem;
  background: var(--surface-3);
  border: 1px solid var(--action-line);
  color: var(--action);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: inherit;
}

.telemetry-btn:hover {
  background: var(--action-soft);
  border-color: var(--action);
  color: var(--ink);
}

.telemetry-btn.secondary {
  background: var(--surface-2);
  border-color: var(--hairline-strong);
  color: var(--ink-3);
}

.telemetry-btn.secondary:hover {
  background: var(--surface-3);
  border-color: var(--hairline-strong);
  color: var(--ink);
}

.copy-feedback {
  font-size: var(--text-2xs);
  color: var(--ok);
  font-weight: bold;
}

.agent-entries {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agent-entry {
  padding: 3px 0;
  color: var(--ink-3);
  font-family: var(--font-mono);
}

.agent-entry.expandable {
  cursor: pointer;
}

.agent-entry-row {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}

.agent-entry .agent-kind {
  color: var(--action);
  font-weight: bold;
}

.agent-entry.response .agent-kind {
  color: var(--ok);
}

.agent-entry.error .agent-kind {
  color: var(--danger);
}

.agent-entry.log .agent-kind {
  color: var(--warn);
}

.agent-entry.telemetry .agent-kind {
  /* Telemetry category purple: no matching token. */
  color: #b8f;
}

.agent-entry.input .agent-kind {
  color: var(--action);
}

.agent-detail {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}

.agent-expand-toggle {
  font-size: var(--text-2xs);
  color: var(--action);
  opacity: 0.8;
  padding: 0 4px;
}

.agent-data-preview {
  margin: 0.3rem 0 0.5rem 1rem;
  padding: 0.4rem 0.6rem;
  background: var(--surface-0);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  font-size: var(--text-2xs);
  max-height: 180px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
