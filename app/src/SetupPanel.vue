<script setup lang="ts">
/**
 * The pre-game menu screen: the welcome block, the tutorial disclosure with
 * the featured catalog card, the setup panel (create + library + error
 * banner), and the authoring splash shown while a new game is generated.
 */
import AgentTaskControls from "./AgentTaskControls.vue";
import CreatePanel from "./CreatePanel.vue";
import LibraryPanel from "./LibraryPanel.vue";
import { useEngineApi } from "./engineContext.ts";
import { useGameLibrary } from "./useGameLibrary.ts";
import { hasWalkthrough } from "./walkthrough.ts";

const { state, stopAgent, continueAgent, discardAgent } = useEngineApi();
const {
  tutorialOpen,
  setTutorialOpen,
  featuredCatalog,
  catalogOpenings,
  catalogErrors,
  catalogBusy,
  libraryActionBusy,
  libraryActionError,
  cachedMeta,
  catalogHasProgress,
  loadCatalogOpening,
  playCatalogGame,
  playCatalogWalkthrough,
  activeTemplate,
} = useGameLibrary();
</script>
<template>
  <section
    v-if="state.phase === 'idle' || state.phase === 'error'"
    class="welcome"
    aria-labelledby="welcome-title"
  >
    <p class="welcome-kicker">
      <a
        href="https://en.wikipedia.org/wiki/Adventure_Game_Interpreter"
        target="_blank"
        rel="noopener noreferrer"
        >Adventure Game Interpreter</a
      >
    </p>
    <h1 id="welcome-title">AGI IS HERE<span>.</span></h1>
    <p class="welcome-line">Dream it. Play it. Remix it.</p>
  </section>

  <details
    id="tutorial"
    v-if="state.phase === 'idle' || state.phase === 'error'"
    class="catalog-shelf"
    data-testid="tutorial-disclosure"
    :open="tutorialOpen"
    aria-labelledby="catalog-title"
  >
    <summary
      class="section-summary"
      data-testid="tutorial-toggle"
      @click.prevent="setTutorialOpen(!tutorialOpen)"
    >
      <h2 id="catalog-title">Play the tutorial</h2>
    </summary>
    <article
      v-for="entry in [featuredCatalog]"
      :key="`${entry.id}-${entry.version}`"
      class="catalog-card"
      :data-testid="`catalog-${entry.id}`"
    >
      <div class="catalog-art">
        <img
          v-if="catalogOpenings[entry.id]?.preview"
          :src="catalogOpenings[entry.id]?.preview"
          :alt="`${entry.title} opening scene`"
        />
        <div v-else class="thumbnail-placeholder" aria-hidden="true">
          {{ catalogBusy[entry.id] ? "CHECKING OPENING…" : "16 COLOR ADVENTURE" }}
        </div>
      </div>
      <div class="catalog-copy">
        <h3>{{ entry.title }}</h3>
        <p>{{ entry.description }}</p>
        <p class="catalog-byline">{{ entry.author }} · {{ entry.license }}</p>
        <p v-if="catalogErrors[entry.id]" role="alert" class="library-error">
          {{ catalogErrors[entry.id] }}
        </p>
        <p v-if="libraryActionError && !cachedMeta" role="alert" class="library-error">
          {{ libraryActionError }}
        </p>
        <button
          v-if="catalogErrors[entry.id]"
          type="button"
          class="ui-button ui-button--secondary"
          :disabled="catalogBusy[entry.id]"
          @click="loadCatalogOpening(entry.id)"
        >
          Retry preview
        </button>
        <div v-else class="catalog-actions">
          <button
            type="button"
            class="ui-button ui-button--primary"
            :data-testid="`catalog-play-${entry.id}`"
            :disabled="catalogBusy[entry.id] || libraryActionBusy"
            @click="playCatalogGame(entry.id)"
          >
            {{
              catalogBusy[entry.id]
                ? "Checking opening…"
                : catalogHasProgress(entry)
                  ? "Resume"
                  : "Play now"
            }}
          </button>
          <button
            v-if="hasWalkthrough(entry.id)"
            type="button"
            class="ui-button ui-button--secondary"
            data-testid="catalog-run-walkthrough"
            :disabled="catalogBusy[entry.id] || libraryActionBusy"
            @click="playCatalogWalkthrough(entry.id)"
          >
            Watch a playthrough
          </button>
        </div>
      </div>
    </article>
  </details>

  <!-- Pre-game setup panel -->
  <div v-if="state.phase === 'idle' || state.phase === 'error'" class="setup-panel">
    <CreatePanel />
    <LibraryPanel />
    <!-- Prominent Error Display inside Setup Panel -->
    <div v-if="state.phase === 'error'" class="error-banner" data-testid="error-panel" role="alert">
      <span class="error-badge">ERROR</span>
      <span class="error-msg">{{ state.error }}</span>
    </div>
  </div>

  <!-- Interstitial Splash / Loading Screen during Genesis -->
  <div v-if="state.phase === 'loading'" class="loading-panel" data-testid="splash-screen">
    <div class="splash-card">
      <h2 class="splash-title">{{ activeTemplate.title }}</h2>
      <p class="splash-desc">{{ activeTemplate.description }}</p>
      <div class="splash-progress">
        <div
          class="spinner-box"
          v-if="state.agentTask?.status !== 'paused' && !state.agentTask?.progress"
        >
          <span class="pulsing-dot" />
          <span>Preparing your adventure…</span>
        </div>
        <p class="splash-subtext">Your game will appear here when it is ready.</p>
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
  width: var(--shell-width);
  box-sizing: border-box;
  margin-bottom: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 32px;
  padding: 0;
}

.welcome {
  width: var(--shell-width);
  padding: 20px 0 36px;
}
.welcome-kicker {
  color: #85b8ba;
  font-size: 12px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  margin: 0 0 16px;
}
.welcome-kicker a {
  color: inherit;
  text-decoration: none;
}
.welcome-kicker a:hover,
.welcome-kicker a:focus-visible {
  text-decoration: underline;
  color: #a2e8ea;
}
.welcome h1 {
  font:
    900 clamp(38px, 6.6vw, 84px)/1.1 ui-monospace,
    "SFMono-Regular",
    Menlo,
    Consolas,
    monospace;
  letter-spacing: -0.065em;
  color: #e9ffff;
  text-shadow: 0 0 32px #55ffff30;
}
.welcome h1 span {
  color: #55ffff;
}
.welcome-line {
  margin: 18px 0 8px;
  color: #e3eded;
  font:
    500 clamp(18px, 2.5vw, 25px)/1.4 system-ui,
    sans-serif;
}
.catalog-shelf {
  width: var(--shell-width);
  margin: 0 auto 28px;
  padding: 22px;
  box-sizing: border-box;
  border: 1px solid #3d6669;
  border-radius: 12px;
  background: linear-gradient(135deg, #152a2c, #0b1113 68%);
  font-family: system-ui, sans-serif;
}
.catalog-card {
  display: grid;
  grid-template-columns: minmax(280px, 1.35fr) minmax(240px, 1fr);
  overflow: hidden;
  border: 1px solid #42676a;
  border-radius: 9px;
  background: #0c1517;
}
.catalog-art {
  min-height: 225px;
  background: #050707;
}
.thumbnail-placeholder {
  display: grid;
  height: 100%;
  min-height: 225px;
  place-items: center;
  color: #759294;
  font: 12px/1.4 monospace;
  letter-spacing: 0.12em;
}
.catalog-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  padding: 24px;
}
.catalog-copy h3 {
  margin: 7px 0;
  color: #fff;
  font-size: 24px;
}
.catalog-copy > p:not(.saved-world-badge) {
  margin: 0 0 14px;
  color: #a9bdbf;
  line-height: 1.5;
}
.catalog-copy .catalog-byline {
  color: #7f999b;
  font-size: 12px;
}
.catalog-copy .ui-button {
  width: auto;
  min-width: 150px;
}
.catalog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.catalog-actions .ui-button {
  flex: 1 1 auto;
}

.setup-panel > .error-banner {
  grid-column: 1 / -1;
}

.splash-card {
  text-align: center;
  max-width: 480px;
}

.splash-title {
  font-size: 1.2rem;
  letter-spacing: 0.15em;
  color: #fff;
  margin: 0 0 0.5rem 0;
}

.splash-desc {
  font-size: 0.8rem;
  color: #aaa;
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
  font-size: 0.85rem;
  color: #5af;
}

.pulsing-dot {
  width: 8px;
  height: 8px;
  background: #5af;
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
  font-size: 0.7rem;
  color: #666;
  margin: 0;
}

@media (max-width: 850px) {
  .catalog-card {
    grid-template-columns: minmax(0, 1fr);
  }
}

.error-banner {
  margin-top: 0.75rem;
  background: #2a0e0e;
  border: 1px solid #933;
  padding: 0.6rem 0.8rem;
  border-radius: 3px;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.error-badge {
  background: #933;
  color: #fff;
  font-family: monospace;
  font-size: 0.65rem;
  font-weight: bold;
  padding: 0.15rem 0.35rem;
  border-radius: 2px;
  letter-spacing: 0.1em;
}

.error-msg {
  font-family: monospace;
  font-size: 0.75rem;
  color: #fbb;
  line-height: 1.4;
  word-break: break-word;
}

.loading-panel {
  width: min(640px, 92vw);
  aspect-ratio: 8 / 5;
  background: #000;
  border: 2px solid #333;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  box-sizing: border-box;
}
</style>
