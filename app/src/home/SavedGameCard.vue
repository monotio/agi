<script setup lang="ts">
/**
 * A game stored in this browser's library: its progress or opening, one line
 * of detail, and the play split button — Resume or Play, with a ▾ "More ways
 * to play" half when the game offers a choice (Start over with a saved game,
 * Watch walkthrough with a recording) — plus a flat ⋯ menu (edit, rename,
 * copy, download, details, remove). With `featured`, the card is also that
 * catalog release's only card on the shelf (the tutorial): it keeps the
 * catalog card's test ids and badge.
 */
import { computed, ref, useSlots, useTemplateRef } from "vue";
import ActionMenu from "../ui/ActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import GameCard, { type CardImage } from "./GameCard.vue";
import GameDownloadDialog from "./GameDownloadDialog.vue";
import RemoveGameDialog from "./RemoveGameDialog.vue";
import ProjectJournalRecovery from "./ProjectJournalRecovery.vue";
import OlderPositionChoice from "./OlderPositionChoice.vue";
import StartFresh from "./StartFresh.vue";
import { libraryDetails, showDetails } from "./cardDetails.ts";
import { shelfTitle } from "./shelfIdentity.ts";
import { useProjectRecovery } from "./projectRecovery.ts";
import { formatRelativeTime } from "./relativeTime.ts";
import { useNow } from "./useNow.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";
import { readMapSidecar } from "../world/roomMapStore.ts";
import { useShellBridge } from "../shell/shellBridge.ts";
import { hasWalkthrough } from "../walkthrough/walkthrough.ts";
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
  onCopyLibraryGame,
  onExportLibraryGame,
  onRemoveLibraryGame,
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
  // The bound reader also carries released journals forward for bodies
  // predating lifetime receipts. An unresolved card has no map to read.
  if (current.status !== "ready") return undefined;
  try {
    return readMapSidecar(localStorage, current.target).journal.at(-1)?.to;
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

const playLabel = computed(() => (autosave.value ? "Resume" : "Play"));

/** The walkthrough this card can offer: recorded for the stored revision. */
const walkthroughTarget = computed(() => {
  const revision = game.library?.revision ?? "";
  return hasWalkthrough(revision) ? revision : undefined;
});

const slots = useSlots();
/**
 * The ▾ half of the play button appears only with a real choice: a saved
 * game to start over, a walkthrough to watch, or an installed copy folded
 * into the tutorial's card.
 */
const hasPlayChoices = computed(
  () =>
    autosave.value !== undefined ||
    walkthroughTarget.value !== undefined ||
    slots["menu"] !== undefined,
);

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

/** Download… asks which file: the project or the playable game. */
const confirmDownload = ref(false);

const card = useTemplateRef("card");

/** Return dialog focus to this card's action menu. */
function menuTrigger(): HTMLElement | null {
  const root = card.value?.$el;
  return root instanceof HTMLElement
    ? root.querySelector<HTMLElement>("[data-testid^='game-actions-']")
    : null;
}

/** Dialogs that replace the ⋯ menu hand focus back to its trigger. */
function onDialogClosed(): void {
  menuTrigger()?.focus({ preventScroll: true });
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
        <UiButton type="submit" size="sm" :disabled="!gameTitle.trim()">Rename</UiButton>
        <UiButton size="sm" variant="ghost" @click="renaming = false">Cancel</UiButton>
      </div>
      <p v-if="renameError" role="alert" class="game-card__alert">{{ renameError }}</p>
    </form>
    <OlderPositionChoice :project-id="game.projectId" />
    <ProjectJournalRecovery :project-id="game.projectId" />
    <StartFresh v-if="isUnreadable(game.projectId)" :project-id="game.projectId" :title />
    <template v-if="!isUnreadable(game.projectId)" #actions>
      <span class="game-card__play" :class="{ 'game-card__play--split': hasPlayChoices }">
        <UiButton
          class="game-card__actions-main"
          :data-testid="featured ? `catalog-play-${featured.id}` : 'btn-resume-cached'"
          :disabled="libraryActionBusy || importBusy"
          @click="play"
        >
          {{ playLabel }}
        </UiButton>
        <ActionMenu
          v-if="hasPlayChoices"
          label="More ways to play"
          icon="chevron-down"
          icon-only
          :test-id="featured ? `play-more-${featured.id}` : `play-more-${game.projectId}`"
          :disabled="libraryActionBusy || importBusy"
        >
          <button type="button" role="menuitem" data-testid="play-more-resume" @click="play">
            {{ playLabel }}
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
            v-if="walkthroughTarget"
            type="button"
            role="menuitem"
            data-testid="run-walkthrough"
            @click="bridge.startWalkthrough(walkthroughTarget)"
          >
            Watch walkthrough
          </button>
          <slot name="menu" />
        </ActionMenu>
      </span>
      <ActionMenu
        label="Game actions"
        icon="ellipsis"
        icon-only
        :test-id="featured ? `game-actions-${featured.id}` : `game-actions-${game.projectId}`"
      >
        <button
          type="button"
          role="menuitem"
          data-testid="edit-library-game"
          @click="bridge.openLogicProject(game.projectId)"
        >
          Edit in Create
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
        <div role="separator"></div>
        <button
          type="button"
          role="menuitem"
          data-testid="open-game-download"
          @click="confirmDownload = true"
        >
          Download…
        </button>
        <button type="button" role="menuitem" data-testid="game-details-item" @click="openDetails">
          Details…
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
      <GameDownloadDialog
        v-model:open="confirmDownload"
        :title
        :busy="exportBusy"
        :work-in-progress="game.library?.workInProgress === true"
        @choose="(project) => onExportLibraryGame(game, project)"
        @closed="onDialogClosed"
      />
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
.game-card__play {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
}
.game-card__play :deep(.ui-btn) {
  flex: 1 1 auto;
  min-width: 0;
}
/* The ▾ half attaches to Play: one shared outline, joined corners. */
.game-card__play--split :deep(.ui-btn) {
  border-radius: var(--radius) 0 0 var(--radius);
}
.game-card__play--split :deep(.action-menu__trigger) {
  width: var(--control-h-touch);
  margin-left: -1px;
  border: 1px solid var(--action-line);
  border-radius: 0 var(--radius) var(--radius) 0;
  color: var(--action);
}
.game-card__play--split :deep(.action-menu__trigger:hover:not(:disabled)),
.game-card__play--split :deep(.action-menu__trigger[aria-expanded="true"]) {
  border-color: var(--action);
  background: var(--action-soft);
}
.game-card__play--split :deep(.action-menu__trigger:disabled) {
  border-color: var(--hairline);
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
