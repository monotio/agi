<script setup lang="ts">
/**
 * "Your games": the Home screen's one shelf. It holds the tutorial, saved
 * and remixed games (inline rename and a per-game action menu), installed
 * and hosted-catalog games (CatalogPanel), a leftover autosave whose game is
 * gone, then the creation templates and "Your own premise", which open the
 * create panel. The header carries the Add game menu; dropping a ZIP or
 * folder anywhere on Home imports (SetupPanel). Library state is the injected
 * shared controller; several elements here feed App.vue's routing through it.
 */
import ActionMenu from "../ui/ActionMenu.vue";
import CatalogPanel from "./CatalogPanel.vue";
import ProfileChoiceDialog from "./ProfileChoiceDialog.vue";
import UiButton from "../ui/UiButton.vue";
import CardDetailsDialog from "./CardDetailsDialog.vue";
import GameCard from "./GameCard.vue";
import SavedGameCard from "./SavedGameCard.vue";
import UnsupportedProject from "./UnsupportedProject.vue";
import TemplateCard from "./TemplateCard.vue";
import TutorialCard from "./TutorialCard.vue";
import { catalogLibraryCopy } from "./shelfIdentity.ts";
import { earlierProgressDetails, showDetails } from "./cardDetails.ts";
import { formatRelativeTime } from "./relativeTime.ts";
import { useEarlierProgressPresence } from "./useEarlierProgress.ts";
import { useNow } from "./useNow.ts";
import { BUILTIN_TEMPLATES } from "../library/gameTemplates.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";
import { useShellBridge } from "../shell/shellBridge.ts";
import { installedProgressTarget } from "../project/progressTarget.ts";
import { getKnownGameByRevision } from "../../../src/games/knownGames.ts";
import { computed } from "vue";

const {
  savedGames,
  unsupportedProjects,
  pendingAutosave,
  pendingProgressTarget,
  localGames,
  featuredCatalog,
  hostedCatalogError,
  hostedCatalogBusy,
  libraryActionError,
  importBusy,
  importError,
  importNotice,
  zipInput,
  folderInput,
  selectedTemplateId,
  onResumeAutosave,
  onStartOver,
  onGameZip,
  onGameFolder,
  refreshHostedCatalog,
  profileChoiceState,
  closeProfileChoice,
  applyProfileChoice,
} = useGameLibrary();
const bridge = useShellBridge();
const now = useNow();
const {
  presence: earlierPresence,
  presenceError: earlierPresenceError,
  retryPresence: retryEarlierPresence,
} = useEarlierProgressPresence(savedGames);

/** The footer's one Earlier progress link opens the shared Details dialog. */
function openEarlierProgress(event: MouseEvent): void {
  const trigger = event.currentTarget;
  showDetails(
    earlierProgressDetails({
      returnFocus: trigger instanceof HTMLElement ? trigger : undefined,
    }),
  );
}

/** The tutorial's library copy shows on the tutorial's own card. */
const shelfSavedGames = computed(() => {
  const tutorial = catalogLibraryCopy(savedGames.value, featuredCatalog);
  return savedGames.value.filter((game) => game !== tutorial);
});

/**
 * The leftover-autosave card's name: the exact instance's title when the
 * pending target resolves to a served descriptor, then a known game's
 * release title, then the record's own id — never a same-spelled card's
 * name from the other domain.
 */
const pendingAutosaveTitle = computed(() => {
  const target = pendingProgressTarget.value;
  const descriptor =
    target?.kind === "installed"
      ? localGames.value.find(
          (game) =>
            game.revision !== undefined &&
            installedProgressTarget(game, game.revision)?.locator === target.locator,
        )
      : undefined;
  return (
    descriptor?.title ??
    getKnownGameByRevision(pendingAutosave.value?.game.identity.revision ?? "")?.title ??
    pendingAutosave.value?.game.identity.project ??
    "Saved game"
  );
});

/**
 * A leftover autosave whose own instance has no card on the shelf gets one.
 * The claim is physical: the pending offer's target names the domain — a
 * project locator is a saved card's when the ids match, an installed
 * locator is a local card's only when the card's own bound target is the
 * same address. A shared spelling across domains claims nothing.
 */
const orphanAutosave = computed(() => {
  const record = pendingAutosave.value;
  const target = pendingProgressTarget.value;
  if (!record || !target) return undefined;
  if (target.kind === "project")
    return savedGames.value.some((game) => game.projectId === target.project) ? undefined : record;
  return localGames.value.some(
    (game) =>
      game.revision !== undefined &&
      installedProgressTarget(game, game.revision)?.locator === target.locator,
  )
    ? undefined
    : record;
});

/** Initials stand in for a screen that cannot be shown. */
function monogram(title: string): string {
  const initials = title
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 4)
    .toUpperCase();
  return initials || "AGI";
}

function startCreating(templateId: string): void {
  selectedTemplateId.value = templateId;
  bridge.openCreateSection();
}
</script>
<template>
  <section id="your-games" class="shelf" aria-labelledby="library-title">
    <header class="shelf-head">
      <h2 id="library-title">Your games</h2>
      <div id="open-game" class="shelf-add" role="group" aria-label="Add game">
        <p class="shelf-hint">Drop a ZIP or folder anywhere to add a game</p>
        <ActionMenu
          :label="importBusy ? 'Adding game…' : 'Add game'"
          test-id="open-game-menu"
          :disabled="importBusy"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="open-game-zip"
            @click="zipInput?.click()"
          >
            ZIP file
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="open-game-folder"
            @click="folderInput?.click()"
          >
            Game folder
          </button>
        </ActionMenu>
        <input
          ref="zipInput"
          type="file"
          accept=".zip,application/zip"
          data-testid="game-zip-input"
          hidden
          @change="onGameZip(($event.target as HTMLInputElement).files?.[0])"
        />
        <input
          ref="folderInput"
          type="file"
          multiple
          webkitdirectory
          data-testid="game-folder-input"
          hidden
          @change="onGameFolder(($event.target as HTMLInputElement).files ?? undefined)"
        />
      </div>
    </header>

    <p v-if="libraryActionError" role="alert" class="shelf-message shelf-message--error">
      {{ libraryActionError }}
    </p>
    <div
      v-if="hostedCatalogError"
      class="shelf-message shelf-message--error"
      data-testid="hosted-catalog-error"
    >
      <p role="alert">{{ hostedCatalogError }}</p>
      <UiButton size="sm" :disabled="hostedCatalogBusy" @click="refreshHostedCatalog">
        Retry game list
      </UiButton>
    </div>
    <p
      v-if="importError"
      role="alert"
      class="shelf-message shelf-message--error"
      data-testid="game-zip-error"
    >
      {{ importError }}
    </p>
    <p
      v-if="importNotice"
      role="status"
      class="shelf-message shelf-message--ok"
      data-testid="game-import-ready"
    >
      {{ importNotice }}
    </p>

    <div class="shelf-grid" data-testid="saved-game-gallery">
      <TutorialCard />
      <SavedGameCard v-for="game in shelfSavedGames" :key="game.projectId" :game />
      <GameCard
        v-for="game in unsupportedProjects"
        :key="game.projectId"
        :title="game.title"
        :monogram="monogram(game.title)"
        :data-testid="`unsupported-project-card-${game.projectId}`"
        :data-project-id="game.projectId"
      >
        <UnsupportedProject :game />
      </GameCard>
      <CatalogPanel />
      <!-- Autosave left over from an installed or unavailable game. -->
      <GameCard
        v-if="orphanAutosave"
        :title="pendingAutosaveTitle"
        :monogram="monogram(pendingAutosaveTitle)"
        :image="
          orphanAutosave.preview
            ? {
                src: orphanAutosave.preview,
                alt: `${pendingAutosaveTitle}, current progress in room ${orphanAutosave.room}`,
                kind: 'progress',
              }
            : undefined
        "
        badge="In progress"
        :meta="`Room ${orphanAutosave.room} · played ${formatRelativeTime(orphanAutosave.savedAt, now)}`"
        play-label="Resume"
        data-testid="autosave-panel"
        @play="onResumeAutosave"
      >
        <template #actions>
          <UiButton
            class="game-card__actions-main"
            data-testid="btn-resume-autosave"
            @click="onResumeAutosave"
          >
            Resume
          </UiButton>
          <ActionMenu label="Game actions" icon="ellipsis" icon-only>
            <button
              type="button"
              role="menuitem"
              data-testid="btn-start-over-picker"
              title="Discard the autosave and play this game from the beginning"
              @click="onStartOver()"
            >
              Start over
            </button>
          </ActionMenu>
        </template>
      </GameCard>
      <TemplateCard
        v-for="tmpl in BUILTIN_TEMPLATES"
        :key="tmpl.id"
        :title="tmpl.title"
        detail="Template · create with AI"
        :test-id="`shelf-template-${tmpl.id}`"
        @select="startCreating(tmpl.id)"
      />
      <TemplateCard
        title="Your own premise"
        detail="Describe it, AI builds it"
        blank
        test-id="shelf-template-custom"
        @select="startCreating('custom')"
      />
    </div>

    <footer class="shelf-notes">
      <p v-if="earlierPresence === 'present'" data-testid="earlier-progress-note">
        Explore
        <button
          type="button"
          class="shelf-notes__link"
          data-testid="earlier-progress-link"
          @click="openEarlierProgress"
        >
          earlier progress
        </button>
        saved in this browser.
      </p>
      <p
        v-else-if="earlierPresence === 'failed'"
        role="status"
        class="shelf-message--error"
        data-testid="earlier-progress-error"
      >
        {{ earlierPresenceError }}
        <button
          type="button"
          class="shelf-notes__link"
          data-testid="earlier-progress-retry"
          @click="retryEarlierPresence"
        >
          Retry
        </button>
      </p>
      <p data-testid="verified-games-hint">
        Verified to boot: King's Quest, Space Quest, Police Quest and more.
        <button
          type="button"
          class="shelf-notes__link"
          data-testid="verified-games-help"
          @click="bridge.openHelp('games')"
        >
          Full list
        </button>
      </p>
      <p data-testid="fan-games-hint">
        Explore over a hundred free AGI games made by fans:
        <a
          href="https://agiwiki.sierrahelp.com/index.php/Fan_AGI_Release_List"
          target="_blank"
          rel="noopener noreferrer"
          >AGI Wiki</a
        >
        ·
        <a
          href="https://sciprogramming.com/fangames.php?eng=agi&cat=Complete&sort=downloads"
          target="_blank"
          rel="noopener noreferrer"
          >SCI Programming</a
        >. Fan games span many genres and audiences.
      </p>
    </footer>

    <CardDetailsDialog />
    <ProfileChoiceDialog
      v-if="profileChoiceState"
      :key="`${profileChoiceState.mode}:${profileChoiceState.projectId}`"
      :choice="profileChoiceState"
      @save="applyProfileChoice"
      @close="closeProfileChoice"
    />
  </section>
</template>

<style scoped>
.shelf {
  min-width: 0;
  font-family: var(--font-sans);
  scroll-margin-top: var(--space-6);
}
.shelf-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3) var(--space-5);
  margin: 0 0 var(--space-4);
}
.shelf-head h2 {
  margin: 0;
  color: var(--ink);
  font: var(--weight-semibold) var(--text-lg) / var(--leading-tight) var(--font-sans);
}
.shelf-add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3) var(--space-4);
}
.shelf-hint {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-sm);
}
.shelf-message {
  margin: 0 0 var(--space-4);
  font-size: var(--text-sm);
  line-height: var(--leading);
}
.shelf-message p {
  margin: 0 0 var(--space-3);
}
.shelf-message--error {
  color: var(--danger);
}
.shelf-message--ok {
  color: var(--ok);
}
/* About five across on a desktop, two on a phone. Cards in a row share one
   height; a short row keeps its cards' width, so one game never spans the shelf. */
.shelf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 184px), 1fr));
  gap: var(--space-5);
}
.shelf-notes {
  margin-top: var(--space-7);
  color: var(--ink-3);
  font-size: var(--text-xs);
  line-height: 1.5;
}
.shelf-notes p {
  max-width: 80ch;
  margin: 0 0 var(--space-2);
}
.shelf-notes a,
.shelf-notes__link {
  color: var(--ink-2);
}
.shelf-notes__link {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.shelf-notes__link:hover {
  color: var(--ink);
}
@media (pointer: coarse) {
  .shelf-hint {
    display: none;
  }
}
@media (max-width: 520px) {
  .shelf-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
  }
}
</style>
