<script setup lang="ts">
/**
 * The installed-fixture and hosted-catalog cards on the Home shelf: installed
 * games with their autosave state, and catalog entries whose openings load
 * through the shelf's bounded thumbnail queue once the cards come near the
 * viewport. An installed copy of the tutorial folds into the tutorial's card
 * (shelfIdentity.ts). All state comes from the injected shared library
 * controller.
 */
import ActionMenu from "./ActionMenu.vue";
import UiButton from "./ui/UiButton.vue";
import GameCard from "./home/GameCard.vue";
import StartFresh from "./home/StartFresh.vue";
import { installedThumbnail, type ThumbnailSource } from "./home/useLazyThumbnail.ts";
import { catalogProjectId, useProjectRecovery } from "./home/projectRecovery.ts";
import { catalogDetails, showDetails } from "./home/cardDetails.ts";
import { isInstalledCatalogCopy } from "./home/shelfIdentity.ts";
import { formatRelativeTime } from "./home/relativeTime.ts";
import { useNow } from "./home/useNow.ts";
import { computed } from "vue";
import { useEngineApi } from "./engineContext.ts";
import { useAiSettings } from "./useAiSettings.ts";
import { useGameLibrary } from "./useGameLibrary.ts";
import { useShellBridge } from "./shellBridge.ts";
import { hasWalkthrough } from "./walkthrough.ts";
import { gameStorageKey, type InstalledGameDescriptor } from "./gameTypes.ts";
import type { GameCatalogEntry } from "./gameCatalog.ts";

const { resumeAudio, startOver } = useEngineApi();
const { llmConfig } = useAiSettings();
const {
  featuredCatalog,
  localGames,
  localAutosave,
  availableCatalogEntries,
  catalogOpenings,
  catalogErrors,
  catalogBusy,
  libraryActionBusy,
  importBusy,
  onPlayLocalGame,
  loadCatalogOpening,
  playCatalogGame,
  playCatalogWalkthrough,
} = useGameLibrary();
const bridge = useShellBridge();
const { isUnreadable, playGuarded } = useProjectRecovery();
const now = useNow();

const shelfLocalGames = computed(() =>
  localGames.value.filter((game) => !isInstalledCatalogCopy(game, featuredCatalog)),
);

function localMeta(game: InstalledGameDescriptor): string {
  const autosave = localAutosave(game);
  if (autosave)
    return `Room ${autosave.room} · played ${formatRelativeTime(autosave.savedAt, now.value)}`;
  return game.folder && game.folder !== game.alias ? game.folder : "Installed game";
}

function localDetails(game: InstalledGameDescriptor): void {
  showDetails({
    title: game.title,
    rows: [
      ["By", game.author ?? ""],
      ["Folder", game.folder ?? ""],
    ].filter((row): row is [string, string] => Boolean(row[1])),
  });
}

function playLocal(game: InstalledGameDescriptor): void {
  void onPlayLocalGame(game.folder ?? game.hash);
}

function playHosted(entry: GameCatalogEntry): void {
  void playGuarded(catalogProjectId(entry), () => playCatalogGame(entry.id));
}

function onStartLocalGameOver(game: InstalledGameDescriptor): void {
  resumeAudio();
  startOver(gameStorageKey({ installed: true, ...game }), llmConfig());
}

function localImage(game: InstalledGameDescriptor) {
  const autosave = localAutosave(game);
  return autosave?.preview
    ? {
        src: autosave.preview,
        alt: `${game.title}, current progress in room ${autosave.room}`,
        kind: "progress" as const,
      }
    : undefined;
}

function catalogImage(entry: GameCatalogEntry) {
  const src = catalogOpenings.value[entry.id]?.preview;
  return src ? { src, alt: `${entry.title} opening scene`, kind: "opening" as const } : undefined;
}

/** The opening is the catalog's own check, run through the shelf's queue. */
function catalogThumbnail(entry: GameCatalogEntry): ThumbnailSource {
  return {
    key: `catalog:${entry.id}:${entry.version}`,
    async render() {
      await loadCatalogOpening(entry.id);
      const preview = catalogOpenings.value[entry.id]?.preview;
      if (!preview) throw new Error(catalogErrors.value[entry.id] ?? "No opening preview.");
      return preview;
    },
  };
}
</script>
<template>
  <GameCard
    v-for="game in shelfLocalGames"
    :key="`local-${game.hash}`"
    :title="game.title"
    :monogram="(game.alias || game.hash).slice(0, 8).toUpperCase()"
    :image="localImage(game)"
    :lazy="installedThumbnail(game)"
    :lazy-alt="`${game.title} opening scene`"
    :meta="localMeta(game)"
    :play-label="localAutosave(game) ? 'Resume' : 'Play'"
    :play-disabled="libraryActionBusy || importBusy"
    :data-testid="`local-game-card-${game.alias || game.folder || game.hash}`"
    @play="playLocal(game)"
  >
    <template #actions>
      <UiButton
        class="game-card__actions-main"
        :data-hash="game.hash"
        :data-alias="game.alias"
        :data-testid="`boot-${game.folder || game.alias || game.hash}`"
        :disabled="libraryActionBusy || importBusy"
        @click="playLocal(game)"
      >
        {{ localAutosave(game) ? "Resume" : "Play" }}
      </UiButton>
      <ActionMenu
        label="Game actions"
        icon="ellipsis"
        icon-only
        :test-id="`game-actions-${game.folder || game.alias || game.hash}`"
      >
        <button
          v-if="hasWalkthrough(game.revision ?? '')"
          type="button"
          role="menuitem"
          data-testid="run-walkthrough"
          @click="bridge.startWalkthrough(game.folder ?? game.hash)"
        >
          <span>Run walkthrough<small>Watch real-time playthrough</small></span>
        </button>
        <button
          v-if="localAutosave(game)"
          type="button"
          role="menuitem"
          @click="onStartLocalGameOver(game)"
        >
          Start over
        </button>
        <button type="button" role="menuitem" @click="localDetails(game)">Details…</button>
      </ActionMenu>
    </template>
  </GameCard>
  <GameCard
    v-for="entry in availableCatalogEntries"
    :key="`catalog-${entry.id}-${entry.version}`"
    :title="entry.title"
    monogram="AGI"
    :image="catalogImage(entry)"
    :lazy="catalogErrors[entry.id] ? undefined : catalogThumbnail(entry)"
    :pending="catalogBusy[entry.id] === true"
    :meta="entry.author ? `${entry.author} · ${entry.license}` : entry.license"
    :play-label="
      isUnreadable(catalogProjectId(entry)) || catalogErrors[entry.id] ? undefined : 'Play'
    "
    :play-disabled="catalogBusy[entry.id] || libraryActionBusy || importBusy"
    :data-testid="`hosted-game-card-${entry.id}`"
    @play="playHosted(entry)"
  >
    <StartFresh
      v-if="isUnreadable(catalogProjectId(entry))"
      :project-id="catalogProjectId(entry)!"
      :title="entry.title"
    />
    <p v-else-if="catalogErrors[entry.id]" role="alert" class="game-card__alert">
      {{ catalogErrors[entry.id] }}
    </p>
    <template v-if="!isUnreadable(catalogProjectId(entry))" #actions>
      <UiButton
        v-if="catalogErrors[entry.id]"
        class="game-card__actions-main"
        :disabled="catalogBusy[entry.id]"
        @click="loadCatalogOpening(entry.id)"
      >
        Retry preview
      </UiButton>
      <UiButton
        v-else
        class="game-card__actions-main"
        :disabled="catalogBusy[entry.id] || libraryActionBusy || importBusy"
        @click="playHosted(entry)"
      >
        {{ catalogBusy[entry.id] ? "Checking opening…" : "Play" }}
      </UiButton>
      <ActionMenu
        label="Game actions"
        icon="ellipsis"
        icon-only
        :test-id="`game-actions-${entry.id}`"
      >
        <button
          v-if="hasWalkthrough(entry.id)"
          type="button"
          role="menuitem"
          data-testid="catalog-run-walkthrough"
          :disabled="catalogBusy[entry.id] || libraryActionBusy || importBusy"
          @click="playCatalogWalkthrough(entry.id)"
        >
          <span>Run walkthrough<small>Watch real-time playthrough</small></span>
        </button>
        <button type="button" role="menuitem" @click="showDetails(catalogDetails(entry))">
          Details…
        </button>
      </ActionMenu>
    </template>
  </GameCard>
</template>
