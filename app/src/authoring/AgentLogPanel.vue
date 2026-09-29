<script setup lang="ts">
import { ref } from "vue";
import SoundPreview from "./SoundPreview.vue";
import UiButton from "../ui/UiButton.vue";
import UiIcon from "../ui/UiIcon.vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { usePresentation } from "../play/usePresentation.ts";
import { useAiSettings } from "../settings/useAiSettings.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";

/**
 * Developer activity: the agent log, the debug bundle and the test game. It
 * never sits on the page: Create docks it in its Activity tab, and Settings →
 * Advanced opens it as a dialog everywhere else. Running the test game emits
 * `booted`, so the dialog can step aside for it.
 */
const emit = defineEmits<{ booted: [] }>();

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
  <section class="agent-panel" aria-label="Developer activity" data-testid="agent-panel">
    <div class="agent-panel-header">
      <span class="backend-tag" title="Renderer" data-testid="gpu-backend">{{
        gpuBackend || "canvas2d"
      }}</span>
      <div class="agent-panel-actions">
        <span v-if="copyFeedback" class="copy-feedback" role="status">{{ copyFeedback }}</span>
        <UiButton
          size="sm"
          icon="copy"
          data-testid="btn-copy-trace"
          title="Copy the whole debug trace to the clipboard"
          @click="copyDebugBundle"
        >
          Copy debug bundle
        </UiButton>
        <UiButton
          size="sm"
          variant="ghost"
          icon="trash"
          data-testid="btn-clear-trace"
          title="Clear the log"
          @click="clearAgentLog"
        >
          Clear
        </UiButton>
      </div>
    </div>
    <UiButton
      v-if="testMode && (state.phase === 'idle' || state.phase === 'error')"
      icon="play"
      data-testid="boot-agent"
      @click="
        resumeAudio();
        bootAgentGame();
        emit('booted');
      "
    >
      Run test game
    </UiButton>
    <div class="agent-entries">
      <div
        v-for="entry in state.agentLog.slice(-50)"
        :key="entry.id"
        class="agent-entry"
        :class="entry.kind"
      >
        <button
          v-if="entry.data"
          type="button"
          class="agent-entry-row agent-entry-row--expandable"
          :aria-expanded="expandedLogIds.has(entry.id)"
          @click="toggleLogEntry(entry.id)"
        >
          <span class="agent-kind">{{ entry.kind }}</span>
          <span class="agent-detail">{{ entry.detail }}</span>
          <span class="agent-expand-toggle">
            <UiIcon
              :name="expandedLogIds.has(entry.id) ? 'chevron-up' : 'chevron-down'"
              :size="12"
            />{{ expandedLogIds.has(entry.id) ? "collapse" : "inspect" }}
          </span>
        </button>
        <div v-else class="agent-entry-row">
          <span class="agent-kind">{{ entry.kind }}</span>
          <span class="agent-detail">{{ entry.detail }}</span>
        </div>
        <pre v-if="entry.data && expandedLogIds.has(entry.id)" class="agent-data-preview">{{
          JSON.stringify(entry.data, null, 2)
        }}</pre>
        <SoundPreview v-if="entry.audio?.length" :audio="entry.audio" />
      </div>
      <p v-if="!state.agentLog.length" class="agent-empty">
        Agent requests, tool calls and results appear here as the assistant works.
      </p>
    </div>
  </section>
</template>

<style scoped>
.backend-tag {
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / 1 var(--font-mono);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}

.agent-panel {
  font-size: var(--text-xs);
}

.agent-empty {
  margin: 0;
  color: var(--ink-3);
  font-family: var(--font-sans);
}

.agent-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: 0 0 var(--space-3);
}

.agent-panel-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
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

.agent-entry-row {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}

/* A row with data is a button: the whole line toggles its preview. */
.agent-entry-row--expandable {
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
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
  color: var(--ink-2);
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
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
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
