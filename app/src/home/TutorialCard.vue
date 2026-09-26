<script setup lang="ts">
/**
 * The bundled tutorial: its only card on the Home shelf. Once Play has stored
 * the release in the library, the card is that library copy (progress,
 * Resume, the full ⋯ menu) under the tutorial's test ids and badge; before
 * that it is the catalog entry, whose opening loads with the catalog on mount.
 * An installed development copy of the tutorial folds in as a ⋯ menu item,
 * and so does a copy of an earlier release a player still has stored ("Continue
 * your 1.0 save", or remove it after a confirmation): the card itself is
 * always the current release.
 */
import { computed, nextTick, ref, useTemplateRef } from "vue";
import ActionMenu from "../ActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import GameCard from "./GameCard.vue";
import SavedGameCard from "./SavedGameCard.vue";
import StartFresh from "./StartFresh.vue";
import { catalogDetails, showDetails } from "./cardDetails.ts";
import {
  catalogLibraryCopy,
  isInstalledCatalogCopy,
  otherReleaseCopies,
  releaseName,
} from "./shelfIdentity.ts";
import { formatRelativeTime } from "./relativeTime.ts";
import { useNow } from "./useNow.ts";
import type { CachedGameMeta } from "../gameStorage.ts";
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
  libraryAutosaves,
  importBusy,
  onPlayLocalGame,
  onPlayLibraryGame,
  onRemoveLibraryGame,
} = useGameLibrary();
const now = useNow();
const { isUnreadable, playGuarded } = useProjectRecovery();
const storedAs = catalogProjectId(entry);
const play = useTemplateRef("play");

const saved = computed(() => catalogLibraryCopy(savedGames.value, entry));
const installedCopies = computed(() =>
  localGames.value.filter((game) => isInstalledCatalogCopy(game, entry)),
);
/** Earlier releases a player still has stored, each resumed from the ⋯ menu. */
const earlierReleases = computed(() =>
  otherReleaseCopies(savedGames.value, entry).map((game) => {
    const version = game.library!.catalog!.version;
    const autosave = libraryAutosaves.value[game.projectId];
    return {
      game,
      version,
      name: releaseName(version),
      label: `Continue your ${releaseName(version)} save`,
      detail: autosave
        ? `Room ${autosave.room} · played ${formatRelativeTime(autosave.savedAt, now.value)}`
        : `${entry.title} ${version}`,
    };
  }),
);

function continueRelease(game: CachedGameMeta): void {
  void playGuarded(game.projectId, () => onPlayLibraryGame(game));
}

/** The earlier release whose removal is being confirmed. */
const removing = ref<{ game: CachedGameMeta; name: string }>();
const removeOpen = computed({
  get: () => removing.value !== undefined,
  set: (open) => {
    if (!open) removing.value = undefined;
  },
});
const removeBusy = ref(false);
const removeError = ref("");

function askRemove(game: CachedGameMeta): void {
  removeError.value = "";
  removing.value = { game, name: releaseName(game.library!.catalog!.version) };
}

/** Remove that project only, through the library's own delete path; its remixes stay. */
async function confirmRemove(): Promise<void> {
  const target = removing.value;
  if (!target) return;
  removeBusy.value = true;
  removeError.value = "";
  try {
    await onRemoveLibraryGame(target.game);
    removing.value = undefined;
  } catch (reason) {
    removeError.value = String(reason).replace(/^Error: /, "");
  } finally {
    removeBusy.value = false;
  }
}

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
      <template v-for="release in earlierReleases" :key="release.game.projectId">
        <button
          type="button"
          role="menuitem"
          :data-testid="`continue-release-${release.version}`"
          :disabled="libraryActionBusy || importBusy"
          @click="continueRelease(release.game)"
        >
          <span
            >{{ release.label }}<small>{{ release.detail }}</small></span
          >
        </button>
        <button
          type="button"
          role="menuitem"
          class="danger"
          :data-testid="`remove-release-${release.version}`"
          :disabled="libraryActionBusy || importBusy"
          @click="askRemove(release.game)"
        >
          Remove your {{ release.name }} save…
        </button>
      </template>
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
        <template v-for="release in earlierReleases" :key="release.game.projectId">
          <button
            type="button"
            role="menuitem"
            :data-testid="`continue-release-${release.version}`"
            :disabled="libraryActionBusy || importBusy"
            @click="continueRelease(release.game)"
          >
            <span
              >{{ release.label }}<small>{{ release.detail }}</small></span
            >
          </button>
          <button
            type="button"
            role="menuitem"
            class="danger"
            :data-testid="`remove-release-${release.version}`"
            :disabled="libraryActionBusy || importBusy"
            @click="askRemove(release.game)"
          >
            Remove your {{ release.name }} save…
          </button>
        </template>
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
  <UiDialog
    v-model:open="removeOpen"
    :title="`Remove your ${removing?.name ?? ''} save?`"
    size="sm"
    data-testid="remove-release-dialog"
  >
    <p class="remove-release__copy">
      Your copy of {{ entry.title }} {{ removing?.name }} and its progress will be removed from this
      browser. Remixes you made from it stay in your games.
    </p>
    <p class="remove-release__copy">Games you exported or downloaded as files are not affected.</p>
    <p v-if="removeError" class="remove-release__error" role="alert">{{ removeError }}</p>
    <template #footer>
      <UiButton data-testid="remove-release-cancel" @click="removeOpen = false">Cancel</UiButton>
      <UiButton
        variant="danger"
        data-testid="remove-release-confirm"
        :disabled="removeBusy"
        @click="confirmRemove"
      >
        Remove
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.remove-release__copy {
  margin: 0 0 var(--space-4);
  color: var(--ink-2);
}
.remove-release__error {
  margin: 0;
  color: var(--danger);
  font-size: var(--text-sm);
}
</style>
