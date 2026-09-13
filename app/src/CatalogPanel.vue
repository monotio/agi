<script setup lang="ts">
/**
 * The fixture and hosted-catalog cards inside the library gallery: installed
 * games with their autosave state, and catalog entries whose opening previews
 * load when the cards scroll into view. All state comes from the injected
 * shared library controller.
 */
import ActionMenu from "./ActionMenu.vue";
import { useEngineApi } from "./engineContext.ts";
import { useAiSettings } from "./useAiSettings.ts";
import { useGameLibrary } from "./useGameLibrary.ts";
import { useShellBridge } from "./shellBridge.ts";
import { hasWalkthrough } from "./walkthrough.ts";
import type { InstalledGameDescriptor } from "./gameTypes.ts";

const { resumeAudio, startOver } = useEngineApi();
const { llmConfig } = useAiSettings();
const {
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
  observeCatalogCard,
} = useGameLibrary();
const bridge = useShellBridge();

function onStartLocalGameOver(game: InstalledGameDescriptor): void {
  resumeAudio();
  startOver(game.folder ?? game.hash, llmConfig());
}
</script>
<template>
  <article
    v-for="game in localGames"
    :key="`local-${game.hash}`"
    class="saved-game-card"
    :data-testid="`local-game-card-${game.alias || game.folder || game.hash}`"
  >
    <div class="saved-game-media">
      <img
        v-if="localAutosave(game)?.preview"
        class="library-thumbnail"
        data-testid="library-thumbnail"
        data-preview-kind="progress"
        :src="localAutosave(game)?.preview"
        :alt="`${game.title}, current progress in room ${localAutosave(game)?.room}`"
      />
      <div v-else class="saved-game-cover" aria-hidden="true">
        {{ (game.alias || game.hash).slice(0, 8).toUpperCase() }}
      </div>
      <span v-if="localAutosave(game)" class="saved-world-badge">IN PROGRESS</span>
    </div>
    <div class="saved-game-card-body">
      <div class="saved-game-info">
        <div class="saved-game-heading">
          <h3 class="saved-world-title">{{ game.title }}</h3>
        </div>
        <p v-if="game.folder && game.folder !== game.alias" class="saved-world-source">
          {{ game.folder }}
        </p>
        <p v-if="localAutosave(game)" class="saved-world-time">
          Room {{ localAutosave(game)?.room }}
        </p>
      </div>
      <div class="saved-game-play-row">
        <button
          type="button"
          class="ui-button ui-button--primary"
          :data-hash="game.hash"
          :data-alias="game.alias"
          :data-testid="`boot-${game.folder || game.alias || game.hash}`"
          :disabled="libraryActionBusy || importBusy"
          @click="onPlayLocalGame(game.folder ?? game.hash)"
        >
          {{ localAutosave(game) ? "Resume" : "Play" }}
        </button>
        <ActionMenu
          v-if="localAutosave(game) || hasWalkthrough(game.hash)"
          label="Game actions"
          icon="more"
          icon-only
          :test-id="`game-actions-${game.folder || game.alias || game.hash}`"
        >
          <button
            v-if="hasWalkthrough(game.hash)"
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
        </ActionMenu>
      </div>
    </div>
  </article>
  <article
    v-for="entry in availableCatalogEntries"
    :key="`catalog-${entry.id}-${entry.version}`"
    :ref="(element) => observeCatalogCard(element, entry.id)"
    class="saved-game-card"
    :data-testid="`hosted-game-card-${entry.id}`"
  >
    <div class="saved-game-media">
      <img
        v-if="catalogOpenings[entry.id]?.preview"
        class="library-thumbnail"
        :src="catalogOpenings[entry.id]?.preview"
        :alt="`${entry.title} opening scene`"
      />
      <div v-else class="saved-game-cover" aria-hidden="true">AGI</div>
    </div>
    <div class="saved-game-card-body">
      <div class="saved-game-info">
        <div class="saved-game-heading">
          <h3 class="saved-world-title">{{ entry.title }}</h3>
        </div>
        <p class="saved-world-time">{{ entry.description }}</p>
      </div>
      <p v-if="catalogErrors[entry.id]" role="alert" class="library-error">
        {{ catalogErrors[entry.id] }}
      </p>
      <div class="saved-game-play-row">
        <button
          v-if="catalogErrors[entry.id]"
          type="button"
          class="ui-button ui-button--secondary"
          :disabled="catalogBusy[entry.id]"
          @click="loadCatalogOpening(entry.id)"
        >
          Retry preview
        </button>
        <button
          v-else
          type="button"
          class="ui-button ui-button--primary"
          :disabled="catalogBusy[entry.id] || libraryActionBusy || importBusy"
          @click="playCatalogGame(entry.id)"
        >
          {{ catalogBusy[entry.id] ? "Checking opening…" : "Play" }}
        </button>
        <button
          v-if="hasWalkthrough(entry.id)"
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="catalog-run-walkthrough"
          :disabled="catalogBusy[entry.id] || libraryActionBusy || importBusy"
          @click="playCatalogWalkthrough(entry.id)"
        >
          Watch
        </button>
      </div>
      <details class="library-details-disclosure">
        <summary>Details</summary>
        <div class="library-details">
          <dl>
            <template v-if="entry.author"
              ><dt>By</dt>
              <dd>{{ entry.author }}</dd></template
            >
            <dt>License</dt>
            <dd>{{ entry.license }}</dd>
            <dt>Version</dt>
            <dd>{{ entry.version }}</dd>
          </dl>
        </div>
      </details>
    </div>
  </article>
</template>
