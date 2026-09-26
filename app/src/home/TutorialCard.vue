<script setup lang="ts">
/**
 * The bundled tutorial: its only card on the Home shelf. Once Play has stored
 * the release in the library, the card is that library copy (progress,
 * Resume, the full ⋯ menu) under the tutorial's test ids and badge; before
 * that it is the catalog entry, whose opening loads with the catalog on mount.
 * An installed development copy of the tutorial folds in as a ⋯ menu item.
 */
import { computed, nextTick, useTemplateRef } from "vue";
import ActionMenu from "../ActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import GameCard from "./GameCard.vue";
import SavedGameCard from "./SavedGameCard.vue";
import StartFresh from "./StartFresh.vue";
import { catalogDetails, showDetails } from "./cardDetails.ts";
import { catalogLibraryCopy, isInstalledCatalogCopy } from "./shelfIdentity.ts";
import { useGameLibrary } from "../useGameLibrary.ts";
import { hasWalkthrough } from "../walkthrough.ts";
import { catalogProjectId, useProjectRecovery } from "./projectRecovery.ts";

/** Adventure Department's rooms (games/adventure-department). */
const TUTORIAL_META = "Tutorial · 3 rooms";

const {
  featuredCatalog: entry,
  savedGames,
  catalogOpenings,
  catalogErrors,
  catalogBusy,
  libraryActionBusy,
  libraryActionError,
  cachedMeta,
  loadCatalogOpening,
  playCatalogGame,
  playCatalogWalkthrough,
  localGames,
  localAutosave,
  importBusy,
  onPlayLocalGame,
} = useGameLibrary();
const { isUnreadable, playGuarded } = useProjectRecovery();
const storedAs = catalogProjectId(entry);
const play = useTemplateRef("play");

const saved = computed(() => catalogLibraryCopy(savedGames.value, entry));
const installedCopies = computed(() =>
  localGames.value.filter((game) => isInstalledCatalogCopy(game, entry)),
);
const image = computed(() => {
  const src = catalogOpenings.value[entry.id]?.preview;
  return src ? { src, alt: `${entry.title} opening scene`, kind: "opening" as const } : undefined;
});
const busy = computed(() => catalogBusy.value[entry.id] === true || libraryActionBusy.value);

function onPlay(): void {
  void playGuarded(storedAs, () => playCatalogGame(entry.id));
}

async function focusPlay(): Promise<void> {
  await nextTick();
  (play.value?.$el as HTMLElement | undefined)?.focus();
}
</script>

<template>
  <SavedGameCard v-if="saved" :game="saved" :featured="entry" :featured-meta="TUTORIAL_META">
    <template #menu>
      <button
        v-for="game in installedCopies"
        :key="`local-${game.hash}`"
        type="button"
        role="menuitem"
        :data-hash="game.hash"
        :data-alias="game.alias"
        :data-testid="`boot-${game.folder || game.alias || game.hash}`"
        :disabled="libraryActionBusy || importBusy"
        @click="onPlayLocalGame(game.folder ?? game.hash)"
      >
        <span
          >{{ localAutosave(game) ? "Resume" : "Play" }} installed copy<small>{{
            game.folder ?? game.alias
          }}</small></span
        >
      </button>
    </template>
  </SavedGameCard>
  <GameCard
    v-else
    :title="entry.title"
    monogram="AGI"
    :image
    :pending="!catalogErrors[entry.id]"
    badge="Tutorial"
    :meta="TUTORIAL_META"
    :play-label="isUnreadable(storedAs) || catalogErrors[entry.id] ? undefined : 'Play'"
    :play-disabled="busy"
    :data-testid="`catalog-${entry.id}`"
    @play="onPlay"
  >
    <StartFresh
      v-if="isUnreadable(storedAs)"
      :project-id="storedAs!"
      :title="entry.title"
      @cleared="focusPlay"
    />
    <p v-else-if="catalogErrors[entry.id]" role="alert" class="game-card__alert">
      {{ catalogErrors[entry.id] }}
    </p>
    <p v-else-if="libraryActionError && !cachedMeta" role="alert" class="game-card__alert">
      {{ libraryActionError }}
    </p>
    <template v-if="!isUnreadable(storedAs)" #actions>
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
        ref="play"
        class="game-card__actions-main"
        :data-testid="`catalog-play-${entry.id}`"
        :disabled="busy"
        @click="onPlay"
      >
        {{ catalogBusy[entry.id] ? "Checking opening…" : "Play now" }}
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
          :disabled="busy"
          @click="playCatalogWalkthrough(entry.id)"
        >
          <span>Run walkthrough<small>Watch real-time playthrough</small></span>
        </button>
        <button
          v-for="game in installedCopies"
          :key="`local-${game.hash}`"
          type="button"
          role="menuitem"
          :data-hash="game.hash"
          :data-alias="game.alias"
          :data-testid="`boot-${game.folder || game.alias || game.hash}`"
          :disabled="libraryActionBusy || importBusy"
          @click="onPlayLocalGame(game.folder ?? game.hash)"
        >
          <span
            >{{ localAutosave(game) ? "Resume" : "Play" }} installed copy<small>{{
              game.folder ?? game.alias
            }}</small></span
          >
        </button>
        <button type="button" role="menuitem" @click="showDetails(catalogDetails(entry))">
          Details…
        </button>
      </ActionMenu>
    </template>
  </GameCard>
</template>
