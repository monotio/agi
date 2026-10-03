<script setup lang="ts">
/**
 * The Home screen and the authoring splash. Home is the hero with its
 * Continue card, the error banner, the create panel and the "Your games"
 * shelf; dropping a ZIP or folder anywhere on it imports a game. The splash
 * shows while a new game is generated or a plain boot runs long.
 */
import { defineAsyncComponent, ref, watch } from "vue";

import UiButton from "../ui/UiButton.vue";
import CreatePanel from "./CreatePanel.vue";
import LibraryPanel from "./LibraryPanel.vue";
import HomeHero from "./HomeHero.vue";
import UnsupportedProject from "./UnsupportedProject.vue";
import type { UnsupportedStoredProject } from "../project/gameStorage.ts";
import { emptyProject } from "./emptyProjectRoute.ts";
import BootCard from "../ui/BootCard.vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";
import { useShell } from "../shell/useShell.ts";

/** Why Home opened instead of the game a link named (App.vue). */
const {
  routeNote = "",
  routePending = false,
  unsupportedProject = undefined,
} = defineProps<{
  routeNote?: string;
  routePending?: boolean;
  unsupportedProject?: UnsupportedStoredProject | undefined;
}>();
const AgentTaskControls = defineAsyncComponent(() => import("../authoring/AgentTaskControls.vue"));
const EmptyProjectStage = defineAsyncComponent(
  () => import("../studio/workspace/EmptyWorkspace.vue"),
);

const { state, stopAgent, continueAgent, discardAgent, openStarterRecovery, currentGame } =
  useEngineApi();
const shell = useShell();

/**
 * "Open starter" after a failed Create commits the prepared project and
 * boots it; landing on its Create view matches a manual create, and the
 * shell only spends the switch when that project is the running one.
 */
async function openStarter(): Promise<void> {
  await openStarterRecovery();
  const projectId = currentGame()?.projectId;
  if (projectId) shell.expectCreate(projectId);
}
const { activeTemplate, onGameDrop, latestVersion, startLatestVersion } = useGameLibrary();
const createOpen = ref(false);
watch(emptyProject, (project) => {
  if (project) createOpen.value = false;
});
watch(
  () => state.phase,
  (phase) => {
    if (phase === "loading" || phase === "running") createOpen.value = false;
  },
);

/** Nested dragenter/dragleave pairs: the outline stays while anything is over Home. */
const dragDepth = ref(0);
function onDrop(event: DragEvent): void {
  dragDepth.value = 0;
  void onGameDrop(event.dataTransfer ?? undefined);
}
</script>
<template>
  <div
    v-if="!routePending && (state.phase === 'idle' || state.phase === 'error')"
    class="setup-panel"
    :class="{ dragging: dragDepth > 0, 'new-game-page': createOpen }"
    data-testid="game-zip-drop"
    @dragenter.prevent="dragDepth++"
    @dragleave="dragDepth = Math.max(0, dragDepth - 1)"
    @dragover.prevent
    @drop.prevent="onDrop"
  >
    <p v-if="routeNote" class="route-note" role="status" data-testid="route-note">
      {{ routeNote }}
    </p>
    <UnsupportedProject
      v-if="unsupportedProject"
      :game="unsupportedProject"
      heading
      class="route-note"
      data-testid="unsupported-project-route"
    />
    <EmptyProjectStage v-if="emptyProject" :project="emptyProject" />
    <HomeHero v-if="!emptyProject" v-show="!createOpen" :create-open="createOpen" />
    <div
      v-if="state.phase === 'error' && !emptyProject"
      class="error-banner"
      data-testid="error-panel"
      role="alert"
    >
      <span class="error-badge">ERROR</span>
      <span class="error-msg">{{ state.error }}</span>
      <UiButton
        v-if="latestVersion"
        size="sm"
        data-testid="start-latest-version"
        @click="startLatestVersion"
        >Start the latest version</UiButton
      >
      <UiButton
        v-if="state.genesisStarter"
        size="sm"
        data-testid="open-starter"
        :disabled="state.genesisStarter.opening"
        @click="openStarter"
      >
        Open starter
      </UiButton>
    </div>
    <CreatePanel v-if="!emptyProject" v-model:open="createOpen" />
    <LibraryPanel v-if="!emptyProject" v-show="!createOpen" />
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
      <BootCard bare class="splash-boot" />
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
          v-if="state.agentTask"
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
.new-game-page {
  margin-top: calc(-1 * var(--space-8));
}
@media (max-width: 700px) {
  .new-game-page {
    margin-top: calc(-1 * var(--space-5));
  }
}
.route-note {
  margin: 0;
  padding: var(--space-3) var(--space-5);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-1);
  font: var(--weight-semibold) var(--text-md) / var(--leading) var(--font-sans);
}
.setup-panel.dragging {
  outline-color: var(--action-line);
}

.splash-card {
  text-align: center;
  max-width: 480px;
}

.splash-card .splash-boot {
  --boot-px: 3;
  margin: 0 auto var(--space-7);
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
