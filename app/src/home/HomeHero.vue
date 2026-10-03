<script setup lang="ts">
/**
 * The top of the Home screen: the wordmark, one line about the app and two
 * calls to action, beside a "Continue" card. With an autosave for the last
 * game played, the primary action continues it and the card shows its
 * current screen from the autosave's preview; otherwise the primary action
 * plays the tutorial and the card shows the tutorial's opening screen.
 * When the last game ended by quitting, one line says so, with Play again and,
 * if it saved progress before the quit, Continue — which is the primary
 * action already when that game is the one the card shows.
 */
import { computed } from "vue";
import BootCard from "../ui/BootCard.vue";
import UiButton from "../ui/UiButton.vue";
import UiChip from "../ui/UiChip.vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { useAiSettings } from "../settings/useAiSettings.ts";
import OlderPositionChoice from "./OlderPositionChoice.vue";
import { useGameLibrary, type LibraryProgress } from "../library/useGameLibrary.ts";
import { useShellBridge } from "../shell/shellBridge.ts";
import { gameStorageKey, type InstalledGameDescriptor } from "../project/gameTypes.ts";
import type { CachedGameMeta } from "../project/gameStorage.ts";
import { installedProgressTarget, type ProgressTarget } from "../project/progressTarget.ts";
import { getKnownGameByRevision } from "../../../src/games/knownGames.ts";
import { catalogProjectId, useProjectRecovery } from "./projectRecovery.ts";
import { shelfTitle } from "./shelfIdentity.ts";
import { formatRelativeTime } from "./relativeTime.ts";
import { useNow } from "./useNow.ts";

const { createOpen } = defineProps<{ createOpen: boolean }>();
const { state, resumeAudio, startOver } = useEngineApi();
const { llmConfig } = useAiSettings();
const {
  pendingAutosave,
  pendingProgressTarget,
  savedGames,
  savedProgress,
  installedProgress,
  featuredCatalog,
  catalogEntries,
  catalogOpenings,
  catalogBusy,
  libraryActionBusy,
  importBusy,
  onResumeAutosave,
  onPlayLocalGame,
  onPlayLibraryGame,
  onStartLibraryGameOver,
  playCatalogGame,
} = useGameLibrary();
const bridge = useShellBridge();
const { playGuarded } = useProjectRecovery();
const now = useNow();

/**
 * The last game played, when its proven pending offer is still current. The
 * offer's own target names the domain: a project locator resolves to the
 * saved entry of that id, an installed locator to the served folder whose
 * descriptor binds that exact address. A same-spelled entry from the other
 * domain lends nothing — no title, no preview.
 */
const last = computed(() => {
  const record = pendingAutosave.value;
  const target = pendingProgressTarget.value;
  if (!record || !target) return undefined;
  const saved =
    target.kind === "project"
      ? savedGames.value.find((game) => game.projectId === target.project)
      : undefined;
  const installed =
    target.kind === "installed"
      ? (state.installedGames ?? []).find(
          (game) =>
            game.revision !== undefined &&
            installedProgressTarget(game, game.revision)?.locator === target.locator,
        )
      : undefined;
  return {
    record,
    title:
      (saved ? shelfTitle(saved, catalogEntries.value) : undefined) ??
      installed?.title ??
      getKnownGameByRevision(record.game.identity.revision)?.title ??
      record.game.identity.project,
    screen: record.preview ?? saved?.library?.preview,
  };
});

/**
 * The game that just quit, matched to its exact instance. A note carrying
 * the run's physical binding resolves by domain — a project locator to the
 * saved entry of that id, an installed locator to the served descriptor
 * whose own bound target is the same address — so a same-spelled entry in
 * the other domain never answers for it. A note with no binding resolves a
 * spelling only when exactly one domain claims it; a contested spelling is
 * nobody's.
 */
const ended = computed(() => {
  const note = state.gameEnded;
  if (!note) return undefined;
  const binding = note.progressTarget;
  let game: CachedGameMeta | undefined;
  let installed: InstalledGameDescriptor | undefined;
  if (binding?.kind === "project") {
    // Only the note's own incarnation may lend its card, title and
    // actions: a ready saved target bound to this exact locator and full
    // identity. A same-id body on another epoch or another revision — a
    // removed and recreated project — leaves the note informational.
    const candidate = savedGames.value.find((entry) => entry.projectId === binding.project);
    const progress = candidate === undefined ? undefined : savedProgress(candidate.projectId);
    if (
      progress?.status === "ready" &&
      progress.target.locator === binding.locator &&
      progress.target.identity.project === binding.identity.project &&
      progress.target.identity.revision === binding.identity.revision
    )
      game = candidate;
  } else if (binding?.kind === "installed") {
    installed = (state.installedGames ?? []).find(
      (entry) =>
        entry.revision !== undefined &&
        installedProgressTarget(entry, entry.revision)?.locator === binding.locator &&
        installedProgressTarget(entry, entry.revision)?.identity.revision ===
          binding.identity.revision,
    );
  } else {
    const saved = savedGames.value.find((entry) => entry.projectId === note.projectId);
    const local = (state.installedGames ?? []).find(
      (entry) => gameStorageKey({ installed: true, ...entry }) === note.projectId,
    );
    if (local === undefined) game = saved;
    else if (saved === undefined) installed = local;
  }
  const progress = game
    ? savedProgress(game.projectId)
    : installed !== undefined
      ? installedProgress(installed)
      : undefined;
  return {
    source: note,
    title: game ? shelfTitle(game, catalogEntries.value) : (installed?.title ?? note.title),
    game,
    installed,
    binding,
    playable: game !== undefined || installed !== undefined,
    saved: progress?.status === "ready" && progress.autosave !== null,
    continued: binding !== undefined && pendingProgressTarget.value?.locator === binding.locator,
  };
});

/**
 * Whether a live progress read still binds the quit note's own physical
 * target — exact locator plus full identity. A same-id body rebound to
 * another epoch, or the same epoch serving another revision, is a
 * different instance and answers false.
 */
function bindsNote(progress: LibraryProgress | undefined, binding: ProgressTarget): boolean {
  return (
    progress?.status === "ready" &&
    progress.target.locator === binding.locator &&
    progress.target.identity.project === binding.identity.project &&
    progress.target.identity.revision === binding.identity.revision
  );
}

/** The exact quit note owns its parked action until it leaves the surface. */
function ownsAction(note: { readonly source: object }): () => boolean {
  return () => ended.value?.source === note.source;
}

/** Play again starts over: a fresh boot, past any progress saved before the quit. */
function playAgain(): void {
  const note = ended.value;
  if (!note) return;
  const { game, installed, binding } = note;
  const isCurrent = ownsAction(note);
  if (game)
    void playGuarded(game.projectId, async () => {
      // The note's captured binding is re-proven at dispatch and again
      // after the audio wait, and the note itself must still be the one on
      // show: a stale or departed quit note can never clear or boot the
      // body recreated under the same id.
      if (!isCurrent()) return;
      if (binding !== undefined && !bindsNote(savedProgress(game.projectId), binding)) return;
      if (!note.saved) {
        if (binding !== undefined) await resumeAudio();
        if (!isCurrent()) return;
        if (binding !== undefined && !bindsNote(savedProgress(game.projectId), binding)) return;
        await onPlayLibraryGame(game, binding, isCurrent);
        return;
      }
      if (binding === undefined) {
        await onStartLibraryGameOver(game, isCurrent);
        return;
      }
      await resumeAudio();
      if (!isCurrent()) return;
      const progress = savedProgress(game.projectId);
      if (progress.status !== "ready" || !bindsNote(progress, binding)) return;
      await startOver(progress.target.locator, llmConfig());
    });
  else if (installed) {
    const progress = installedProgress(installed);
    if (note.saved && progress.status === "ready") {
      void (async () => {
        await resumeAudio();
        if (!isCurrent()) return;
        // The live descriptor for the binding's own folder — the card the
        // note captured may have been replaced while audio waited, and only
        // the descriptor serving now can answer the note's exact target.
        const current =
          binding?.kind === "installed"
            ? (state.installedGames ?? []).find((entry) => entry.folder === binding.folder)
            : installed;
        if (current === undefined) return;
        const live = installedProgress(current);
        if (live.status !== "ready") return;
        if (binding !== undefined && !bindsNote(live, binding)) return;
        await startOver(live.target.locator, llmConfig());
      })();
    } else void onPlayLocalGame(installed.folder ?? installed.hash, binding, isCurrent);
  }
}

function continueEnded(): void {
  const note = ended.value;
  if (!note) return;
  const { game, installed, binding } = note;
  const isCurrent = ownsAction(note);
  if (game)
    void playGuarded(game.projectId, async () => {
      // The binding travels into the play path itself: after every awaited
      // bind and audio wait the live body must still be the exact instance
      // this note proved — a rebound epoch or replaced revision refuses —
      // and the note itself must still be the one on show.
      if (!isCurrent()) return;
      if (binding !== undefined && !bindsNote(savedProgress(game.projectId), binding)) return;
      await onPlayLibraryGame(game, binding, isCurrent);
    });
  else if (installed) {
    if (!isCurrent()) return;
    if (binding !== undefined && !bindsNote(installedProgress(installed), binding)) return;
    void onPlayLocalGame(installed.folder ?? installed.hash, binding, isCurrent);
  }
}

const tutorialScreen = computed(
  () => catalogOpenings.value[featuredCatalog.id]?.preview ?? featuredCatalog.preview,
);

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
      <!-- The wordmark in the interpreter's own font; the heading's text is
           for assistive tech and search, the boot card for the eye. -->
      <h1 id="welcome-title" class="hero-title">
        <BootCard class="hero-boot" /><span class="hero-title__text">AGI IS HERE.</span>
      </h1>
      <p class="hero-line">
        Play Sierra-style adventures. Build your own with the game running beside you, in the
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
          Make a new game
        </UiButton>
      </div>
      <OlderPositionChoice hero />
      <p v-if="ended" class="hero-ended" role="status" data-testid="game-ended">
        <span
          ><strong>{{ ended.title }}</strong> · The game ended (it quit).</span
        >
        <template v-if="ended.playable">
          <UiButton
            size="sm"
            variant="ghost"
            data-testid="game-ended-play-again"
            :disabled="libraryActionBusy || importBusy"
            @click="playAgain"
          >
            Play again
          </UiButton>
          <UiButton
            v-if="ended.saved && !ended.continued"
            size="sm"
            variant="ghost"
            data-testid="game-ended-continue"
            :disabled="libraryActionBusy || importBusy"
            @click="continueEnded"
          >
            Continue
          </UiButton>
        </template>
      </p>
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
.hero-title {
  margin: 0 0 var(--space-6);
  line-height: 0;
}
/* Visually hidden, still the heading's accessible name. */
.hero-title__text {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
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
.hero-ended {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin: var(--space-5) 0 0;
  color: var(--ink-2);
  font-size: var(--text-sm);
}
.hero-ended strong {
  color: var(--ink);
  font-weight: var(--weight-semibold);
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
