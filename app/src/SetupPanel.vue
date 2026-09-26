<script setup lang="ts">
/**
 * The Home screen and the authoring splash. Home is the hero with its
 * Continue card, the error banner, the create panel and the "Your games"
 * shelf; dropping a ZIP or folder anywhere on it imports a game. The splash
 * shows while a new game is generated or a plain boot runs long.
 */
import { ref } from "vue";
import AgentTaskControls from "./AgentTaskControls.vue";
import CreatePanel from "./CreatePanel.vue";
import LibraryPanel from "./LibraryPanel.vue";
import HomeHero from "./home/HomeHero.vue";
import { useEngineApi } from "./engineContext.ts";
import { useGameLibrary } from "./useGameLibrary.ts";

const { state, stopAgent, continueAgent, discardAgent } = useEngineApi();
const { activeTemplate, onGameDrop } = useGameLibrary();
const createOpen = ref(false);

/** Nested dragenter/dragleave pairs: the outline stays while anything is over Home. */
const dragDepth = ref(0);
function onDrop(event: DragEvent): void {
  dragDepth.value = 0;
  void onGameDrop(event.dataTransfer ?? undefined);
}
</script>
<template>
  <div
    v-if="state.phase === 'idle' || state.phase === 'error'"
    class="setup-panel"
    :class="{ dragging: dragDepth > 0 }"
    data-testid="game-zip-drop"
    @dragenter.prevent="dragDepth++"
    @dragleave="dragDepth = Math.max(0, dragDepth - 1)"
    @dragover.prevent
    @drop.prevent="onDrop"
  >
    <HomeHero :create-open="createOpen" />
    <div v-if="state.phase === 'error'" class="error-banner" data-testid="error-panel" role="alert">
      <span class="error-badge">ERROR</span>
      <span class="error-msg">{{ state.error }}</span>
    </div>
    <CreatePanel v-model:open="createOpen" />
    <LibraryPanel />
  </div>

  <!-- Interstitial Splash / Loading Screen during Genesis -->
  <!-- A plain boot names the game it opens and stays hidden unless slow. -->
  <div
    v-if="state.phase === 'loading'"
    class="loading-panel"
    :class="{ quiet: state.loading?.generating === false }"
    data-testid="splash-screen"
  >
    <div class="splash-card">
      <h2 class="splash-title">
        {{
          state.loading?.generating === false
            ? state.loading.title
            : state.loading?.title || activeTemplate.title
        }}
      </h2>
      <p v-if="state.loading?.generating !== false" class="splash-desc">
        {{ activeTemplate.description }}
      </p>
      <div class="splash-progress">
        <div
          class="spinner-box"
          v-if="state.agentTask?.status !== 'paused' && !state.agentTask?.progress"
        >
          <span class="pulsing-dot" />
          <span>{{
            state.loading?.generating === false ? "Loading…" : "Preparing your adventure…"
          }}</span>
        </div>
        <p v-if="state.loading?.generating !== false" class="splash-subtext">
          Your game will appear here when it is ready.
        </p>
        <AgentTaskControls
          :task="state.agentTask"
          @stop="stopAgent"
          @resume="continueAgent"
          @discard="discardAgent"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.setup-panel {
  position: relative;
  display: flex;
  width: var(--shell-width);
  box-sizing: border-box;
  flex-direction: column;
  gap: var(--space-8);
  margin-bottom: var(--space-4);
  font-family: var(--font-sans);
  border-radius: var(--radius-lg);
  outline: 2px dashed transparent;
  outline-offset: var(--space-4);
  transition: outline-color var(--duration-fast) var(--ease-out);
}
.setup-panel.dragging {
  outline-color: var(--action-line);
}

.splash-card {
  text-align: center;
  max-width: 480px;
}

.splash-title {
  font-size: var(--text-xl);
  letter-spacing: 0.15em;
  color: var(--ink);
  margin: 0 0 0.5rem 0;
}

.splash-desc {
  font-size: var(--text-sm);
  color: var(--ink-2);
  margin: 0 0 1.2rem 0;
  line-height: 1.4;
}

.splash-progress {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.spinner-box {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: var(--text-md);
  color: var(--action);
}

.pulsing-dot {
  width: 8px;
  height: 8px;
  background: var(--action);
  border-radius: 50%;
  animation: pulse 1s infinite alternate;
}

@keyframes pulse {
  0% {
    opacity: 0.2;
    transform: scale(0.8);
  }
  100% {
    opacity: 1;
    transform: scale(1.2);
  }
}

.splash-subtext {
  font-size: var(--text-2xs);
  color: var(--ink-3);
  margin: 0;
}

.error-banner {
  background: var(--danger-soft);
  border: 1px solid var(--danger-line);
  padding: 0.6rem 0.8rem;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.error-badge {
  background: var(--danger);
  color: var(--action-ink);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: bold;
  padding: 0.15rem 0.35rem;
  border-radius: var(--radius-sm);
  letter-spacing: 0.1em;
}

.error-msg {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--danger);
  line-height: 1.4;
  word-break: break-word;
}

/* A quick boot shows only the black screen; the card appears if the load runs long. */
.loading-panel.quiet .splash-card {
  animation: quiet-reveal 0.8s both;
}

@keyframes quiet-reveal {
  0%,
  60% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

.loading-panel {
  width: min(640px, 92vw);
  aspect-ratio: 8 / 5;
  background: var(--agi-0);
  border: 2px solid var(--hairline);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  box-sizing: border-box;
}
@media (max-width: 600px) {
  .setup-panel {
    gap: var(--space-7);
  }
}
</style>
