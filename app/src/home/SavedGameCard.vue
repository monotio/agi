<script setup lang="ts">
/**
 * A game stored in this browser's library: its progress or opening, one line
 * of detail, Play or Resume, and a ⋯ menu with the library's actions (rename,
 * copy, interpreter, details, download, export, remove). With `featured`, the
 * card is also that catalog release's only card on the shelf (the tutorial):
 * it keeps the catalog card's test ids and badge.
 */
import { computed, ref, useTemplateRef } from "vue";
import ActionMenu from "../ui/ActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import GameCard, { type CardImage } from "./GameCard.vue";
import RemoveGameDialog from "./RemoveGameDialog.vue";
import StartFresh from "./StartFresh.vue";
import { libraryDetails, showDetails } from "./cardDetails.ts";
import { shelfTitle } from "./shelfIdentity.ts";
import { projectThumbnail } from "./useLazyThumbnail.ts";
import { useProjectRecovery } from "./projectRecovery.ts";
import { formatRelativeTime } from "./relativeTime.ts";
import { useNow } from "./useNow.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";
import { readMapSidecar } from "../world/roomMapStore.ts";
import { useShellBridge } from "../shell/shellBridge.ts";
import { hasWalkthrough } from "../walkthrough/walkthrough.ts";
import { describeGameProfile } from "../library/profileChoice.ts";
import type { CachedGameMeta } from "../project/gameStorage.ts";
import type { GameCatalogEntry } from "../library/gameCatalog.ts";

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
  catalogEntries,
  savedProgress,
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

/**
 * This card's own progress: the bound physical target plus the record read
 * under its locator. Pending and unbound states keep the opening — a card
 * never borrows another game's progress through a shared id or spelling.
 */
const progress = computed(() => savedProgress(game.projectId));
const autosave = computed(() =>
  progress.value.status === "ready" ? (progress.value.autosave ?? undefined) : undefined,
);
const editing = computed(() => renaming.value && selectedProjectId.value === game.projectId);

/** A copy of a release the catalog no longer carries is titled with its release. */
const title = computed(() => shelfTitle(game, catalogEntries.value));

const image = computed<CardImage | undefined>(() => {
  if (autosave.value?.preview)
    return {
      src: autosave.value.preview,
      alt: `${title.value}, current progress in room ${autosave.value.room}`,
      kind: "progress",
    };
  const opening = game.library?.preview;
  return opening
    ? { src: opening, alt: `${title.value} opening scene`, kind: "opening" }
    : undefined;
});

/**
 * A game played without an autosave to show for it (a 1.0 copy, say) still
 * has its room journal: the last room it reached. Unreadable map data says
 * nothing either way.
 */
function lastJournalRoom(): number | undefined {
  const current = progress.value;
  // The journal lives under the bound physical locator — never the bare
  // project id — so a card with no ready target has no map to read.
  if (current.status !== "ready") return undefined;
  try {
    return readMapSidecar(localStorage, current.target.locator).journal.at(-1)?.to;
  } catch {
    return undefined;
  }
}

const meta = computed(() => {
  if (autosave.value)
    return `Room ${autosave.value.room} · played ${formatRelativeTime(autosave.value.savedAt, now.value)}`;
  const provenance = (featured ? undefined : libraryProvenance(game)) ?? featuredMeta;
  if (provenance) return provenance;
  const room = lastJournalRoom();
  return room === undefined ? "Not played yet" : `Played before · last in room ${room}`;
});

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

/** Remove game deletes everything stored for the game: it asks first. */
const confirmRemove = ref(false);

const card = useTemplateRef("card");

/** Return dialog focus to this card's action menu. */
function menuTrigger(): HTMLElement | null {
  const root = card.value?.$el;
  return root instanceof HTMLElement
    ? root.querySelector<HTMLElement>("[data-testid^='game-actions-']")
    : null;
}

async function remove(): Promise<void> {
  confirmRemove.value = false;
  await onRemoveLibraryGame(game);
}

function openDetails(): void {
  selectLibraryGame(game);
  showDetails(libraryDetails(game, { returnFocus: menuTrigger() ?? undefined }));
}
</script>

<template>
  <GameCard
    ref="card"
    :title
    title-test-id="saved-game-title"
    :monogram
    :image
    :lazy="projectThumbnail(game)"
    :lazy-alt="`${title} opening scene`"
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
    <StartFresh v-if="isUnreadable(game.projectId)" :project-id="game.projectId" :title />
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
          v-if="game.library?.source !== 'catalog'"
          type="button"
          role="menuitem"
          data-testid="edit-library-game"
          @click="bridge.openLogicProject(game.projectId)"
        >
          <span>Edit<small>Open in Logic Studio</small></span>
        </button>
        <button
          v-if="game.library?.source !== 'catalog'"
          type="button"
          role="menuitem"
          data-testid="edit-library-game-sound"
          @click="bridge.openSoundProject(game.projectId)"
        >
          <span>Sound Studio<small>Edit sounds</small></span>
        </button>
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
          <span>Download game…<small>The whole project: edits, saves and history</small></span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="export-library-game"
          :disabled="exportBusy"
          @click="onExportLibraryGame(game)"
        >
          <span>Export game…<small>The playable game, ready to share</small></span>
        </button>
        <div role="separator"></div>
        <button
          type="button"
          role="menuitem"
          class="danger"
          data-testid="remove-library-game"
          @click="confirmRemove = true"
        >
          Remove game…
        </button>
      </ActionMenu>
      <RemoveGameDialog
        v-model:open="confirmRemove"
        :title
        :download-disabled="exportBusy"
        @download="onExportLibraryGame(game, true)"
        @remove="remove"
      />
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
