<script setup lang="ts">
/**
 * The top of the Home screen: the wordmark, one line about the app and two
 * calls to action, beside a "Continue" card. With an autosave for the last
 * game played, the primary action continues it and the card shows its
 * current screen from the autosave's preview; otherwise the primary action
 * plays the tutorial and the card shows the tutorial's opening screen.
 */
import { computed } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiChip from "../ui/UiChip.vue";
import { useEngineApi } from "../engineContext.ts";
import { useGameLibrary } from "../useGameLibrary.ts";
import { useShellBridge } from "../shellBridge.ts";
import { gameStorageKey } from "../gameTypes.ts";
import { getKnownGameByRevision } from "../../../src/games/knownGames.ts";
import { catalogProjectId, useProjectRecovery } from "./projectRecovery.ts";
import { formatRelativeTime } from "./relativeTime.ts";
import { useNow } from "./useNow.ts";

const { createOpen } = defineProps<{ createOpen: boolean }>();
const { state } = useEngineApi();
const {
  pendingAutosave,
  savedGames,
  featuredCatalog,
  catalogOpenings,
  catalogBusy,
  libraryActionBusy,
  importBusy,
  onResumeAutosave,
  playCatalogGame,
} = useGameLibrary();
const bridge = useShellBridge();
const { playGuarded } = useProjectRecovery();
const now = useNow();

/** The last game played, when it left an autosave to continue from. */
const last = computed(() => {
  const record = pendingAutosave.value;
  if (!record) return undefined;
  const project = record.game.identity.project;
  const saved = savedGames.value.find((game) => game.projectId === project);
  const installed = (state.installedGames ?? []).find(
    (game) => gameStorageKey({ installed: true, ...game }) === project,
  );
  return {
    record,
    title:
      saved?.title ??
      installed?.title ??
      getKnownGameByRevision(record.game.identity.revision)?.title ??
      project,
    screen: record.preview ?? saved?.library?.preview,
  };
});

const tutorialScreen = computed(() => catalogOpenings.value[featuredCatalog.id]?.preview);

function onPrimary(): void {
  const record = last.value?.record;
  if (record) void playGuarded(record.game.identity.project, onResumeAutosave);
  else
    void playGuarded(catalogProjectId(featuredCatalog), () => playCatalogGame(featuredCatalog.id));
}
</script>

<template>
  <section class="hero" aria-labelledby="welcome-title">
    <div class="hero-copy">
      <h1 id="welcome-title">AGI IS HERE<span>.</span></h1>
      <p class="hero-line">
        Play Sierra-style adventures, build your own with AI, and edit every room by hand in the
        authentic
        <a
          href="https://en.wikipedia.org/wiki/Adventure_Game_Interpreter"
          target="_blank"
          rel="noopener noreferrer"
          >AGI</a
        >
        format.
      </p>
      <div class="hero-ctas">
        <UiButton
          variant="primary"
          icon="play"
          class="hero-cta"
          data-testid="hero-primary"
          :disabled="
            libraryActionBusy || importBusy || (!last && catalogBusy[featuredCatalog.id] === true)
          "
          @click="onPrimary"
        >
          {{ last ? `Continue ${last.title}` : "Play the tutorial" }}
        </UiButton>
        <UiButton
          icon="sparkles"
          class="hero-cta"
          data-testid="create-adventure-toggle"
          aria-controls="create-adventure"
          :aria-expanded="createOpen"
          @click="bridge.openCreateSection()"
        >
          Create an adventure
        </UiButton>
      </div>
    </div>

    <figure class="continue" data-testid="home-continue">
      <div class="continue-screen">
        <img
          v-if="last?.screen"
          :src="last.screen"
          :alt="`${last.title}, current screen in room ${last.record.room}`"
        />
        <img
          v-else-if="!last && tutorialScreen"
          :src="tutorialScreen"
          :alt="`${featuredCatalog.title} opening scene`"
        />
        <div v-else class="continue-empty" aria-hidden="true"></div>
      </div>
      <figcaption class="continue-meta">
        <div class="continue-text">
          <strong>{{ last ? last.title : featuredCatalog.title }}</strong>
          <span v-if="last">
            Room {{ last.record.room }} · played {{ formatRelativeTime(last.record.savedAt, now) }}
          </span>
          <span v-else>{{ featuredCatalog.description }}</span>
        </div>
        <UiChip v-if="last" tone="ok" dot>Autosaved</UiChip>
        <UiChip v-else>Tutorial</UiChip>
      </figcaption>
    </figure>
  </section>
</template>

<style scoped>
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: var(--space-9);
  align-items: center;
  padding: var(--space-6) 0 0;
}
.hero h1 {
  margin: 0 0 var(--space-4);
  color: var(--ink);
  font: 800 var(--text-display) / 1 var(--font-mono);
  letter-spacing: 0.02em;
  text-shadow: 0 0 24px var(--action-soft);
}
.hero h1 span {
  color: var(--action);
}
.hero-line {
  max-width: 34rem;
  margin: 0 0 var(--space-7);
  color: var(--ink-2);
  font-size: var(--text-lg);
  line-height: var(--leading);
}
.hero-line a {
  color: inherit;
  text-decoration-color: var(--hairline-strong);
  text-underline-offset: 3px;
}
.hero-line a:hover {
  color: var(--action-hover);
  text-decoration-color: currentColor;
}
.hero-ctas {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
/* A long game title wraps inside the button rather than widening the page. */
.hero-cta {
  max-width: 100%;
  white-space: normal;
  text-align: left;
}
.continue {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  background: var(--surface-1);
}
.continue-screen {
  aspect-ratio: 8 / 5;
  background: var(--agi-0);
}
.continue-screen img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  image-rendering: pixelated;
}
.continue-empty {
  height: 100%;
  background: linear-gradient(145deg, var(--surface-2), var(--surface-sunken));
}
.continue-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
}
.continue-text {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-0);
}
.continue-text strong {
  color: var(--ink);
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
}
.continue-text span {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
@media (max-width: 860px) {
  .hero {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-7);
    padding: var(--space-3) 0 0;
  }
}
</style>
