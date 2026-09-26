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
import ActionMenu from "./ActionMenu.vue";
import CatalogPanel from "./CatalogPanel.vue";
import ProfileChoiceDialog from "./ProfileChoiceDialog.vue";
import UiButton from "./ui/UiButton.vue";
import CardDetailsDialog from "./home/CardDetailsDialog.vue";
import GameCard from "./home/GameCard.vue";
import SavedGameCard from "./home/SavedGameCard.vue";
import TemplateCard from "./home/TemplateCard.vue";
import TutorialCard from "./home/TutorialCard.vue";
import { catalogLibraryCopy } from "./home/shelfIdentity.ts";
import { formatRelativeTime } from "./home/relativeTime.ts";
import { useNow } from "./home/useNow.ts";
import { BUILTIN_TEMPLATES } from "./gameTemplates.ts";
import { useGameLibrary } from "./useGameLibrary.ts";
import { useShellBridge } from "./shellBridge.ts";
import { getKnownGameByRevision } from "../../src/games/knownGames.ts";
import { computed } from "vue";

const {
  savedGames,
  pendingAutosave,
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

/** The tutorial's library copy shows on the tutorial's own card. */
const shelfSavedGames = computed(() => {
  const tutorial = catalogLibraryCopy(savedGames.value, featuredCatalog);
  return savedGames.value.filter((game) => game !== tutorial);
});

/** The leftover-autosave card's name: a known game's title, else its storage key. */
const pendingAutosaveTitle = computed(
  () =>
    getKnownGameByRevision(pendingAutosave.value?.game.identity.revision ?? "")?.title ??
    pendingAutosave.value?.game.identity.project ??
    "Saved game",
);

/** A leftover autosave from an installed or unavailable game gets a card of its own. */
const orphanAutosave = computed(() => {
  const record = pendingAutosave.value;
  if (!record) return undefined;
  const project = record.game.identity.project;
  if (savedGames.value.some((game) => game.projectId === project)) return undefined;
  if (localGames.value.some((game) => (game.folder ?? game.hash ?? game.alias) === project))
    return undefined;
  return record;
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
              @click="onStartOver"
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
      <p data-testid="verified-games-hint">
        Verified to boot: King's Quest I–IV, Space Quest I–II, Police Quest I, Leisure Suit Larry I,
        The Black Cauldron, Mixed-Up Mother Goose, Donald Duck's Playground, Gold Rush!, Manhunter
        1–2, demopac4; the Amiga editions of King's Quest II, Space Quest I–II, Police Quest I, Gold
        Rush! and Manhunter 2; and Space Quest II for the Apple IIgs.
      </p>
      <p data-testid="fan-games-hint">
        No Sierra copies? Fans have made over a hundred free AGI games:
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
        >. Their content varies, as fan works do.
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
  max-width: 72ch;
  margin: 0 0 var(--space-2);
}
.shelf-notes a {
  color: var(--ink-2);
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
