<script setup lang="ts">
/**
 * A game stored in this browser's library: its progress or opening, one line
 * of detail, Play or Resume, and a ⋯ menu with the library's actions (rename,
 * copy, interpreter, details, download, export, remove). With `featured`, the
 * card is also that catalog release's only card on the shelf (the tutorial):
 * it keeps the catalog card's test ids and badge.
 */
import { computed } from "vue";
import ActionMenu from "../ActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import GameCard, { type CardImage } from "./GameCard.vue";
import StartFresh from "./StartFresh.vue";
import { libraryDetails, showDetails } from "./cardDetails.ts";
import { projectThumbnail } from "./useLazyThumbnail.ts";
import { useProjectRecovery } from "./projectRecovery.ts";
import { formatRelativeTime } from "./relativeTime.ts";
import { useNow } from "./useNow.ts";
import { useGameLibrary } from "../useGameLibrary.ts";
import { useShellBridge } from "../shellBridge.ts";
import { hasWalkthrough } from "../walkthrough.ts";
import { describeGameProfile } from "../profileChoice.ts";
import type { CachedGameMeta } from "../gameStorage.ts";
import type { GameCatalogEntry } from "../gameCatalog.ts";

const {
  game,
  featured = undefined,
  featuredMeta = undefined,
} = defineProps<{
  game: CachedGameMeta;
  featured?: GameCatalogEntry | undefined;
  /** The featured card's line when there is no progress to report. */
  featuredMeta?: string | undefined;
}>();

const {
  selectedProjectId,
  renaming,
  gameTitle,
  renameError,
  libraryAutosaves,
  libraryActionBusy,
  importBusy,
  exportBusy,
  selectLibraryGame,
  beginRename,
  setTitleInput,
  saveGameTitle,
  libraryProvenance,
  onPlayLibraryGame,
  onStartLibraryGameOver,
  onCheckLibraryGame,
  onCopyLibraryGame,
  onExportLibraryGame,
  onRemoveLibraryGame,
  openLibraryProfileChoice,
} = useGameLibrary();
const bridge = useShellBridge();
const { isUnreadable, playGuarded } = useProjectRecovery();
const now = useNow();

const autosave = computed(() => libraryAutosaves.value[game.projectId]);
const editing = computed(() => renaming.value && selectedProjectId.value === game.projectId);

const image = computed<CardImage | undefined>(() => {
  if (autosave.value?.preview)
    return {
      src: autosave.value.preview,
      alt: `${game.title}, current progress in room ${autosave.value.room}`,
      kind: "progress",
    };
  const opening = game.library?.preview;
  return opening
    ? { src: opening, alt: `${game.title} opening scene`, kind: "opening" }
    : undefined;
});

const meta = computed(() =>
  autosave.value
    ? `Room ${autosave.value.room} · played ${formatRelativeTime(autosave.value.savedAt, now.value)}`
    : ((featured ? undefined : libraryProvenance(game)) ?? featuredMeta ?? "Not played yet"),
);

const badge = computed(() => {
  if (featured) return "Tutorial";
  const source = game.library?.source;
  return source === "remix" ? "Remix" : !source || source === "authored" ? "Yours" : undefined;
});

const playLabel = computed(() => (autosave.value ? "Resume" : featured ? "Play now" : "Play"));

/** Initials stand in for a screen that cannot be shown. */
const monogram = computed(
  () =>
    game.title
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((word) => word[0])
      .join("")
      .slice(0, 4)
      .toUpperCase() || "AGI",
);

function play(): void {
  void playGuarded(game.projectId, () => onPlayLibraryGame(game));
}

function openDetails(): void {
  selectLibraryGame(game);
  showDetails(libraryDetails(game));
}
</script>

<template>
  <GameCard
    :title="game.title"
    title-test-id="saved-game-title"
    :monogram
    :image
    :lazy="projectThumbnail(game)"
    :lazy-alt="`${game.title} opening scene`"
    :badge
    :meta
    :heading-hidden="editing"
    :play-label="isUnreadable(game.projectId) ? undefined : playLabel"
    :play-disabled="libraryActionBusy || importBusy"
    :class="{ selected: selectedProjectId === game.projectId }"
    :data-testid="featured ? `catalog-${featured.id}` : `saved-game-card-${game.projectId}`"
    :data-project-id="game.projectId"
    @play="play"
  >
    <form
      v-if="editing"
      class="game-rename"
      data-testid="rename-game-form"
      @submit.prevent="saveGameTitle"
    >
      <label :for="`game-title-${game.projectId}`">Game name</label>
      <input
        :id="`game-title-${game.projectId}`"
        :ref="setTitleInput"
        v-model="gameTitle"
        maxlength="100"
        required
        @keydown.esc="renaming = false"
      />
      <div class="game-rename__actions">
        <UiButton type="submit" size="sm" :disabled="!gameTitle.trim()">Save name</UiButton>
        <UiButton size="sm" variant="ghost" @click="renaming = false">Cancel</UiButton>
      </div>
      <p v-if="renameError" role="alert" class="game-card__alert">{{ renameError }}</p>
    </form>
    <StartFresh
      v-if="isUnreadable(game.projectId)"
      :project-id="game.projectId"
      :title="game.title"
    />
    <template v-if="!isUnreadable(game.projectId)" #actions>
      <UiButton
        class="game-card__actions-main"
        :data-testid="featured ? `catalog-play-${featured.id}` : 'btn-resume-cached'"
        :disabled="libraryActionBusy || importBusy"
        @click="play"
      >
        {{ playLabel }}
      </UiButton>
      <ActionMenu
        label="Game actions"
        icon="ellipsis"
        icon-only
        :test-id="featured ? `game-actions-${featured.id}` : `game-actions-${game.projectId}`"
      >
        <button
          v-if="hasWalkthrough(game.library?.revision ?? '')"
          type="button"
          role="menuitem"
          data-testid="run-walkthrough"
          @click="bridge.startWalkthrough(game.library?.revision ?? game.projectId)"
        >
          <span>Run walkthrough<small>Watch real-time playthrough</small></span>
        </button>
        <slot name="menu" />
        <button
          v-if="autosave"
          type="button"
          role="menuitem"
          data-testid="start-library-game-over"
          @click="onStartLibraryGameOver(game)"
        >
          Start over
        </button>
        <button
          v-if="game.library?.validation.status === 'unverified'"
          type="button"
          role="menuitem"
          data-testid="check-library-game"
          :disabled="libraryActionBusy"
          @click="onCheckLibraryGame(game)"
        >
          Check opening
        </button>
        <button type="button" role="menuitem" data-testid="rename-game" @click="beginRename(game)">
          Rename…
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="copy-library-game"
          :disabled="libraryActionBusy"
          @click="onCopyLibraryGame(game)"
        >
          Make a copy
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="interpreter-profile-menu-item"
          @click="openLibraryProfileChoice(game)"
        >
          <span
            >Interpreter profile<small>{{ describeGameProfile(game) }}</small></span
          >
        </button>
        <button type="button" role="menuitem" data-testid="game-details-item" @click="openDetails">
          Details…
        </button>
        <div role="separator"></div>
        <button
          type="button"
          role="menuitem"
          data-testid="download-library-game"
          :disabled="exportBusy"
          @click="onExportLibraryGame(game, true)"
        >
          <span
            >Download game…<small
              >For development: editing work, saved progress and history — a ZIP file</small
            ></span
          >
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="export-library-game"
          :disabled="exportBusy"
          @click="onExportLibraryGame(game)"
        >
          <span
            >Export game…<small
              >For publishing: playable game without private editing work or play history — a ZIP
              file</small
            ></span
          >
        </button>
        <div role="separator"></div>
        <button
          type="button"
          role="menuitem"
          class="danger"
          data-testid="remove-library-game"
          @click="onRemoveLibraryGame(game)"
        >
          Remove game
        </button>
      </ActionMenu>
    </template>
  </GameCard>
</template>

<style scoped>
.selected {
  border-color: var(--action-line);
}
.game-rename {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.game-rename label {
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.game-rename input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--surface-sunken);
  font: inherit;
}
.game-rename__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
